import { z } from "zod";
import { executionRecord, stopRecord } from "../shared/protocol";
import type { ProjectionEvent, WireEntry, WireMessage } from "./wire";

const executionSchema = z.object({
  command: z.string(),
  workspaceRevision: z.number(),
  outcome: z.string(),
  exitCode: z.number().nullable().optional(),
});
export type TranscriptItem = {
  id: string;
  role: string;
  author?: string;
  text: string;
  timestamp: number;
  error?: string;
  execution?: z.infer<typeof executionSchema>;
};
type Tool = { callId: string; name: string; output: string };
export type View = {
  messages: TranscriptItem[];
  live: TranscriptItem | null;
  blocks: string[];
  running: boolean;
  tools: Tool[];
  queued: number;
  retry: { at: number; error: string } | null;
  model: { provider: string; modelId: string } | null;
  error: string | null;
  usage: { tokens: number; cost: number };
};
export const emptyView: View = {
  messages: [],
  live: null,
  blocks: [],
  running: false,
  tools: [],
  queued: 0,
  retry: null,
  model: null,
  error: null,
  usage: { tokens: 0, cost: 0 },
};
function blockText(
  block: Exclude<
    WireMessage,
    { role: "system" | "user" | "toolResult" }
  >["content"][number],
): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "thinking":
      return `[Thinking]\n${block.thinking}`;
    case "toolCall":
      return `${block.name}\n${JSON.stringify(block.arguments, null, 2)}`;
    case "image":
      return "[Image omitted]";
  }
}
function messageText(message: WireMessage): string {
  if (message.role === "system") return "";
  if (typeof message.content === "string") return message.content;
  const content = message.content.map(blockText).join("\n");
  return message.role === "toolResult"
    ? `${message.toolName} · ${message.isError ? "failed" : "result"}\n${content}${message.details === undefined ? "" : `\nDetails: ${JSON.stringify(message.details, null, 2)}`}`
    : content;
}
function projectMessage(message: WireMessage, id: string): TranscriptItem {
  const execution =
    message.role === "toolResult"
      ? executionSchema.safeParse(message.details)
      : null;
  return {
    id,
    role: message.role,
    text: messageText(message),
    timestamp: "timestamp" in message ? message.timestamp : 0,
    ...("errorMessage" in message ? { error: message.errorMessage } : {}),
    ...(execution?.success
      ? {
          execution: {
            ...execution.data,
            outcome:
              message.role === "toolResult" &&
              message.isError &&
              execution.data.outcome === "running"
                ? "interrupted"
                : execution.data.outcome,
          },
        }
      : {}),
  };
}
const attribution = z.object({
  actor: z.string(),
  text: z.string(),
  mode: z.enum(["steer", "followUp"]),
});
function entryItems(entry: WireEntry): TranscriptItem[] {
  if (entry.kind === "multipi.control") {
    const record = stopRecord.parse(entry.data);
    return [
      {
        id: String(entry.id),
        role: "notice",
        author: record.actor,
        text: "Host control · Stop requested; earlier task requests cancelled",
        timestamp: record.observedAt,
      },
    ];
  }
  if (entry.kind === "multipi.execution") {
    const record = executionRecord.parse(entry.data);
    return [
      {
        id: String(entry.id),
        role: "execution",
        text: `Host execution record · ${record.reason}\n${JSON.stringify(record, null, 2)}`,
        timestamp: record.observedAt,
        execution: executionSchema.parse(record),
      },
    ];
  }
  if (entry.kind === "pi.reset")
    return [
      {
        id: String(entry.id),
        role: "notice",
        text: "Context reset",
        timestamp: 0,
      },
    ];
  if (entry.kind === "pi.system") return [];
  const actor =
    entry.kind === "multipi.input" ? attribution.safeParse(entry.data) : null;
  if (actor?.success)
    return [
      {
        id: String(entry.id),
        role: "user",
        author: actor.data.actor,
        text: `${actor.data.mode === "steer" ? "Steer · " : ""}${actor.data.text}`,
        timestamp:
          entry.model?.[0] && "timestamp" in entry.model[0]
            ? entry.model[0].timestamp
            : 0,
      },
    ];
  return (entry.model ?? [])
    .filter((message) => message.role !== "system")
    .map((message, index) =>
      projectMessage(
        message,
        index ? `${entry.id}:${index}` : String(entry.id),
      ),
    );
}
function append(view: View, entry: WireEntry): View {
  const items = entryItems(entry);
  if (entry.kind === "pi.reset") return { ...view, messages: items };
  return {
    ...view,
    messages: [
      ...view.messages,
      ...items.filter(
        (item) => !view.messages.some((known) => known.id === item.id),
      ),
    ],
  };
}
function liveMessage(view: View, message: WireMessage): View {
  return {
    ...view,
    live: projectMessage(message, "live"),
    blocks: message.role === "assistant" ? message.content.map(blockText) : [],
  };
}
function totalUsage(
  usage: Extract<ProjectionEvent, { type: "usage_changed" }>["usage"],
): View["usage"] {
  return [...Object.values(usage.models), ...Object.values(usage.tools)].reduce(
    (sum, bucket) => ({
      tokens: sum.tokens + bucket.totalTokens,
      cost: sum.cost + bucket.cost.total,
    }),
    { tokens: 0, cost: 0 },
  );
}
export function reduceView(view: View, event: ProjectionEvent): View {
  switch (event.type) {
    case "snapshot": {
      const messages = event.entries.reduce(append, emptyView).messages;
      let next: View = {
        ...emptyView,
        messages,
        running: !!event.run,
        queued: event.inbox.length,
        tools: [...event.tools, ...event.nestedTools]
          .filter((tool) => tool.status === "running")
          .map((tool) => ({
            callId: tool.callId,
            name: tool.name,
            output: tool.output ?? "",
          })),
        model: event.agent.model ?? null,
        retry: event.generation?.retry ?? null,
        usage: totalUsage(event.usage),
      };
      if (event.generation?.message)
        next = liveMessage(next, event.generation.message);
      return next;
    }
    case "run_start":
      return { ...view, running: true, error: null };
    case "run_end":
      return {
        ...view,
        running: false,
        live: null,
        blocks: [],
        tools: [],
        retry: null,
      };
    case "message_start":
      return event.message.role === "assistant"
        ? liveMessage(view, event.message)
        : view;
    case "message_update": {
      let next = view;
      for (const change of event.changes) {
        if (change.type === "message") {
          next = liveMessage(next, change.message);
          continue;
        }
        if (!next.live || change.type === "toolcall_delta") continue;
        const blocks = [...next.blocks];
        if ("block" in change)
          blocks[change.contentIndex] = blockText(change.block);
        else
          blocks[change.contentIndex] =
            (blocks[change.contentIndex] ??
              (change.type === "thinking_delta" ? "[Thinking]\n" : "")) +
            change.delta;
        next = {
          ...next,
          blocks,
          live: { ...next.live, text: blocks.join("\n") },
        };
      }
      return next;
    }
    case "entry_appended":
      return append(view, event.entry);
    case "message_end": {
      const next = append(view, event.entry);
      return event.entry.model?.some((message) => message.role === "assistant")
        ? { ...next, live: null, blocks: [] }
        : next;
    }
    case "tool_execution_start":
      return {
        ...view,
        tools: [
          ...view.tools.filter((tool) => tool.callId !== event.toolCallId),
          { callId: event.toolCallId, name: event.toolName, output: "" },
        ],
      };
    case "tool_execution_update": {
      const output = event.output;
      if (!output) return view;
      return {
        ...view,
        tools: view.tools.map((tool) =>
          tool.callId !== event.toolCallId
            ? tool
            : {
                ...tool,
                output:
                  "set" in output
                    ? output.set
                    : tool.output.slice(output.trimStart ?? 0) +
                      (output.append ?? ""),
              },
        ),
      };
    }
    case "tool_execution_end":
      return {
        ...(event.entry ? append(view, event.entry) : view),
        tools: view.tools.filter((tool) => tool.callId !== event.toolCallId),
      };
    case "inbox_update":
      return { ...view, queued: event.items.length };
    case "auto_retry_start":
      return { ...view, retry: { at: event.at, error: event.errorMessage } };
    case "auto_retry_end":
      return { ...view, retry: null };
    case "agent_changed":
      return { ...view, model: event.agent.model ?? null };
    case "usage_changed":
      return { ...view, usage: totalUsage(event.usage) };
    case "task_failed":
      return { ...view, error: event.message };
    case "submission":
      return event.record.status === "unanswered"
        ? {
            ...view,
            error: `Unanswered input: ${event.record.reason ?? "unknown"}`,
          }
        : view;
  }
}
