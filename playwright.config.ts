import { defineConfig } from "@playwright/test";
import { braveExecutable } from "./test/browser/brave.ts";
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:8793",
    launchOptions: { executablePath: braveExecutable },
    headless: true,
  },
  webServer: {
    command:
      "WRANGLER_SEND_METRICS=false pnpm exec wrangler dev --local --config test/e2e/wrangler.jsonc --port 8793",
    url: "http://localhost:8793",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
