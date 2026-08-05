import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*_test.mjs"],
    environment: "node",
    coverage: {
      include: [
        "src/pages.ts",
        "src/client.ts",
        "src/server.mjs",
        "src/hooks.mjs",
        "src/source-refs.ts"
      ]
    }
  }
});
