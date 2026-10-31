import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/container/**/*.test.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
    server: { deps: { inline: ["@cloudflare/sandbox"] } },
  },
  resolve: {
    alias: {
      "cloudflare:workers": new URL(
        "./test/container/cloudflare-workers.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
