import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { RoomStore, authorizeData } from "../../src/room/state";

describe("durable app documents on Pi's commit line", () => {
  it("persists room membership and actor/payload-bound receipts", async () => {
    const pi = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const store = new RoomStore(pi);
      await store.initialize({
        id: crypto.randomUUID(),
        title: "Task",
        repository: "org/repo",
        baseSha: "a".repeat(40),
        owner: "alice@example.test",
        createdAt: new Date().toISOString(),
      });
      const identity = {
        id: "alice@example.test",
        subject: "alice",
        expiresAt: Date.now() + 60_000,
      };
      expect((await store.authorize(identity)).role).toBe("owner");
      await store.intent("key", identity.id, "original", "op");
      await expect(
        store.intent("key", identity.id, "changed", "op"),
      ).rejects.toThrow("different payload");
      await store.receipt("key", { accepted: true }, "accepted");
      expect(
        (await store.intent("key", identity.id, "original", "op")).state,
      ).toBe("accepted");
      await store.update((room) => {
        room.members["bob@example.test"] = "observer";
      });
      const snapshot = await store.read();
      expect(() =>
        authorizeData(snapshot, { ...identity, expiresAt: 0 }),
      ).toThrow("expired");
      await expect(
        store.authorize({ ...identity, id: "bob@example.test" }, true),
      ).rejects.toThrow();
      await store.update((room) => {
        delete room.members["bob@example.test"];
      });
      await expect(
        store.authorize({ ...identity, id: "bob@example.test" }),
      ).rejects.toThrow();
    } finally {
      await pi.close(BACKGROUND_CONTEXT);
    }
  });
});
