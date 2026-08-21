import { describe, expect, it } from "vitest";
import {
  assertRouteTable,
  createServerRouteTable,
  matchRoute,
  routeKey,
  SERVER_ROUTE_DECLARATIONS,
  templatePathParameters,
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
  createGraphsPlanningRoutes,
  createGraphsPlanningStreamRoutes
} from "./routes/graphs-planning.js";
import { createGraphPipeline } from "./routes/graph-pipeline.js";
import { createGraphsPlanningWritesRoutes } from "./routes/graphs-planning-writes.js";
import { createGraphPlanningWorkflows } from "./routes/graph-workflows.js";
import { createEnvironmentsRoutes } from "./routes/environments.js";
import { createCreateEnvironmentRoutes } from "./routes/create-environment.js";
import { createAzureAutoSetupTestDependencies } from "../../test/support/server/azure-auto-setup.js";
import { successfulSelectedGhExecutor } from "../../test/support/server/selected-gh.js";

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
      claimSelectionHandle: () => ({
        ok: true,
        login: "octocat",
        credentialSource: "keyring",
        commit() {},
        release() {}
      }),
      startOperation: () => ({
        ok: true,
        operation: { operationId: "", currentStage: null }
      }),
      persistOperations: () => Promise.resolve(),
      finish: () => {},
      scheduleEnvironmentOperation: () => true,
      errorMessage: (error) => String(error)
    },
    {
      getOperation: () => undefined,
      canResumeInput: () => false,
      resumeAfterInput: () => {},
      requireInput: () => {},
      finish: () => {},
      isTerminalState: () => false,
      persistOperations: () => Promise.resolve(),
      toClientView: () => null,
      scheduleEnvironmentOperation: () => true,
      errorMessage: (error) => String(error),
      inputRequiredState: "input_required"
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
    triggerDeployFailureNotice: () => false,
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
    },
    abandonment: {
      abandon: () => {
        throw new Error(
          "unexpected deployment abandonment from the route-table suite"
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
        reason: "",
        accounts: []
      }),
    resetGhIdentityCache: () => {},
    prepareGitHubAccount: async () => ({
      readiness: {
        ready: false,
        login: "",
        credentialSource: null,
        summary: "Additional GitHub access is required",
        checks: {
          repository: { state: "error", detail: "" },
          workflow: { state: "error", detail: "" },
          environment: { state: "error", detail: "" },
          packages: { state: "error", detail: "" },
          identity: { state: "error", detail: "" }
        },
        repair: null,
        restoration: null
      }
    }),
    preflightRepoAdmin: () => Promise.resolve(""),
    isValidRepoSlug: () => false,
    errorMessage: (error) => String(error)
  }),
  ...createIdentityAuthRoutes({
    azureCredentialIdValidationError: () => "",
    azureLoginRequiredResponse: () => ({ error: "", code: "", tenantId: "" }),
    isCliCommandMissing: () => false,
    isUuid: () => false,
    buildAzureCliAssistMessage: () => ({ prompt: "", displayPrompt: "" }),
    runSessionPrompt: () => Promise.resolve({ status: 200 }),
    runCommand: () => Promise.resolve(""),
    errorMessage: (error) => String(error)
  }),
  ...createGraphsPlanningRoutes({
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
    getSelectedGitHubExecutor: () => successfulSelectedGhExecutor(),
    hasCompleteVerificationIdentity: () => false,
    findWorkflowRun: () => Promise.resolve(null),
    getRunDetail: () => Promise.resolve(null),
    fetchRunLog: () => Promise.resolve(null),
    extractErrorLines: () => [],
    extractGitHubActionsStepLog: () => "",
    explainOidcEnterpriseClaim: () => "",
    explainNoSubscriptions: () => "",
    addLegacyStep: () => null,
    isTerminalState: () => false,
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
    getSelectedGitHubExecutor: () => successfulSelectedGhExecutor(),
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
    readGitHubJson: () =>
      Promise.resolve({ ok: true, status: 200, json: {}, stderr: "" }),
    bootstrapGHCRStatePackage: () => Promise.resolve({ visibility: undefined }),
    stateRegistryForEnvironment: () => "",
    getDefaultBranch: () => Promise.resolve("main"),
    getBranchHeadSha: () => Promise.resolve(null),
    createBranchRef: () => Promise.resolve({ ok: false, stderr: "" }),
    tempFile: { write: () => "", remove: () => {} },
    setCanonicalEnvironment: () => {},
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
  })
};
const table = createServerRouteTable(productionHandlers);

