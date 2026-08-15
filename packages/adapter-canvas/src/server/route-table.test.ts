import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertRouteTable,
  createServerRouteTable,
  LEGACY_ROUTE_INVENTORY,
  matchRoute,
  MIGRATED_ROUTE_KEYS,
  routeKey,
  SERVER_ROUTE_DECLARATIONS,
  type RouteHandler,
  type ServerRoute
} from "./route-table.js";
import { createLivenessSourceRoutes } from "./routes/liveness-source.js";
import { createDeploymentsRoutes } from "./routes/deployments.js";
import { createOperationsStatusRoutes } from "./routes/operations-status.js";
import { createRepositoriesRoutes } from "./routes/repositories.js";
import { createAzureDiscoveryRoutes } from "./routes/azure-discovery.js";
import { createAzureAutoSetupRoutes } from "./routes/azure-auto-setup.js";
import { createIdentityProfilesRoutes } from "./routes/identity-profiles.js";
import { createIdentityAuthRoutes } from "./routes/identity-auth.js";
import {
  createGraphsPlanningReadsRoutes,
  createGraphsPlanningStreamRoutes
} from "./routes/graphs-planning-reads.js";
import { createEnvironmentsRoutes } from "./routes/environments.js";
import { createGraphsPlanningWritesRoutes } from "./routes/graphs-planning-writes.js";
import { createGraphPlanningWorkflows } from "./routes/graph-workflows.js";
import { createGraphPipeline } from "./routes/graph-pipeline.js";
import { createCreateEnvironmentRoutes } from "./routes/create-environment.js";
import { createAzureAutoSetupTestDependencies } from "../../test/support/server/azure-auto-setup.js";

interface CompatibilityRoute {
  method: "ANY" | "GET" | "POST";
  path: string;
  match: "exact" | "prefix";
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../test/fixtures/runtime-compatibility.json", import.meta.url),
    "utf8"
  )
) as { routes: CompatibilityRoute[] };
const legacySource = readFileSync(
  new URL("../server.ts", import.meta.url),
  "utf8"
);

