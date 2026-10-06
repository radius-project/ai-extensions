import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Windows pull-request test gate", () => {
  it("runs the portable filesystem, resolver and built-artifact suites on Windows", () => {
    const workflow = parse(
      readFileSync(
        new URL("../../../../.github/workflows/build.yml", import.meta.url),
        "utf8"
      )
    );
    const job = workflow.jobs["windows-process-integration"];
    expect(job["runs-on"]).toBe("windows-latest");
    const commands = job.steps
      .filter((step) => typeof step.run === "string")
      .map((step) => step.run);
    expect(commands).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm run test:integration:windows-process",
      "pnpm --filter @radius-project/adapter-canvas exec vitest run src/credential-provenance-store.test.ts src/operation-store.test.ts test/integration/runtime/radius-type-definition.test.ts",
      "pnpm run build",
      "pnpm run test:integration:artifact"
    ]);
  });
});
