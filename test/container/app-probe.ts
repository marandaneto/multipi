import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { RoomDO, type RoomWorkspace } from "../../src/room/room";
import { RoomDocument } from "../../src/room/state";
import { WorkspaceService } from "../../src/workspace/service";
import type { AppEnv } from "../../src/worker/env";
export {
  DirectoryBackupGateway,
  GitReadGateway,
  DependencyGateway,
} from "../../src/worker/index";

const roomId = "11111111-1111-4111-8111-111111111111";
function identity() {
  return {
    id: "alice@example.test",
    subject: "fixture",
    expiresAt: Date.now() + 3_600_000,
  };
}
class FixtureWorkspace extends WorkspaceService {
  holdAfterBackup = false;
  backupHeld = false;
  override async checkpoint(callId: string) {
    const checkpoint = await super.checkpoint(callId);
    if (this.holdAfterBackup) {
      this.backupHeld = true;
      await new Promise<void>(() => {});
    }
    return checkpoint;
  }
  constructor(...args: ConstructorParameters<typeof WorkspaceService>) {
    super(...args);
  }
  override async initialize(
    metadata: Parameters<WorkspaceService["initialize"]>[0],
  ) {
    this.attach(metadata);
    this.container.start({
      image: this.container.images.workspace,
      enableInternet: false,
    });
    await this.container.setInactivityTimeout(60_000);
    const result = getOrThrow(
      await this.env.exec(
        "git init -q && git config user.name Fixture && git config user.email fixture@example.test && printf original > old.txt && printf 'export const value = 1;\\n' > index.js && git add . && git commit -qm initial",
        undefined,
        BACKGROUND_CONTEXT,
      ),
    );
    if (result.exitCode !== 0) throw new Error("Fixture setup failed");
    return super.checkpoint("initialize");
  }
}
export class AppProbe extends RoomDO {
  private fixtureWorkspace?: FixtureWorkspace;
  private denyBackupRead = false;
  protected override workspace(): RoomWorkspace {
    return (this.fixtureWorkspace ??= new FixtureWorkspace(
      this.ctx.container!,
      roomId,
      this.ctx.exports.DirectoryBackupGateway,
      {
        head: (key) =>
          this.denyBackupRead
            ? Promise.resolve(null)
            : this.env.BACKUPS.head(key),
        put: (key, value, options) => this.env.BACKUPS.put(key, value, options),
      },
      async () =>
        (
          await (
            await this.harness.pi()
          ).snapshot(RoomDocument, BACKGROUND_CONTEXT)
        )?.checkpoint ?? null,
      async () => {},
      (stage) => this.workspaceTransition(stage),
    ));
  }
  async setup() {
    await this.initialize({
      id: roomId,
      title: "Native recovery fixture",
      repository: "fixture/repo",
      baseSha: "a".repeat(40),
      owner: identity().id,
      createdAt: new Date().toISOString(),
    });
    let sha = "";
    getOrThrow(
      await this.workspace().env!.exec(
        ["git", "rev-parse", "HEAD"],
        {
          onOutput: (text) => {
            sha += text;
          },
        },
        BACKGROUND_CONTEXT,
      ),
    );
    await (
      await this.harness.pi()
    ).commit(async (tx) => {
      (await tx.doc(RoomDocument)).metadata!.baseSha = sha.trim();
    }, BACKGROUND_CONTEXT);
  }
  async failAutomaticRestore() {
    this.denyBackupRead = true;
    await this.workspace().stop();
  }
  allowRestore() {
    this.denyBackupRead = false;
  }
  holdBackup() {
    this.workspace();
    this.fixtureWorkspace!.holdAfterBackup = true;
  }
  backupHeld() {
    return this.fixtureWorkspace?.backupHeld ?? false;
  }
  crash() {
    this.ctx.abort("Intentional application recovery probe");
  }
  async hasFile(path: string) {
    await this.workspace().ensure();
    return getOrThrow(
      await this.workspace().env!.exists(path, BACKGROUND_CONTEXT),
    );
  }
}
type ProbeEnv = AppEnv & { PROBE: DurableObjectNamespace<AppProbe> };
export default {
  async fetch(request: Request, env: ProbeEnv) {
    const room = env.PROBE.getByName(roomId);
    const path = new URL(request.url).pathname;
    if (path === "/setup") {
      await room.setup();
      return Response.json({ id: roomId });
    }
    if (path === "/crash") {
      try {
        await room.crash();
      } catch {}
      return Response.json({ crashRequested: true });
    }
    if (path === "/fail-restore") {
      await room.failAutomaticRestore();
      return Response.json({ ok: true });
    }
    if (path === "/allow-restore") {
      await room.allowRestore();
      return Response.json({ ok: true });
    }
    if (path === "/hold-backup") {
      await room.holdBackup();
      return Response.json({ ok: true });
    }
    if (path === "/backup-held")
      return Response.json({ held: await room.backupHeld() });
    if (path === "/has")
      return Response.json({
        exists: await room.hasFile(
          new URL(request.url).searchParams.get("path")!,
        ),
      });
    const headers = new Headers(request.headers);
    headers.set("x-multipi-identity", JSON.stringify(identity()));
    return room.fetch(new Request(request, { headers }));
  },
};
