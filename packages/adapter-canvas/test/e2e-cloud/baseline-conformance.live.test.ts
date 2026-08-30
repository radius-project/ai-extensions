// The conformance check against the real fixture repository.
//
// Opt-in, following `deploy-dispatch-az-contract.live.test.ts`: it is collected
// on every run but skips unless `RADIUS_CLOUD_E2E` is set *and* the fixture
// repository constants have been provisioned, so `pnpm test` is never broken by
// an absent credential or a placeholder SHA.
//
// The compile port is the product's own `buildGraphViaRad` rather than a second
// Bicep invocation, so a baseline this check accepts is one the product can
// actually compile, resolved against the same managed `rad` and the same Radius
// extension reference.
import { describe, expect, it } from "vitest";
import { buildGraphViaRad } from "@radius-project/adapter-shared";
import {
  assertBaselineConformance,
  type BaselineCompileResult
} from "./support/baseline-conformance.js";
import {
  createNodeCloudFixturePorts,
  describeError,
  expectSuccess,
  parseJsonArray,
  type CloudCommandPort
} from "./support/cloud-command-port.js";
import {
  describeUnprovisionedFixtureRepository,
  FIXTURE_BASELINE_SHA,
  FIXTURE_RADIUS_DIRECTORY,
  FIXTURE_REPOSITORY,
  isFixtureRepositoryProvisioned
} from "./support/fixture-repository.js";

const ENABLED =
  !!process.env.RADIUS_CLOUD_E2E && isFixtureRepositoryProvisioned();

const APP_BICEP = `${FIXTURE_RADIUS_DIRECTORY}/app.bicep`;

async function listBaselineFiles(
  commands: CloudCommandPort
): Promise<string[]> {
  const context = `gh api git/trees of ${FIXTURE_REPOSITORY}@${FIXTURE_BASELINE_SHA}`;
  const paths = parseJsonArray(
    await commands.runGh([
      "api",
      `repos/${FIXTURE_REPOSITORY}/git/trees/${FIXTURE_BASELINE_SHA}?recursive=1`,
      "--jq",
      '[.tree[] | select(.type == "blob") | .path]'
    ]),
    context
  );
  const prefix = `${FIXTURE_RADIUS_DIRECTORY}/`;
  return paths
    .filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.startsWith(prefix)
    )
    .map((entry) => entry.slice(prefix.length));
}

async function compileBaseline(
  commands: CloudCommandPort
): Promise<BaselineCompileResult> {
  const content = expectSuccess(
    await commands.runGh([
      "api",
      `repos/${FIXTURE_REPOSITORY}/contents/${APP_BICEP}?ref=${FIXTURE_BASELINE_SHA}`,
      "--header",
      "Accept: application/vnd.github.raw"
    ]),
    `gh api contents/${APP_BICEP}@${FIXTURE_BASELINE_SHA}`
  ).stdout;

  const diagnostics: string[] = [];
  try {
    const resources = await buildGraphViaRad(content, APP_BICEP, {
      log: (message: string) => diagnostics.push(message)
    });
    // An application that compiles to nothing is not a usable journey subject,
    // so it is a conformance failure rather than a silent pass.
    if (resources.length === 0)
      return {
        ok: false,
        diagnostics: [...diagnostics, "The baseline compiled to no resources."]
      };
    return { ok: true, diagnostics };
  } catch (error) {
    return { ok: false, diagnostics: [...diagnostics, describeError(error)] };
  }
}

describe.skipIf(!ENABLED)(
  `pinned baseline of ${FIXTURE_REPOSITORY}@${FIXTURE_BASELINE_SHA.slice(0, 8)}`,
  () => {
    it("carries every required staged file and still compiles", async () => {
      const commands = createNodeCloudFixturePorts().commands;

      const result = await assertBaselineConformance({
        listBaselineFiles: () => listBaselineFiles(commands),
        compileBaseline: () => compileBaseline(commands)
      });

      expect(result.ok).toBe(true);
    }, 300_000);
  }
);

// Always runs, credentials or not: the guard that keeps a placeholder from
// masquerading as a passing cloud check is itself worth a test.
describe("live conformance gating", () => {
  it("stays disabled until the fixture repository is provisioned", () => {
    if (isFixtureRepositoryProvisioned()) {
      expect(describeUnprovisionedFixtureRepository()).toBe(
        "The fixture repository is provisioned."
      );
      return;
    }
    expect(ENABLED).toBe(false);
    expect(describeUnprovisionedFixtureRepository()).toContain(
      "not provisioned yet"
    );
  });
});
