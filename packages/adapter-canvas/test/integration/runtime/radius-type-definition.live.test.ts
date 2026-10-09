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
  "extensions",
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
// The "Provisioned service usernames" section of the radius-app-bicep skill's
// references/secrets-handling.md depends on these upstream contract facts.
// The resolved schema keeps no property descriptions, so the RabbitMQ check
// asserts that username is readable and not sensitive instead of matching the
// "exposed as a read-only connection value" description.
const GUIDANCE = "Provisioned service usernames in secrets-handling.md";
const usernameTypes = [
  "Radius.Messaging/rabbitMQ",
  "Radius.Data/mySqlDatabases",
  "Radius.Data/postgreSqlDatabases",
  "Radius.Data/sqlServerDatabases"
] as const;
const adminLoginTypes = new Set<string>([
  "Radius.Data/mySqlDatabases",
  "Radius.Data/postgreSqlDatabases",
  "Radius.Data/sqlServerDatabases"
]);
const ADMIN_LOGIN_MAPPING =
  /^\s*administratorLogin:\s*'\{\{context\.resource\.properties\.username\}\}'\s*(?:\/\/.*)?$/mu;

interface ResolvedResource {
  type: string;
  schema: {
    properties?: {
      properties?: { properties?: Record<string, Record<string, unknown>> };
    };
  };
  recipe?: { status?: string; definition?: unknown };
}

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

  it("keeps the upstream username contract the skill guidance relies on", async () => {
    const cacheRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "radius-type-live-")
    );
    try {
      const contract = await resolver.resolveRadiusTypes([...usernameTypes], {
        cacheRoot,
        processTimeoutMs: 30_000,
        fetchTimeoutMs: 30_000
      });

      expect(contract.notFound, `${GUIDANCE} names these types`).toEqual([]);
      const resources = contract.resources as ResolvedResource[];
      expect(resources.map((resource) => resource.type)).toEqual(usernameTypes);

      for (const resource of resources) {
        const username =
          resource.schema.properties?.properties?.properties?.username;
        expect(
          username,
          `${GUIDANCE} sets username on ${resource.type}, so its schema must define it`
        ).toBeDefined();
        expect(
          username?.type,
          `${GUIDANCE} writes a string username on ${resource.type}`
        ).toBe("string");
        expect(
          username?.readOnly,
          `${GUIDANCE} sets username on ${resource.type}, so it must stay writable`
        ).not.toBe(true);

        if (resource.type === "Radius.Messaging/rabbitMQ") {
          expect(
            username?.writeOnly,
            `${GUIDANCE} binds consumers to rabbitMQ.properties.username, so it must stay readable`
          ).not.toBe(true);
          expect(
            username?.sensitive,
            `${GUIDANCE} passes rabbitMQ.properties.username through plain env.value, so it must not be sensitive`
          ).not.toBe(true);
        }

        if (adminLoginTypes.has(resource.type)) {
          expect(
            resource.recipe?.status,
            `${GUIDANCE} keeps the existing username on refresh because the Azure pack maps it to administratorLogin for ${resource.type}`
          ).toBe("available");
          expect(
            resource.recipe?.definition,
            `${GUIDANCE} keeps the existing username on refresh because the Azure pack maps it to administratorLogin for ${resource.type}`
          ).toMatch(ADMIN_LOGIN_MAPPING);
        }
      }
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
