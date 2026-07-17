import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*_test.mjs"],
    environment: "node",
    coverage: {
      include: ["src/pages.mjs", "src/client.mjs", "src/server.mjs", "src/hooks.mjs", "src/source-refs.mjs"],
    },
  },
});
