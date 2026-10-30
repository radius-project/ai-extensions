import { createServer } from "node:http";
import { redactCredentials } from "@radius-project/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createEnvironmentsRoutes } from "../../../src/server/routes/environments.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { EnvironmentsDependencies } from "../../../src/server/routes/environments.js";
import {
  getRunDetail,
  fetchRunLog,
  extractErrorLines,
  extractGitHubActionsStepLog,
  explainOidcEnterpriseClaim,
  explainNoSubscriptions,
  isSelectedGhAuthorizationError,
  SelectedGhAuthorizationError
} from "../../../src/deploy.js";
import { SelectedGhAuthorizationError as SharedAuthorizationError } from "@radius-project/adapter-shared";
import { createWorkflowObservationScope } from "../../../src/server/services/workflow-observation-scope.js";
import {
  addLegacyStep,
  createOperation,
  finish,
  finishSucceeded,
  hasCompleteVerificationIdentity,
  isTerminalState,
  toPersistedOperation
} from "../../../src/operations.js";
import { persistBestEffort } from "../../../src/server.js";
import { createVerificationStatusService } from "../../../src/server/services/verification-status.js";

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
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    redactDiagnostic: redactCredentials,
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
    isTerminalState,
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
  it.each([
    "success",
    "failure",
    "log-error",
    "unknown",
    "save-error"
  ] as const)(
    "matches the direct service's %s result and save-time record through real HTTP",
    async (scenario) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
      function fixture() {
        const operation = createOperation({
          operationId: "op_parity",
          repo: REPO,
          environment: "dev",
          provider: "azure"
        });
        operation.currentStage = "verify";
        operation.context.githubLogin = "saved-account";
        operation.verification = {
          runId: "91",
          workflow: "verify.yml",
          ref: "topic",
          environment: "dev",
          dispatchedAt: Date.now()
        };
        const effects: unknown[] = [];
        const scope = createWorkflowObservationScope(() => {
          throw new Error("Unexpected deployment observation");
        });
        const executor = successfulSelectedGhExecutor({
          login: "saved-account"
        });
        const dependencies = fullDeps({
          readInstanceEntry: () => ({ observation: scope }),
          getOperation: () => operation,
          getSelectedGitHubExecutor: () => executor,
          hasCompleteVerificationIdentity,
          getRunDetail: async (repo, runId, selected) => {
            expect(selected).toBe(executor);
            effects.push(["read", repo, runId, selected?.login]);
            return {
              status: "completed",
              conclusion:
                scenario === "unknown" ? "future-conclusion"
                : scenario === "success" || scenario === "save-error" ?
                  "success"
                : "failure",
              steps: []
            };
          },
          fetchRunLog: async () => {
            effects.push("log");
            if (scenario === "log-error") throw new Error("Log unavailable");
            return 'Error: client_secret="synthetic private value"';
          },
          extractErrorLines,
          extractGitHubActionsStepLog,
          explainOidcEnterpriseClaim,
          explainNoSubscriptions,
          addLegacyStep,
          finish,
          finishSucceeded,
          persistBestEffort,
          persistOperations: async () => {
            effects.push(["save", toPersistedOperation(operation)]);
            if (scenario === "save-error") throw new Error("Disk unavailable");
          },
          reportOperationDiagnostic: (diagnostic) => {
            effects.push(["diagnostic", diagnostic.code, diagnostic.message]);
          }
        });
        return { operation, effects, scope, dependencies };
      }
      const direct = fixture();
      const http = fixture();
      try {
        const service = createVerificationStatusService(
          direct.dependencies,
          () => direct.scope
        );
        const input = {
          repo: REPO,
          operationId: "op_parity",
          environment: "dev"
        };
        const expected = await service(input);
        const baseUrl = await startVerifyStatusServer(http.dependencies);
        const response = await fetch(
          `${baseUrl}/api/verify-status?${new URLSearchParams(input)}`
        );
        expect(response.status).toBe(expected.status);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual(expected.body);
        expect(http.effects).toEqual(direct.effects);
        expect(toPersistedOperation(http.operation)).toEqual(
          toPersistedOperation(direct.operation)
        );
        expect(expected.body.state).toBe(
          scenario === "unknown" ? "unknown"
          : scenario === "success" || scenario === "save-error" ? "success"
          : "failed"
        );
        expect(JSON.stringify(http.operation)).not.toContain(
          "synthetic private value"
        );
        expect(http.scope.stopped).toBe(false);
        expect(direct.scope.stopped).toBe(true);
      } finally {
        direct.scope.stop();
        http.scope.stop();
      }
    }
  );

  it("redacts and bounds workflow diagnostics before persistence and HTTP serialization", async () => {
    const operation = {
      repo: REPO,
      environment: "dev",
      state: "verifying",
      context: { githubLogin: "octocat" },
      currentStage: "verify",
      verification: { dispatchedAt: 1, runId: "91" }
    };
    const finish = vi.fn();
    const persistOperations = vi.fn(async () => {
      const retained = JSON.stringify(finish.mock.calls);
      expect(retained).not.toContain("fixture private");
      expect(retained).not.toContain("fixture-opaque-material");
    });
    const baseUrl = await startVerifyStatusServer({
      readInstanceEntry: () => undefined,
      getOperation: () => operation,
      hasCompleteVerificationIdentity: () => true,
      getRunDetail: async () => ({
        status: "completed",
        conclusion: "failure",
        steps: [
          {
            name: 'Azure Login (OIDC) password="fixture private step"',
            conclusion: "failure"
          }
        ]
      }),
      fetchRunLog: async () =>
        'Error: password="' +
        "fixture private line ".repeat(1000) +
        '"\nError: fixture-opaque-material\nError: ' +
        "z".repeat(6000),
      redactDiagnostic: (value) =>
        value.replaceAll("fixture-opaque-material", "[REDACTED]"),
      extractErrorLines,
      extractGitHubActionsStepLog,
      explainOidcEnterpriseClaim,
      explainNoSubscriptions,
      finish,
      persistBestEffort: async ({ persist }) => {
        await persist();
        return true;
      },
      persistOperations,
      reportOperationDiagnostic: () => {}
    });
    const response = await fetch(
      `${baseUrl}/api/verify-status?repo=${REPO}&environment=dev&operationId=op-1`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      state: "failed",
      runId: "91",
      error: expect.stringContaining(
        "Credential verification failed (failure)."
      )
    });
    expect(body.error).toHaveLength(4000);
    expect(body.error).toContain("[REDACTED]");
    expect(JSON.stringify(body)).not.toContain("fixture private");
    expect(JSON.stringify(body)).not.toContain("fixture-opaque-material");
    expect(finish).toHaveBeenCalledExactlyOnceWith(
      operation,
      "failed_partial",
      {
        failure: expect.objectContaining({
          message:
            'Credential verification failed. Failed step: Azure Login (OIDC) password="[REDACTED]".',
          evidence: body.error
        })
      }
    );
    expect(persistOperations).toHaveBeenCalledOnce();
  });

  it("publishes and persists the confirmed failure when bounded log output is unavailable", async () => {
    const operation = {
      repo: REPO,
      environment: "dev",
      state: "verifying",
      context: { githubLogin: "octocat" },
      currentStage: "verify",
      verification: { dispatchedAt: 1, runId: "91" }
    };
    const scope = createWorkflowObservationScope(() => {
      throw new Error("Unexpected artifact read");
    });
    const calls: string[][] = [];
    const executor = successfulSelectedGhExecutor({
      run: async (args, options) => {
        calls.push(args);
        if (args[0] === "api") {
          return {
            code: 0,
            stderr: "",
            stdout:
              "HTTP/2 200\n\n" +
              JSON.stringify(
                args[1].includes("/jobs") ?
                  {
                    total_count: 1,
                    jobs: [
                      {
                        steps: [
                          {
                            name: "Azure Login (OIDC)",
                            conclusion: "failure"
                          }
                        ]
                      }
                    ]
                  }
                : { status: "completed", conclusion: "failure" }
              )
          };
        }
        expect(args).toEqual(["run", "view", "91", "--log", "--repo", REPO]);
        expect(options?.timeout).toBeGreaterThan(0);
        expect(options?.timeout).toBeLessThanOrEqual(30000);
        expect(options?.maxBuffer).toBe(20 * 1024 * 1024);
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        return {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          stdout: "",
          stderr: ""
        };
      }
    });
    const finish = vi.fn((_operation: unknown, state: string) => {
      operation.state = state;
    });
    const persistOperations = vi.fn(async () => {
      expect(operation.state).toBe("failed_partial");
    });
    try {
      const baseUrl = await startVerifyStatusServer({
        readInstanceEntry: () => ({ observation: scope }),
        getOperation: () => operation,
        hasCompleteVerificationIdentity: () => true,
        getSelectedGitHubExecutor: () => executor,
        isSelectedGitHubAuthorizationError: isSelectedGhAuthorizationError,
        getRunDetail,
        fetchRunLog,
        extractErrorLines,
        extractGitHubActionsStepLog,
        explainOidcEnterpriseClaim,
        explainNoSubscriptions,
        finish,
        persistBestEffort: async ({ persist }) => {
          await persist();
          return true;
        },
        persistOperations,
        reportOperationDiagnostic: () => {}
      });
      const response = await fetch(
        `${baseUrl}/api/verify-status?repo=${REPO}&environment=dev&operationId=op-1`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toMatchObject({
        state: "failed",
        runId: "91",
        runUrl: `https://github.com/${REPO}/actions/runs/91`,
        category: "generic",
        error: expect.stringContaining(
          "The verification log could not be read: the output limit was exceeded."
        )
      });
      expect(finish).toHaveBeenCalledExactlyOnceWith(
        operation,
        "failed_partial",
        expect.objectContaining({
          failure: expect.objectContaining({
            code: "verify-run-failed",
            evidence: expect.stringContaining(
              "Failed step: Azure Login (OIDC)."
            )
          })
        })
      );
      expect(persistOperations).toHaveBeenCalledOnce();
      expect(calls).toHaveLength(3);
    } finally {
      scope.stop();
    }
  });

  it("serializes the classified permissions failure over the wire", async () => {
    const operation = {
      repo: REPO,
      environment: "dev",
      context: { githubLogin: "octocat" },
      currentStage: "verify",
      verification: { dispatchedAt: 1, runId: "91" }
    };
    let finished: unknown;
    const calls: string[][] = [];
    const executor = successfulSelectedGhExecutor({
      login: "octocat",
      run: async (args, options) => {
        calls.push(args);
        if (args[0] === "api") {
          expect(options?.timeout).toBeGreaterThan(0);
          expect(options?.timeout).toBeLessThanOrEqual(15000);
          return {
            code: 0,
            stderr: "",
            stdout:
              "HTTP/2 200\n\n" +
              JSON.stringify(
                args[1].includes("/jobs") ?
                  {
                    total_count: 1,
                    jobs: [
                      {
                        steps: [
                          {
                            name: "Check AKS cluster access",
                            conclusion: "failure"
                          }
                        ]
                      }
                    ]
                  }
                : {
                    status: "completed",
                    conclusion: "failure"
                  }
              )
          };
        }
        if (args.join(" ") === "run view 91 --log --repo octo/app") {
          expect(options).toEqual({
            timeout: expect.any(Number),
            maxBuffer: 20 * 1024 * 1024,
            signal: expect.any(AbortSignal)
          });
          expect(options?.timeout).toBeGreaterThan(0);
          expect(options?.timeout).toBeLessThanOrEqual(30000);
          expect(options?.signal?.aborted).toBe(false);
          return {
            code: 0,
            stderr: "",
            stdout:
              "Error: AuthorizationFailed. The client does not have permission to perform action 'Microsoft.ContainerService/managedClusters/read'."
          };
        }
        throw new Error("Unexpected selected read: " + args.join(" "));
      }
    });
    const baseUrl = await startVerifyStatusServer({
      readInstanceEntry: () => undefined,
      getOperation: () => operation,
      hasCompleteVerificationIdentity: () => true,
      getSelectedGitHubExecutor: () => executor,
      isSelectedGitHubAuthorizationError: isSelectedGhAuthorizationError,
      getRunDetail,
      fetchRunLog,
      extractErrorLines,
      extractGitHubActionsStepLog,
      explainOidcEnterpriseClaim,
      explainNoSubscriptions,
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
    expect(calls).toHaveLength(3);
    expect(SelectedGhAuthorizationError).toBe(SharedAuthorizationError);
    expect(
      isSelectedGhAuthorizationError(
        new SharedAuthorizationError("octocat", 403, "denied")
      )
    ).toBe(true);
  });
});
