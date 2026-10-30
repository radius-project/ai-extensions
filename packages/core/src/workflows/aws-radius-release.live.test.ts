// Opt-in live check of the AWS Radius runtime default: the installer checksum
// must match radius-project/radius deploy/install.sh at the pinned commit, and
// the catalog at that commit must carry the aws-eks recipe pack. Runs with the
// other live workflow suites when RUN_LIVE_WORKFLOW_TESTS is set.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { fetchExtensionFile } from "../../test/support/live-github.js";
import { AWS_RADIUS_RELEASE } from "./aws-radius-release.js";

const LIVE = !!process.env.RUN_LIVE_WORKFLOW_TESTS;

describe.skipIf(!LIVE)("the AWS Radius runtime default (live)", () => {
  it("pins the installer checksum at its commit", async () => {
    const installer = await fetchExtensionFile(
      "radius-project/radius",
      "deploy",
      "install.sh",
      AWS_RADIUS_RELEASE.commit
    );
    expect(createHash("sha256").update(installer).digest("hex")).toBe(
      AWS_RADIUS_RELEASE.checksum
    );
  }, 30_000);

  it("reads a catalog that carries the aws-eks recipe pack", async () => {
    const catalog = parseYaml(
      await fetchExtensionFile(
        "radius-project/radius",
        "deploy/manifest",
        "defaults.yaml",
        AWS_RADIUS_RELEASE.commit
      )
    ) as { recipePacks?: { name?: string; ref?: string }[] };
    expect(
      catalog.recipePacks?.find((pack) => pack.name === "aws-eks")?.ref
    ).toMatch(/^[0-9a-f]{40}$/u);
  }, 30_000);
});
