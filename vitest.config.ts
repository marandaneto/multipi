import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "src/client/**/*.test.ts"],
    environment: "node",
  },
});
