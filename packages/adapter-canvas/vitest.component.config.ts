// Browser component layer (P1-A): one browser unit mounted in a real DOM.
//
// The graph modules are given the real React, ReactDOM and React Flow the build
// inlines into extension.mjs and are rendered by a real Chromium engine, so
// hooks, roots, measurement and pointer behaviour are the product's own rather
// than a stand-in. The node-environment suite in vitest.config.ts keeps the
// pure logic; this config exists for the behaviour that needs a DOM.

import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/component/**/*.test.ts"],
    // The plan's browser component and functional budget.
    testTimeout: 10_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      screenshotFailures: false,
      instances: [{ browser: "chromium" }]
    }
  }
});
