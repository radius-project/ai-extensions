import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "visual/canvas-visual.test.ts",
  globalSetup: "./test/e2e/global-setup.ts",
  globalTeardown: "./test/e2e/global-teardown.ts",
  failOnFlakyTests: true,
  timeout: 30_000,
  workers: 1,
  retries: 0,
  outputDir: "test-results/visual",
  snapshotPathTemplate: "{testDir}/{testFileDir}/__screenshots__/{arg}{ext}",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/visual" }]
  ],
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixels: 0,
      scale: "css"
    }
  },
  use: {
    browserName: "chromium",
    viewport: { width: 900, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    headless: true
  }
});
