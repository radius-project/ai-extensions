import { defineConfig } from "@playwright/test";

// No browser download is needed: tests attach to the running Copilot app's
// WebView2 over CDP instead of launching a Playwright browser.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  projects: [{ name: "copilot-app-windows" }]
});
