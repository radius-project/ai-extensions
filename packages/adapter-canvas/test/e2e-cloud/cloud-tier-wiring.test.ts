// The cloud tier's wiring, which nothing else can prove.
//
// A suite that is not reachable from a config runs zero tests and reports
// success, and a config that is not in the lint script's explicit file list is
// silently unlinted. Both failures look exactly like a passing repository, so
// they are asserted here rather than trusted.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import cloudConfig from "../../playwright.cloud.config.js";
import chromiumConfig from "../../playwright.config.js";
import vitestConfig from "../../vitest.config.js";
import {
  CLOUD_HOOK_TEARDOWN_HEADROOM_MS,
  CLOUD_INSTALLATION_TOKEN_LIFETIME_MS,
  CREATE_OPERATION_TIMEOUT_MS,
  CREATE_TEST_TIMEOUT_MS,
  DELETE_OPERATION_TIMEOUT_MS,
  DELETE_POSTCONDITION_TIMEOUT_MS,
  DELETE_TEST_TIMEOUT_MS,
  SERIAL_TEST_TIMEOUT_BUDGET_MS
} from "./support/cloud-timeout-budget.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
async function packageManifest(): Promise<{ scripts: Record<string, string> }> {
  return JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8")
  ) as { scripts: Record<string, string> };
}

describe("the cloud Playwright config", () => {
  it("collects this directory's cloud specs", () => {
    expect(cloudConfig.testDir).toBe("./test/e2e-cloud");
    expect(cloudConfig.testMatch).toBe("**/*.cloud.spec.ts");
  });

  it("never retries, because later stages of the journey are destructive", () => {
    expect(cloudConfig.retries).toBe(0);
    expect(cloudConfig.projects).toBeUndefined();
  });

  it("serializes runs, which contend for one repository-scoped Entra application", () => {
    expect(cloudConfig.workers).toBe(1);
    expect(cloudConfig.fullyParallel).toBe(false);
  });

  it("allows far longer than the Chromium tier for a real cloud round trip", () => {
    const chromiumTimeout = chromiumConfig.timeout ?? 0;
    expect(cloudConfig.timeout).toBeGreaterThan(chromiumTimeout);
    expect(cloudConfig.timeout).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(cloudConfig.expect?.timeout).toBeGreaterThan(0);
  });

  it("budgets every sequential stage and leaves hook headroom", () => {
    const globalTimeout = cloudConfig.globalTimeout ?? 0;

    expect(CREATE_TEST_TIMEOUT_MS).toBeGreaterThan(CREATE_OPERATION_TIMEOUT_MS);
    expect(DELETE_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      DELETE_OPERATION_TIMEOUT_MS + 2 * DELETE_POSTCONDITION_TIMEOUT_MS
    );
    expect(
      globalTimeout - SERIAL_TEST_TIMEOUT_BUDGET_MS
    ).toBeGreaterThanOrEqual(CLOUD_HOOK_TEARDOWN_HEADROOM_MS);
    expect(CREATE_TEST_TIMEOUT_MS).toBeLessThan(
      CLOUD_INSTALLATION_TOKEN_LIFETIME_MS
    );
    expect(DELETE_TEST_TIMEOUT_MS).toBeLessThan(
      CLOUD_INSTALLATION_TOKEN_LIFETIME_MS
    );
  });

  it("keeps its output apart so neither tier erases the other's traces", () => {
    expect(cloudConfig.outputDir).toBe("test-results/cloud");
    expect(cloudConfig.outputDir).not.toBe(chromiumConfig.outputDir);
    const htmlReporter = (cloudConfig.reporter as [string, unknown][]).find(
      (entry) => entry[0] === "html"
    );
    expect(htmlReporter?.[1]).toMatchObject({
      outputFolder: path.join(packageRoot, "playwright-report-cloud")
    });
  });

  it("installs the same credential-store isolation the Chromium tier needs", () => {
    expect(cloudConfig.globalSetup).toBe(chromiumConfig.globalSetup);
    expect(cloudConfig.globalTeardown).toBe(chromiumConfig.globalTeardown);
  });

  it("retains a trace and a screenshot for a run nobody can reproduce locally", () => {
    expect(cloudConfig.use?.trace).toBe("retain-on-failure");
    expect(cloudConfig.use?.screenshot).toBe("only-on-failure");
    expect(cloudConfig.use?.headless).toBe(true);
  });
});

describe("the cloud tier's file sets", () => {
  it("names every journey so this config, and only this config, collects it", async () => {
    const files = await readdir(path.join(packageRoot, "test", "e2e-cloud"));
    const specs = files.filter((file) => file.endsWith(".spec.ts"));
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((file) => file.endsWith(".cloud.spec.ts"))).toBe(true);
  });

  it("keeps the journey out of the Vitest run that has no credentials", () => {
    const include = vitestConfig.test?.include ?? [];
    expect(include).toContain("test/e2e-cloud/**/*.test.ts");
    expect(include.some((pattern) => pattern.includes(".spec.ts"))).toBe(false);
  });

  it("leaves the Chromium tier collecting only its own spec", () => {
    expect(chromiumConfig.testMatch).toBe("canvas-chromium.test.ts");
  });
});

describe("the cloud tier's package scripts", () => {
  it("resolves test:cloud to this config", async () => {
    const manifest = await packageManifest();
    expect(manifest.scripts["test:cloud"]).toBe(
      "playwright test --config playwright.cloud.config.ts"
    );
  });

  it("lints the new config, which the enumerated file list would otherwise skip", async () => {
    const manifest = await packageManifest();
    expect(manifest.scripts.lint).toContain("playwright.cloud.config.ts");
  });
});