const productionHandlers = {
  ...createLivenessSourceRoutes({
    getOpenSourceHandler: () => null,
    readInstanceState: () => undefined,
    toSafeRepoRelPath: (input) => String(input)
  }),
  ...createOperationsStatusRoutes(
    {
      latest: () => null,
      latestAny: () => null,
      get: () => null,
      toClientView: () => null
    },
    {
      isValidRepoSlug: () => false,
      isResourceGroupName: () => false,
      isAksClusterName: () => false,
      isUuid: () => false,
      buildStages: () => [],
      createOperation: () => ({ operationId: "", currentStage: null }),
      startOperation: () => ({
        ok: true,
        operation: { operationId: "", currentStage: null }
      }),
      persistOperations: () => Promise.resolve(),
      finish: () => {},
      scheduleEnvironmentOperation: () => true,
      errorMessage: (error) => String(error)
    }
  ),
  ...createRepositoriesRoutes({
    cliExec: () => {},
    readInstanceState: () => undefined,
    repoMatchesWorkspace: () => false
  }),
  ...createDeploymentsRoutes({
    readInstanceEntry: () => undefined,
    triggerDeployRepairHandoff: () => false,
    deployHandoffStatus: () => ({
      state: "idle",
      attempts: 0,
      maxAttempts: 3,
      pending: false
    }),
    resolveRepoAppName: () => Promise.resolve(""),
    resolveEnvDeployment: () => Promise.resolve(null),
    ghOrThrow: () => Promise.resolve(""),
    resetDeploymentViewState: () => {},
    deployListCache: new Map(),
    deployListTtlMs: 0,
    activeDeploymentMutation: () => undefined,
    reserveDeploymentMutation: () => null,
    releaseDeploymentMutation: () => {},
    deploymentStatusBlocksMutation: () => false,
    localDeploymentBlocksMutation: () => false,
    ensureWorkflowsCurrent: () => Promise.resolve({ created: [], failed: [] }),
    findWorkflowRun: () => Promise.resolve(null),
    runGh: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    readProcessEnv: () => ({}),
    setTimer: () => ({}),
    // Construction-only: this suite asserts table shape and ownership, so the
    // deploy admission service is never invoked here. Its behavior is covered
    // by services/deploy-request.test.ts and by the loopback HTTP suite.
    deployRequest: {
      deploy: () => {
        throw new Error(
          "unexpected deploy dispatch from the route-table suite"
        );
      }
    }
  }),
  ...createAzureDiscoveryRoutes({
    runAz: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    runCli: () => Promise.resolve(""),
    isUuid: () => false,
    parseServedReposFromSubjects: () => []
  }),
  ...createAzureAutoSetupRoutes(createAzureAutoSetupTestDependencies()),
  ...createIdentityProfilesRoutes({
    listCredentialProfiles: () => [],
    saveCredentialProfile: () => null,
    deleteCredentialProfile: () => false,
    getGitHubIdentity: () =>
      Promise.resolve({
        actingLogin: "",
        displayLogin: "",
        mismatch: false,
        actingHasWorkflow: false,
        actingHasPackages: false,
        preferredLogin: null,
        reason: "",
        accounts: []
      }),
    resetGhIdentityCache: () => {},
    switchGhAccount: () => Promise.resolve({ ok: true }),
    setPreferredGitHubLogin: () => {},
    preflightRepoAdmin: () => Promise.resolve(""),
    isValidRepoSlug: () => false,
    errorMessage: (error) => String(error)
  }),
  ...createIdentityAuthRoutes({
    validateAzureCredentials: () => Promise.resolve({ success: false }),
    generateAzureOIDC: () => ({ message: "", output: "" }),
    generateAWSOIDC: () => ({ message: "", output: "" }),
    readInstanceState: () => undefined,
    setSharedAzureCredentials: () => {},
    saveCredentials: () => {},
    azureCredentialIdValidationError: () => "",
    azureLoginRequiredResponse: () => ({ error: "", code: "", tenantId: "" }),
    isCliCommandMissing: () => false,
    isUuid: () => false,
    buildAzureCliAssistMessage: () => ({ prompt: "", displayPrompt: "" }),
    runSessionPrompt: () => Promise.resolve({ status: 200 }),
    runCommand: () => Promise.resolve(""),
    errorMessage: (error) => String(error)
  }),
  ...createGraphsPlanningReadsRoutes({
    readInstanceEntry: () => undefined,
    createDeployStatusReader: () => ({
      graph: () => Promise.resolve({ graph: null, status: "missing" }),
      progress: () => Promise.resolve(null)
    }),
    buildDeployStatusMap: () => new Map(),
    buildDeployMessageMap: () => new Map(),
    deployStatusKeys: () => [],
    projectDeployedGraph: () => [],
    canvasGraphResources: () => [],
    applyDeployMessages: () => {},
    record: () => ({}),
    errorMessage: (error) => String(error),
    repoMatchesWorkspace: () => false
  }),
  ...createGraphsPlanningWritesRoutes({
    workflows: createGraphPlanningWorkflows({
      readInstanceEntry: () => undefined,
      pipeline: createGraphPipeline({
        fetchBicepSelection: () =>
          Promise.resolve({
            content: null,
            fromWorkspace: false,
            branch: "",
            bicepPath: ""
          }),
        resolveRadArtifactsDir: () =>
          Promise.resolve({ dir: "", remote: false }),
        buildGraphViaRad: () => Promise.resolve([]),
        canvasGraphResources: () => [],
        workspaceGraphJsonPath: () => "",
        graphDefinitionHash: () => "",
        radArtifactsFingerprint: () => "",
        removeDirectory: () => {}
      }),
      triggerAppBicepHandoff: () => {},
      prepareSourceRefResources: () => ({ view: "graph", token: "" }),
      setSourceRefResources: () => false,
      isCurrentSourceRefToken: () => false,
      defaultBranchForState: () => "main",
      canReuseModeledGraph: () => false,
      addGraphProgress: () => false,
      beginPlannedGraphRequest: () => 1,
      isCurrentPlannedGraphRequest: () => false,
      fetchRecipePack: () => Promise.resolve([]),
      resolveRecipeOutputs: () => Promise.resolve([]),
      computeGraphDiff: () => [],
      record: () => ({}),
      optionalString: () => "",
      errorMessage: (error) => String(error)
    })
  }),
  ...createEnvironmentsRoutes({
    errorMessage: (error) => String(error),
    repoMatchesWorkspace: () => false,
    readInstanceEntry: () => undefined,
    runCommand: () => Promise.resolve(""),
    fetchFileFromRepo: () => Promise.resolve(null),
    appParams: () => [],
    resolveRepoAppName: () => Promise.resolve(""),
    resolveEnvDeployment: () => Promise.resolve(null),
    logError: () => {},
    cliExec: () => {},
    envListCacheGet: () => undefined,
    envListCacheSet: () => {},
    envListCacheDelete: () => {},
    envListTtlMs: 0,
    kickoffWorkflowSync: () => {},
    now: () => 0,
    getOperation: () => null,
    hasCompleteVerificationIdentity: () => false,
    findWorkflowRun: () => Promise.resolve(null),
    getRunDetail: () => Promise.resolve(null),
    fetchRunLog: () => Promise.resolve(null),
    extractErrorLines: () => [],
    extractGitHubActionsStepLog: () => "",
    explainOidcEnterpriseClaim: () => "",
    addLegacyStep: () => null,
    finish: () => null,
    finishSucceeded: () => null,
    persistBestEffort: () => Promise.resolve(true),
    persistOperations: () => Promise.resolve(),
    reportOperationDiagnostic: () => {},
    verifyWorkflowFile: "radius-verify-credentials.yml",
    stageVerify: "verify"
  }),
  // Construction-only: this suite asserts table shape and ownership, so the
  // handler is never invoked here. Its behavior is covered by the collocated
  // seam tests and by test/integration/http/create-environment.test.ts.
  ...createCreateEnvironmentRoutes({
    isServerOwnedRequest: () => false,
    readInstanceEntry: () => undefined,
    cliExec: () => ({ stdin: null }),
    readProcessEnv: () => ({}),
    isValidRepoSlug: () => false,
    getOperation: () => null,
    isStale: () => false,
    createOperation: () => ({ operationId: "op" }),
    buildStages: () => [],
    startOperation: () => ({ ok: true }),
    persistOperations: () => Promise.resolve(),
    reportOperationDiagnostic: () => {},
    finishFailed: () => {},
    enterStage: () => {},
    errorMessage: (error) => String(error),
    stageAuthorizeIdentity: "authorize-identity",
    stageConfigureEnvironment: "configure-environment",
    addLegacyStep: () => {},
    finalizeSetupFailure: () =>
      Promise.resolve({ status: 500, body: { error: "", code: "" } }),
    persistMutationCheckpoint: () => Promise.resolve(true),
    persistBestEffort: () => Promise.resolve(true),
    runAzCommand: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    preflightRepoAdmin: () => Promise.resolve(""),
    preflightGhcrPackageWriteAccess: () =>
      Promise.resolve({ ok: true, credentials: null }),
    bootstrapGHCRStatePackage: () => Promise.resolve({ visibility: undefined }),
    stateRegistryForEnvironment: () => "",
    getDefaultBranch: () => Promise.resolve("main"),
    getBranchHeadSha: () => Promise.resolve(null),
    createBranchRef: () => Promise.resolve({ ok: false, stderr: "" }),
    tempFile: { write: () => "", remove: () => {} },
    resolveGitHubEnvironmentCreateState: () => null,
    recordGitHubEnvironment: () => {},
    envListCacheDelete: () => {},
    ociStateBackend: "oci",
    defaultStateArchive: "latest",
    azureCredential: () => ({}),
    awsCredential: () => ({}),
    optionalString: () => "",
    generateVerifyWorkflow: () => Promise.resolve(""),
    generateDeployWorkflow: () => Promise.resolve({}),
    generateDeleteWorkflow: () => Promise.resolve({}),
    recordCommittedWorkflowFile: () => {},
    deleteLegacyDeployWorkflow: () => Promise.resolve(true),
    createPullRequestApi: () => Promise.resolve({ ok: false, stderr: "" }),
    planCredentialVerification: () =>
      Promise.resolve({
        shouldDispatch: false,
        ref: "main",
        defaultBranch: "main",
        pullRequestUrl: "",
        skipReason: ""
      }),
    fetchFileFromRepo: () => Promise.resolve(null),
    buildVerifyWorkflowDispatchArgs: () => [],
    verifyWorkflowFile: "radius-verify-credentials.yml",
    stageVerify: "verify",
    recordCleanupState: () => {},
    recordCommitState: () => {},
    setStageState: () => {},
    finish: () => {},
    sleep: () => Promise.resolve(),
    now: () => 0
  }),
  ...createGraphsPlanningStreamRoutes({
    readInstanceEntry: () => undefined,
    defaultBranchForState: () => "main",
    prepareSourceRef: () => ({ token: "" }),
    commitSourceRef: () => true,
    triggerAppBicepHandoff: () => {},
    fetchBicepSelection: () =>
      Promise.resolve({
        content: null,
        fromWorkspace: false,
        branch: "main",
        bicepPath: ""
      }),
    workspaceGraphJsonPath: () => "",
    radArtifactsDirForSelection: () =>
      Promise.resolve({ dir: "", remote: false }),
    buildGraphViaRad: () => Promise.resolve([]),
    canvasGraphResources: () => [],
    errorMessage: (error) => String(error)
  })
};
const table = createServerRouteTable(productionHandlers);

