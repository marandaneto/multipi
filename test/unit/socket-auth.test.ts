import type { Connection } from "agents/lifecycle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  SOCKET_AUTHORIZATION_MS,
  SocketAuthorization,
} from "../../src/room/socket-auth";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
function socket() {
  return {
    state: {
      id: "alice@example.test",
      subject: "alice",
      expiresAt: Date.now() + 3_600_000,
      authorizedUntil: Date.now() + SOCKET_AUTHORIZATION_MS,
    },
    close: vi.fn(),
  } satisfies Pick<Connection, "state" | "close">;
}

it("closes an idle socket at the server lease deadline", async () => {
  expect(SOCKET_AUTHORIZATION_MS).toBe(60_000);
  const authorization = new SocketAuthorization();
  const connection = socket();
  authorization.watch(connection);
  await vi.advanceTimersByTimeAsync(SOCKET_AUTHORIZATION_MS - 1);
  expect(connection.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(connection.close).toHaveBeenCalledWith(
    4002,
    "Reconnect to authenticate",
  );
});
it("does not renew through resync or a reconstructed authorization manager", async () => {
  const original = new SocketAuthorization();
  const connection = socket();
  original.watch(connection);
  await vi.advanceTimersByTimeAsync(30_000);
  original.watch(connection);
  original.forget(connection);
  const resumed = new SocketAuthorization();
  resumed.watch(connection);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(connection.close).toHaveBeenCalledWith(
    4002,
    "Reconnect to authenticate",
  );
});
it("rejects expired persisted leases even when their timer never ran", () => {
  const connection = socket();
  vi.setSystemTime(Date.now() + SOCKET_AUTHORIZATION_MS);
  expect(() => new SocketAuthorization().identity(connection)).toThrow(
    "Reconnect",
  );
  expect(connection.close).toHaveBeenCalledWith(
    4002,
    "Reconnect to authenticate",
  );
});
it("requires a fresh handshake for legacy attachments", () => {
  const connection = {
    state: {
      id: "alice@example.test",
      subject: "alice",
      expiresAt: Date.now() + 10000,
    },
    close: vi.fn(),
  };
  expect(() => new SocketAuthorization().identity(connection)).toThrow(
    "Reconnect",
  );
  expect(connection.close).toHaveBeenCalledWith(
    4002,
    "Reconnect to authenticate",
  );
});
it("keeps the real JWT expiry and closes sooner when it expires first", async () => {
  const authorization = new SocketAuthorization();
  const connection = socket();
  connection.state.expiresAt = Date.now() + 500;
  expect(authorization.identity(connection).expiresAt).toBe(
    connection.state.expiresAt,
  );
  authorization.watch(connection);
  await vi.advanceTimersByTimeAsync(500);
  expect(connection.close).toHaveBeenCalledWith(
    4001,
    "Reconnect to authenticate",
  );
});
it("clears the timer when a socket disconnects", async () => {
  const authorization = new SocketAuthorization();
  const connection = socket();
  authorization.watch(connection);
  authorization.forget(connection);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(SOCKET_AUTHORIZATION_MS);
  expect(connection.close).not.toHaveBeenCalled();
});
