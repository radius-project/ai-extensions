import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "canvas-reliability.test.ts",
  globalSetup: "./test/e2e/global-setup.ts",
  globalTeardown: "./test/e2e/global-teardown.ts",
  failOnFlakyTests: true,
  timeout: 30_000,
  workers: 1,
  retries: 1,
  outputDir: "test-results/reliability",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/reliability" }]
  ],
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
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
