import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiHarness } from "agents/harness/pi";
import {
  AppError,
  canonicalCommand,
  digest,
  requireOwner,
  type Command,
  type Identity,
} from "../shared/protocol";
import {
  authorizeData,
  CommandDocument,
  RoomDocument,
  type Checkpoint,
  type RoomMetadata,
  RoomStore,
} from "./state";

export type WorkspaceReview = {
  revision: number;
  digest: string;
  patch: string;
  files: { path: string; status: string }[];
};
export interface WorkspacePort {
  initialize(metadata: RoomMetadata): Promise<Checkpoint>;
  checkpoint(callId: string): Promise<Checkpoint>;
  restore(checkpoint: Checkpoint): Promise<void>;
  stop(): Promise<void>;
  review(baseSha: string, checkpoint: Checkpoint): Promise<WorkspaceReview>;
}
type Agent = Pick<PiHarness, "submit" | "abort" | "retry" | "pending"> & {
  busy(): Promise<boolean>;
};

export class RoomControl {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly store: RoomStore,
    readonly agent: Agent,
    readonly workspace: WorkspacePort,
    readonly changed: () => Promise<void>,
    readonly mayLeaveReview: () => Promise<void> = async () => {},
  ) {}
  serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async initialize(metadata: RoomMetadata) {
    await this.store.initialize(metadata);
    try {
      const checkpoint = await this.workspace.initialize(metadata);
      await this.store.update((room) => {
        if (room.mode !== "provisioning")
          throw new AppError(409, "Workspace preparation was cancelled");
        room.checkpoint = checkpoint;
        room.mode = "ready";
        room.diagnostic = null;
      });
    } catch {
      await this.workspace.stop().catch(() => undefined);
      await this.store.update((room) => {
        if (room.mode === "provisioning") {
          room.mode = "recovery";
          room.diagnostic = "Workspace initialization failed";
        }
      });
      throw new AppError(503, "Workspace initialization failed");
    }
  }
  async dispatch(
    identity: Identity,
    input: Exclude<Command, { type: "resync" }>,
    validateConnection: () => void = () => {},
  ) {
    return this.serialize(async () => {
      validateConnection();
      const { data, role } = await this.store.authorize(identity, true);
      if (data.mode === "archived") throw new AppError(409, "Room archived");
      const operationId = await digest(
        `${data.metadata!.id}:${identity.id}:${input.id}`,
      );
      const payloadDigest = await digest(canonicalCommand(input));
      const receipt = await this.store.intent(
        operationId,
        identity.id,
        payloadDigest,
        operationId,
        input.type === "submit" ? input.text : null,
        data.controlEpoch ?? 0,
      );
      if (receipt.state !== "intent") return JSON.parse(receipt.result!);
      if (
        ["stop", "resume", "retry"].includes(input.type) &&
        receipt.controlEpoch !== (data.controlEpoch ?? 0)
      )
        throw new AppError(
          409,
          "Control belongs to an earlier recovery state; use a new command",
        );

      switch (input.type) {
        case "submit": {
          if (data.mode !== "ready")
            throw new AppError(
              409,
              "Room is not ready to run; recover or exit review first",
            );
          const pending = await this.agent.pending();
          if (pending.length >= 20)
            throw new AppError(429, "Room input queue is full");
          const result = await this.agent.submit(
            `[${identity.id}] ${input.text}`,
            {
              operationId,
              whenBusy: input.mode,
              entry: {
                kind: "multipi.input",
                data: {
                  actor: identity.id,
                  commandId: input.id,
                  mode: input.mode,
                  text: input.text,
                },
              },
            },
          );
          await this.store.receipt(operationId, { ...result }, "accepted");
          await this.changed();
          return result;
        }
        case "withdraw": {
          const original = await this.store.getReceipt(input.operationId);
          if (!original || (original.actor !== identity.id && role !== "owner"))
            throw new AppError(403, "Cannot withdraw another operator's input");
          const root = await this.store.pi.root(BACKGROUND_CONTEXT);
          const record = await this.store.pi.commit(
            (tx) => tx.submissionByRequest(root.id, input.operationId),
            BACKGROUND_CONTEXT,
          );
          if (!record || record.type !== "input")
            throw new AppError(409, "Input is no longer queued");
          if (receipt.withdrawal === undefined) {
            if (record.status !== "queued")
              throw new AppError(409, "Input is no longer queued");
            await this.store.pi.commit(async (tx) => {
              (await tx.doc(CommandDocument, operationId, receipt)).withdrawal =
                record.id;
            }, BACKGROUND_CONTEXT);
          } else if (receipt.withdrawal !== record.id)
            throw new AppError(409, "Withdrawal target changed");
          const aborted = await this.store.pi.abortSubmission(
            record.id,
            BACKGROUND_CONTEXT,
          );
          if (aborted !== "aborted") {
            const settled = await this.store.pi.commit(
              (tx) => tx.submissionByRequest(root.id, input.operationId),
              BACKGROUND_CONTEXT,
            );
            if (
              aborted !== "settled" ||
              settled?.type !== "input" ||
              settled.status !== "unanswered" ||
              settled.reason !== "aborted"
            )
              throw new AppError(409, "Input is no longer queued");
          }
          const result = { ok: true };
          await this.store.receipt(operationId, result, "done", (room) => {
            if (
              original.text &&
              !room.withdrawn?.some(
                (item) => item.operationId === input.operationId,
              )
            )
              room.withdrawn = [
                ...(room.withdrawn ?? []),
                {
                  actor: original.actor,
                  text: original.text,
                  operationId: input.operationId,
                  reason: "withdrawn",
                },
              ].slice(-20);
          });
          await this.changed();
          return result;
        }
        case "stop":
          await this.mayLeaveReview();
          const stopped = await this.pendingNotes("stopped");
          const root = await this.store.pi.root(BACKGROUND_CONTEXT);
          await this.store.pi.commit(async (tx) => {
            const room = await tx.doc(RoomDocument);
            const record = await tx.doc(CommandDocument, operationId, receipt);
            room.mode = "stopping";
            room.withdrawn = [...(room.withdrawn ?? []), ...stopped].slice(-20);
            if (!record.stopRecorded) {
              const observedAt = Date.now();
              await tx.appendEntry(root.id, {
                kind: "multipi.control",
                data: {
                  actor: identity.id,
                  commandId: input.id,
                  action: "stop",
                  observedAt,
                },
              });
              record.stopRecorded = true;
            }
          }, BACKGROUND_CONTEXT);
          await this.changed();
          try {
            await Promise.all([this.agent.abort(), this.workspace.stop()]);
            await this.store.omitStoppedInputs();
            await this.store.recordInterruption("stop");
            await this.store.receipt(
              operationId,
              { ok: true },
              "done",
              (room) => {
                room.mode = "stopped";
                room.execution = null;
              },
            );
          } catch {
            await this.store.recordInterruption("stop");
            await this.store.update((room) => {
              room.mode = "recovery";
              room.diagnostic = "Stop needs workspace recovery";
            });
            await this.changed();
            throw new AppError(503, "Stop needs workspace recovery");
          }
          await this.changed();
          return { ok: true };
        case "resume":
          if (!["stopped", "recovery"].includes(data.mode) || !data.checkpoint)
            throw new AppError(409, "No restorable checkpoint");
          await this.agent.abort();
          await this.store.omitStoppedInputs();
          await this.store.recordInterruption("restore");
          try {
            await this.store.update((room) => {
              room.mode = "recovery";
            });
            await this.workspace.restore(data.checkpoint);
          } catch {
            await this.store.update((room) => {
              room.mode = "recovery";
              room.diagnostic = "Workspace restore failed";
            });
            await this.changed();
            throw new AppError(
              503,
              "Workspace restore failed; execution remains blocked",
            );
          }
          await this.store.receipt(
            operationId,
            { ok: true },
            "done",
            (room) => {
              room.mode = "ready";
              room.execution = null;
              room.diagnostic = null;
              room.controlEpoch = (room.controlEpoch ?? 0) + 1;
            },
          );
          await this.changed();
          return { ok: true };
        case "retry":
          if (data.mode !== "ready")
            throw new AppError(409, "Recover the workspace before retrying");
          if (receipt.retryIssued)
            throw new AppError(
              409,
              "Retry outcome unconfirmed; inspect parked work and use a new command",
            );
          await this.store.pi.commit(async (tx) => {
            (await tx.doc(CommandDocument, operationId, receipt)).retryIssued =
              true;
          }, BACKGROUND_CONTEXT);
          await this.agent.retry();
          break;
      }
      const result = { ok: true };
      await this.store.receipt(operationId, result, "done");
      await this.changed();
      return result;
    });
  }

  private async pendingNotes(reason: string) {
    const notes = [];
    for (const pending of await this.agent.pending()) {
      const receipt = await this.store.getReceipt(pending.operationId);
      if (receipt?.text)
        notes.push({
          actor: receipt.actor,
          text: receipt.text,
          operationId: pending.operationId,
          reason,
        });
    }
    return notes;
  }
  async membership(
    identity: Identity,
    principal: string,
    role: "operator" | "observer" | null,
    allowed: () => void,
  ) {
    return this.serialize(async () => {
      await this.store.update((room) => {
        requireOwner(authorizeData(room, identity));
        if (principal === room.metadata?.owner)
          throw new AppError(409, "Cannot remove or demote the owner");
        if (role) {
          allowed();
          room.members[principal] = role;
        } else delete room.members[principal];
        if (Object.keys(room.members).length > 100)
          throw new AppError(409, "Room membership limit reached");
      });
      await this.changed();
    });
  }
  async archive(identity: Identity) {
    return this.serialize(async () => {
      const { data, role } = await this.store.authorize(identity);
      requireOwner(role);
      if (data.mode === "archived") return;
      await this.mayLeaveReview();
      const stopped = await this.pendingNotes("archived");
      await this.store.update((room) => {
        room.mode = "stopping";
        room.withdrawn = [...(room.withdrawn ?? []), ...stopped].slice(-20);
      });
      try {
        await Promise.all([this.agent.abort(), this.workspace.stop()]);
        await this.store.recordInterruption("archive");
      } catch {
        await this.store.recordInterruption("archive");
        await this.store.update((room) => {
          room.mode = "recovery";
          room.diagnostic = "Archive needs workspace recovery";
        });
        await this.changed();
        throw new AppError(503, "Archive needs workspace recovery");
      }
      await this.store.update((room) => {
        room.mode = "archived";
        room.execution = null;
      });
      await this.changed();
    });
  }
  async prepareReview(identity: Identity) {
    return this.serialize(async () => {
      const { data } = await this.store.authorize(identity, true);
      if (data.mode !== "ready" || !data.checkpoint || !data.metadata)
        throw new AppError(409, "Workspace is not ready for review");
      if (await this.agent.busy())
        throw new AppError(409, "Stop or finish the agent before review");
      await this.store.update((room) => {
        room.mode = "review";
      });
      await this.changed();
      try {
        const review = await this.workspace.review(
          data.metadata.baseSha,
          data.checkpoint,
        );
        const id = crypto.randomUUID();
        await this.store.update((room) => {
          room.review = {
            id,
            revision: review.revision,
            digest: review.digest,
          };
        });
        await this.changed();
        return { ...review, id };
      } catch {
        await this.store.update((room) => {
          room.mode = "recovery";
          room.diagnostic = "Review failed; restore workspace";
        });
        await this.changed();
        throw new AppError(503, "Review failed");
      }
    });
  }
  async exitReview(identity: Identity) {
    return this.serialize(async () => {
      const { data } = await this.store.authorize(identity, true);
      if (data.mode !== "review") throw new AppError(409, "Not reviewing");
      await this.mayLeaveReview();
      await this.store.update((room) => {
        room.mode = "ready";
        room.review = null;
      });
      await this.changed();
    });
  }
}
