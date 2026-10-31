import { expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { guardProvider } from "../../src/room/model-guard";
import { AppError } from "../../src/shared/protocol";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

it.each(["stream", "streamSimple"] as const)(
  "delegates allowed %s calls without changing the response",
  async (method) => {
    const faux = fauxProvider({ tokensPerSecond: 10000 });
    faux.setResponses([fauxAssistantMessage("allowed response")]);
    const dispatch = vi.spyOn(faux.provider, method);
    const check = vi.fn(async () => {});
    const guarded = guardProvider(faux.provider, check);
    const result = await guarded[method](
      faux.getModel(),
      normalizeContext({ messages: [] }),
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([
      { type: "text", text: "allowed response" },
    ]);
    expect(check).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
  },
);

it.each(
  (["stream", "streamSimple"] as const).flatMap((method) => [
    { method, timeoutMs: 50, waitMs: 51 },
    { method, timeoutMs: undefined, waitMs: 120001 },
    { method, timeoutMs: 300000, waitMs: 120001 },
  ]),
)(
  "enforces the capped deadline for $method timeout=$timeoutMs",
  async ({ method, timeoutMs, waitMs }) => {
    vi.useFakeTimers();
    const faux = fauxProvider();
    const source = createAssistantMessageEventStream();
    const dispatch = vi.spyOn(faux.provider, method).mockReturnValue(source);
    const guarded = guardProvider(faux.provider, async () => {});
    let completed = false;
    const pending = guarded[method](
      faux.getModel(),
      normalizeContext({ messages: [] }),
      { timeoutMs },
    )
      .result()
      .then((value) => {
        completed = true;
        return value;
      });
    try {
      await vi.advanceTimersByTimeAsync(waitMs);
      expect(completed).toBe(true);
      const result = await pending;
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe("Model request timed out");
      expect(dispatch.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      source.push({
        type: "done",
        reason: "stop",
        message: fauxAssistantMessage("cleanup"),
      });
      source.end();
      await pending;
      vi.useRealTimers();
    }
  },
);

it("aborts a running stream even if the provider ignores its signal", async () => {
  vi.useFakeTimers();
  const faux = fauxProvider();
  const source = createAssistantMessageEventStream();
  const dispatch = vi
    .spyOn(faux.provider, "streamSimple")
    .mockReturnValue(source);
  const controller = new AbortController();
  const pending = guardProvider(faux.provider, async () => {})
    .streamSimple(faux.getModel(), normalizeContext({ messages: [] }), {
      signal: controller.signal,
    })
    .result();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledOnce();
    controller.abort(new Error("private cancellation detail"));
    const result = await pending;
    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).not.toContain("private cancellation detail");
    expect(dispatch.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    source.end();
    vi.useRealTimers();
  }
});

it("bounds a stalled policy check without starting the provider", async () => {
  vi.useFakeTimers();
  const faux = fauxProvider();
  const dispatch = vi.spyOn(faux.provider, "streamSimple");
  const check = Promise.withResolvers<void>();
  const pending = guardProvider(faux.provider, () => check.promise)
    .streamSimple(faux.getModel(), normalizeContext({ messages: [] }), {
      timeoutMs: 50,
    })
    .result();
  try {
    await vi.advanceTimersByTimeAsync(51);
    expect((await pending).errorMessage).toBe("Model request timed out");
    expect(dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    check.resolve();
    vi.useRealTimers();
  }
});

it("preserves last reported partial usage without inventing a completed response", async () => {
  vi.useFakeTimers();
  const faux = fauxProvider();
  const source = createAssistantMessageEventStream();
  vi.spyOn(faux.provider, "streamSimple").mockReturnValue(source);
  const pending = guardProvider(faux.provider, async () => {})
    .streamSimple(faux.getModel(), normalizeContext({ messages: [] }), {
      timeoutMs: 50,
    })
    .result();
  try {
    await vi.advanceTimersByTimeAsync(0);
    const partial = fauxAssistantMessage("partial response");
    partial.usage.totalTokens = 17;
    source.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "partial response",
      partial,
    });
    await vi.advanceTimersByTimeAsync(51);
    const result = await pending;
    partial.usage.totalTokens = 999;
    partial.content = [];
    expect(result.stopReason).toBe("error");
    expect(result.usage.totalTokens).toBe(17);
    expect(result.content).toEqual([
      { type: "text", text: "partial response" },
    ]);
  } finally {
    source.end();
    vi.useRealTimers();
  }
});

it("fails rather than leaving result pending if the provider ends without a terminal event", async () => {
  const faux = fauxProvider();
  const source = createAssistantMessageEventStream();
  vi.spyOn(faux.provider, "streamSimple").mockReturnValue(source);
  source.end();
  const result = await guardProvider(faux.provider, async () => {})
    .streamSimple(faux.getModel(), normalizeContext({ messages: [] }))
    .result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toBe("Model response ended without a result");
});

it("rejects a late response even if the timeout callback has not run", async () => {
  vi.useFakeTimers();
  const faux = fauxProvider();
  const source = createAssistantMessageEventStream();
  vi.spyOn(faux.provider, "streamSimple").mockReturnValue(source);
  const pending = guardProvider(faux.provider, async () => {})
    .streamSimple(faux.getModel(), normalizeContext({ messages: [] }), {
      timeoutMs: 50,
    })
    .result();
  try {
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 51);
    source.push({
      type: "done",
      reason: "stop",
      message: fauxAssistantMessage("too late"),
    });
    const result = await pending;
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Model request timed out");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    source.end();
    vi.useRealTimers();
  }
});

it("does not dispatch a denied request and records zero provider usage", async () => {
  const faux = fauxProvider();
  const dispatch = vi.spyOn(faux.provider, "streamSimple");
  const guarded = guardProvider(faux.provider, async () => {
    throw new AppError(429, "Room model budget reached; start a new room");
  });
  const result = await guarded
    .streamSimple(faux.getModel(), normalizeContext({ messages: [] }))
    .result();
  expect(dispatch).not.toHaveBeenCalled();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toBe(
    "Room model budget reached; start a new room",
  );
  expect(result.usage.totalTokens).toBe(0);
  expect(result.usage.cost.total).toBe(0);
});

it("redacts unexpected host errors instead of exposing private details", async () => {
  const faux = fauxProvider();
  const guarded = guardProvider(faux.provider, async () => {
    throw new Error("test-only-private-host-detail");
  });
  const result = await guarded
    .streamSimple(faux.getModel(), normalizeContext({ messages: [] }))
    .result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toBe(
    "Model request blocked; check room diagnostics",
  );
});

it("does not start a provider request aborted while awaiting the policy check", async () => {
  const faux = fauxProvider();
  const dispatch = vi.spyOn(faux.provider, "streamSimple");
  const checked = Promise.withResolvers<void>();
  const controller = new AbortController();
  const guarded = guardProvider(faux.provider, () => checked.promise);
  const pending = guarded
    .streamSimple(faux.getModel(), normalizeContext({ messages: [] }), {
      signal: controller.signal,
    })
    .result();
  controller.abort();
  checked.resolve();
  expect((await pending).stopReason).toBe("aborted");
  expect(dispatch).not.toHaveBeenCalled();
});
