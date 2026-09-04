import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

// The cloud tier, kept as its own config rather than a project inside
// `playwright.config.ts`, because the two runs disagree about everything that
// matters: this one talks to real Azure and GitHub, takes tens of minutes, and
// must never retry.
//
// `retries: 0` is a correctness rule, not a preference. Later stages of this
// journey are destructive, and a retry would re-run a half-completed
// create-or-delete against infrastructure the first attempt already changed —
// so a flake would be laundered into a pass over inconsistent state.
//
// `testMatch` also matters. The suite's support modules are unit-tested with
// Vitest, whose `include` covers `test/e2e-cloud/**/*.test.ts`; a Playwright
// spec named `*.test.ts` here would be collected by Vitest and fail on an
// unknown `test.describe.configure`. The `.cloud.spec.ts` suffix is what keeps
// the two runners' file sets disjoint.
export default defineConfig({
  testDir: "./test/e2e-cloud",
  testMatch: "**/*.cloud.spec.ts",
  // Shared with the Chromium tier on purpose: both need the credential-store
  // isolation installed before the first production import, and cloud mode
  // still relies on the same server warm-up and Windows shim.
  globalSetup: "./test/e2e/global-setup.ts",
  globalTeardown: "./test/e2e/global-teardown.ts",
  // One journey provisions an Entra application, a service principal, two
  // federated credentials, a role assignment, a GitHub Environment, and its
  // workflows. The per-test budget has to outlast all of it, or a slow cloud
  // reports as a product failure.
  timeout: 45 * 60 * 1000,
  expect: { timeout: 60_000 },
  // Serializes tests inside one process. Cross-process/cloud-run serialization
  // is enforced by the repository-scoped lease acquired by the cloud fixture.
  workers: 1,
  retries: 0,
  fullyParallel: false,
  // Kept apart from `test-results/chromium` so a cloud run cannot erase the
  // Chromium tier's traces, or be erased by them.
  outputDir: "test-results/cloud",
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: path.join(packageRoot, "playwright-report-cloud")
      }
    ]
  ],
  use: {
    browserName: "chromium",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    headless: true
  }
});
