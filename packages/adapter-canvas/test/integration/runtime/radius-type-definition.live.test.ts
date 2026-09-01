// Opt-in compatibility test for the latest stable Radius release. The
// synthetic radius-type-definition fixture keeps pull-request tests hermetic,
// but it cannot reveal an upstream change to the generated index or type-file
// shapes. This test asks a real rad binary for its exact source commit and then
// exercises the resolver against the generated definitions at that commit.
//
// The live-upstream workflow enables this test only on scheduled and manual
// runs. It intentionally does not run in the default pull-request suite because
// it downloads a released CLI and definitions from public GitHub endpoints.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const LIVE = process.env.RUN_LIVE_RADIUS_TYPE_DEFINITION_TESTS === "1";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
);
const script = path.join(
  root,
  "plugins",
  "radius",
  "skills",
  "radius-app-bicep",
  "scripts",
  "show-radius-type.mjs"
);
const resolver = await import(pathToFileURL(script).href);
const representativeTypes = [
  "Radius.Core/applications",
  "Radius.Compute/containers",
  "Radius.Data/redisCaches",
  "Radius.AI/models"
] as const;

describe.skipIf(!LIVE)("live generated Radius definition compatibility", () => {
  it("resolves representative definitions from the managed Radius release", async () => {
    const cacheRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "radius-type-live-")
    );
    try {
      const contract = await resolver.resolveRadiusTypes(
        [...representativeTypes],
        {
          cacheRoot,
          processTimeoutMs: 30_000,
          fetchTimeoutMs: 30_000
        }
      );

      expect(contract.extension).toMatch(
        /^br:biceptypes\.azurecr\.io\/radius:/u
      );
      expect(contract.notFound).toEqual([]);
      expect(
        contract.resources.map((resource: { type: string }) => resource.type)
      ).toEqual(representativeTypes);
      const containers = contract.resources.find(
        (resource: { type: string }) =>
          resource.type === "Radius.Compute/containers"
      );
      expect(containers?.recipe).toMatchObject({
        status: "available",
        provenance: "managed-release-default",
        recipePack: "azure",
        repository: "radius-project/resource-types-contrib",
        commit: expect.stringMatching(/^[0-9a-f]{40}$/u),
        path: "recipe-packs/azure/aks-recipepack.bicep",
        definition: expect.stringContaining("'Radius.Compute/containers':")
      });
      for (const resource of contract.resources) {
        expect(resource.apiVersion).toMatch(/^\d{4}-\d{2}-\d{2}/u);
        expect(resource.schema).toMatchObject({
          type: "object",
          properties: {
            name: { type: "string" },
            properties: { type: "object" }
          },
          required: expect.arrayContaining(["name", "properties"])
        });
      }
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
