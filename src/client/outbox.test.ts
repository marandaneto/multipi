import { describe, expect, it } from "vitest";
import {
  SubmitOutbox,
  type OutboxItem,
  type OutboxStore,
  type Scope,
  type Submit,
} from "./outbox";
class MemoryStore implements OutboxStore {
  items: OutboxItem[] = [];
  async list(scope: Scope) {
    return this.items
      .filter(
        (item) =>
          item.principal === scope.principal && item.roomId === scope.roomId,
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  async put(item: OutboxItem) {
    this.items = this.items.filter(
      (old) =>
        old.command.id !== item.command.id ||
        old.principal !== item.principal ||
        old.roomId !== item.roomId,
    );
    this.items.push(item);
  }
  async remove(scope: Scope, id: string) {
    this.items = this.items.filter(
      (item) =>
        item.principal !== scope.principal ||
        item.roomId !== scope.roomId ||
        item.command.id !== id,
    );
  }
}
const scope = { principal: "alice@example.test", roomId: "room-one" };
const command = (id = "00000000-0000-4000-8000-000000000001"): Submit => ({
  type: "submit",
  id,
  text: "fix it",
  mode: "followUp",
});
describe("client/outbox", () => {
  it("survives coordinator reload and waits for the synchronized writable gate", async () => {
    const store = new MemoryStore();
    const first = new SubmitOutbox(store, scope);
    await first.enqueue(command());
    const reloaded = new SubmitOutbox(store, scope);
    const sent: Submit[] = [];
    await reloaded.replay(
      () => false,
      (item) => sent.push(item),
    );
    expect(sent).toEqual([]);
    await reloaded.replay(
      () => true,
      (item) => sent.push(item),
    );
    await reloaded.replay(
      () => true,
      (item) => sent.push(item),
    );
    expect(sent).toEqual([command()]);
    reloaded.newConnection();
    await reloaded.replay(
      () => true,
      (item) => sent.push(item),
    );
    expect(sent).toEqual([command(), command()]);
  });
  it("never leaks prompts between principals or rooms", async () => {
    const store = new MemoryStore();
    await new SubmitOutbox(store, scope).enqueue(command());
    for (const other of [
      { ...scope, principal: "bob@example.test" },
      { ...scope, roomId: "room-two" },
    ]) {
      const outbox = new SubmitOutbox(store, other);
      expect(await outbox.list()).toEqual([]);
      await outbox.acknowledge(command().id);
      expect(store.items).toHaveLength(1);
    }
  });
  it("removes acknowledged/confirmed-rejected submits and never replays them", async () => {
    const store = new MemoryStore();
    const outbox = new SubmitOutbox(store, scope);
    await outbox.enqueue(command());
    await outbox.acknowledge(command().id);
    outbox.newConnection();
    const sent: Submit[] = [];
    await outbox.replay(
      () => true,
      (item) => sent.push(item),
    );
    expect(sent).toEqual([]);
    expect(await outbox.list()).toEqual([]);
  });
  it("closes a replay gate immediately on disconnect and preserves original command IDs", async () => {
    const store = new MemoryStore();
    const outbox = new SubmitOutbox(store, scope);
    await outbox.enqueue(command());
    await outbox.enqueue(command("00000000-0000-4000-8000-000000000002"));
    let writable = true;
    const sent: Submit[] = [];
    await outbox.replay(
      () => writable,
      (item) => {
        sent.push(item);
        writable = false;
      },
    );
    expect(sent).toHaveLength(1);
    expect(store.items).toHaveLength(2);
    outbox.newConnection();
    await outbox.replay(
      () => true,
      (item) => sent.push(item),
    );
    expect(sent.map((item) => item.id)).toEqual([
      command().id,
      command().id,
      "00000000-0000-4000-8000-000000000002",
    ]);
  });
  it("does not lose a submit when a transport send fails", async () => {
    const store = new MemoryStore();
    const outbox = new SubmitOutbox(store, scope);
    await outbox.enqueue(command());
    await expect(
      outbox.replay(
        () => true,
        () => {
          throw new Error("closed");
        },
      ),
    ).rejects.toThrow("closed");
    const sent: Submit[] = [];
    await outbox.replay(
      () => true,
      (item) => sent.push(item),
    );
    expect(sent).toEqual([command()]);
  });
});
