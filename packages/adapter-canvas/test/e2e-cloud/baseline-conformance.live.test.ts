// The conformance check against the real fixture repository.
//
// Opt-in, following the structure of the existing `.live.test.ts` files: it is
// collected on every run but skipped unless explicitly enabled. Unlike those
// files, this check is deliberately gated on `RADIUS_CLOUD_E2E` and is not run
// by `live-tests.yml`, because it needs the provisioned fixture repository, not
// only a live CLI. Provisioning placeholders keep the normal suite skipped too.
//
// The compile port is the product's own `buildGraphViaRad` rather than a second
// Bicep invocation, so a baseline this check accepts is one the product can
// actually compile, resolved against the same managed `rad` and the same Radius
// extension reference.
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { buildGraphViaRad } from "@radius-project/adapter-shared";
import {
  assertBaselineConformance,
  compileBaselineWorkspace
} from "./support/baseline-conformance.js";
import {
  createNodeCloudFixturePorts,
  expectSuccess,
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

async function listBaselineFiles(
  commands: CloudCommandPort,
  workspacePath: string
): Promise<string[]> {
  const paths = expectSuccess(
    await commands.runGit(
      ["ls-tree", "-r", "--name-only", "HEAD", "--", FIXTURE_RADIUS_DIRECTORY],
      workspacePath
    ),
    `git ls-tree of ${FIXTURE_REPOSITORY}@${FIXTURE_BASELINE_SHA}`
  )
    .stdout.split(/\r?\n/)
    .filter(Boolean);
  const prefix = `${FIXTURE_RADIUS_DIRECTORY}/`;
  return paths
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length));
}

describe.skipIf(!ENABLED)(
  `pinned baseline of ${FIXTURE_REPOSITORY}@${FIXTURE_BASELINE_SHA.slice(0, 8)}`,
  () => {
    it("carries every required staged file and still compiles", async () => {
      const ports = createNodeCloudFixturePorts();
      const workspacePath = await ports.makeWorkspaceDir(
        "radtest-canvas-conformance"
      );
      let failure: unknown;
      try {
        expectSuccess(
          await ports.commands.runGh([
            "repo",
            "clone",
            FIXTURE_REPOSITORY,
            workspacePath
          ]),
          `gh repo clone ${FIXTURE_REPOSITORY}`
        );
        expectSuccess(
          await ports.commands.runGit(
            ["reset", "--hard", FIXTURE_BASELINE_SHA],
            workspacePath
          ),
          `git reset --hard ${FIXTURE_BASELINE_SHA}`
        );

        const result = await assertBaselineConformance({
          listBaselineFiles: () =>
            listBaselineFiles(ports.commands, workspacePath),
          compileBaseline: () =>
            compileBaselineWorkspace(workspacePath, FIXTURE_RADIUS_DIRECTORY, {
              readTextFile: (file) => fs.readFile(file, "utf8"),
              buildGraph: buildGraphViaRad
            })
        });
        expect(result.ok).toBe(true);
      } catch (error) {
        failure = error;
      }

      try {
        await ports.removeDir(workspacePath);
      } catch (cleanupError) {
        if (failure)
          throw new AggregateError(
            [failure, cleanupError],
            `Baseline conformance and cleanup both failed for ${workspacePath}.`,
            { cause: cleanupError }
          );
        throw new Error(
          `Baseline conformance failed to remove ${workspacePath}: ${
            cleanupError instanceof Error ?
              cleanupError.message
            : String(cleanupError)
          }`,
          { cause: cleanupError }
        );
      }
      if (failure) throw failure;
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
