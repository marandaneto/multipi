import { DirectoryBackup } from "@cloudflare/sandbox";
import { z } from "zod";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { buildReview, captureSchema, captureScript } from "./review";
export { reviewSchema } from "./review";
import type { WorkspacePort } from "../room/control";
import type { Checkpoint, RoomMetadata } from "../room/state";
import { AppError, digest } from "../shared/protocol";
import { createNativeExecutionEnv } from "./native-env";

const ROOT = "/workspace/repo";
const instanceType = z.enum([
  "lite",
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
]);
type RestoreStage = "restoring" | "ready" | "failed";
type WorkspaceBucket = {
  head(key: string): Promise<{ size: number } | null>;
  put(
    key: string,
    value: string,
    options: { onlyIf: { etagDoesNotMatch: string } },
  ): Promise<unknown>;
};

export class WorkspaceService implements WorkspacePort {
  private currentEnv;
  private metadata: RoomMetadata | null = null;
  private verified = false;
  private preparationCancelled = false;
  private cancellationGeneration = 0;
  private readonly backups: DirectoryBackup;
  private readonly instance: z.infer<typeof instanceType> | undefined;
  constructor(
    readonly container: Container,
    readonly roomId: string,
    gateway: ConstructorParameters<typeof DirectoryBackup>[1],
    readonly bucket: WorkspaceBucket,
    readonly latest: () => Promise<Checkpoint | null>,
    readonly configureNetwork: (repository: string) => Promise<void>,
    readonly transition: (stage: RestoreStage) => Promise<void>,
    instance?: string,
  ) {
    this.instance = instanceType.optional().parse(instance);
    this.currentEnv = createNativeExecutionEnv(container, `room:${roomId}`);
    this.backups = new DirectoryBackup(container, gateway, {
      binding: "BACKUPS",
      prefix: `rooms/${roomId}/`,
    });
  }
  get env() {
    return this.currentEnv;
  }
  attach(metadata: RoomMetadata) {
    this.metadata = metadata;
  }
  private assertPreparing() {
    if (this.preparationCancelled)
      throw new AppError(409, "Workspace preparation was cancelled");
  }
  private assertCurrent(generation: number) {
    if (generation !== this.cancellationGeneration)
      throw new AppError(409, "Workspace operation was cancelled");
  }
  private async start(generation: number, initializing = false) {
    if (!this.metadata) throw new AppError(409, "Workspace not initialized");
    await this.configureNetwork(this.metadata.repository);
    if (initializing) this.assertPreparing();
    this.assertCurrent(generation);
    if (!this.container.running)
      this.container.start({
        image: this.container.images.workspace,
        enableInternet: false,
        ...(this.instance ? { instance: this.instance } : {}),
      });
    await this.container.setInactivityTimeout(10 * 60_000);
    // The entrypoint mkdir can race native exec; establish the restore target first.
    getOrThrow(
      await this.env.createDir(ROOT, { recursive: true }, BACKGROUND_CONTEXT),
    );
  }
  async ensure() {
    if (!this.verified || !this.container.running) {
      const checkpoint = await this.latest();
      if (!checkpoint) throw new AppError(409, "Workspace has no checkpoint");
      await this.restore(checkpoint);
    }
  }
  private async run(argv: string[]) {
    let output = "";
    const result = getOrThrow(
      await this.env.exec(
        argv,
        {
          timeout: 120,
          onOutput: (text) => {
            output += text;
            if (output.length > 4 * 1024 * 1024)
              throw new Error("Workspace output limit exceeded");
          },
          env: {
            GIT_TERMINAL_PROMPT: "0",
            GIT_SSL_CAINFO:
              "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
            NODE_EXTRA_CA_CERTS:
              "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
          },
        },
        BACKGROUND_CONTEXT,
      ),
    );
    if (result.exitCode !== 0)
      throw new AppError(422, "Workspace command failed");
    return output;
  }
  async initialize(metadata: RoomMetadata) {
    const generation = this.cancellationGeneration;
    this.assertPreparing();
    this.attach(metadata);
    await this.container.destroy();
    this.assertPreparing();
    this.currentEnv = createNativeExecutionEnv(
      this.container,
      `room:${this.roomId}`,
    );
    await this.start(generation, true);
    await this.run(["git", "init", "--quiet", ROOT]);
    await this.run(["git", "config", "core.hooksPath", "/dev/null"]);
    await this.run([
      "git",
      "remote",
      "add",
      "origin",
      `https://github.com/${metadata.repository}.git`,
    ]);
    await this.run(["git", "fetch", "--depth=1", "origin", metadata.baseSha]);
    await this.run([
      "git",
      "checkout",
      "-b",
      `multipi/${this.roomId}`,
      "FETCH_HEAD",
    ]);
    const checkpoint = await this.checkpoint("initialize");
    this.assertPreparing();
    this.verified = true;
    return checkpoint;
  }
  async checkpoint(callId: string): Promise<Checkpoint> {
    const generation = this.cancellationGeneration;
    const measured = await this.run([
      "du",
      "-sb",
      "--exclude=node_modules",
      ROOT,
    ]);
    this.assertCurrent(generation);
    const size = Number(measured.split(/\s/)[0]);
    if (!Number.isSafeInteger(size) || size > 20 * 1024 * 1024)
      throw new AppError(413, "Workspace exceeds 20 MiB pilot limit");
    const record = await this.backups.backup({
      dir: ROOT,
      name: callId,
      gitignore: false,
      exclude: ["**/node_modules/", "**/.pnpm-store/"],
    });
    this.assertCurrent(generation);
    if (record.size > 20 * 1024 * 1024) {
      await this.backups.delete(record);
      throw new AppError(413, "Backup exceeds pilot limit");
    }
    const revision = ((await this.latest())?.revision ?? 0) + 1;
    this.assertCurrent(generation);
    return {
      revision,
      backupKey: record.id,
      digest: record.sha256,
    };
  }
  async restore(checkpoint: Checkpoint) {
    const generation = this.cancellationGeneration;
    this.verified = false;
    await this.transition("restoring");
    try {
      this.assertCurrent(generation);
      const object = await this.bucket.head(
        `rooms/${this.roomId}/${checkpoint.backupKey}.tar.zst`,
      );
      this.assertCurrent(generation);
      if (!object || object.size > 20 * 1024 * 1024)
        throw new AppError(409, "Workspace backup unavailable");
      await this.container.destroy();
      this.assertCurrent(generation);
      this.currentEnv = createNativeExecutionEnv(
        this.container,
        `room:${this.roomId}`,
      );
      await this.start(generation);
      this.assertCurrent(generation);
      await this.backups.restore({
        id: checkpoint.backupKey,
        dir: ROOT,
        size: object.size,
        sha256: checkpoint.digest,
        format: "tar+zstd/1",
      });
      this.assertCurrent(generation);
      await this.transition("ready");
      this.assertCurrent(generation);
      this.verified = true;
    } catch (error) {
      if (generation === this.cancellationGeneration) {
        await this.currentEnv.fence().catch(() => undefined);
        await this.transition("failed");
      }
      throw error;
    }
  }
  async stop() {
    this.preparationCancelled = true;
    this.cancellationGeneration++;
    this.verified = false;
    await this.currentEnv.fence();
  }
  async review(baseSha: string, checkpoint: Checkpoint) {
    await this.ensure();
    const content = buildReview(
      captureSchema.parse(
        JSON.parse(
          await this.run([
            "node",
            "--input-type=module",
            "-e",
            captureScript,
            baseSha,
          ]),
        ),
      ),
    );
    const contentDigest = await digest(
      JSON.stringify({ baseSha, files: content.files }),
    );
    await this.bucket.put(
      `rooms/${this.roomId}/reviews/${contentDigest}.json`,
      JSON.stringify({ baseSha, files: content.files, patch: content.patch }),
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
    return {
      revision: checkpoint.revision,
      digest: contentDigest,
      patch: content.patch,
      files: content.files.map((item) => ({
        path: item.path,
        status: item.content === null ? "deleted" : "changed",
      })),
    };
  }
}
