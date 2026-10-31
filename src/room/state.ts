import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineDocFamily,
  type Harness,
  type ContextEdit,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import {
  AppError,
  type ExecutionRecord,
  type Identity,
  type Role,
} from "../shared/protocol";

export type RoomMetadata = {
  id: string;
  title: string;
  repository: string;
  baseSha: string;
  owner: string;
  createdAt: string;
};
export type Checkpoint = {
  revision: number;
  backupKey: string;
  digest: string;
};
export type RoomData = {
  metadata: RoomMetadata | null;
  members: Record<string, Role>;
  mode:
    | "provisioning"
    | "ready"
    | "stopping"
    | "stopped"
    | "recovery"
    | "review"
    | "archived";
  checkpoint: Checkpoint | null;
  controlEpoch?: number;
  execution: {
    callId: string;
    beforeRevision: number;
    shell?: { command: string; startedAt: number; recorded?: boolean };
  } | null;
  diagnostic: string | null;
  restoreMode?:
    | "provisioning"
    | "ready"
    | "stopping"
    | "stopped"
    | "recovery"
    | "review"
    | "archived"
    | null;
  review: { id: string; revision: number; digest: string } | null;
  publishedHead: string | null;
  withdrawn?: {
    actor: string;
    text: string;
    operationId: string;
    reason: string;
  }[];
};
export const RoomDocument = defineDoc<RoomData>({
  kind: "multipi.room",
  version: 1,
  scope: "session",
  initial: () => ({
    metadata: null,
    members: {},
    mode: "provisioning",
    checkpoint: null,
    execution: null,
    diagnostic: null,
    review: null,
    publishedHead: null,
  }),
  checkpointWhen: () => true,
});
type Receipt = {
  actor: string;
  text: string | null;
  digest: string;
  operationId: string;
  state: "intent" | "accepted" | "done";
  result: string | null;
  stopRecorded?: boolean;
  controlEpoch?: number;
  withdrawal?: number;
  retryIssued?: boolean;
};
export const CommandDocument = defineDocFamily<Receipt, Receipt>({
  kind: "multipi.command",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  checkpointWhen: () => true,
});

export class RoomStore {
  constructor(readonly pi: Harness) {}
  async read(): Promise<Readonly<RoomData>> {
    return (
      (await this.pi.snapshot(RoomDocument, BACKGROUND_CONTEXT)) ??
      RoomDocument.definition.initial()
    );
  }
  async update<T>(change: (room: RoomData) => T | Promise<T>): Promise<T> {
    return this.pi.commit(
      async (tx) => change(await tx.doc(RoomDocument)),
      BACKGROUND_CONTEXT,
    );
  }
  async recordExecution(
    callId: string,
    result: Pick<ExecutionRecord, "outcome" | "exitCode" | "reason">,
    checkpoint?: Checkpoint,
  ) {
    const root = await this.pi.root(BACKGROUND_CONTEXT);
    await this.pi.commit(async (tx) => {
      const room = await tx.doc(RoomDocument);
      const execution = room.execution;
      if (!execution || execution.callId !== callId) {
        if (checkpoint) throw new AppError(409, "Execution was superseded");
        return;
      }
      if (checkpoint && execution.shell?.recorded)
        throw new AppError(409, "Execution was superseded");
      if (checkpoint) room.checkpoint = checkpoint;
      if (!execution.shell || execution.shell.recorded) return;
      await tx.appendEntry(root.id, {
        kind: "multipi.execution",
        data: {
          callId,
          command: execution.shell.command,
          startedAt: execution.shell.startedAt,
          observedAt: Date.now(),
          workspaceRevision: checkpoint?.revision ?? execution.beforeRevision,
          ...result,
        },
      });
      execution.shell.recorded = true;
    }, BACKGROUND_CONTEXT);
  }
  async omitStoppedInputs() {
    const stopped =
      (await this.read()).withdrawn?.filter(
        (item) => item.reason === "stopped",
      ) ?? [];
    if (!stopped.length) return;
    const root = await this.pi.root(BACKGROUND_CONTEXT);
    const context = await root.context(BACKGROUND_CONTEXT);
    const visible = new Set(
      context.entries
        .filter((_, index) =>
          context.contributions[index]?.some(
            (message) => message.role === "user",
          ),
        )
        .map((entry) => entry.id),
    );
    await this.pi.commit(async (tx) => {
      const edits: ContextEdit[] = [];
      for (const item of stopped) {
        const submission = await tx.submissionByRequest(
          root.id,
          item.operationId,
        );
        if (
          submission?.type === "input" &&
          submission.status === "unanswered" &&
          submission.entry !== undefined &&
          visible.has(submission.entry) &&
          !edits.some((edit) => edit.target === submission.entry)
        ) {
          edits.push({ target: submission.entry, action: "omit" });
        }
      }
      if (edits.length)
        await tx.appendEntry(root.id, {
          kind: "multipi.context",
          data: { reason: "stopped_inputs" },
          edits,
        });
    }, BACKGROUND_CONTEXT);
  }
  async recordInterruption(
    reason: Exclude<ExecutionRecord["reason"], "result">,
  ) {
    const execution = (await this.read()).execution;
    if (!execution?.shell || execution.shell.recorded) return;
    await this.recordExecution(execution.callId, {
      outcome: "interrupted",
      exitCode: null,
      reason,
    });
  }
  async initialize(metadata: RoomMetadata) {
    await this.update((room) => {
      if (room.metadata) throw new AppError(409, "Room already initialized");
      room.metadata = metadata;
      room.members[metadata.owner] = "owner";
    });
  }
  async authorize(identity: Identity, write = false) {
    const data = await this.read();
    const memberRole = authorizeData(data, identity);
    if (write && memberRole === "observer")
      throw new AppError(403, "Operator access required");
    return { data, role: memberRole };
  }
  async intent(
    key: string,
    actor: string,
    digest: string,
    operationId: string,
    text: string | null = null,
    controlEpoch?: number,
  ) {
    return this.pi.commit(async (tx) => {
      const record = await tx.doc(CommandDocument, key, {
        actor,
        text,
        digest,
        operationId,
        state: "intent",
        result: null,
        ...(controlEpoch === undefined ? {} : { controlEpoch }),
      });
      if (record.actor !== actor || record.digest !== digest)
        throw new AppError(409, "Command ID already has a different payload");
      return { ...record };
    }, BACKGROUND_CONTEXT);
  }
  getReceipt(key: string) {
    return this.pi.snapshot(CommandDocument, key, BACKGROUND_CONTEXT);
  }
  async receipt(
    key: string,
    result: JsonValue,
    state: "accepted" | "done",
    change?: (room: RoomData) => void,
  ) {
    await this.pi.commit(async (tx) => {
      const record = await tx.doc(CommandDocument, key, {
        actor: "",
        text: null,
        digest: "",
        operationId: "",
        state: "intent",
        result: null,
      });
      record.state = state;
      record.result = JSON.stringify(result);
      if (change) change(await tx.doc(RoomDocument));
    }, BACKGROUND_CONTEXT);
  }
}
export function authorizeData(
  data: Readonly<RoomData>,
  identity: Identity,
): Role {
  if (identity.expiresAt <= Date.now())
    throw new AppError(401, "Identity expired");
  if (!data.metadata) throw new AppError(404, "Room not found");
  const memberRole = Object.hasOwn(data.members, identity.id)
    ? data.members[identity.id]
    : undefined;
  if (!memberRole) throw new AppError(403, "Not a room member");
  return memberRole;
}
