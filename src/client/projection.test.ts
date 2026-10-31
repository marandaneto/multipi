import { describe, expect, it } from "vitest";
import { emptyView, reduceView } from "./projection";
import { projectionEvent } from "./wire";
const event = (value: unknown) => projectionEvent.parse(value);
const usage = { models: {}, tools: {} };
const snapshot = (
  entries: unknown[] = [],
  extra: Record<string, unknown> = {},
) =>
  event({
    type: "snapshot",
    entries,
    tools: [],
    nestedTools: [],
    inbox: [],
    agent: {},
    usage,
    ...extra,
  });
const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: 123,
  stopReason: "stop",
});
const user = {
  id: 1,
  kind: "multipi.input",
  model: [
    { role: "user", content: "[alice@example.test] fix it", timestamp: 100 },
  ],
  data: { actor: "alice@example.test", text: "fix it", mode: "followUp" },
};
const answer = {
  id: 2,
  kind: "pi.assistant",
  model: [assistant("hello world")],
};
describe("client/projection", () => {
  it("preserves an attributed host Stop notice across duplicate delivery and reload without presenting it as a tool result", () => {
    const record = {
      id: 40,
      kind: "multipi.control",
      data: {
        actor: "alice@example.test",
        commandId: "a0c86199-7b5e-4b74-b877-8f16f494a8dd",
        action: "stop",
        observedAt: 200,
      },
      model: [
        {
          role: "system",
          content: "Host cancellation directive",
          timestamp: 200,
        },
      ],
    };
    const view = [
      snapshot([user]),
      event({ type: "entry_appended", entry: record }),
      event({ type: "entry_appended", entry: record }),
    ].reduce(reduceView, emptyView);
    expect(view).toEqual(reduceView(emptyView, snapshot([user, record])));
    expect(view.messages).toHaveLength(2);
    expect(view.messages[1]).toMatchObject({
      role: "notice",
      author: "alice@example.test",
      timestamp: 200,
      text: "Host control · Stop requested; earlier task requests cancelled",
    });
    expect(view.messages[1]?.execution).toBeUndefined();
  });
  it("rejects malformed host control data rather than inventing its actor", () => {
    expect(() =>
      reduceView(
        emptyView,
        snapshot([
          { id: 40, kind: "multipi.control", data: { action: "stop" } },
        ]),
      ),
    ).toThrow();
  });
  it("keeps a host interruption through run cancellation, deduplication and reload without fabricating a tool result", () => {
    const receipt = {
      id: 42,
      kind: "multipi.execution",
      data: {
        callId: "call",
        command: "<literal command>",
        startedAt: 100,
        observedAt: 200,
        workspaceRevision: 3,
        outcome: "interrupted",
        exitCode: null,
        reason: "stop",
      },
    };
    const view = [
      snapshot(),
      event({ type: "entry_appended", entry: receipt }),
      event({ type: "run_end" }),
      event({ type: "entry_appended", entry: receipt }),
    ].reduce(reduceView, emptyView);
    expect(view).toEqual(reduceView(emptyView, snapshot([receipt])));
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]).toMatchObject({
      role: "execution",
      timestamp: 200,
      execution: {
        outcome: "interrupted",
        exitCode: null,
        workspaceRevision: 3,
      },
    });
    expect(view.messages[0]?.text).toContain("Host execution record");
  });
  it("rejects malformed known host execution entries instead of hiding them", () => {
    expect(() =>
      reduceView(
        emptyView,
        snapshot([
          { id: 42, kind: "multipi.execution", data: { outcome: "completed" } },
        ]),
      ),
    ).toThrow();
  });
  it("converges streamed attributed entries and finalized response with a late snapshot", () => {
    const streamed = [
      snapshot(),
      event({ type: "entry_appended", entry: user }),
      event({ type: "run_start" }),
      event({ type: "message_start", message: assistant("") }),
      event({
        type: "message_update",
        changes: [
          {
            type: "text_start",
            contentIndex: 0,
            block: { type: "text", text: "hello" },
          },
          { type: "text_delta", contentIndex: 0, delta: " world" },
        ],
      }),
      event({ type: "message_end", entry: answer }),
      event({ type: "entry_appended", entry: answer }),
      event({ type: "run_end" }),
    ].reduce(reduceView, emptyView);
    const late = reduceView(emptyView, snapshot([user, answer]));
    expect(streamed).toEqual(late);
    expect(streamed.messages[0]).toMatchObject({
      author: "alice@example.test",
      text: "fix it",
    });
    expect(streamed.messages).toHaveLength(2);
  });
  it("converges in-flight text, running tools, trim/append and replaced output", () => {
    let live = reduceView(
      emptyView,
      snapshot([], { run: {}, generation: { message: assistant("hello") } }),
    );
    live = [
      event({
        type: "message_update",
        changes: [{ type: "text_delta", contentIndex: 0, delta: " world" }],
      }),
      event({
        type: "tool_execution_start",
        toolCallId: "a",
        toolName: "bash",
      }),
      event({
        type: "tool_execution_update",
        toolCallId: "a",
        output: { set: "discard\nlogs" },
      }),
      event({
        type: "tool_execution_update",
        toolCallId: "a",
        output: { trimStart: 8, append: "\nexit 1" },
      }),
    ].reduce(reduceView, live);
    const late = reduceView(
      emptyView,
      snapshot([], {
        run: {},
        generation: { message: assistant("hello world") },
        tools: [
          {
            callId: "a",
            name: "bash",
            status: "running",
            output: "logs\nexit 1",
          },
        ],
      }),
    );
    expect(live).toEqual(late);
  });
  it("replaces stale disconnected state, including resets, usage, retries and queue", () => {
    const reset = { id: 3, kind: "pi.reset" };
    const old = reduceView(
      emptyView,
      snapshot([user, answer], { run: {}, inbox: [{ id: 9, mode: "steer" }] }),
    );
    const latest = snapshot([user, answer, reset], {
      generation: { retry: { at: 999, error: "rate limited" } },
      agent: { model: { provider: "example", modelId: "test" } },
      usage: {
        models: { test: { totalTokens: 7, cost: { total: 0.1 } } },
        tools: {},
      },
    });
    expect(reduceView(old, latest)).toEqual(reduceView(emptyView, latest));
    expect(reduceView(old, latest).messages.map((item) => item.text)).toEqual([
      "Context reset",
    ]);
    expect(reduceView(old, latest).usage).toEqual({ tokens: 7, cost: 0.1 });
  });
  it("keeps tool result details authoritative and deduplicates end/appended events", () => {
    const result = {
      id: 4,
      kind: "pi.tool",
      model: [
        {
          role: "toolResult",
          toolName: "bash",
          toolCallId: "a",
          timestamp: 500,
          isError: true,
          content: [{ type: "text", text: "tests failed" }],
          details: {
            command: "pnpm test",
            workspaceRevision: 2,
            exitCode: 1,
            outcome: "failed",
          },
        },
      ],
    };
    const streamed = [
      event({ type: "tool_execution_end", toolCallId: "a", entry: result }),
      event({ type: "entry_appended", entry: result }),
    ].reduce(reduceView, emptyView);
    expect(streamed).toEqual(reduceView(emptyView, snapshot([result])));
    expect(streamed.messages[0]?.text).toContain('"exitCode": 1');
    expect(streamed.messages[0]?.execution).toEqual({
      command: "pnpm test",
      workspaceRevision: 2,
      exitCode: 1,
      outcome: "failed",
    });
  });
  it("shows unanswered submissions and never interprets generated HTML", () => {
    const view = reduceView(
      emptyView,
      event({
        type: "message_start",
        message: assistant('<img src=x onerror="alert(1)">'),
      }),
    );
    expect(view.live?.text).toContain("<img");
    expect(
      reduceView(
        view,
        event({
          type: "submission",
          record: { id: 7, status: "unanswered", reason: "withdrawn" },
        }),
      ).error,
    ).toBe("Unanswered input: withdrawn");
  });
});
