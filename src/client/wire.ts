import { z } from "zod";
import {
  publishedDelivery,
  type Identity,
  type Role,
} from "../shared/protocol";
import type { RoomData, RoomMetadata } from "../room/state";

const identity = z.object({
  id: z.string(),
  subject: z.string(),
  expiresAt: z.number(),
}) satisfies z.ZodType<Identity>;
const role = z.enum([
  "owner",
  "operator",
  "observer",
]) satisfies z.ZodType<Role>;
export const metadata = z.object({
  id: z.uuid(),
  title: z.string(),
  repository: z.string(),
  baseSha: z.string(),
  owner: z.string(),
  createdAt: z.string(),
}) satisfies z.ZodType<RoomMetadata>;
const reviewRef = z.object({
  id: z.string(),
  revision: z.number(),
  digest: z.string(),
});
export const roomData = z.object({
  metadata: metadata.nullable(),
  members: z.record(z.string(), role),
  mode: z.enum([
    "provisioning",
    "ready",
    "stopping",
    "stopped",
    "recovery",
    "review",
    "archived",
  ]),
  checkpoint: z
    .object({ revision: z.number(), backupKey: z.string(), digest: z.string() })
    .nullable(),
  execution: z
    .object({ callId: z.string(), beforeRevision: z.number() })
    .nullable(),
  diagnostic: z.string().nullable(),
  withdrawn: z
    .array(
      z.object({
        actor: z.string(),
        text: z.string(),
        operationId: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  review: reviewRef.nullable(),
  publishedHead: z.string().nullable(),
}) satisfies z.ZodType<RoomData>;
export const meResponse = z.object({ identity, localDev: z.boolean() });
export const roomsResponse = z.object({ rooms: z.array(metadata) });
export const createdResponse = z.object({ id: z.uuid() });
export const reviewResponse = reviewRef.extend({
  patch: z.string(),
  files: z.array(z.object({ path: z.string(), status: z.string() })),
});
export type Review = z.infer<typeof reviewResponse>;
export const publishedResponse = z.object({
  pullRequestUrl: z.url(),
  headSha: z.string(),
});
const pending = z.array(
  z.object({
    operationId: z.string(),
    actor: z.string(),
    status: z.enum(["queued", "running", "parked"]),
  }),
);
export const roomResponse = z.object({
  room: roomData,
  publication: publishedDelivery.nullable().optional(),
  role,
  identity,
  pending,
});
export type RoomEnvelope = z.infer<typeof roomResponse>;

// Validate only fields consumed by this text projection; extra native event fields stay on the server.
const text = z.object({ type: z.literal("text"), text: z.string() });
const image = z.object({ type: z.literal("image") });
const block = z.discriminatedUnion("type", [
  text,
  image,
  z.object({ type: z.literal("thinking"), thinking: z.string() }),
  z.object({
    type: z.literal("toolCall"),
    id: z.string(),
    name: z.string(),
    arguments: z.unknown(),
  }),
]);
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }),
  z.object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(z.union([text, image]))]),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal("assistant"),
    content: z.array(block),
    timestamp: z.number(),
    stopReason: z.string(),
    errorMessage: z.string().optional(),
  }),
  z.object({
    role: z.literal("toolResult"),
    content: z.array(z.union([text, image])),
    timestamp: z.number(),
    toolName: z.string(),
    toolCallId: z.string(),
    isError: z.boolean(),
    details: z.unknown().optional(),
  }),
]);
export type WireMessage = z.infer<typeof message>;
const entry = z.object({
  id: z.number(),
  kind: z.string(),
  model: z.array(message).optional(),
  data: z.unknown().optional(),
});
export type WireEntry = z.infer<typeof entry>;
const change = z.union([
  z.object({
    type: z.enum(["text_start", "thinking_start", "toolcall_start", "block"]),
    contentIndex: z.number().int().nonnegative().max(4096),
    block,
  }),
  z.object({
    type: z.enum(["text_delta", "thinking_delta"]),
    contentIndex: z.number().int().nonnegative().max(4096),
    delta: z.string(),
  }),
  z.object({ type: z.literal("toolcall_delta"), contentIndex: z.number() }),
  z.object({ type: z.literal("message"), message }),
]);
const tool = z.object({
  callId: z.string(),
  name: z.string(),
  status: z.enum(["pending", "running", "done"]),
  output: z.string().optional(),
});
const agent = z.object({
  model: z.object({ provider: z.string(), modelId: z.string() }).optional(),
});
const retry = z.object({ at: z.number(), error: z.string() });
const inbox = z.array(
  z.object({ id: z.number(), mode: z.enum(["steer", "followUp", "write"]) }),
);
const usageBucket = z.object({
  totalTokens: z.number(),
  cost: z.object({ total: z.number() }),
});
const usage = z.object({
  models: z.record(z.string(), usageBucket),
  tools: z.record(z.string(), usageBucket),
});
export const projectionEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    entries: z.array(entry),
    run: z.object({}).optional(),
    generation: z
      .object({ message: message.optional(), retry: retry.optional() })
      .optional(),
    tools: z.array(tool),
    nestedTools: z.array(tool),
    inbox,
    agent,
    usage,
  }),
  z.object({ type: z.literal("run_start") }),
  z.object({ type: z.literal("run_end") }),
  z.object({ type: z.literal("message_start"), message }),
  z.object({ type: z.literal("message_update"), changes: z.array(change) }),
  z.object({ type: z.literal("message_end"), entry }),
  z.object({ type: z.literal("entry_appended"), entry }),
  z.object({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
  }),
  z.object({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string(),
    output: z
      .union([
        z.object({ set: z.string() }),
        z.object({
          trimStart: z.number().nonnegative().optional(),
          append: z.string().optional(),
        }),
      ])
      .optional(),
  }),
  z.object({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    entry: entry.optional(),
  }),
  z.object({ type: z.literal("inbox_update"), items: inbox }),
  z.object({
    type: z.literal("auto_retry_start"),
    at: z.number(),
    errorMessage: z.string(),
  }),
  z.object({ type: z.literal("auto_retry_end") }),
  z.object({ type: z.literal("agent_changed"), agent }),
  z.object({ type: z.literal("usage_changed"), usage }),
  z.object({ type: z.literal("task_failed"), message: z.string() }),
  z.object({
    type: z.literal("submission"),
    record: z.object({
      id: z.number(),
      status: z.string(),
      reason: z.string().optional(),
    }),
  }),
]);
export type ProjectionEvent = z.infer<typeof projectionEvent>;
export const socketMessage = z.discriminatedUnion("type", [
  roomResponse.extend({
    type: z.literal("room"),
    presence: z.array(z.string()),
  }),
  z.object({ type: z.literal("pi"), events: z.array(z.unknown()) }),
  z.object({ type: z.literal("result"), id: z.string(), result: z.unknown() }),
  z.object({
    type: z.literal("error"),
    id: z.string().optional(),
    message: z.string(),
    status: z.number(),
  }),
]);
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function safeLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    signal,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const raw = await response.text();
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = raw;
  }
  if (!response.ok) {
    const error = z.object({ message: z.string() }).safeParse(value);
    const alternate = z.object({ error: z.string() }).safeParse(value);
    throw new Error(
      error.success
        ? error.data.message
        : alternate.success
          ? alternate.data.error
          : raw || `HTTP ${response.status}`,
    );
  }
  return schema.parse(value);
}
export const ignoredResponse = z.unknown();
