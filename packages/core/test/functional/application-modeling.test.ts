// Functional: the application-modeling journey a Radius UI drives end to end.
//
// Unit tests pin each module in isolation; this suite proves the modules
// compose — that the contract one step emits is the contract the next step
// consumes. Everything runs through real core functions with a single seam
// faked: the injected GitHub port. Nothing touches the network, the shell, or
// the filesystem.
//
// Journey: list the branch -> decide the repository is modelable -> fetch the
// authored model -> judge its freshness -> convert the rad graph -> filter it
// for display -> resolve recipes to concrete resources -> project the deployed
// view.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  applicationGraphToResources,
  evaluateAppModelFreshness,
  evaluateAppSource,
  fetchBicepFromRepo,
  fetchRecipePack,
  filterGraphVisualizationResources,
  normalizeAppBicep,
  projectDeployedGraph,
  resolveRecipeOutputs,
  serializeAppOrigin,
  unsupportedAppSourceReport,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE
} from "../../src/index.js";
import { recipePackContentPath } from "../../src/modeling/recipe-pack.js";
import { createFakeGitHub } from "../support/fake-github.js";
import {
  API_ID,
  APP_BICEP,
  APP_BICEP_WITH_CACHE,
  AZURE_RECIPE_PACK,
  CACHE_ID,
  contentsPath,
  DB_ID,
  HEAD_BRANCH,
  IMAGE_ID,
  KUBERNETES_RECIPE_PACK,
  REGISTRY_SECRET_ID,
  REPO,
  appGraphPayload
} from "../fixtures/storefront-app.js";

// The adapter injects a Node hasher because core stays free of node built-ins;
// the functional journey uses the same primitive the real writer does.
function hashAppBicep(content: string): string {
  return `sha256:${createHash("sha256")
    .update(normalizeAppBicep(content))
    .digest("hex")}`;
}

const SOURCE_COMMIT = "0".repeat(40);
const HEAD_COMMIT = "1".repeat(40);

const SOURCE_LISTING = [
  "README.md",
  "Dockerfile",
  "src/api/index.ts",
  ".radius/app.bicep",
  ".radius/app.origin.json",
  "node_modules/vendored/Dockerfile",
  ".devcontainer/Dockerfile"
];

function githubForHead(options: { modelAtRoot?: boolean } = {}) {
  const modelPath = options.modelAtRoot ? "app.bicep" : ".radius/app.bicep";
  return createFakeGitHub({
    trees: {
      [`${REPO}@${HEAD_BRANCH}`]: SOURCE_LISTING
    },
    files: {
      [contentsPath(REPO, modelPath, HEAD_BRANCH)]: APP_BICEP_WITH_CACHE,
      [contentsPath(REPO, ".radius/app.origin.json", HEAD_BRANCH)]:
        serializeAppOrigin({
          generatedAt: "2026-01-01T00:00:00.000Z",
          sourceCommit: SOURCE_COMMIT,
          skillVersion: "1.4.0",
          appBicepHash: hashAppBicep(APP_BICEP_WITH_CACHE)
        }),
      [recipePackContentPath("azure")]: AZURE_RECIPE_PACK,
      [recipePackContentPath("kubernetes")]: KUBERNETES_RECIPE_PACK
    },
    absent:
      options.modelAtRoot ?
        [contentsPath(REPO, ".radius/app.bicep", HEAD_BRANCH)]
      : []
  });
}