describe("server route ownership boundary", () => {
  it("pins all declared routes to one owner", () => {
    const declarationKeys = SERVER_ROUTE_DECLARATIONS.map(routeKey);
    const handlerKeys = Object.keys(productionHandlers);
    expect(new Set(declarationKeys).size).toBe(
      SERVER_ROUTE_DECLARATIONS.length
    );
    expect(handlerKeys.length).toBe(SERVER_ROUTE_DECLARATIONS.length);
    expect(new Set(handlerKeys).size).toBe(SERVER_ROUTE_DECLARATIONS.length);
    expect(handlerKeys.sort()).toEqual([...declarationKeys].sort());
    expect(
      SERVER_ROUTE_DECLARATIONS.every((route) => route.owner.length > 0)
    ).toBe(true);
    expect(
      SERVER_ROUTE_DECLARATIONS.every((route) =>
        route.method === "POST" ?
          route.mutationPolicy === "nonce-required" ||
          route.mutationPolicy === "legacy-exempt"
        : route.mutationPolicy === "none"
      )
    ).toBe(true);
    expect(
      SERVER_ROUTE_DECLARATIONS.filter(
        (route) => route.mutationPolicy === "nonce-required"
      ).map(routeKey)
    ).toEqual([
      "POST /api/github-account",
      "POST /api/operations",
      "POST /api/abandon-deployment",
      "POST /api/operations/:operationId/resume/:code",
      "POST /api/operations/:operationId/abandon"
    ]);
    expect(() => assertRouteTable(table)).not.toThrow();
  });

  it("requires one concrete handler for every declaration and rejects extras", () => {
    expect(table.map(routeKey)).toEqual(
      SERVER_ROUTE_DECLARATIONS.map(routeKey)
    );
    expect(table.every((route) => typeof route.handler === "function")).toBe(
      true
    );
    expect(() => createServerRouteTable({})).toThrow(
      "Missing handler for server route: ANY /api/ping"
    );
    expect(() =>
      createServerRouteTable({
        "ANY /api/ping": productionHandlers["ANY /api/ping"] as RouteHandler
      })
    ).toThrow("Missing handler for server route: GET /api/operations");
    expect(() =>
      createServerRouteTable({
        ...productionHandlers,
        "GET /api/undeclared": () => {}
      })
    ).toThrow(
      "Handler registered for undeclared server route: GET /api/undeclared"
    );
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
    // POST /api/operations must resolve to its own declaration rather than being
    // swallowed by the GET rule and land on a distinct concrete handler.
    const created = matchRoute(table, "POST", "/api/operations");
    expect(routeKey(created!)).toBe("POST /api/operations");
    expect(created?.handler).not.toBe(latest?.handler);
    expect(created?.handler).not.toBe(byId?.handler);
    // A method with no declaration at all still falls through.
    expect(matchRoute(table, "DELETE", "/api/operations")).toBeUndefined();
  });

  it("matches only the two anchored POST operation-action templates", () => {
    const resume = matchRoute(
      table,
      "POST",
      "/api/operations/op-1/resume/app-selection-required"
    );
    const abandon = matchRoute(table, "POST", "/api/operations/op-1/abandon");
    expect(routeKey(resume!)).toBe(
      "POST /api/operations/:operationId/resume/:code"
    );
    expect(routeKey(abandon!)).toBe(
      "POST /api/operations/:operationId/abandon"
    );
    for (const path of [
      "/api/operations//resume/code",
      "/api/operations/op/resume/",
      "/api/operations/op/resume/code/extra",
      "/api/operations/op/abandon/extra",
      "/api/operations/op/unknown"
    ]) {
      expect(matchRoute(table, "POST", path), path).toBeUndefined();
    }

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

  it("extracts raw template segments and regex-escapes literal path text", () => {
    expect(
      templatePathParameters("/api/v1.0/:operationId", "/api/v1.0/octo%2Fsetup")
    ).toEqual({ operationId: "octo%2Fsetup" });
    expect(
      templatePathParameters("/api/v1.0/:operationId", "/api/v1x0/op")
    ).toBeUndefined();
    expect(() => templatePathParameters("/api/:123", "/api/value")).toThrow(
      "Invalid server route template segment: :123"
    );
    expect(() =>
      templatePathParameters("/api/:id/:id", "/api/one/two")
    ).toThrow("Duplicate server route template parameter: id");
    expect(() => templatePathParameters("/api/static", "/api/static")).toThrow(
      "Server route template has no parameters: /api/static"
    );
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
          handler: null
        } as unknown as ServerRoute
      ])
    ).toThrow("Server route has no handler: ANY /api/ping");
  });

  it("requires every POST route to declare protection or a legacy exemption", () => {
    const post = table.find((route) => route.method === "POST") as ServerRoute;
    const get = table.find((route) => route.method === "GET") as ServerRoute;

    expect(() =>
      assertRouteTable([{ ...post, mutationPolicy: "none" }])
    ).toThrow(`POST server route has no mutation policy: ${routeKey(post)}`);
    expect(() =>
      assertRouteTable([{ ...get, mutationPolicy: "nonce-required" }])
    ).toThrow(
      `Non-POST server route declares a mutation policy: ${routeKey(get)}`
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
          method: "POST",
          mutationPolicy: "legacy-exempt"
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
