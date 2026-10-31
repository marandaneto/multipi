import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflare } from "@cloudflare/vite-plugin";
import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";
import config from "../../vite.config";

vi.mock("@cloudflare/vite-plugin", () => ({
  cloudflare: vi.fn(() => ({ name: "cloudflare-test" })),
}));

beforeEach(() => vi.mocked(cloudflare).mockClear());

describe("deployment configuration", () => {
  it("keeps example repository grants out of production and local defaults", () => {
    for (const name of [
      "wrangler.staging.example.jsonc",
      "wrangler.jsonc",
      "wrangler.local.jsonc",
    ]) {
      const path = new URL(`../../${name}`, import.meta.url);
      const parsed = parseConfigFileTextToJson(
        String(path),
        readFileSync(path, "utf8"),
      );
      expect(parsed.error).toBeUndefined();
      expect(parsed.config.account_id).toBeUndefined();
      const grants = JSON.parse(parsed.config.vars.ALLOWED_REPOSITORIES);
      if (name === "wrangler.staging.example.jsonc") {
        expect(grants).toEqual({
          "example/repo": ["owner@example.test", "operator@example.test"],
        });
        expect(parsed.config.workers_dev).toBe(false);
        expect(parsed.config.preview_urls).toBe(false);
      } else {
        expect(grants).toEqual({});
      }
      if (name === "wrangler.jsonc") {
        expect(parsed.config.workers_dev).toBe(false);
        expect(parsed.config.preview_urls).toBe(false);
      }
    }
  });
  it("enables the larger workspace only in staging", () => {
    for (const [name, expected] of [
      ["wrangler.staging.example.jsonc", "standard-1"],
      ["wrangler.jsonc", undefined],
      ["wrangler.local.jsonc", undefined],
    ]) {
      const path = new URL(`../../${name}`, import.meta.url);
      const parsed = parseConfigFileTextToJson(
        String(path),
        readFileSync(path, "utf8"),
      );
      expect(parsed.error).toBeUndefined();
      expect(parsed.config.vars?.WORKSPACE_INSTANCE_TYPE).toBe(expected);
    }
  });
  it.each([
    ["serve", "development", "wrangler.local.jsonc"],
    ["serve", "production", "wrangler.local.jsonc"],
    ["build", "production", "wrangler.jsonc"],
    ["build", "staging", "wrangler.staging.jsonc"],
    ["build", "custom", "wrangler.jsonc"],
  ] as const)("routes %s/%s to %s", (command, mode, configPath) => {
    config({ command, mode });
    expect(cloudflare).toHaveBeenLastCalledWith({ configPath });
  });
});