describe("application modeling journey", () => {
  it("carries a containerized repository from source listing to deployed view", async () => {
    const gh = githubForHead();

    const source = evaluateAppSource(await gh.treePaths(REPO, HEAD_BRANCH));
    expect(source).toEqual({ status: "single", dockerfiles: ["Dockerfile"] });

    const model = await fetchBicepFromRepo(gh, REPO, HEAD_BRANCH);
    expect(model).toBe(APP_BICEP_WITH_CACHE);

    const freshness = evaluateAppModelFreshness({
      model,
      originText: await gh.getContent(
        contentsPath(REPO, ".radius/app.origin.json", HEAD_BRANCH)
      ),
      headCommit: HEAD_COMMIT,
      sourceChanged: false,
      generatorVersion: "1.4.0",
      hashAppBicep
    });
    expect(freshness.status).toBe("up-to-date");
    expect(freshness.stale).toBe(false);

    const modeled = applicationGraphToResources(
      appGraphPayload({ withCache: true }),
      ".radius/app.bicep",
      model ?? ""
    );
    expect(modeled.map((r) => r.id)).toEqual([
      API_ID,
      DB_ID,
      IMAGE_ID,
      REGISTRY_SECRET_ID,
      CACHE_ID
    ]);

    // Inbound edges are synthesized from the authored outbound ones, so the
    // database knows the container depends on it without rad emitting it.
    const database = modeled.find((r) => r.id === DB_ID);
    expect(database.connections).toEqual([
      { id: API_ID, direction: "Inbound" }
    ]);

    // The container node anchors back to its authored declaration line.
    const container = modeled.find((r) => r.id === API_ID);
    const bicepLines = APP_BICEP_WITH_CACHE.split("\n");
    expect(bicepLines[container.definitionLine - 1]).toContain("resource api ");
    expect(container.definitionFile).toBe(".radius/app.bicep");
    expect(container.codeReference).toBe("src/api/index.ts#L1");

    // The build-only image and its reserved registry secret are display noise.
    const visible = filterGraphVisualizationResources(modeled);
    expect(visible.map((r) => r.id)).toEqual([API_ID, DB_ID, CACHE_ID]);
    expect(
      visible
        .find((r) => r.id === API_ID)
        .connections.map((c: { id: string }) => c.id)
    ).not.toContain(IMAGE_ID);

    // Recipes resolve each abstract resource to the concrete Azure resource the
    // pack's recipe deploys.
    const recipes = await fetchRecipePack(gh, "azure");
    const planned = await resolveRecipeOutputs(gh, visible, recipes, "azure");
    expect(
      planned.map((r: any) => [r.name, r.outputResources[0]?.displayType])
    ).toEqual([
      ["api", "Azure Kubernetes Service"],
      ["orders", "Azure Database for PostgreSQL"],
      ["sessions", "Azure Cache for Redis Enterprise"]
    ]);

    // The deployed view keeps the modeled topology and paints it with status.
    const deployed = projectDeployedGraph(planned, {
      [API_ID]: "success",
      "orders|radius.data/postgresqldatabases": "in_progress"
    });
    expect(
      deployed.map((r: any) => [r.name, r.deployStatus, r.outputResources])
    ).toEqual([
      ["api", "success", []],
      ["orders", "in_progress", []],
      ["sessions", "pending", []]
    ]);
  });

  it("falls back to a root app.bicep only after the .radius location misses", async () => {
    const gh = githubForHead({ modelAtRoot: true });

    const model = await fetchBicepFromRepo(gh, REPO, HEAD_BRANCH);

    expect(model).toBe(APP_BICEP_WITH_CACHE);
    expect(gh.reads).toEqual([
      contentsPath(REPO, ".radius/app.bicep", HEAD_BRANCH),
      contentsPath(REPO, "app.bicep", HEAD_BRANCH)
    ]);
  });

  it("reports a repository with no application Dockerfile as unmodelable", () => {
    const source = evaluateAppSource([
      "README.md",
      "src/api/index.ts",
      "node_modules/vendored/Dockerfile",
      ".devcontainer/Dockerfile"
    ]);

    expect(source).toEqual({ status: "none", dockerfiles: [] });

    const report = unsupportedAppSourceReport(REPO);
    expect(report).toContain(UNSUPPORTED_NO_DOCKERFILE_MESSAGE);
    expect(report).toContain(REPO);
    expect(report).toContain("no .radius files were written");
  });

  it("treats an unresolvable listing as unknown rather than unmodelable", async () => {
    const gh = createFakeGitHub();

    const paths = await gh.treePaths(REPO, HEAD_BRANCH).catch(() => []);

    expect(evaluateAppSource(paths)).toEqual({
      status: "unknown",
      dockerfiles: []
    });
  });

  it("requires confirmation before regenerating a hand-edited stale model", async () => {
    const gh = githubForHead();
    const originText = await gh.getContent(
      contentsPath(REPO, ".radius/app.origin.json", HEAD_BRANCH)
    );

    // The model on the branch is not the one the recorded generation produced.
    const freshness = evaluateAppModelFreshness({
      model: APP_BICEP,
      originText,
      headCommit: HEAD_COMMIT,
      sourceChanged: true,
      generatorVersion: "1.4.0",
      hashAppBicep
    });

    expect(freshness.status).toBe("manually-edited");
    expect(freshness.stale).toBe(true);
    expect(freshness.requiresConfirmation).toBe(true);
  });

  it("reports a model as stale once the application source moves on", async () => {
    const gh = githubForHead();
    const originText = await gh.getContent(
      contentsPath(REPO, ".radius/app.origin.json", HEAD_BRANCH)
    );

    const freshness = evaluateAppModelFreshness({
      model: APP_BICEP_WITH_CACHE,
      originText,
      headCommit: HEAD_COMMIT,
      sourceChanged: true,
      generatorVersion: "1.4.0",
      hashAppBicep
    });

    expect(freshness.status).toBe("source-changed");
    expect(freshness.requiresConfirmation).toBe(false);
    expect(freshness.reason).toContain(SOURCE_COMMIT);
  });

  it("annotates Kubernetes workloads with the environment's cluster service", async () => {
    const gh = githubForHead();
    const modeled = applicationGraphToResources(
      appGraphPayload({ withCache: true }),
      ".radius/app.bicep",
      APP_BICEP_WITH_CACHE
    );
    const visible = filterGraphVisualizationResources(modeled);

    const recipes = await fetchRecipePack(gh, "kubernetes");
    const onKubernetes = await resolveRecipeOutputs(
      gh,
      visible,
      recipes,
      "kubernetes"
    );
    const onAws = await resolveRecipeOutputs(gh, visible, recipes, "aws");

    expect(onKubernetes[0].outputResources[0].displayType).toBe(
      "Deployment (K8s)"
    );
    expect(onAws[0].outputResources[0].displayType).toBe("Deployment (EKS)");
  });

  it("plans no outputs for a resource type the recipe pack does not cover", async () => {
    const gh = githubForHead();
    const recipes = await fetchRecipePack(gh, "kubernetes");

    // The kubernetes pack has no postgreSqlDatabases recipe, and modeling must
    // never fabricate a concrete resource for it.
    const planned = await resolveRecipeOutputs(
      gh,
      [{ name: "orders", type: "Radius.Data/postgreSqlDatabases" }],
      recipes,
      "kubernetes"
    );

    expect(planned[0].recipe).toBeNull();
    expect(planned[0].outputResources).toEqual([]);
  });

  it("yields no recipes when the provider's pack cannot be read", async () => {
    const gh = createFakeGitHub({
      absent: [recipePackContentPath("azure")]
    });

    await expect(fetchRecipePack(gh, "azure")).resolves.toEqual([]);
  });

  it("keeps an already-deployed application deployed when a status payload omits it", () => {
    const modeled = applicationGraphToResources(
      appGraphPayload({ withCache: false }),
      ".radius/app.bicep",
      APP_BICEP
    );
    const deployed = projectDeployedGraph(modeled, { [API_ID]: "success" });

    const reprojected = projectDeployedGraph(deployed, {});

    expect(reprojected.map((r: any) => [r.name, r.deployStatus])).toEqual([
      ["api", "success"],
      ["orders", "pending"]
    ]);
  });
});
