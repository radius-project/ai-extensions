// End-to-end test for @radius-project/core.
//
// Exercises the full UI-agnostic product pipeline a UI adapter drives when a
// user models a repository and ships it with Radius:
//
//   1. Model the repository    — parse docker-compose + Terraform sources.
//   2. Build the app graph     — Bicep -> application graph (CLI or regex path).
//   3. Diff two graphs         — base vs. head branch comparison.
//   4. Select a platform       — Azure / AWS compute-platform registry.
//   5. Generate workflows      — verify + deploy GitHub Actions YAML.
//   6. Model an ARM template   — symbolic-name graph build + diff hashing.
//
// Everything here is driven through the package's public API surface
// (src/index.ts) and uses only deterministic, port-free functions, so the test
// runs without any network, GitHub, or SDK access.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  // modeling
  parseComposeServices,
  parseTerraformResources,
  formatTerraformType,
  // graph
  buildGraphFromBicep,
  computeGraphDiff,
  buildModeledGraph,
  buildResourceID,
  computeDiffHash,
  MODELED_GRAPH_DEFAULTS,
  // platforms
  listPlatforms,
  getPlatform,
  generatePortalUrl,
  // workflows
  generateVerifyWorkflow,
  generateDeployWorkflow,
  RADIUS_CORE_VERSION,
} from "@radius-project/core";

// --- Fixtures: a small "todo app" repo (web container + database) -----------

const COMPOSE = `
version: "3.9"
services:
  frontend:
    build: ./frontend
    ports:
      - "8080:3000"
    depends_on:
      - db
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: example
`;

const TERRAFORM = `
resource "aws_db_instance" "mysql" {
  engine = "mysql"
}

module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
}
`;

// A Radius bicep app: a frontend container connected to a SQL database. The
// `application` is a parameter (not a resource), matching how Radius app.bicep
// is generated.
const APP_BICEP = `
param application string

resource frontend 'Applications.Core/containers@2023-10-01-preview' = {
  name: 'frontend'
  properties: {
    application: application
    connections: {
      db: {
        source: database.id
      }
    }
  }
}

resource database 'Applications.Datastores/sqlDatabases@2023-10-01-preview' = {
  name: 'database'
  properties: {
    application: application
  }
}
`;

// The head branch adds a Redis cache that the frontend also connects to.
const APP_BICEP_HEAD = `
param application string

resource frontend 'Applications.Core/containers@2023-10-01-preview' = {
  name: 'frontend'
  properties: {
    application: application
    connections: {
      db: {
        source: database.id
      }
      cache: {
        source: cache.id
      }
    }
  }
}

resource database 'Applications.Datastores/sqlDatabases@2023-10-01-preview' = {
  name: 'database'
  properties: {
    application: application
  }
}

resource cache 'Applications.Datastores/redisCaches@2023-10-01-preview' = {
  name: 'cache'
  properties: {
    application: application
  }
}
`;

const findByName = (resources, name) => resources.find((r) => r.name === name);

test("package exposes a version", () => {
  assert.equal(typeof RADIUS_CORE_VERSION, "string");
  assert.match(RADIUS_CORE_VERSION, /^\d+\.\d+\.\d+$/);
});

test("step 1: models a docker-compose + terraform repository", () => {
  const services = parseComposeServices(COMPOSE);
  const names = services.map((s) => s.name).sort();
  assert.deepEqual(names, ["db", "frontend"]);

  const frontend = findByName(services, "frontend");
  assert.equal(frontend.hasDockerfile, true, "frontend builds from a Dockerfile");
  assert.equal(frontend.port, 3000, "container port parsed from the mapping");
  assert.equal(frontend.dependsOnDb, true, "frontend depends_on db");

  const db = findByName(services, "db");
  assert.equal(db.image, "postgres:16");

  const tf = parseTerraformResources(TERRAFORM);
  const rds = findByName(tf, "mysql");
  assert.ok(rds, "aws_db_instance resource discovered");
  assert.equal(rds.provider, "aws");
  assert.equal(formatTerraformType(rds.type), "AWS Db Instance");

  const vpc = findByName(tf, "vpc");
  assert.ok(vpc, "terraform module discovered");
  assert.equal(vpc.displayType, "AWS VPC Module");
});

test("step 2: builds an application graph from bicep", async () => {
  const resources = await buildGraphFromBicep(APP_BICEP);
  assert.ok(resources.length >= 2, "graph has the modeled resources");

  const frontend = findByName(resources, "frontend");
  const database = findByName(resources, "database");
  assert.ok(frontend, "frontend container is in the graph");
  assert.ok(database, "database is in the graph");

  // IDs follow the canonical Radius resource-id layout regardless of whether
  // the bicep-CLI path or the regex fallback produced the graph.
  assert.equal(
    database.id,
    buildResourceID("Applications.Datastores/sqlDatabases", "database"),
  );
  assert.ok(
    database.id.includes(`/${MODELED_GRAPH_DEFAULTS.plane}/`),
    "id embeds the default plane",
  );

  // The frontend declares an outbound connection to the database.
  const outbound = (frontend.connections || []).find(
    (c) => c.direction === "Outbound" && c.id === database.id,
  );
  assert.ok(outbound, "frontend -> database outbound connection present");

  // ...and the database gets the mirrored inbound connection.
  const inbound = (database.connections || []).find(
    (c) => c.direction === "Inbound" && c.id === frontend.id,
  );
  assert.ok(inbound, "database <- frontend inbound connection mirrored");
});

