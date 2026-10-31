import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { request, safeLink } from "./wire";
import { publishedDelivery } from "../shared/protocol";
afterEach(() => vi.unstubAllGlobals());
describe("client/wire", () => {
  it("keeps only public persisted delivery fields", () => {
    const value = {
      reviewId: "review",
      headSha: "b".repeat(40),
      pullRequestUrl: "https://github.com/org/repo/pull/1",
    };
    expect(
      publishedDelivery.parse({
        ...value,
        payload: "private",
        result: "private",
      }),
    ).toEqual(value);
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "http://example.test/pr",
  ])("rejects unsafe persisted delivery URL %s", (pullRequestUrl) => {
    expect(
      publishedDelivery.safeParse({
        reviewId: "review",
        headSha: "b".repeat(40),
        pullRequestUrl,
      }).success,
    ).toBe(false);
  });
  it("uses same-origin credentials and exact JSON request bodies", async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await request("/api/action", z.object({ ok: z.boolean() }), "POST", {
        value: "test",
      }),
    ).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith("/api/action", {
      method: "POST",
      credentials: "same-origin",
      signal: undefined,
      headers: { "Content-Type": "application/json" },
      body: '{"value":"test"}',
    });
  });
  it("preserves server errors across supported response formats", async () => {
    for (const body of [
      '{"error":"Access denied"}',
      '{"message":"Access denied"}',
      "Access denied",
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status: 403 })),
      );
      await expect(request("/api/rooms", z.unknown())).rejects.toThrow(
        "Access denied",
      );
    }
  });
  it("validates successful responses instead of trusting malformed HTTP snapshots", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"rooms":null}')),
    );
    await expect(
      request("/api/rooms", z.object({ rooms: z.array(z.unknown()) })),
    ).rejects.toThrow();
  });
  it("never creates executable or insecure publication links", () => {
    expect(safeLink("javascript:alert(1)")).toBeUndefined();
    expect(
      safeLink("data:text/html,<script>alert(1)</script>"),
    ).toBeUndefined();
    expect(safeLink("http://example.test/pr")).toBeUndefined();
    expect(safeLink("https://github.com/org/repo/pull/1")).toBe(
      "https://github.com/org/repo/pull/1",
    );
  });
});
