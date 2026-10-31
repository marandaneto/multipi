import { z } from "zod";

export const LIMITS = Object.freeze({
  files: 100,
  fileBytes: 256 * 1024,
  totalBytes: 1024 * 1024,
  treeEntries: 20_000,
  uploadPackBytes: 8 * 1024 * 1024,
});
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const repository = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/)
  .refine(
    (v) => !v.endsWith("/.") && !v.endsWith("/..") && !v.endsWith(".git"),
  );
const identityText = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v.isWellFormed() && !/[<>\x00-\x1f\x7f]/.test(v));
const actorSchema = z
  .object({
    id: identityText,
    name: identityText,
    email: identityText.refine((v) => /^[^\s@]+@[^\s@]+$/.test(v)),
  })
  .strict();
const manifestSchema = z
  .object({
    roomId: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    repository,
    baseSha: sha,
    expectedHead: sha.nullable(),
    title: z
      .string()
      .min(1)
      .max(200)
      .refine((v) => !/[\x00-\x1f\x7f]/.test(v)),
    body: z
      .string()
      .max(32_000)
      .refine(
        (v) => !v.includes("<!-- multipi-operation:"),
        "Operation marker is reserved",
      ),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            content: z.string().nullable(),
            mode: z.enum(["100644", "100755"]),
          })
          .strict(),
      )
      .min(1)
      .max(LIMITS.files),
  })
  .strict();
export type PublishManifest = z.infer<typeof manifestSchema>;
export type PublishActor = z.infer<typeof actorSchema>;
export type PreparedPublish = Readonly<{
  version: 1;
  manifest: PublishManifest;
  actor: PublishActor;
  timestamp: string;
  digest: string;
}>;
export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly code: string = "invalid",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}
export function assert(
  condition: unknown,
  message: string,
  code = "invalid",
): asserts condition {
  if (!condition) throw new GitHubError(message, code);
}
export function parseRepository(value: string): string {
  const result = repository.safeParse(value);
  assert(result.success, "Expected canonical owner/repository, not a URL");
  return result.data;
}
const encoder = new TextEncoder();
export const utf8 = (value: string): Uint8Array => encoder.encode(value);
export async function hash(
  algorithm: "SHA-1" | "SHA-256",
  bytes: Uint8Array,
): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(algorithm, new Uint8Array(bytes)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
export async function gitHash(
  type: "blob" | "tree" | "commit",
  bytes: Uint8Array,
): Promise<string> {
  return hash("SHA-1", concat(utf8(`${type} ${bytes.length}\0`), bytes));
}
function validatePath(path: string): void {
  assert(
    path.isWellFormed() &&
      !/[\\\x00-\x1f\x7f]/.test(path) &&
      path === path.normalize("NFC"),
    "Unsupported file path",
  );
  const segments = path.split("/");
  assert(
    segments.every(
      (s) => s !== "" && s !== "." && s !== ".." && !/[ .]$/.test(s),
    ),
    "Unsafe file path",
  );
  assert(
    !segments.some((s) => s.toLowerCase() === ".git"),
    "Git metadata changes are forbidden",
  );
  assert(
    segments[0]?.toLowerCase() !== ".github",
    "GitHub workflow/automation changes are unsupported",
  );
  assert(
    !segments.some((s) =>
      [".gitmodules", ".gitattributes"].includes(s.toLowerCase()),
    ),
    "Submodule/LFS configuration changes are unsupported",
  );
}
export function validateText(content: string): void {
  assert(
    content.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content),
    "Binary/control-character content is unsupported",
  );
  assert(
    !content.startsWith("version https://git-lfs.github.com/spec/v1"),
    "LFS content is unsupported",
  );
  assert(utf8(content).length <= LIMITS.fileBytes, "File size limit exceeded");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
/** Caller must durably persist this exact payload and bind its digest to approval before publish. */
export async function preparePublish(
  manifest: PublishManifest,
  actor: PublishActor,
  timestamp: string,
): Promise<PreparedPublish> {
  const m = manifestSchema.parse(manifest);
  const a = actorSchema.parse(actor);
  assert(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp) &&
      Number.isFinite(Date.parse(timestamp)) &&
      new Date(timestamp).toISOString() === timestamp.replace("Z", ".000Z"),
    "Supply a fixed UTC timestamp with second precision",
  );
  let total = 0;
  const seen = new Set<string>();
  for (const file of m.files) {
    validatePath(file.path);
    const key = file.path.toLowerCase();
    assert(!seen.has(key), "Duplicate/case-colliding file path");
    seen.add(key);
    if (file.content !== null) {
      validateText(file.content);
      const size = utf8(file.content).length;
      assert(size <= LIMITS.fileBytes, "File size limit exceeded");
      total += size;
    }
  }
  assert(total <= LIMITS.totalBytes, "Manifest size limit exceeded");
  for (const path of seen)
    for (const other of seen)
      assert(
        path === other || !other.startsWith(`${path}/`),
        "Overlapping file paths",
      );
  m.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const payload = { version: 1 as const, manifest: m, actor: a, timestamp };
  return freeze({
    ...payload,
    digest: await hash("SHA-256", utf8(JSON.stringify(payload))),
  });
}
export async function validatePrepared(
  value: PreparedPublish,
): Promise<PreparedPublish> {
  assert(value.version === 1, "Unsupported prepared version");
  const prepared = await preparePublish(
    value.manifest,
    value.actor,
    value.timestamp,
  );
  assert(prepared.digest === value.digest, "Prepared payload digest mismatch");
  return prepared;
}
