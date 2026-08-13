import { defineConfig } from "vitest/config";
import coverageBaseline from "./coverage-baseline.json" with { type: "json" };

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts"],
      thresholds: {
        ...coverageBaseline.aggregate,
        "packages/adapter-canvas/src/**":
          coverageBaseline.packages["adapter-canvas"],
        "packages/adapter-shared/src/**":
          coverageBaseline.packages["adapter-shared"],
        "packages/core/src/**": coverageBaseline.packages.core,
        "packages/adapter-canvas/src/runtime/**":
          coverageBaseline.newlyExtracted.runtime
      }
    }
  }
});
