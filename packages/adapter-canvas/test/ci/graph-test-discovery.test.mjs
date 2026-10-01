import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);
const adapterRoot = join(repoRoot, "packages", "adapter-canvas");
const runner = join(repoRoot, "node_modules", "vitest", "vitest.mjs");

describe("shared graph test discovery", () => {
  it.each([
    {
      gate: "pull-request coverage",
      cwd: repoRoot,
      config: "vitest.config.ts"
    },
    {
      gate: "scheduled reliability",
      cwd: adapterRoot,
      config: "vitest.reliability.config.ts"
    }
  ])("keeps migrated suites executable in $gate", ({ cwd, config }) => {
    const specifications = JSON.parse(
      execFileSync(
        process.execPath,
        [runner, "list", "--filesOnly", "--json", "--config", config],
        { cwd, encoding: "utf8", timeout: 10_000 }
      )
    );
    const files = specifications.map(({ file }) =>
      relative(repoRoot, file).replaceAll("\\", "/")
    );
    expect(files).toEqual(
      expect.arrayContaining([
        ...[
          "build",
          "details",
          "external-url",
          "html",
          "layout",
          "legend",
          "model",
          "node"
        ].map((name) => `packages/graph-react/src/${name}.test.ts`),
        "packages/graph-react/src/graph.browser.test.ts",
        "packages/adapter-canvas/src/browser/graph/surface.test.ts",
        "packages/adapter-canvas/src/browser/graph/navigation.test.ts",
        "packages/adapter-canvas/src/browser/graph/progress.test.ts",
        "packages/adapter-canvas/test/integration/http/liveness-source.test.ts",
        "packages/adapter-canvas/test/integration/http/graphs-planning.test.ts",
        "packages/adapter-canvas/test/e2e-cloud/support/cloud-command-port.test.ts",
        "packages/adapter-canvas/test/e2e-cloud/support/cloud-fixture.test.ts"
      ])
    );
    expect(
      specifications.find(({ file }) =>
        file
          .replaceAll("\\", "/")
          .endsWith("/graph-react/src/graph.browser.test.ts")
      )
    ).toMatchObject({ projectName: "graph-react-component (chromium)" });
  });

  it("provisions Chromium before the cross-platform reliability command", () => {
    const workflow = parse(
      readFileSync(
        join(repoRoot, ".github", "workflows", "canvas-reliability.yml"),
        "utf8"
      )
    );
    const steps = workflow.jobs.resilience.steps;
    const install = steps.findIndex(
      (step) => step.run === "pnpm exec playwright install --with-deps chromium"
    );
    const run = steps.findIndex(
      (step) => step.run === "pnpm run test:reliability"
    );
    expect(install).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(install);
  });
});
