import { z } from "zod";
import { GitHubError } from "../github";
import { AppError } from "../shared/protocol";

export async function body(
  request: Request,
  limit = 24 * 1024,
): Promise<unknown> {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new AppError(413, "Request too large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError(400, "Malformed JSON");
  }
}
export function errorResponse(error: unknown): Response {
  const status =
    error instanceof AppError
      ? error.status
      : error instanceof z.ZodError
        ? 400
        : error instanceof GitHubError
          ? 409
          : 500;
  const message =
    error instanceof AppError || error instanceof GitHubError
      ? error.message
      : error instanceof z.ZodError
        ? "Invalid request"
        : "Request failed; check room diagnostics";
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
