import { z } from "zod";

export const email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
export const role = z.enum(["owner", "operator", "observer"]);
export type Role = z.infer<typeof role>;
export const repository = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
export const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const publishedDelivery = z.object({
  reviewId: z.string(),
  headSha: z.string(),
  pullRequestUrl: z
    .url()
    .refine((value) => new URL(value).protocol === "https:"),
});
export const command = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("submit"),
      id: z.uuid(),
      text: z.string().trim().min(1).max(16_384),
      mode: z.enum(["followUp", "steer"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("withdraw"),
      id: z.uuid(),
      operationId: z.string().min(1).max(200),
    })
    .strict(),
  z.object({ type: z.literal("stop"), id: z.uuid() }).strict(),
  z.object({ type: z.literal("resume"), id: z.uuid() }).strict(),
  z.object({ type: z.literal("retry"), id: z.uuid() }).strict(),
  z.object({ type: z.literal("resync") }).strict(),
]);
export type Command = z.infer<typeof command>;
export const createRoom = z
  .object({
    title: z.string().trim().min(1).max(100),
    repository,
    baseSha: sha,
  })
  .strict();
export const membershipChange = z
  .object({ email, role: z.enum(["operator", "observer"]).nullable() })
  .strict();
export type Identity = { id: string; subject: string; expiresAt: number };

export const stopRecord = z.object({
  actor: email,
  commandId: z.uuid(),
  action: z.literal("stop"),
  observedAt: z.number(),
});

export const executionRecord = z.object({
  callId: z.string(),
  command: z.string(),
  startedAt: z.number(),
  observedAt: z.number(),
  workspaceRevision: z.number().int(),
  outcome: z.enum(["completed", "failed", "interrupted", "timed_out"]),
  exitCode: z.number().int().nullable(),
  reason: z.enum(["result", "error", "stop", "archive", "restart", "restore"]),
});
export type ExecutionRecord = z.infer<typeof executionRecord>;

export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function requireOperator(memberRole: Role | undefined) {
  if (memberRole !== "owner" && memberRole !== "operator")
    throw new AppError(403, "Operator access required");
}
export function requireOwner(memberRole: Role | undefined) {
  if (memberRole !== "owner") throw new AppError(403, "Owner access required");
}
export function canonicalCommand(value: unknown) {
  return JSON.stringify(command.parse(value));
}
export async function digest(value: string | Uint8Array) {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
