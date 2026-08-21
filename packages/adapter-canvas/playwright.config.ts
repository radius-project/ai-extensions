import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

// Safety, destructive, branch-selection, path-confinement and redaction cases
// never retry: a pass that only happens on the second attempt would hide the
// exact class of regression they exist to catch. Everything else gets the one
// diagnostic retry the test plan allows, and the original failure is retained.
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "canvas-chromium.test.ts",
  globalSetup: "./test/e2e/global-setup.ts",
  globalTeardown: "./test/e2e/global-teardown.ts",
  timeout: 30_000,
  workers: 1,
  // Keep Chromium output separate so this run cannot erase a visual report
  // produced earlier in the same checkout.
  outputDir: "test-results/chromium",
  reporter: [
    ["list"],
    [
      "./test/e2e/support/retry-only-reporter.ts",
      {
        outputFile: path.join(
          packageRoot,
          "test-results/chromium-retry-only-passes.json"
        )
      }
    ],
    ["html", { open: "never", outputFolder: "playwright-report" }]
  ],
  use: {
    browserName: "chromium",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    headless: true
  },
  projects: [
    {
      name: "canvas-safety",
      grep: /@safety/,
      retries: 0
    },
    {
      name: "canvas",
      grepInvert: /@safety/,
      retries: 1
    }
  ]
});
