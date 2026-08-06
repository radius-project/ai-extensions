import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      include: [
        "src/pages.ts",
        "src/client.ts",
        "src/server.ts",
        "src/hooks.ts",
        "src/source-refs.ts"
      ]
    }
  }
});
