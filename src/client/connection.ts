import { z } from "zod";
import type { Command, Identity } from "../shared/protocol";
import { emptyView, reduceView, type View } from "./projection";
import {
  SubmitOutbox,
  type OutboxItem,
  type OutboxStore,
  type Submit,
} from "./outbox";
import {
  errorText,
  projectionEvent,
  request,
  roomResponse,
  socketMessage,
  type RoomEnvelope,
} from "./wire";

export type ConnectionState = {
  room: RoomEnvelope | null;
  view: View;
  presence: string[];
  synced: boolean;
  status: string;
  error: string | null;
  outbox: OutboxItem[];
};
type Control = Exclude<Command, { type: "submit" | "resync" }>;
const controlLabels = {
  stop: "Stop",
  resume: "Restore",
  retry: "Retry",
  withdraw: "Withdrawal",
};
const eventTypes = new Set<string>(
  projectionEvent.options.map((option) => option.shape.type.value),
);
export function canOperate(state: ConnectionState): boolean {
  return (
    state.synced &&
    !!state.room &&
    state.room.identity.expiresAt > Date.now() &&
    (state.room.role === "owner" || state.room.role === "operator") &&
    ["ready", "stopping", "stopped", "recovery", "review"].includes(
      state.room.room.mode,
    )
  );
}
export function canArchive(state: ConnectionState): boolean {
  return (
    state.room?.role === "owner" &&
    (canOperate(state) ||
      (state.synced &&
        state.room.identity.expiresAt > Date.now() &&
        state.room.room.mode === "provisioning"))
  );
}
export class RoomConnection {
  private state: ConnectionState = {
    room: null,
    view: emptyView,
    presence: [],
    synced: false,
    status: "Loading room",
    error: null,
    outbox: [],
  };
  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private abort = new AbortController();
  private stopped = false;
  private roomSynced = false;
  private piSynced = false;
  private attempts = 0;
  private generation = 0;
  private outbox: SubmitOutbox;
  private confirmations = new Map<
    string,
    {
      type: Control["type"];
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    readonly roomId: string,
    readonly identity: Identity,
    store: OutboxStore,
  ) {
    this.outbox = new SubmitOutbox(store, { principal: identity.id, roomId });
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): ConnectionState => this.state;
  private update(change: Partial<ConnectionState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...change };
    this.listeners.forEach((listener) => listener());
  }
  private validateIdentity(envelope: RoomEnvelope): void {
    if (
      envelope.identity.id !== this.identity.id ||
      envelope.identity.expiresAt <= Date.now() ||
      envelope.room.metadata?.id !== this.roomId ||
      envelope.room.members[this.identity.id] !== envelope.role
    )
      throw new Error(
        "Room identity or membership changed; reload to authenticate again",
      );
  }
  private async refreshOutbox(): Promise<void> {
    this.update({ outbox: await this.outbox.list() });
  }
  async start(): Promise<void> {
    try {
      const room = await request(
        `/api/rooms/${this.roomId}`,
        roomResponse,
        "GET",
        undefined,
        this.abort.signal,
      );
      if (this.stopped) return;
      this.validateIdentity(room);
      this.update({ room });
      await this.refreshOutbox();
      if (this.stopped) return;
      const remaining =
        Math.min(this.identity.expiresAt, room.identity.expiresAt) - Date.now();
      this.expiryTimer = setTimeout(
        () => {
          this.update({
            synced: false,
            status: "Authentication expired; reload to sign in",
          });
          this.closeTransport();
        },
        Math.max(0, Math.min(remaining, 2147483647)),
      );
      this.connect();
    } catch (error) {
      this.update({ error: errorText(error), status: "Unable to load room" });
    }
  }
  private settleControl(id: string, error?: Error): void {
    const confirmation = this.confirmations.get(id);
    if (!confirmation) return;
    this.confirmations.delete(id);
    clearTimeout(confirmation.timer);
    if (error) confirmation.reject(error);
    else confirmation.resolve();
  }
  private unconfirm(id: string): void {
    const confirmation = this.confirmations.get(id);
    if (confirmation)
      this.settleControl(
        id,
        new Error(
          `${controlLabels[confirmation.type]} outcome unconfirmed; check room state before trying again`,
        ),
      );
  }
  private loseConfirmations(): void {
    for (const id of this.confirmations.keys()) this.unconfirm(id);
  }
  private closeTransport(): void {
    this.loseConfirmations();
    clearTimeout(this.retryTimer);
    clearTimeout(this.syncTimer);
    this.generation++;
    this.socket?.close();
    this.socket = null;
  }
  stop(): void {
    this.stopped = true;
    this.abort.abort();
    this.closeTransport();
    clearTimeout(this.expiryTimer);
  }
  private connect(): void {
    if (this.stopped || this.identity.expiresAt <= Date.now()) return;
    this.roomSynced = false;
    this.piSynced = false;
    this.outbox.newConnection();
    this.update({
      synced: false,
      status: "Connecting · waiting for snapshots",
      error: null,
    });
    const generation = ++this.generation;
    const url = new URL(`/api/rooms/${this.roomId}/socket`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    const active = () =>
      !this.stopped && this.generation === generation && this.socket === socket;
    this.syncTimer = setTimeout(() => {
      if (active()) {
        this.update({ error: "Snapshot connection timed out" });
        socket.close();
      }
    }, 15000);
    socket.onmessage = (event) => {
      if (!active() || typeof event.data !== "string") return;
      try {
        const raw: unknown = JSON.parse(event.data);
        const message = socketMessage.parse(raw);
        if (message.type === "room") {
          this.validateIdentity(message);
          this.roomSynced = true;
          this.update({ room: message, presence: message.presence });
        } else if (message.type === "pi") {
          for (const rawEvent of message.events) {
            const parsed = projectionEvent.safeParse(rawEvent);
            if (!parsed.success) {
              const tag = z.object({ type: z.string() }).safeParse(rawEvent);
              if (tag.success && !eventTypes.has(tag.data.type)) continue;
              throw new Error(
                "Invalid agent event; reconnect for a fresh snapshot",
              );
            }
            if (parsed.data.type === "snapshot") this.piSynced = true;
            if (this.piSynced)
              this.update({ view: reduceView(this.state.view, parsed.data) });
          }
        } else if (message.type === "result") {
          this.settleControl(message.id);
          void this.outbox
            .acknowledge(message.id)
            .then(() => this.refreshOutbox())
            .catch((error) =>
              this.update({ error: errorText(error), synced: false }),
            );
        } else {
          if (message.id)
            this.settleControl(message.id, new Error(message.message));
          this.update({ error: message.message });
          if (message.id && message.status < 500)
            void this.outbox
              .acknowledge(message.id)
              .then(() => this.refreshOutbox())
              .catch((error) =>
                this.update({ error: errorText(error), synced: false }),
              );
          if (message.status === 401 || message.status === 403) {
            this.update({
              synced: false,
              status: "Access denied; reload to authenticate",
            });
            this.closeTransport();
            return;
          }
        }
        if (this.roomSynced && this.piSynced) {
          this.attempts = 0;
          clearTimeout(this.syncTimer);
          this.update({ synced: true, status: "Connected · synchronized" });
          void this.outbox
            .replay(
              () =>
                active() &&
                canOperate(this.state) &&
                this.state.room?.room.mode === "ready",
              (command) => socket.send(JSON.stringify(command)),
            )
            .catch((error) =>
              this.update({ error: errorText(error), synced: false }),
            );
        }
      } catch (error) {
        this.update({ error: errorText(error), synced: false });
        socket.close();
      }
    };
    socket.onerror = () => {
      if (active()) this.update({ error: "Socket connection failed" });
    };
    socket.onclose = (event) => {
      if (!active()) return;
      this.loseConfirmations();
      clearTimeout(this.syncTimer);
      this.update({
        synced: false,
        status: "Disconnected · work continues on the server",
      });
      if ([1008, 4001, 4003, 4401, 4403].includes(event.code)) {
        this.update({ status: "Access denied; reload to authenticate" });
        return;
      }
      if (this.attempts >= 6) {
        this.update({ status: "Reconnect limit reached · use Reconnect" });
        return;
      }
      const delay = Math.min(1000 * 2 ** this.attempts++, 15000);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }
  async submit(text: string, mode: Submit["mode"]): Promise<void> {
    if (!canOperate(this.state) || this.state.room?.room.mode !== "ready")
      throw new Error("Wait for a writable, synchronized room");
    const command: Submit = {
      type: "submit",
      id: crypto.randomUUID(),
      text: text.trim(),
      mode,
    };
    if (!command.text || command.text.length > 16384)
      throw new Error("Prompt must contain 1–16,384 characters");
    await this.outbox.enqueue(command);
    await this.refreshOutbox();
    const socket = this.socket;
    const generation = this.generation;
    if (socket)
      await this.outbox.replay(
        () =>
          !this.stopped &&
          generation === this.generation &&
          socket.readyState === WebSocket.OPEN &&
          canOperate(this.state) &&
          this.state.room?.room.mode === "ready",
        (item) => socket.send(JSON.stringify(item)),
      );
  }
  send(command: Control): Promise<void> {
    if (
      !canOperate(this.state) ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    )
      throw new Error("Wait for a writable, synchronized room");
    if (this.confirmations.has(command.id))
      throw new Error("Control is already awaiting confirmation");
    const confirmation = Promise.withResolvers<void>();
    this.confirmations.set(command.id, {
      ...confirmation,
      type: command.type,
      timer: setTimeout(() => this.unconfirm(command.id), 30000),
    });
    try {
      this.socket.send(JSON.stringify(command));
    } catch {
      this.unconfirm(command.id);
    }
    return confirmation.promise;
  }
  async discard(id: string): Promise<void> {
    await this.outbox.acknowledge(id);
    await this.refreshOutbox();
  }
}
