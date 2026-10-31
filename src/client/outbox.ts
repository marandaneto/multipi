import { z } from "zod";
import type { Command } from "../shared/protocol";
export type Submit = Extract<Command, { type: "submit" }>;
export type Scope = { principal: string; roomId: string };
export type OutboxItem = Scope & { command: Submit; createdAt: number };
export interface OutboxStore {
  list(scope: Scope): Promise<OutboxItem[]>;
  put(item: OutboxItem): Promise<void>;
  remove(scope: Scope, id: string): Promise<void>;
}
const itemSchema = z
  .object({
    principal: z.string(),
    roomId: z.string(),
    createdAt: z.number(),
    command: z
      .object({
        type: z.literal("submit"),
        id: z.uuid(),
        text: z.string().trim().min(1).max(16384),
        mode: z.enum(["followUp", "steer"]),
      })
      .strict(),
  })
  .strict();
const key = (scope: Scope, id: string) => [scope.principal, scope.roomId, id];
export class IndexedOutbox implements OutboxStore {
  private database: Promise<IDBDatabase> | undefined;
  private open(): Promise<IDBDatabase> {
    return (this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("multipi-submit-outbox", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("submits", {
          keyPath: ["principal", "roomId", "command.id"],
        });
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () =>
        reject(request.error ?? new Error("Cannot open browser outbox"));
      request.onblocked = () =>
        reject(new Error("Outbox upgrade blocked; close other multipi tabs"));
    }));
  }
  private async transaction<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("submits", mode);
      const request = action(transaction.objectStore("submits"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Outbox transaction aborted"));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Outbox transaction failed"));
    });
  }
  async list(scope: Scope): Promise<OutboxItem[]> {
    const values: unknown[] = await this.transaction("readonly", (store) =>
      store.getAll(
        IDBKeyRange.bound(
          [scope.principal, scope.roomId, ""],
          [scope.principal, scope.roomId, "\uffff"],
        ),
      ),
    );
    return values
      .map((value) => itemSchema.parse(value))
      .filter(
        (item) =>
          item.principal === scope.principal && item.roomId === scope.roomId,
      )
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt || a.command.id.localeCompare(b.command.id),
      );
  }
  async put(item: OutboxItem): Promise<void> {
    await this.transaction("readwrite", (store) =>
      store.put(itemSchema.parse(item)),
    );
  }
  async remove(scope: Scope, id: string): Promise<void> {
    await this.transaction("readwrite", (store) =>
      store.delete(key(scope, id)),
    );
  }
}
export class SubmitOutbox {
  private sent = new Set<string>();
  constructor(
    readonly store: OutboxStore,
    readonly scope: Scope,
  ) {}
  newConnection(): void {
    this.sent.clear();
  }
  list(): Promise<OutboxItem[]> {
    return this.store.list(this.scope);
  }
  async enqueue(command: Submit): Promise<void> {
    await this.store.put({ ...this.scope, command, createdAt: Date.now() });
  }
  async acknowledge(id: string): Promise<void> {
    await this.store.remove(this.scope, id);
  }
  // The caller opens this gate only after BOTH authenticated room and Pi snapshots.
  async replay(
    syncedAndWritable: () => boolean,
    send: (command: Submit) => void,
  ): Promise<void> {
    for (const item of await this.list()) {
      if (!syncedAndWritable()) return;
      if (this.sent.has(item.command.id)) continue;
      this.sent.add(item.command.id);
      try {
        send(item.command);
      } catch (error) {
        this.sent.delete(item.command.id);
        throw error;
      }
    }
  }
}
