import { defineConfig } from "vitest/config";
import coverageBaseline from "./coverage-baseline.json" with { type: "json" };

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: [
        "packages/*/src/**/*.ts",
        "plugins/radius/skills/radius-app-bicep/scripts/show-radius-type.mjs"
      ],
      exclude: ["packages/*/src/**/*.test.ts"],
      thresholds: {
        ...coverageBaseline.aggregate,
        "plugins/radius/skills/radius-app-bicep/scripts/show-radius-type.mjs": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100
        },
        "packages/adapter-canvas/src/**":
          coverageBaseline.packages["adapter-canvas"],
        "packages/adapter-shared/src/**":
          coverageBaseline.packages["adapter-shared"],
        "packages/core/src/**": coverageBaseline.packages.core,
        "packages/adapter-canvas/src/runtime/**":
          coverageBaseline.newlyExtracted.runtime,
        "packages/adapter-canvas/src/browser/**":
          coverageBaseline.newlyExtracted.browser
      }
    }
  }
});
