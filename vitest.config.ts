import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/core/vitest.config.ts",
      "packages/adapter-shared/vitest.config.ts",
      "packages/adapter-canvas/vitest.config.ts"
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/*/src/**/*.test.ts",
        "packages/*/src/**/*_test.ts",
        "packages/*/src/**/*.live_test.ts"
      ]
    }
  }
});
