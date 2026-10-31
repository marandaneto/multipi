import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { RoomStore } from "../../src/room/state";

async function fixture() {
  const storage = new MemoryStorage();
  const pi = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  const store = new RoomStore(pi);
  await store.update((room) => {
    room.mode = "ready";
    room.checkpoint = { revision: 1, backupKey: "old", digest: "old" };
    room.execution = {
      callId: "call",
      beforeRevision: 1,
      shell: { command: "sleep 60", startedAt: 123 },
    };
  });
  const records = async () =>
    (
      await (await pi.root(BACKGROUND_CONTEXT)).context(BACKGROUND_CONTEXT)
    ).entries.filter((entry) => entry.kind === "multipi.execution");
  return { pi, store, records };
}

describe("durable host execution records", () => {
  it("persists one interruption despite concurrent observers without changing the checkpoint or model context", async () => {
    const f = await fixture();
    try {
      await Promise.all([
        f.store.recordInterruption("stop"),
        f.store.recordInterruption("restart"),
      ]);
      const records = await f.records();
      expect(records).toHaveLength(1);
      expect(records[0]?.data).toMatchObject({
        callId: "call",
        command: "sleep 60",
        startedAt: 123,
        outcome: "interrupted",
        exitCode: null,
        workspaceRevision: 1,
      });
      expect((await f.store.read()).checkpoint?.revision).toBe(1);
      expect((await f.store.read()).execution?.shell?.recorded).toBe(true);
      expect(
        (
          await (
            await f.pi.root(BACKGROUND_CONTEXT)
          ).context(BACKGROUND_CONTEXT)
        ).messages,
      ).toEqual([]);
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it.each([
    ["completed", 0],
    ["failed", 7],
  ] as const)(
    "records %s only with its committed checkpoint and real exit code",
    async (outcome, exitCode) => {
      const f = await fixture();
      try {
        await f.store.recordExecution(
          "call",
          { outcome, exitCode, reason: "result" },
          { revision: 2, backupKey: "new", digest: "new" },
        );
        await f.store.recordInterruption("stop");
        expect(await f.records()).toHaveLength(1);
        expect((await f.records())[0]?.data).toMatchObject({
          outcome,
          exitCode,
          workspaceRevision: 2,
        });
        expect((await f.store.read()).checkpoint?.revision).toBe(2);
      } finally {
        await f.pi.close(BACKGROUND_CONTEXT);
      }
    },
  );
  it("cannot replace an interrupted observation with late completion or advance its checkpoint", async () => {
    const f = await fixture();
    try {
      await f.store.recordInterruption("stop");
      await expect(
        f.store.recordExecution(
          "call",
          { outcome: "completed", exitCode: 0, reason: "result" },
          { revision: 2, backupKey: "late", digest: "late" },
        ),
      ).rejects.toThrow("superseded");
      expect((await f.store.read()).checkpoint?.revision).toBe(1);
      expect(await f.records()).toHaveLength(1);
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it("does not fabricate command metadata for legacy non-shell intents", async () => {
    const f = await fixture();
    try {
      await f.store.update((room) => {
        room.execution = { callId: "legacy", beforeRevision: 1 };
      });
      await f.store.recordInterruption("restore");
      expect(await f.records()).toEqual([]);
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
});
