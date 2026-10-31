import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomConnection, canArchive, canOperate } from "./connection";
import type { OutboxItem, OutboxStore, Scope } from "./outbox";
const roomId = "00000000-0000-4000-8000-000000000010";
const identity = {
  id: "alice@example.test",
  subject: "alice",
  expiresAt: Date.now() + 3600000,
};
function envelope(role = "operator", mode = "ready") {
  return {
    room: {
      metadata: {
        id: roomId,
        title: "Demo",
        repository: "org/repo",
        baseSha: "a".repeat(40),
        owner: "owner@example.test",
        createdAt: "2026-01-01",
      },
      members: { [identity.id]: role },
      mode,
      checkpoint: { revision: 1, backupKey: "backup", digest: "d" },
      execution: null,
      diagnostic: null,
      review: null,
      publishedHead: null,
    },
    role,
    identity,
    pending: [],
  };
}
const piSnapshot = {
  type: "pi",
  events: [
    {
      type: "snapshot",
      entries: [],
      tools: [],
      nestedTools: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    },
  ],
};
class MemoryStore implements OutboxStore {
  items: OutboxItem[] = [
    {
      principal: identity.id,
      roomId,
      command: {
        type: "submit",
        id: "00000000-0000-4000-8000-000000000001",
        text: "pending",
        mode: "followUp",
      },
      createdAt: 1,
    },
  ];
  async list(scope: Scope) {
    return this.items.filter(
      (item) =>
        item.principal === scope.principal && item.roomId === scope.roomId,
    );
  }
  async put(item: OutboxItem) {
    this.items.push(item);
  }
  async remove(_scope: Scope, id: string) {
    this.items = this.items.filter((item) => item.command.id !== id);
  }
}
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: URL) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    const value: unknown = JSON.parse(data);
    this.sent.push(value);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
