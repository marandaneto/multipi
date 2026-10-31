import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import type { PiPendingOperation } from "agents/harness/pi";
import { describe, expect, it, vi } from "vitest";
import { RoomControl, type WorkspacePort } from "../../src/room/control";
import { RoomStore } from "../../src/room/state";
import { canonicalCommand, digest } from "../../src/shared/protocol";

async function fixture(
  modelFixture?: ReturnType<typeof fauxProvider>,
  initialize = true,
) {
  const models = createModels();
  if (modelFixture) models.setProvider(modelFixture.provider);
  const pi = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  if (modelFixture) {
    const model = modelFixture.getModel();
    await pi.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
  }
  const store = new RoomStore(pi);
  const checkpoint = { revision: 1, backupKey: "backup-1", digest: "d" };
  const workspace: WorkspacePort = {
    initialize: vi.fn(async () => checkpoint),
    checkpoint: vi.fn(async () => checkpoint),
    stop: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
    review: vi.fn(async () => ({
      revision: 1,
      digest: "d",
      patch: "patch",
      files: [],
    })),
  };
  const submit = vi.fn(
    async (_input: unknown, options?: { operationId?: string }) => ({
      operationId: options?.operationId ?? "",
      session: "1",
      accepted: true,
    }),
  );
  const agent = {
    submit,
    abort: vi.fn(async () => true),
    retry: vi.fn(async () => false),
    pending: vi.fn(async (): Promise<PiPendingOperation[]> => []),
    busy: vi.fn(async () => false),
  };
  const changed = vi.fn(async () => undefined);
  const mayLeaveReview = vi.fn(async () => undefined);
  const control = new RoomControl(
    store,
    agent,
    workspace,
    changed,
    mayLeaveReview,
  );
  const identity = {
    id: "alice@example.test",
    subject: "a",
    expiresAt: Date.now() + 60_000,
  };
  const metadata = {
    id: crypto.randomUUID(),
    title: "Task",
    repository: "org/repo",
    baseSha: "a".repeat(40),
    owner: identity.id,
    createdAt: new Date().toISOString(),
  };
  if (initialize) await control.initialize(metadata);
  return {
    pi,
    metadata,
    store,
    control,
    identity,
    agent,
    workspace,
    changed,
    mayLeaveReview,
  };
}

