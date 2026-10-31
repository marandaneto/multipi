import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ command, mode }) => ({
  plugins: [
    react(),
    cloudflare({
      configPath:
        command === "serve"
          ? "wrangler.local.jsonc"
          : mode === "staging"
            ? "wrangler.staging.jsonc"
            : "wrangler.jsonc",
    }),
  ],
  server: { host: "localhost" },
}));