describe("server route ownership boundary", () => {
  it("pins all 38 routes to one owner and matches the compatibility fixture", () => {
    expect(SERVER_ROUTE_DECLARATIONS).toHaveLength(38);
    expect(
      SERVER_ROUTE_DECLARATIONS.map(({ method, path, match }) => ({
        method,
        path,
        match
      }))
    ).toEqual(fixture.routes);
    expect(
      SERVER_ROUTE_DECLARATIONS.every((route) => route.owner.length > 0)
    ).toBe(true);
    expect(() => assertRouteTable(table)).not.toThrow();
  });

  // operations-status is now fully migrated: main added POST /api/operations
  // after the GETs, and the base slice moved it onto the route table too, so the
  // family owns all three of its routes. azure-discovery, graphs-planning and
  // environments each completed on the base, and deployments completes here
  // with POST /api/deploy — the last legacy route in the chain. The route table
  // now owns every declared route, so the legacy fallback inventory is empty
  // and every family's residual is asserted as empty rather than by naming a
  // remaining key.
  it("owns every declared route across all families and leaves no route on the legacy fallback", () => {
    expect(MIGRATED_ROUTE_KEYS).toEqual([
      "ANY /api/ping",
      "GET /api/operations",
      "GET /api/operations/",
      "POST /api/open-source",
      "GET /api/credential-profiles",
      "GET /api/github-identity",
      "POST /api/github-account",
      "POST /api/save-credential-profile",
      "POST /api/delete-credential-profile",
      "POST /api/oidc",
      "POST /api/verify-azure-login",
      "POST /api/azure-cli-assist",
      "POST /api/verify-aws-login",
      "GET /api/list-azure-app-registrations",
      "GET /api/azure-app-serves-repos",
      "POST /api/azure-auto-setup",
      "GET /api/user-repos",
      "POST /api/repo-branches",
      "POST /api/discover-branches",
      "GET /api/load-graph-stream",
      "POST /api/operations",
      "GET /api/deploy-status",
      "GET /api/list-applications",
      "GET /api/list-deployments",
      "POST /api/deploy",
      "POST /api/deploy-reset",
      "POST /api/delete-deployment",
      "GET /api/progress",
      "GET /api/deployed-graph",
      "POST /api/app-params",
      "POST /api/delete-environment",
      "GET /api/list-environments",
      "GET /api/verify-status",
      "POST /api/load-graph",
      "POST /api/plan-graph",
      "POST /api/diff-branches",
      "POST /api/create-environment",
      "POST /api/discover"
    ]);
    expect(Object.keys(productionHandlers).sort()).toEqual(
      [...MIGRATED_ROUTE_KEYS].sort()
    );
    expect(LEGACY_ROUTE_INVENTORY).toHaveLength(0);
    // Every family is pinned explicitly, so a later slice cannot quietly
    // re-legacy a route that the table now owns. The whole chain has migrated,
    // so each residual is asserted as empty by owner rather than by naming a
    // remaining key.
    expect(LEGACY_ROUTE_INVENTORY).not.toContain("POST /api/operations");
    expect(LEGACY_ROUTE_INVENTORY).not.toContain("POST /api/deploy");
    expect(LEGACY_ROUTE_INVENTORY).not.toContain("POST /api/delete-deployment");
    expect(LEGACY_ROUTE_INVENTORY).not.toContain("POST /api/azure-auto-setup");
    expect(LEGACY_ROUTE_INVENTORY).not.toContain("POST /api/discover");
    expect(LEGACY_ROUTE_INVENTORY).not.toContain("POST /api/load-graph");
    expect(LEGACY_ROUTE_INVENTORY).not.toContain("POST /api/plan-graph");
    expect(LEGACY_ROUTE_INVENTORY).not.toContain("POST /api/diff-branches");
    expect(LEGACY_ROUTE_INVENTORY).not.toContain(
      "POST /api/create-environment"
    );
    for (const family of [
      "azure-discovery",
      "graphs-planning",
      "environments",
      "deployments"
    ] as const) {
      expect(
        LEGACY_ROUTE_INVENTORY.filter((key) =>
          SERVER_ROUTE_DECLARATIONS.some(
            (route) => routeKey(route) === key && route.owner === family
          )
        ),
        family
      ).toEqual([]);
    }
    expect(LEGACY_ROUTE_INVENTORY).toEqual(
      fixture.routes
        .map(routeKey)
        .filter((key) => !MIGRATED_ROUTE_KEYS.includes(key))
    );
    expect(
      table
        .filter((route) => route.migration === "migrated")
        .map(routeKey)
        .sort()
    ).toEqual([...MIGRATED_ROUTE_KEYS].sort());
    expect(
      table
        .filter((route) => route.migration === "legacy")
        .every((route) => route.handler === null)
    ).toBe(true);
  });

  // Independently hardcoded, in declaration order, so the derived complement
  // above cannot be the only source of truth. A slice that migrates or drops a
  // route has to update this list deliberately. The chain is now fully
  // migrated, so the pin is empty.
  const RESIDUAL_ROUTE_PIN: string[] = [];

  it("moves exactly POST /api/deploy out of the residual inventory", () => {
    // The pre-deploy migrated ledger, written out by hand rather than derived,
    // so "base + one key" is proven against an independent transcript instead
    // of against whatever the ledger currently says.
    const BASE_MIGRATED_ROUTE_KEYS = [
      "ANY /api/ping",
      "GET /api/operations",
      "GET /api/operations/",
      "POST /api/open-source",
      "GET /api/credential-profiles",
      "GET /api/github-identity",
      "POST /api/github-account",
      "POST /api/save-credential-profile",
      "POST /api/delete-credential-profile",
      "POST /api/oidc",
      "POST /api/verify-azure-login",
      "POST /api/azure-cli-assist",
      "POST /api/verify-aws-login",
      "GET /api/list-azure-app-registrations",
      "GET /api/azure-app-serves-repos",
      "POST /api/azure-auto-setup",
      "GET /api/user-repos",
      "POST /api/repo-branches",
      "POST /api/discover-branches",
      "GET /api/load-graph-stream",
      "POST /api/operations",
      "GET /api/deploy-status",
      "GET /api/list-applications",
      "GET /api/list-deployments",
      "POST /api/deploy-reset",
      "POST /api/delete-deployment",
      "GET /api/progress",
      "GET /api/deployed-graph",
      "POST /api/app-params",
      "POST /api/delete-environment",
      "GET /api/list-environments",
      "GET /api/verify-status",
      "POST /api/load-graph",
      "POST /api/plan-graph",
      "POST /api/diff-branches",
      "POST /api/create-environment",
      "POST /api/discover"
    ];

    // Nothing the base already owned may be lost by this slice.
    for (const key of BASE_MIGRATED_ROUTE_KEYS) {
      expect(MIGRATED_ROUTE_KEYS, key).toContain(key);
    }
    expect(
      MIGRATED_ROUTE_KEYS.filter(
        (key) => !BASE_MIGRATED_ROUTE_KEYS.includes(key)
      )
    ).toEqual(["POST /api/deploy"]);
    expect(MIGRATED_ROUTE_KEYS).toHaveLength(
      BASE_MIGRATED_ROUTE_KEYS.length + 1
    );

    // The derived complement and the independent residual pin must agree, in
    // declaration order.
    expect([...LEGACY_ROUTE_INVENTORY].sort()).toEqual(
      [...RESIDUAL_ROUTE_PIN].sort()
    );
    expect(RESIDUAL_ROUTE_PIN).not.toContain("POST /api/deploy");
  });

  it("keeps the residual legacy dispatcher exactly equal to the inventory", () => {
    const residualLegacyCount =
      (legacySource.match(/pathname === "\/api\//g) || []).length +
      (legacySource.match(/pathname\.startsWith\("\/api\//g) || []).length;
    // Cross-checked against the inventory, and independently pinned: 0 of 38
    // after this slice, which retires the legacy chain entirely. The regex
    // counts only `pathname ===` and
    // `pathname.startsWith` matchers, so the two regex-matched routes main
    // added under /api/operations/ (:id/resume/:code and the abandon route) are
    // not counted here and are not declared in the route table either.
    expect(residualLegacyCount).toBe(LEGACY_ROUTE_INVENTORY.length);
    expect(residualLegacyCount).toBe(0);
    // The remaining method-aware matchers in `server.ts` must be exactly the
    // residual inventory, keyed independently of the derived complement. Both
    // are now empty, which is what retiring the chain means.
    expect([...LEGACY_ROUTE_INVENTORY].sort()).toEqual(
      [...RESIDUAL_ROUTE_PIN].sort()
    );

    for (const route of table) {
      const matcher =
        route.match === "prefix" ?
          `pathname.startsWith("${route.path}")`
        : `pathname === "${route.path}"`;
      const methodMatcher =
        route.method === "ANY" ? "" : `req.method === "${route.method}"`;
      // A path can carry more than one method (GET and POST /api/operations),
      // so advance past occurrences whose method does not match. This also keeps
      // the migrated-absence check below method-aware: a migrated GET must not be
      // considered still-legacy just because a sibling POST shares its path.
      let offset = legacySource.indexOf(matcher);
      while (
        offset >= 0 &&
        methodMatcher &&
        !legacySource.slice(offset, offset + 180).includes(methodMatcher)
      ) {
        offset = legacySource.indexOf(matcher, offset + matcher.length);
      }
      if (route.migration === "migrated") {
        // A migrated route must no longer be answered by the legacy chain.
        expect(offset, routeKey(route)).toBe(-1);
        continue;
      }
      expect(offset, routeKey(route)).toBeGreaterThan(-1);
      if (route.method !== "ANY") {
        expect(legacySource.slice(offset, offset + 180)).toContain(
          `req.method === "${route.method}"`
        );
      }
    }
  });

  it("fails when a migrated route has no handler", () => {
    expect(() => createServerRouteTable({})).toThrow(
      "Missing handler for migrated server route: ANY /api/ping"
    );
    expect(() =>
      createServerRouteTable({
        "ANY /api/ping": productionHandlers["ANY /api/ping"] as RouteHandler
      })
    ).toThrow("Missing handler for migrated server route: GET /api/operations");
  });

  it("matches the exact operations route before the by-id prefix route", () => {
    const latest = matchRoute(table, "GET", "/api/operations");
    const byId = matchRoute(table, "GET", "/api/operations/abc");
    expect(routeKey(latest!)).toBe("GET /api/operations");
    expect(routeKey(byId!)).toBe("GET /api/operations/");
    // The prefix rule must not swallow the exact route, and the two routes must
    // land on genuinely different handlers.
    expect(latest?.handler).not.toBe(byId?.handler);
    // A trailing slash with no id is a by-id lookup for the empty id.
    expect(routeKey(matchRoute(table, "GET", "/api/operations/")!)).toBe(
      "GET /api/operations/"
    );
    // Declaration order is what makes that true, so pin it.
    expect(
      SERVER_ROUTE_DECLARATIONS.findIndex(
        (route) => routeKey(route) === "GET /api/operations"
      )
    ).toBeLessThan(
      SERVER_ROUTE_DECLARATIONS.findIndex(
        (route) => routeKey(route) === "GET /api/operations/"
      )
    );
    // POST /api/operations is now migrated, so it must resolve to its own
    // declaration rather than being swallowed by the GET rule, carry a handler,
    // and land on a handler distinct from the two GET routes.
    const created = matchRoute(table, "POST", "/api/operations");
    expect(routeKey(created!)).toBe("POST /api/operations");
    expect(created?.migration).toBe("migrated");
    expect(created?.handler).not.toBeNull();
    expect(created?.handler).not.toBe(latest?.handler);
    expect(created?.handler).not.toBe(byId?.handler);
    // A method with no declaration at all still falls through.
    expect(matchRoute(table, "DELETE", "/api/operations")).toBeUndefined();
  });

  it("leaves main's undeclared sub-routes under /api/operations/ to the legacy chain", () => {
    // `main` serves two routes under this family's prefix with regexes rather
    // than declarations: POST /api/operations/:id/resume/:code and
    // POST /api/operations/:id/abandon. They are not in the route table, so the
    // dispatcher must not claim them -- and it only fails to claim them because
    // the migrated prefix route is GET-only. That disjointness is the whole
    // reason the migration is safe for those paths, so pin it: the dispatcher
    // now runs the table BEFORE the entire legacy chain, so if either route
    // were ever widened past POST this route would start shadowing it silently.
    expect(
      matchRoute(table, "POST", "/api/operations/op-1/resume/abc")
    ).toBeUndefined();
    expect(
      matchRoute(table, "POST", "/api/operations/op-1/abandon")
    ).toBeUndefined();

    // The shadowing is real for GET, and is pre-existing rather than a
    // regression: legacy's GET prefix branch claimed these composite paths too,
    // answering 404 for the whole tail as an operation id.
    const resumeAsGet = matchRoute(
      table,
      "GET",
      "/api/operations/op-1/resume/abc"
    );
    expect(routeKey(resumeAsGet!)).toBe("GET /api/operations/");
  });

  it("treats a missing request method as matching nothing but ANY routes", () => {
    // Node types `req.method` as optional, so the table must not blow up or
    // accidentally match a verb route when it is absent.
    expect(matchRoute(table, undefined, "/api/operations")).toBeUndefined();
    expect(matchRoute(table, undefined, "/api/operations/abc")).toBeUndefined();
    expect(routeKey(matchRoute(table, undefined, "/api/ping")!)).toBe(
      "ANY /api/ping"
    );
    // Method comparison is case-insensitive on the way in.
    expect(routeKey(matchRoute(table, "get", "/api/operations")!)).toBe(
      "GET /api/operations"
    );
  });

  it("fails on duplicate, unowned, or handlerless routes", () => {
    // The legacy chain is fully retired, so no production route is legacy any
    // more. `assertRouteTable` must still reject a legacy route that carries a
    // handler, so the invalid shape is synthesized from a real declaration
    // rather than found in the table.
    const legacyRoute = {
      ...table[0],
      migration: "legacy" as const,
      handler: null
    };
    expect(table.some((route) => route.migration === "legacy")).toBe(false);
    expect(() => assertRouteTable([...table, table[0]])).toThrow(
      "Duplicate server route: ANY /api/ping"
    );

    expect(() =>
      assertRouteTable([{ ...table[0], owner: "" } as unknown as ServerRoute])
    ).toThrow("Unowned server route: ANY /api/ping");

    expect(() =>
      assertRouteTable([
        {
          ...table[0],
          migration: "migrated",
          handler: null
        } as unknown as ServerRoute
      ])
    ).toThrow("Migrated server route has no handler: ANY /api/ping");

    expect(() =>
      assertRouteTable([
        {
          ...legacyRoute,
          migration: "legacy",
          handler: () => {}
        } as unknown as ServerRoute
      ])
    ).toThrow(
      `Legacy server route unexpectedly has a handler: ${routeKey(legacyRoute)}`
    );
  });

  it("fails when a prefix route makes a later route unreachable", () => {
    const prefix = table.find((route) => route.path === "/api/operations/");
    expect(prefix?.method).toBe("GET");

    expect(() =>
      assertRouteTable([
        prefix as ServerRoute,
        {
          ...(prefix as ServerRoute),
          path: "/api/operations/summary",
          match: "exact"
        } as ServerRoute
      ])
    ).toThrow(
      "Server route GET /api/operations/summary is unreachable behind earlier prefix route GET /api/operations/"
    );

    expect(() =>
      assertRouteTable([
        prefix as ServerRoute,
        {
          ...(prefix as ServerRoute),
          path: "/api/operations/logs/",
          method: "ANY"
        } as ServerRoute
      ])
    ).toThrow(
      "Server route ANY /api/operations/logs/ is unreachable behind earlier prefix route GET /api/operations/"
    );
  });

  it("allows routes an earlier prefix route cannot claim", () => {
    const prefix = table.find(
      (route) => route.path === "/api/operations/"
    ) as ServerRoute;

    // Disjoint method: the prefix cannot claim a POST sub-route.
    expect(() =>
      assertRouteTable([
        prefix,
        {
          ...prefix,
          path: "/api/operations/abandon",
          match: "exact",
          method: "POST"
        } as ServerRoute
      ])
    ).not.toThrow();

    // Outside the prefix, and the exact sibling that legitimately precedes it.
    expect(() =>
      assertRouteTable([
        prefix,
        { ...prefix, path: "/api/operation", match: "exact" } as ServerRoute
      ])
    ).not.toThrow();
    expect(() =>
      assertRouteTable([
        { ...prefix, path: "/api/operations", match: "exact" } as ServerRoute,
        prefix
      ])
    ).not.toThrow();
  });
});
