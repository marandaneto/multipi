import { describe, expect, it } from "vitest";
import {
  canonicalCommand,
  command,
  digest,
  requireOperator,
  requireOwner,
} from "../../src/shared/protocol";
import { allowedRepository, requireSameOrigin } from "../../src/worker/auth";

describe("server command and policy boundary", () => {
  it("rejects forged authors and unbounded input", () => {
    const input = {
      type: "submit",
      id: crypto.randomUUID(),
      mode: "steer",
      text: "fix",
    };
    expect(command.safeParse({ ...input, author: "owner" }).success).toBe(
      false,
    );
    expect(
      command.safeParse({ ...input, text: "x".repeat(16_385) }).success,
    ).toBe(false);
    expect(canonicalCommand(input)).toBe(
      canonicalCommand({
        text: "fix",
        mode: "steer",
        id: input.id,
        type: "submit",
      }),
    );
  });
  it("enforces roles independently of the browser UI", () => {
    expect(() => requireOperator("observer")).toThrow();
    expect(() => requireOperator(undefined)).toThrow();
    expect(() => requireOwner("operator")).toThrow();
    expect(() => requireOperator("operator")).not.toThrow();
  });
  it("requires exact repository membership, not just app installation", () => {
    const policy = JSON.stringify({ "org/repo": ["alice@example.test"] });
    expect(() =>
      allowedRepository("org/repo", "alice@example.test", policy),
    ).not.toThrow();
    expect(() =>
      allowedRepository("org/repo", "bob@example.test", policy),
    ).toThrow();
    expect(() =>
      allowedRepository("org/other", "alice@example.test", policy),
    ).toThrow();
  });
  it("rejects cross-origin writes and deployment misconfiguration", () => {
    const req = (origin: string) =>
      new Request("https://multipi.test/api", { headers: { Origin: origin } });
    expect(() =>
      requireSameOrigin(req("https://evil.test"), {
        APP_ORIGIN: "https://multipi.test",
      }),
    ).toThrow();
    expect(() => requireSameOrigin(req("https://multipi.test"), {})).toThrow();
    expect(() =>
      requireSameOrigin(req("https://multipi.test"), {
        APP_ORIGIN: "https://multipi.test",
      }),
    ).not.toThrow();
  });
  it("binds distinct canonical payloads to distinct digests", async () => {
    expect(await digest("a")).not.toBe(await digest("b"));
    expect(await digest("a")).toHaveLength(64);
  });
});