test("step 3: diffs the base and head graphs", async () => {
  const base = await buildGraphFromBicep(APP_BICEP);
  const head = await buildGraphFromBicep(APP_BICEP_HEAD);

  const diff = computeGraphDiff(base, head);
  const status = (name) => findByName(diff, name)?.diffStatus;

  // The cache is new on the head branch.
  assert.equal(status("cache"), "added", "redis cache reported as added");

  // The database is structurally unchanged across branches.
  assert.equal(status("database"), "unchanged", "database unchanged");

  // The frontend gained a connection, so it is reported as modified.
  assert.equal(status("frontend"), "modified", "frontend connection added");

  // Nothing was removed.
  assert.equal(
    diff.some((r) => r.diffStatus === "removed"),
    false,
    "no resources removed between branches",
  );
});

test("step 4: selects compute platforms from the registry", () => {
  const platforms = listPlatforms();
  const ids = platforms.map((p) => p.id).sort();
  assert.deepEqual(ids, ["aws", "azure"]);

  const azure = getPlatform("azure");
  assert.ok(azure, "azure platform registered");
  assert.equal(azure.displayName, "Azure");
  assert.equal(azure.supports.oidc, true);

  assert.equal(getPlatform("does-not-exist"), undefined, "unknown id -> undefined");

  // Portal deep links are produced for capable platforms.
  const url = generatePortalUrl("Microsoft.DBforPostgreSQL/flexibleServers", "azure", {
    oidcAzure: { subscriptionId: "sub-123" },
    deployParams: { resourceGroup: "rg-demo" },
  });
  assert.match(url, /^https:\/\/portal\.azure\.com\//, "azure portal URL");
  assert.match(url, /sub-123/);
  assert.match(url, /rg-demo/);

  // Unknown platform yields an empty link rather than throwing.
  assert.equal(generatePortalUrl("anything", "nope", {}), "");
});

test("step 5: generates verify and deploy workflows per platform", () => {
  const azure = getPlatform("azure");
  const aws = getPlatform("aws");

  const verify = generateVerifyWorkflow("production", azure);
  assert.match(verify, /name: Radius - Verify Credentials/);
  assert.match(verify, /default: 'production'/, "env threaded into the workflow");
  assert.match(verify, /Provider: azure/);
  assert.ok(verify.includes(azure.verifyWorkflowSteps.trim().split("\n")[0]));

  const deploy = generateDeployWorkflow("production", aws, ".radius/app.bicep");
  assert.match(deploy, /name: Deploy Radius Application/);
  assert.ok(
    deploy.includes(aws.radCredentialRegister.split("\n")[0]),
    "platform-specific rad credential register injected",
  );

  // Azure and AWS produce distinct deploy workflows (different cluster auth).
  const deployAzure = generateDeployWorkflow("production", azure, ".radius/app.bicep");
  assert.notEqual(deploy, deployAzure, "workflow content is platform-specific");
});

test("step 6: builds + hashes a graph from a symbolic ARM template", () => {
  // Mirrors the languageVersion 2.0 (symbolic-name) output of `bicep build`.
  const template = {
    resources: {
      frontend: {
        type: "Applications.Core/containers@2023-10-01-preview",
        properties: {
          name: "frontend",
          properties: {
            connections: {
              db: { source: "[reference('database').id]" },
            },
          },
        },
        dependsOn: ["database"],
      },
      database: {
        type: "Applications.Datastores/sqlDatabases@2023-10-01-preview",
        properties: { name: "database", properties: {} },
      },
    },
  };

  const graph = buildModeledGraph(template);
  assert.equal(graph.resources.length, 2);

  const frontend = findByName(graph.resources, "frontend");
  const database = findByName(graph.resources, "database");

  // The symbolic reference was rewritten to a concrete resource id and resolved
  // into an outbound connection.
  const dbId = buildResourceID("Applications.Datastores/sqlDatabases", "database");
  assert.ok(
    frontend.connections.some((c) => c.id === dbId && c.direction === "Outbound"),
    "symbolic connection resolved to outbound edge",
  );
  assert.ok(
    database.connections.some((c) => c.direction === "Inbound"),
    "inbound edge mirrored onto the database",
  );

  // Every resource carries a deterministic, content-addressed diff hash.
  assert.match(frontend.diffHash, /^sha256:[0-9a-f]{64}$/);

  // computeDiffHash ignores runtime-bound, non-authorable properties.
  const authored = { foo: "bar" };
  assert.equal(
    computeDiffHash(authored),
    computeDiffHash({ ...authored, provisioningState: "Succeeded", status: {} }),
    "non-authorable properties excluded from the hash",
  );
  assert.notEqual(
    computeDiffHash({ foo: "bar" }),
    computeDiffHash({ foo: "baz" }),
    "authorable changes change the hash",
  );
});
