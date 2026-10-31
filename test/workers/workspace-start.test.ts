import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { WorkspaceService } from "../../src/workspace/service";
import { ok } from "@earendil-works/pi-durable/env";

function fixture(
  instance?: string,
  configureNetwork: () => Promise<void> = async () => {},
) {
  const stopped = new Error("startup captured");
  const unused = () => {
    throw new Error("Unexpected container operation");
  };
  const container: Container = {
    running: false,
    images: { workspace: "pinned-image" },
    start: vi.fn(() => {
      throw stopped;
    }),
    destroy: vi.fn(async () => {}),
    monitor: unused,
    signal: unused,
    getTcpPort: unused,
    setInactivityTimeout: unused,
    interceptOutboundHttp: unused,
    interceptAllOutboundHttp: unused,
    interceptOutboundHttps: unused,
    snapshotContainer: unused,
    exec: unused,
    inspect: unused,
  };
  const workspace = new WorkspaceService(
    container,
    "startup-fixture",
    exports.DirectoryBackupGateway,
    {
      head: (key) => env.BACKUPS.head(key),
      put: (key, value, options) => env.BACKUPS.put(key, value, options),
    },
    async () => null,
    configureNetwork,
    async () => {},
    instance,
  );
  return { container, workspace, stopped };
}
const metadata = {
  id: "startup-fixture",
  title: "Startup",
  repository: "org/repo",
  baseSha: "a".repeat(40),
  owner: "owner@example.test",
  createdAt: "2026-10-29",
};

it("passes the deployment-selected instance to native startup without enabling internet", async () => {
  const f = fixture("standard-1");
  await expect(f.workspace.initialize(metadata)).rejects.toThrow(
    "startup captured",
  );
  expect(f.container.start).toHaveBeenCalledExactlyOnceWith({
    image: "pinned-image",
    enableInternet: false,
    instance: "standard-1",
  });
});
it("leaves unspecified deployments on the existing platform default", async () => {
  const f = fixture();
  await expect(f.workspace.initialize(metadata)).rejects.toThrow(
    "startup captured",
  );
  expect(f.container.start).toHaveBeenCalledExactlyOnceWith({
    image: "pinned-image",
    enableInternet: false,
  });
});
it.each(["destroy", "network"])(
  "does not restart initialization after Stop while awaiting %s",
  async (stage) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pause = async () => {
      entered.resolve();
      await release.promise;
    };
    const f = fixture(undefined, stage === "network" ? pause : async () => {});
    if (stage === "destroy")
      vi.mocked(f.container.destroy).mockImplementationOnce(pause);
    const outcome = f.workspace.initialize(metadata).catch((error) => error);
    await entered.promise;
    await f.workspace.stop();
    release.resolve();
    expect(await outcome).toMatchObject({
      message: "Workspace preparation was cancelled",
    });
    expect(f.container.start).not.toHaveBeenCalled();
  },
);
it("does not initialize after preparation was already stopped", async () => {
  const f = fixture();
  await f.workspace.stop();
  await expect(f.workspace.initialize(metadata)).rejects.toThrow(
    "Workspace preparation was cancelled",
  );
  expect(f.container.start).not.toHaveBeenCalled();
});
it("does not start a backup when Stop interrupts checkpoint measurement", async () => {
  const f = fixture();
  vi.spyOn(f.workspace.env, "exec").mockImplementation(
    async (_command, options, context) => {
      options?.onOutput?.("10", context, { stream: "stdout" });
      await f.workspace.stop();
      return ok({ exitCode: 0 });
    },
  );
  await expect(f.workspace.checkpoint("interrupted")).rejects.toThrow(
    "Workspace operation was cancelled",
  );
  expect(f.container.start).not.toHaveBeenCalled();
});
it("does not restart a restore superseded while reading its backup", async () => {
  const f = fixture();
  f.workspace.attach(metadata);
  await env.BACKUPS.put("rooms/startup-fixture/checkpoint.tar.zst", "fixture");
  vi.spyOn(f.workspace.bucket, "head").mockImplementationOnce(async (key) => {
    const object = await env.BACKUPS.head(key);
    await f.workspace.stop();
    return object;
  });
  await expect(
    f.workspace.restore({
      revision: 1,
      backupKey: "checkpoint",
      digest: "fixture",
    }),
  ).rejects.toThrow("Workspace operation was cancelled");
  expect(f.container.start).not.toHaveBeenCalled();
  expect(f.container.destroy).toHaveBeenCalledTimes(1);
});
it.each(["basic", "typo", "standard-5"])(
  "rejects unsupported instance %s before starting a container",
  (instance) => {
    expect(() => fixture(instance)).toThrow();
  },
);
