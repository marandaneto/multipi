import type { Connection } from "agents/lifecycle";
import { z } from "zod";
import { AppError, type Identity } from "../shared/protocol";

export const SOCKET_AUTHORIZATION_MS = 60_000;
export const identitySchema = z.object({
  id: z.email(),
  subject: z.string(),
  expiresAt: z.number(),
});
const socketState = identitySchema.extend({ authorizedUntil: z.number() });
type Socket = Pick<Connection, "state" | "close">;

export class SocketAuthorization {
  private readonly timers = new Map<Socket, ReturnType<typeof setTimeout>>();

  identity(socket: Socket): Identity {
    const state = socketState.safeParse(socket.state);
    if (!state.success) this.reject(socket, 4002);
    const { id, subject, expiresAt, authorizedUntil } = state.data;
    if (expiresAt <= Date.now()) this.reject(socket, 4001);
    if (authorizedUntil <= Date.now()) this.reject(socket, 4002);
    return { id, subject, expiresAt };
  }

  watch(socket: Socket): void {
    this.forget(socket);
    const identity = this.identity(socket);
    const { authorizedUntil } = socketState.parse(socket.state);
    this.timers.set(
      socket,
      setTimeout(
        () => {
          this.forget(socket);
          socket.close(
            identity.expiresAt <= Date.now() ? 4001 : 4002,
            "Reconnect to authenticate",
          );
        },
        Math.max(0, Math.min(identity.expiresAt, authorizedUntil) - Date.now()),
      ),
    );
  }

  forget(socket: Socket): void {
    clearTimeout(this.timers.get(socket));
    this.timers.delete(socket);
  }

  private reject(socket: Socket, code: number): never {
    this.forget(socket);
    socket.close(code, "Reconnect to authenticate");
    throw new AppError(401, "Reconnect to authenticate");
  }
}
