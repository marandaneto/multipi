import { createExecutionContext, env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { DependencyGateway } from "../../src/worker/index";

it("preserves compact npm metadata negotiation without forwarding credentials", async () => {
  const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response('{"name":"fixture"}', {
      headers: { "Content-Type": "application/vnd.npm.install-v1+json" },
    }),
  );
  try {
    const accept =
      "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";
    const gateway = new DependencyGateway(createExecutionContext(), env);
    const response = await gateway.fetch(
      new Request("https://registry.npmjs.org/fixture", {
        headers: {
          Accept: accept,
          Authorization: "Bearer test-only-sentinel",
          Cookie: "test-only-cookie=value",
          "X-Private-Header": "test-only-private-value",
        },
      }),
    );
    expect(upstream).toHaveBeenCalledOnce();
    const [url, options] = upstream.mock.calls[0]!;
    expect(String(url)).toBe("https://registry.npmjs.org/fixture");
    expect(Object.fromEntries(new Headers(options?.headers))).toEqual({
      accept,
    });
    expect(options?.redirect).toBe("manual");
    expect(response.headers.get("Content-Type")).toBe(
      "application/vnd.npm.install-v1+json",
    );
    expect(await response.json()).toEqual({ name: "fixture" });
  } finally {
    upstream.mockRestore();
  }
});

it.each([
  ["http://registry.npmjs.org/fixture", "GET"],
  ["https://registry.npmjs.org:444/fixture", "GET"],
  ["https://registry.npmjs.org.evil.example/fixture", "GET"],
  ["https://example.com/fixture", "GET"],
  ["https://registry.npmjs.org/fixture", "POST"],
  ["https://registry.npmjs.org/fixture", "PUT"],
])(
  "denies dependency requests outside the read-only allowlist: %s %s",
  async (url, method) => {
    const upstream = vi.spyOn(globalThis, "fetch");
    try {
      const gateway = new DependencyGateway(createExecutionContext(), env);
      const response = await gateway.fetch(new Request(url, { method }));
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Denied");
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      upstream.mockRestore();
    }
  },
);

it("does not follow registry redirects or expose upstream errors", async () => {
  const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("test-only-upstream-detail", {
      status: 302,
      headers: { Location: "https://example.com/redirect" },
    }),
  );
  try {
    const gateway = new DependencyGateway(createExecutionContext(), env);
    const response = await gateway.fetch(
      new Request("https://registry.npmjs.org/fixture"),
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Registry fetch failed");
    expect(response.headers.has("Location")).toBe(false);
    expect(upstream.mock.calls[0]?.[1]?.redirect).toBe("manual");
  } finally {
    upstream.mockRestore();
  }
});
