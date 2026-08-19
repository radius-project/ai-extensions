import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/visual",
  testMatch: "canvas-visual.test.ts",
  globalSetup: "./test/e2e/global-setup.ts",
  globalTeardown: "./test/e2e/global-teardown.ts",
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  outputDir: "test-results/visual",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  reporter: [
    ["list"],
    [
      "./test/e2e/support/retry-only-reporter.ts",
      { outputFile: "test-results/visual-retry-only-passes.json" }
    ],
    ["html", { open: "never", outputFolder: "playwright-visual-report" }]
  ],
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      maxDiffPixelRatio: 0.01
    }
  },
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    headless: true
  },
  projects: [
    {
      name: "canvas-visual",
      retries: 1
    }
  ]
});