const settle = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
let connection: RoomConnection | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", new URL("https://example.test/#/rooms/test"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(envelope()))),
  );
});
afterEach(() => {
  connection?.stop();
  connection = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function start() {
  const store = new MemoryStore();
  connection = new RoomConnection(roomId, identity, store);
  await connection.start();
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("No socket");
  socket.onopen?.();
  return { connection, socket, store };
}
describe("client/connection", () => {
  it("allows only a synchronized unexpired owner to archive provisioning without enabling model commands", async () => {
    const { connection, socket } = await start();
    expect(canArchive(connection.getSnapshot())).toBe(false);
    socket.receive(piSnapshot);
    socket.receive({
      type: "room",
      ...envelope("owner", "provisioning"),
      presence: [],
    });
    expect(canArchive(connection.getSnapshot())).toBe(true);
    expect(canOperate(connection.getSnapshot())).toBe(false);
    const current = connection.getSnapshot();
    if (!current.room) throw new Error("Room snapshot required");
    expect(
      canArchive({
        ...current,
        room: {
          ...current.room,
          identity: { ...identity, expiresAt: Date.now() - 1 },
        },
      }),
    ).toBe(false);
    for (const role of ["operator", "observer"]) {
      socket.receive({
        type: "room",
        ...envelope(role, "provisioning"),
        presence: [],
      });
      expect(canArchive(connection.getSnapshot())).toBe(false);
    }
    socket.receive({
      type: "room",
      ...envelope("owner", "archived"),
      presence: [],
    });
    expect(canArchive(connection.getSnapshot())).toBe(false);
  });
  it("requires both fresh snapshots, then replays only submits once per connection", async () => {
    const { connection, socket } = await start();
    expect(socket.url.href).toBe(
      `wss://example.test/api/rooms/${roomId}/socket`,
    );
    expect(() =>
      connection.send({ type: "stop", id: crypto.randomUUID() }),
    ).toThrow("synchronized");
    socket.receive(piSnapshot);
    await settle();
    expect(socket.sent).toEqual([]);
    socket.receive({ type: "room", ...envelope(), presence: [identity.id] });
    await settle();
    expect(connection.getSnapshot().synced).toBe(true);
    expect(socket.sent).toHaveLength(1);
    socket.receive({ type: "room", ...envelope(), presence: [] });
    await settle();
    expect(socket.sent).toHaveLength(1);
    const confirmation = expect(
      connection.send({ type: "stop", id: crypto.randomUUID() }),
    ).rejects.toThrow("Stop outcome unconfirmed");
    expect(socket.sent).toHaveLength(2);
    socket.close();
    await confirmation;
    expect(connection.getSnapshot().synced).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.instances.at(-1);
    if (!next || next === socket) throw new Error("No reconnect");
    next.onopen?.();
    next.receive({ type: "room", ...envelope(), presence: [] });
    await settle();
    expect(next.sent).toEqual([]);
    next.receive(piSnapshot);
    await settle();
    expect(next.sent).toHaveLength(1);
    expect(next.sent[0]).toMatchObject({
      type: "submit",
      id: "00000000-0000-4000-8000-000000000001",
    });
  });
  it("does not replay to observers or while stopped, but resumes when ready", async () => {
    const { connection, socket } = await start();
    socket.receive({ type: "room", ...envelope("observer"), presence: [] });
    socket.receive(piSnapshot);
    await settle();
    expect(socket.sent).toHaveLength(0);
    await expect(connection.submit("no", "steer")).rejects.toThrow("writable");
    socket.receive({
      type: "room",
      ...envelope("operator", "stopped"),
      presence: [],
    });
    await settle();
    expect(socket.sent).toHaveLength(0);
    socket.receive({ type: "room", ...envelope(), presence: [] });
    await settle();
    expect(socket.sent).toHaveLength(1);
  });
  it("removes results and confirmed application errors, but not uncertain disconnects", async () => {
    const { socket, store } = await start();
    const id = store.items[0]?.command.id;
    socket.receive({ type: "room", ...envelope(), presence: [] });
    socket.receive(piSnapshot);
    await settle();
    socket.receive({
      type: "error",
      id,
      status: 503,
      message: "Outcome uncertain",
    });
    await settle();
    expect(store.items).toHaveLength(1);
    socket.receive({ type: "error", id, status: 409, message: "Queue full" });
    await settle();
    expect(store.items).toEqual([]);
    store.items.push({
      principal: identity.id,
      roomId,
      command: {
        type: "submit",
        id: crypto.randomUUID(),
        text: "next",
        mode: "steer",
      },
      createdAt: 2,
    });
    socket.receive({
      type: "result",
      id: store.items[0]?.command.id,
      result: { accepted: true },
    });
    await settle();
    expect(store.items).toEqual([]);
  });
  it("fails closed on unknown roles/modes and never trusts a principal switch", async () => {
    const { connection, socket } = await start();
    socket.receive({ type: "room", ...envelope("admin"), presence: [] });
    await settle();
    expect(connection.getSnapshot().synced).toBe(false);
    expect(socket.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.instances.at(-1);
    if (!next) throw new Error("No socket");
    next.receive({
      type: "room",
      ...envelope("operator", "future-mode"),
      presence: [],
    });
    expect(connection.getSnapshot().synced).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    const third = FakeSocket.instances.at(-1);
    if (!third) throw new Error("No socket");
    third.receive({
      type: "room",
      ...envelope(),
      identity: { ...identity, id: "bob@example.test" },
      presence: [],
    });
    expect(connection.getSnapshot().synced).toBe(false);
  });
  it("bounds reconnect attempts and cleans up every timer on unmount", async () => {
    const { connection } = await start();
    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000, 30000]) {
      FakeSocket.instances.at(-1)?.close();
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(FakeSocket.instances).toHaveLength(7);
    expect(connection.getSnapshot().status).toContain("Reconnect limit");
    connection.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("renews healthy authorization leases beyond the consecutive retry limit", async () => {
    const { connection, store } = await start();
    for (let index = 0; index < 8; index++) {
      const socket = FakeSocket.instances.at(-1)!;
      socket.receive({ type: "room", ...envelope(), presence: [] });
      socket.receive(piSnapshot);
      await settle();
      expect(connection.getSnapshot().synced).toBe(true);
      expect(socket.sent).toHaveLength(1);
      expect(socket.sent[0]).toMatchObject({ type: "submit" });
      const confirmation = expect(
        connection.send({ type: "stop", id: crypto.randomUUID() }),
      ).rejects.toThrow("Stop outcome unconfirmed");
      socket.close(4002);
      await confirmation;
      expect(connection.getSnapshot().synced).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      const next = FakeSocket.instances.at(-1)!;
      expect(next).not.toBe(socket);
      expect(next.sent).toEqual([]);
    }
    expect(store.items).toHaveLength(1);
  });
  it("only confirms the matching control, and never persists it as a submit", async () => {
    const { connection, socket, store } = await start();
    socket.receive({ type: "room", ...envelope(), presence: [] });
    socket.receive(piSnapshot);
    await settle();
    const id = crypto.randomUUID();
    let confirmed = false;
    const completion = connection.send({ type: "resume", id }).then(() => {
      confirmed = true;
    });
    expect(() => connection.send({ type: "resume", id })).toThrow(
      "awaiting confirmation",
    );
    socket.receive({
      type: "result",
      id: crypto.randomUUID(),
      result: { ok: true },
    });
    await settle();
    expect(confirmed).toBe(false);
    socket.receive({ type: "result", id, result: { ok: true } });
    await completion;
    expect(confirmed).toBe(true);
    expect(store.items.every((item) => item.command.type === "submit")).toBe(
      true,
    );
    connection.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([409, 503])(
    "reports the server's explicit %s control error",
    async (status) => {
      const { connection, socket } = await start();
      socket.receive({ type: "room", ...envelope(), presence: [] });
      socket.receive(piSnapshot);
      await settle();
      const id = crypto.randomUUID();
      const failed = expect(
        connection.send({ type: "withdraw", id, operationId: "queued" }),
      ).rejects.toThrow("Control failed");
      socket.receive({ type: "error", id, status, message: "Control failed" });
      await failed;
      connection.stop();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("bounds confirmation wait without replaying or cancelling server work", async () => {
    const { connection, socket } = await start();
    socket.receive({ type: "room", ...envelope(), presence: [] });
    socket.receive(piSnapshot);
    await settle();
    const id = crypto.randomUUID();
    const unknown = expect(
      connection.send({ type: "resume", id }),
    ).rejects.toThrow(
      "Restore outcome unconfirmed; check room state before trying again",
    );
    await vi.advanceTimersByTimeAsync(30001);
    await unknown;
    expect(
      socket.sent.filter(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "resume",
      ),
    ).toHaveLength(1);
    expect(socket.readyState).toBe(1);
    socket.receive({ type: "result", id, result: { ok: true } });
    connection.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports uncertainty if an open socket throws during a control send and releases the confirmation timer", async () => {
    const { connection, socket } = await start();
    socket.receive({ type: "room", ...envelope(), presence: [] });
    socket.receive(piSnapshot);
    await settle();
    vi.spyOn(socket, "send").mockImplementationOnce(() => {
      throw new Error("fixture send failure");
    });
    await expect(
      connection.send({ type: "resume", id: crypto.randomUUID() }),
    ).rejects.toThrow("Restore outcome unconfirmed");
    connection.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports unconfirmed controls and clears their timer when the view is disposed", async () => {
    const { connection, socket } = await start();
    socket.receive({ type: "room", ...envelope(), presence: [] });
    socket.receive(piSnapshot);
    await settle();
    const failed = expect(
      connection.send({ type: "retry", id: crypto.randomUUID() }),
    ).rejects.toThrow("Retry outcome unconfirmed");
    connection.stop();
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("revocation errors stop reconnect and disable controls", async () => {
    const { connection, socket } = await start();
    socket.receive({ type: "room", ...envelope(), presence: [] });
    socket.receive(piSnapshot);
    await settle();
    socket.receive({
      type: "error",
      status: 403,
      message: "Membership removed",
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(connection.getSnapshot().synced).toBe(false);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