describe("room control semantics", () => {
  it.each(["success", "failure"] as const)(
    "does not reopen an archived room when initialization finishes with %s",
    async (outcome) => {
      const f = await fixture(undefined, false);
      const preparing = Promise.withResolvers<{
        revision: number;
        backupKey: string;
        digest: string;
      }>();
      vi.mocked(f.workspace.initialize).mockReturnValueOnce(preparing.promise);
      const initializing = f.control.initialize(f.metadata).catch(() => {});
      try {
        await expect
          .poll(async () => (await f.store.read()).metadata?.id)
          .toBe(f.metadata.id);
        await f.control.archive(f.identity);
        if (outcome === "success")
          preparing.resolve({ revision: 1, backupKey: "late", digest: "late" });
        else preparing.reject(new Error("late preparation failure"));
        await initializing;
        expect((await f.store.read()).mode).toBe("archived");
        expect((await f.store.read()).checkpoint).toBeNull();
      } finally {
        preparing.reject(new Error("test cleanup"));
        await initializing;
        await f.pi.close(BACKGROUND_CONTEXT);
      }
    },
  );
  it("keeps Archive terminal when a repeated cleanup would fail", async () => {
    const f = await fixture();
    try {
      await f.control.archive(f.identity);
      vi.mocked(f.workspace.stop).mockRejectedValueOnce(
        new Error("cleanup unavailable"),
      );
      await expect(f.control.archive(f.identity)).resolves.toBeUndefined();
      expect((await f.store.read()).mode).toBe("archived");
      expect(f.workspace.stop).toHaveBeenCalledTimes(1);
      await expect(
        f.control.dispatch(f.identity, {
          type: "resume",
          id: crypto.randomUUID(),
        }),
      ).rejects.toThrow("Room archived");
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it.each(["stop", "resume"] as const)(
    "does not repeat an old %s intent against a later recovery cycle",
    async (type) => {
      const f = await fixture();
      const old = { type, id: crypto.randomUUID() };
      try {
        if (type === "resume")
          await f.control.dispatch(f.identity, {
            type: "stop",
            id: crypto.randomUUID(),
          });
        const receipt = vi
          .spyOn(f.store, "receipt")
          .mockRejectedValueOnce(new Error("completion receipt unavailable"));
        await f.control.dispatch(f.identity, old).catch(() => {});
        receipt.mockRestore();
        if ((await f.store.read()).mode !== "ready")
          await f.control.dispatch(f.identity, {
            type: "resume",
            id: crypto.randomUUID(),
          });
        await f.control.dispatch(f.identity, {
          type: "submit",
          id: crypto.randomUUID(),
          text: "later work",
          mode: "followUp",
        });
        if (type === "resume")
          await f.control.dispatch(f.identity, {
            type: "stop",
            id: crypto.randomUUID(),
          });
        const before = (await f.store.read()).mode;
        const aborts = f.agent.abort.mock.calls.length;
        const restores = vi.mocked(f.workspace.restore).mock.calls.length;
        await f.control.dispatch(f.identity, old).catch(() => {});
        expect(f.agent.abort).toHaveBeenCalledTimes(aborts);
        expect(f.workspace.restore).toHaveBeenCalledTimes(restores);
        expect((await f.store.read()).mode).toBe(before);
      } finally {
        await f.pi.close(BACKGROUND_CONTEXT);
      }
    },
  );
  it("does not issue Retry twice when its completion receipt is unavailable", async () => {
    const f = await fixture();
    const command = { type: "retry" as const, id: crypto.randomUUID() };
    try {
      const receipt = vi
        .spyOn(f.store, "receipt")
        .mockRejectedValueOnce(new Error("completion unavailable"));
      await expect(f.control.dispatch(f.identity, command)).rejects.toThrow(
        "completion unavailable",
      );
      receipt.mockRestore();
      f.agent.retry.mockResolvedValue(true);
      await expect(f.control.dispatch(f.identity, command)).rejects.toThrow(
        "Retry outcome unconfirmed",
      );
      expect(f.agent.retry).toHaveBeenCalledTimes(1);
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it("reconciles a withdrawal after its durable abort reply is lost and keeps one reusable draft", async () => {
    const model = fauxProvider({ tokensPerSecond: 1000 });
    model.setResponses([fauxAssistantMessage("x".repeat(10000))]);
    const f = await fixture(model);
    try {
      const root = await f.pi.root(BACKGROUND_CONTEXT);
      await root.submit(
        { type: "input", content: "active", requestId: "active" },
        BACKGROUND_CONTEXT,
      );
      await f.store.intent(
        "queued",
        f.identity.id,
        "queued-digest",
        "queued",
        "queued draft",
      );
      const queued = await root.submit(
        {
          type: "input",
          content: "queued draft",
          requestId: "queued",
          whenBusy: "followUp",
        },
        BACKGROUND_CONTEXT,
      );
      expect(
        (await f.pi.inspect(BACKGROUND_CONTEXT)).submissions.find(
          (record) => record.id === queued.id,
        )?.status,
      ).toBe("queued");
      const original = f.pi.abortSubmission.bind(f.pi);
      const abort = vi
        .spyOn(f.pi, "abortSubmission")
        .mockImplementationOnce(async (...args) => {
          const result = await original(...args);
          expect(result).toBe("aborted");
          throw new Error("withdrawal reply lost after commit");
        });
      const command = {
        type: "withdraw" as const,
        id: crypto.randomUUID(),
        operationId: "queued",
      };
      await expect(f.control.dispatch(f.identity, command)).rejects.toThrow(
        "reply lost",
      );
      abort.mockRestore();
      expect((await queued.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
      await expect(f.control.dispatch(f.identity, command)).resolves.toEqual({
        ok: true,
      });
      await f.control.dispatch(f.identity, command);
      expect((await f.store.read()).withdrawn).toEqual([
        {
          actor: f.identity.id,
          text: "queued draft",
          operationId: "queued",
          reason: "withdrawn",
        },
      ]);
      expect(
        (await f.pi.inspect(BACKGROUND_CONTEXT)).submissions.some(
          (record) => record.id === queued.id,
        ),
      ).toBe(false);
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it("rejects an incomplete legacy control without inventing its epoch but returns a completed legacy receipt", async () => {
    const f = await fixture();
    try {
      const command = { type: "stop" as const, id: crypto.randomUUID() };
      const key = await digest(
        `${(await f.store.read()).metadata!.id}:${f.identity.id}:${command.id}`,
      );
      await f.store.intent(
        key,
        f.identity.id,
        await digest(canonicalCommand(command)),
        key,
      );
      await expect(f.control.dispatch(f.identity, command)).rejects.toThrow(
        "earlier recovery state",
      );
      expect(f.agent.abort).not.toHaveBeenCalled();
      await f.store.receipt(key, { ok: true }, "done");
      await expect(f.control.dispatch(f.identity, command)).resolves.toEqual({
        ok: true,
      });
      expect((await f.store.read()).mode).toBe("ready");
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it("does not turn a queued-withdrawal race into cancellation of an active input", async () => {
    const model = fauxProvider({ tokensPerSecond: 1000 });
    model.setResponses([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("x".repeat(10000)),
    ]);
    const f = await fixture(model);
    try {
      const root = await f.pi.root(BACKGROUND_CONTEXT);
      const first = await root.submit(
        { type: "input", content: "first", requestId: "first" },
        BACKGROUND_CONTEXT,
      );
      await f.store.intent(
        "queued-race",
        f.identity.id,
        "digest",
        "queued-race",
        "next input",
      );
      const next = await root.submit(
        {
          type: "input",
          content: "next input",
          requestId: "queued-race",
          whenBusy: "followUp",
        },
        BACKGROUND_CONTEXT,
      );
      const abort = f.pi.abortSubmission.bind(f.pi);
      vi.spyOn(f.pi, "abortSubmission").mockImplementationOnce(
        async (...args) => {
          await first.wait(BACKGROUND_CONTEXT);
          return abort(...args);
        },
      );
      await expect(
        f.control.dispatch(f.identity, {
          type: "withdraw",
          id: crypto.randomUUID(),
          operationId: "queued-race",
        }),
      ).rejects.toThrow("no longer queued");
      expect(
        (await f.pi.inspect(BACKGROUND_CONTEXT)).submissions.find(
          (record) => record.id === next.id,
        )?.status,
      ).toBe("placed");
      expect((await f.store.read()).withdrawn ?? []).toEqual([]);
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it("revalidates queued connections at serialized admission", async () => {
    const f = await fixture();
    try {
      let release!: () => void;
      const held = f.control.serialize(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await Promise.resolve();
      let valid = true;
      const validate = vi.fn(() => {
        if (!valid) throw new Error("Connection lease expired");
      });
      const queued = f.control.dispatch(
        f.identity,
        { type: "retry", id: crypto.randomUUID() },
        validate,
      );
      expect(validate).not.toHaveBeenCalled();
      valid = false;
      const rejected = expect(queued).rejects.toThrow(
        "Connection lease expired",
      );
      release();
      await held;
      await rejected;
      expect(validate).toHaveBeenCalledTimes(1);
      expect(f.agent.retry).not.toHaveBeenCalled();
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it("admits a retried attributed command once and rejects different payloads", async () => {
    const f = await fixture();
    try {
      const input = {
        type: "submit" as const,
        id: crypto.randomUUID(),
        text: "fix it",
        mode: "steer" as const,
      };
      await f.control.dispatch(f.identity, input);
      await f.control.dispatch(f.identity, input);
      expect(f.agent.submit).toHaveBeenCalledTimes(1);
      expect(f.agent.submit.mock.calls[0]?.[0]).toBe(
        "[alice@example.test] fix it",
      );
      await expect(
        f.control.dispatch(f.identity, { ...input, text: "different" }),
      ).rejects.toThrow("different payload");
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it("rejects a submit at the 20-pending-input cap without admitting more work", async () => {
    const f = await fixture();
    try {
      f.agent.pending.mockResolvedValue(
        Array.from({ length: 20 }, (_, index) => ({
          operationId: `queued-${index}`,
          session: "1",
          status: "queued" as const,
        })),
      );
      await expect(
        f.control.dispatch(f.identity, {
          type: "submit",
          id: crypto.randomUUID(),
          text: "overflow",
          mode: "followUp",
        }),
      ).rejects.toThrow("Room input queue is full");
      expect(f.agent.submit).not.toHaveBeenCalled();
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it("does not let observers write, and rejects revoked users immediately", async () => {
    const f = await fixture();
    try {
      await f.control.membership(
        f.identity,
        "bob@example.test",
        "observer",
        () => {},
      );
      const bob = { ...f.identity, id: "bob@example.test" };
      await expect(
        f.control.dispatch(bob, { type: "stop", id: crypto.randomUUID() }),
      ).rejects.toThrow();
      await f.control.membership(f.identity, bob.id, null, () => {});
      await expect(f.store.authorize(bob)).rejects.toThrow("Not a room member");
      await expect(
        f.control.membership(f.identity, f.identity.id, null, () => {}),
      ).rejects.toThrow("owner");
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it("freezes review, refuses busy sessions and requires explicit exit", async () => {
    const f = await fixture();
    try {
      f.agent.busy.mockResolvedValueOnce(true);
      await expect(f.control.prepareReview(f.identity)).rejects.toThrow(
        "Stop or finish",
      );
      await f.control.prepareReview(f.identity);
      expect((await f.store.read()).mode).toBe("review");
      await expect(
        f.control.dispatch(f.identity, {
          type: "submit",
          id: crypto.randomUUID(),
          text: "change",
          mode: "followUp",
        }),
      ).rejects.toThrow("not ready");
      await f.control.exitReview(f.identity);
      expect((await f.store.read()).mode).toBe("ready");
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it("keeps an uncertain publication reachable by blocking every review-leaving control", async () => {
    const f = await fixture();
    try {
      await f.control.prepareReview(f.identity);
      f.mayLeaveReview.mockRejectedValue(new Error("Pending publication"));
      await expect(
        f.control.dispatch(f.identity, {
          type: "stop",
          id: crypto.randomUUID(),
        }),
      ).rejects.toThrow("Pending publication");
      await expect(f.control.archive(f.identity)).rejects.toThrow(
        "Pending publication",
      );
      await expect(f.control.exitReview(f.identity)).rejects.toThrow(
        "Pending publication",
      );
      expect((await f.store.read()).mode).toBe("review");
      expect(f.workspace.stop).not.toHaveBeenCalled();
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it("records one attributed cancellation intent before cleanup, even when a failed Stop is retried", async () => {
    const f = await fixture();
    const command = { type: "stop" as const, id: crypto.randomUUID() };
    try {
      vi.mocked(f.workspace.stop).mockImplementationOnce(async () => {
        const root = await f.pi.root(BACKGROUND_CONTEXT);
        const notes = (await root.context(BACKGROUND_CONTEXT)).entries.filter(
          (entry) => entry.kind === "multipi.control",
        );
        expect((await f.store.read()).mode).toBe("stopping");
        expect(notes).toHaveLength(1);
        expect(notes[0]?.data).toMatchObject({
          actor: f.identity.id,
          action: "stop",
          commandId: command.id,
        });
        expect(notes[0]?.model).toBeUndefined();
        throw new Error("fixture cleanup failure");
      });
      await expect(f.control.dispatch(f.identity, command)).rejects.toThrow(
        "Stop needs workspace recovery",
      );
      await f.control.dispatch(f.identity, command);
      await f.control.dispatch(f.identity, command);
      const root = await f.pi.root(BACKGROUND_CONTEXT);
      expect(
        (await root.context(BACKGROUND_CONTEXT)).entries.filter(
          (entry) => entry.kind === "multipi.control",
        ),
      ).toHaveLength(1);
      expect((await f.pi.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);
      expect(f.agent.submit).not.toHaveBeenCalled();
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it("retains stopped inputs for deliberate human resubmission", async () => {
    const f = await fixture();
    try {
      await f.store.intent(
        "queued",
        "bob@example.test",
        "digest",
        "queued",
        "run the regression tests",
      );
      f.agent.pending.mockResolvedValue([
        { operationId: "queued", session: "1", status: "queued" },
      ]);
      await f.control.dispatch(f.identity, {
        type: "stop",
        id: crypto.randomUUID(),
      });
      expect((await f.store.read()).withdrawn).toEqual([
        {
          actor: "bob@example.test",
          text: "run the regression tests",
          operationId: "queued",
          reason: "stopped",
        },
      ]);
      expect(f.agent.submit).not.toHaveBeenCalled();
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
  it.each(["review", "stop", "resume", "archive"] as const)(
    "notifies clients of recovery after failed %s cleanup",
    async (operation) => {
      const f = await fixture();
      try {
        const observed: string[] = [];
        f.changed.mockImplementation(async () => {
          observed.push((await f.store.read()).mode);
        });
        if (operation === "resume")
          await f.store.update((room) => {
            room.mode = "stopped";
          });
        const failing =
          operation === "review"
            ? f.workspace.review
            : operation === "resume"
              ? f.workspace.restore
              : f.workspace.stop;
        vi.mocked(failing).mockRejectedValueOnce(
          new Error("fixture cleanup failed"),
        );
        const action =
          operation === "review"
            ? f.control.prepareReview(f.identity)
            : operation === "archive"
              ? f.control.archive(f.identity)
              : f.control.dispatch(f.identity, {
                  type: operation,
                  id: crypto.randomUUID(),
                });
        await expect(action).rejects.toThrow();
        expect((await f.store.read()).mode).toBe("recovery");
        expect(observed.at(-1)).toBe("recovery");
      } finally {
        await f.pi.close(BACKGROUND_CONTEXT);
      }
    },
  );
  it("makes Stop durable before cleanup and Resume restores a known checkpoint", async () => {
    const f = await fixture();
    try {
      vi.mocked(f.workspace.stop).mockImplementationOnce(async () => {
        expect((await f.store.read()).mode).toBe("stopping");
      });
      await f.control.dispatch(f.identity, {
        type: "stop",
        id: crypto.randomUUID(),
      });
      expect((await f.store.read()).mode).toBe("stopped");
      await f.control.dispatch(f.identity, {
        type: "resume",
        id: crypto.randomUUID(),
      });
      expect(f.workspace.restore).toHaveBeenCalledWith({
        revision: 1,
        backupKey: "backup-1",
        digest: "d",
      });
      expect((await f.store.read()).mode).toBe("ready");
    } finally {
      await f.pi.close(BACKGROUND_CONTEXT);
    }
  });
});
