import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createEnvironmentsRoutes } from "../../../src/server/routes/environments.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { EnvironmentsDependencies } from "../../../src/server/routes/environments.js";

// HTTP-integration coverage for the verify-status route's failure-classification
// contract (issue #99). The classifier itself is proven at the unit level; this
// case proves the classified fields (`category`, `component`,
// `missingPermissions`, `detail`) survive serialization and transport when the
// route is driven over a real loopback server on an OS-assigned port with the
// composition-root request handler, so a browser polling `/api/verify-status`
// actually receives them. It also asserts the pre-existing failed-response
// shape (`state`, `runId`, `runUrl`, `error`) is unchanged.

const REPO = "octo/app";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

// Every seam throws unless the scenario overrides it, so the route can only
// answer by exercising exactly the collaborators the failed-verify path uses.
function fullDeps(
  overrides: Partial<EnvironmentsDependencies>
): EnvironmentsDependencies {
  const unset = (name: string) => (): never => {
    throw new Error(`unexpected call: ${name}`);
  };
  // Typed as `EnvironmentsDependencies` directly (no `as unknown as` cast) so
  // the compiler guarantees every seam is present: a newly-added dependency
  // fails the build here instead of silently arriving `undefined` at runtime.
  // Every function is an `unset` stub that throws on an unexpected call; the two
  // seams the failed-verify path always touches without a scenario override
  // return real values — a fully-formed test executor and "not an auth error" —
  // rather than a masking placeholder object.
  const base: EnvironmentsDependencies = {
    errorMessage: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
    redactDiagnostic: unset("redactDiagnostic"),
    repoMatchesWorkspace: unset("repoMatchesWorkspace"),
    readInstanceEntry: unset("readInstanceEntry"),
    runCommand: unset("runCommand"),
    fetchFileFromRepo: unset("fetchFileFromRepo"),
    appParams: unset("appParams"),
    resolveRepoAppName: unset("resolveRepoAppName"),
    resolveEnvDeployment: unset("resolveEnvDeployment"),
    logError: unset("logError"),
    discoverEnvironmentTarget: unset("discoverEnvironmentTarget"),
    activeDeleteOperation: unset("activeDeleteOperation"),
    createOperation: unset("createOperation"),
    buildDeleteStages: unset("buildDeleteStages"),
    startOperation: unset("startOperation"),
    toClientView: unset("toClientView"),
    scheduleEnvironmentOperation: unset("scheduleEnvironmentOperation"),
    cliExec: unset("cliExec"),
    activeDeleteEnvironment: unset("activeDeleteEnvironment"),
    envListCacheGet: unset("envListCacheGet"),
    envListCacheSet: unset("envListCacheSet"),
    envListCacheGeneration: unset("envListCacheGeneration"),
    envListCacheDelete: unset("envListCacheDelete"),
    envListTtlMs: 15000,
    kickoffWorkflowSync: unset("kickoffWorkflowSync"),
    now: () => 0,
    getOperation: unset("getOperation"),
    getSelectedGitHubExecutor: () => successfulSelectedGhExecutor(),
    isSelectedGitHubAuthorizationError: () => false,
    hasCompleteVerificationIdentity: unset("hasCompleteVerificationIdentity"),
    findWorkflowRun: unset("findWorkflowRun"),
    settleVerificationDispatchRecovery: () => {},
    getRunDetail: unset("getRunDetail"),
    fetchRunLog: unset("fetchRunLog"),
    extractErrorLines: unset("extractErrorLines"),
    extractGitHubActionsStepLog: unset("extractGitHubActionsStepLog"),
    explainOidcEnterpriseClaim: unset("explainOidcEnterpriseClaim"),
    explainNoSubscriptions: unset("explainNoSubscriptions"),
    addLegacyStep: unset("addLegacyStep"),
    isTerminalState: unset("isTerminalState"),
    finish: unset("finish"),
    finishSucceeded: unset("finishSucceeded"),
    persistBestEffort: unset("persistBestEffort"),
    persistOperations: unset("persistOperations"),
    reportOperationDiagnostic: unset("reportOperationDiagnostic"),
    verifyWorkflowFile: "radius-verify-credentials.yml",
    stageVerify: "verify"
  };
  return { ...base, ...overrides };
}

async function startVerifyStatusServer(
  overrides: Partial<EnvironmentsDependencies>
): Promise<string> {
  const routes = createTestRouteTable(
    createEnvironmentsRoutes(fullDeps(overrides))
  );
  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        handleUnmatchedRequest: (_request, response) => {
          response.writeHead(404);
          response.end("unmatched");
        }
      }),
    createState: () => ({}),
    defaultPage: "environment",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });
  const entry = await container.getOrCreate("verify-status-classification");
  return entry.baseUrl;
}

describe("verify-status HTTP contract — failure classification", () => {
  it("serializes the classified permissions failure over the wire", async () => {
    const operation = {
      repo: REPO,
      environment: "dev",
      context: { githubLogin: "octocat" },
      currentStage: "verify",
      verification: { dispatchedAt: 1, runId: "91" }
    };
    let finished: unknown;
    const baseUrl = await startVerifyStatusServer({
      readInstanceEntry: () => undefined,
      getOperation: () => operation,
      hasCompleteVerificationIdentity: () => true,
      getRunDetail: () =>
        Promise.resolve({
          status: "completed",
          conclusion: "failure",
          steps: [{ name: "Check AKS cluster access", conclusion: "failure" }]
        }),
      fetchRunLog: () =>
        Promise.resolve(
          "Error: AuthorizationFailed. The client does not have permission to perform action 'Microsoft.ContainerService/managedClusters/read'."
        ),
      extractErrorLines: () => ["denied"],
      extractGitHubActionsStepLog: () => "",
      explainOidcEnterpriseClaim: () => "",
      explainNoSubscriptions: () => "",
      finish: (_op: unknown, state: unknown) => {
        finished = state;
      },
      persistBestEffort: async ({
        persist
      }: {
        persist: () => Promise<void>;
      }) => {
        await persist();
        return true;
      },
      persistOperations: () => Promise.resolve(),
      reportOperationDiagnostic: () => {}
    } as Partial<EnvironmentsDependencies>);

    const response = await fetch(
      `${baseUrl}/api/verify-status?repo=${encodeURIComponent(
        REPO
      )}&environment=dev&operationId=op-1`
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      state: string;
      runId: string;
      runUrl: string;
      error: string;
      category: string;
      component?: string;
      missingPermissions?: string[];
    };
    expect(body.state).toBe("failed");
    expect(body.runId).toBe("91");
    expect(body.runUrl).toBe("https://github.com/octo/app/actions/runs/91");
    expect(body.error).toContain("Failed step: Check AKS cluster access.");
    expect(body.category).toBe("permissions");
    expect(body.component).toBeUndefined();
    expect(body.missingPermissions).toEqual([
      "Microsoft.ContainerService/managedClusters/read"
    ]);
    expect(finished).toBe("failed_partial");
  });
});
