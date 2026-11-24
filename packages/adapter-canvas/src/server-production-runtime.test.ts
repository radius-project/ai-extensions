import { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi
} from "vitest";
import { DELETE_RADIUS_REF } from "@radius-project/core";
import {
  createProductionCanvasServerRuntime,
  setOpenSourceHandler,
  type EnvironmentDeletionCoordinatorPorts
} from "./server.js";
import {
  buildDeleteStages,
  buildStages,
  configureOperationStore,
  createOperation,
  operations,
  STAGE_DELETE_GITHUB_ENV,
  STAGE_DELETE_RADIUS_ENV,
  setStageState
} from "./operations.js";
import { disabledOperationStore } from "./operation-store.js";
import { configureCredentialProvenanceStore } from "./credential-provenance.js";
import { createEnvironmentAccountContext } from "./runtime/environment-account-context.js";
import { createEnvironmentExecutionOwner } from "./runtime/environment-execution-owner.js";
import { createEnvironmentDeletionTool } from "./runtime/environment-deletion-tool.js";
import type { CanvasState } from "./shared.js";
import { createTestDeploymentRuntime } from "../test/support/server/deployment-runtime.js";
import { createDeferred } from "../test/support/browser/fakes.js";
import type { SelectedGhExecutor } from "./gh.js";
import { generateDeleteWorkflow } from "./infra.js";
import type {
  GitHubAccountLease,
  GitHubAccountLeaseMetadata,
  GitHubAccountLeaseResult
} from "./server/services/github-account-coordinator.js";

const unexpectedDeletion = async (): Promise<never> => {
  throw new Error("Unexpected external deletion");
};

const accountContext = () =>
  createEnvironmentAccountContext("production-runtime-test", {
    createReadOnlyExecutor: async () => {
      throw new Error("Unexpected account read");
    },
    withSelectedAccount: async () => {
      throw new Error("Unexpected account lease");
    }
  });

const deletionPorts: EnvironmentDeletionCoordinatorPorts = {
  deleteRadiusEnvironment: unexpectedDeletion,
  removeAwsEnvironmentAccess: unexpectedDeletion,
  removeAwsDeployIdentityLock: unexpectedDeletion,
  readRepositoryId: unexpectedDeletion,
  runAz: unexpectedDeletion,
  readAzureIdentity: unexpectedDeletion,
  deleteGitHubEnvironment: unexpectedDeletion,
  deleteStatePackage: unexpectedDeletion,
  withCredentialProvenanceLock: (work) => work(),
  readCredentialProvenance: () => {
    throw new Error("Unexpected credential provenance read");
  },
  removeCredentialProvenance: unexpectedDeletion,
  clearEnvironmentCredentialProvenance: unexpectedDeletion,
  persist: () => operations.persist(),
  errorMessage: String,
  log: () => {
    throw new Error("Unexpected deletion diagnostic");
  }
};

function runtime(
  overrides: Partial<
    NonNullable<
      Parameters<
        typeof createProductionCanvasServerRuntime
      >[0]["serverDependencies"]
    >
  > = {},
  executionOwner = createEnvironmentExecutionOwner(),
  deploymentRuntime = createTestDeploymentRuntime()
) {
  return createProductionCanvasServerRuntime({
    deploymentRuntime,
    awsEnabled: false,
    executionOwner,
    accountContext: accountContext(),
    environmentDeletionPorts: deletionPorts,
    serverDependencies: {
      preferredPort: async () => 0,
      prepareIdentity: () => {},
      ...overrides
    }
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function mutationHeaders(
  baseUrl: string,
  nonce: unknown
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: baseUrl,
    "Sec-Fetch-Site": "same-origin",
    "X-Radius-Mutation-Nonce": String(nonce ?? "")
  };
}

beforeEach(async () => {
  await configureOperationStore(disabledOperationStore());
});

afterEach(async () => {
  operations.clear();
  await configureOperationStore(disabledOperationStore());
  setOpenSourceHandler(async () => {});
  vi.restoreAllMocks();
});

describe("production canvas server runtime", () => {
  it.each(["environment", "deployment"] as const)(
    "rejects chat deletion after %s services shut down",
    async (owner) => {
      const execution = createEnvironmentExecutionOwner();
      const deployment = createTestDeploymentRuntime();
      const server = runtime({}, execution, deployment);
      if (owner === "environment") await execution.shutdown();
      else await deployment.owner.shutdown(0);
      await expect(
        server.prepareApplicationDeletion({
          login: "fixture-owner",
          isCurrent: () => true,
          request: {
            repo: "octo/app",
            environment: "dev",
            application: "app",
            deploymentId: "42",
            runUrl: "https://github.com/octo/app/actions/runs/17",
            force: false
          }
        })
      ).rejects.toThrow("authorization expired");
    }
  );

  it.each([true, false])(
    "requires current authorization before opening the selected GitHub executor (%s)",
    async (isCurrent) => {
      const server = runtime();
      await expect(
        server.prepareApplicationDeletion({
          login: "fixture-owner",
          isCurrent: () => isCurrent,
          request: {
            repo: "octo/app",
            environment: "dev",
            application: "app",
            deploymentId: "42",
            runUrl: "https://github.com/octo/app/actions/runs/17",
            force: false
          }
        })
      ).rejects.toThrow(
        isCurrent ? "Unexpected account read" : "authorization expired"
      );
    }
  );

  it.each([
    "unchanged",
    "replaced",
    "unreadable",
    "stale",
    "invalid-id"
  ] as const)(
    "revalidates the selected environment after deletion confirmation (%s)",
    async (scenario) => {
      const save = vi.fn(async (_envelope: { operations: unknown[] }) => {});
      await configureOperationStore({
        ...disabledOperationStore(),
        durable: true,
        save
      });
      let environmentId = scenario === "invalid-id" ? 0 : 17;
      let current = true;
      let approved = false;
      const run = vi.fn(async (args: string[]) => {
        if (
          args[1] === "/repos/octo/app/environments/dev/variables?per_page=100"
        ) {
          expect(args.slice(2)).toEqual(["--jq", ".variables[].name"]);
          return {
            code: 0,
            stdout: "AZURE_CLIENT_ID\nAZURE_TENANT_ID\n",
            stderr: ""
          };
        }
        expect(args).toEqual([
          "api",
          "/repos/octo/app/deployments?per_page=100&environment=dev",
          "--jq",
          ".[].id"
        ]);
        return approved && scenario === "unreadable" ?
            { code: 1, stdout: "", stderr: "HTTP 403" }
          : { code: 0, stdout: "", stderr: "" };
      });
      const runOrThrow = vi.fn(async (args: string[]) => {
        if (args[1] === "/repos/octo/app/environments/dev")
          return { code: 0, stdout: String(environmentId), stderr: "" };
        if (
          args[1] === "/repos/octo/app/environments/dev/variables?per_page=100"
        )
          return {
            code: 0,
            stdout:
              "AZURE_CLIENT_ID\tfixture-client\nAZURE_TENANT_ID\tfixture-tenant\n",
            stderr: ""
          };
        expect(args).toEqual(["api", "/repos/octo/app", "--jq", ".id"]);
        return { code: 0, stdout: "7", stderr: "" };
      });
      const createReadOnlyExecutor = vi.fn<() => Promise<SelectedGhExecutor>>(
        async () => ({
          login: "octocat",
          credentialSource: "injected",
          requiresKeyringSwitch: false,
          scopes: [],
          verifyIdentity: async () => {},
          run,
          runOrThrow,
          packageCredentials: () => {
            throw new Error("Unexpected GHCR call");
          },
          redact: String,
          errorMessage: String
        })
      );
      const withSelectedAccount = vi.fn(async (login: string) => {
        expect(login).toBe("octocat");
        expect(save.mock.calls.at(-1)?.[0].operations).toEqual([
          expect.objectContaining({
            deleteRecovery: expect.objectContaining({
              selectedOwner: "octocat",
              repoId: 7
            })
          })
        ]);
        throw new Error("Selected account revoked before execution");
      });
      const server = createProductionCanvasServerRuntime({
        deploymentRuntime: createTestDeploymentRuntime(),
        awsEnabled: false,
        executionOwner: createEnvironmentExecutionOwner(),
        accountContext: createEnvironmentAccountContext("admission-test", {
          createReadOnlyExecutor,
          withSelectedAccount
        }),
        environmentDeletionPorts: deletionPorts
      });
      const tool = createEnvironmentDeletionTool({
        openScope: ({ repo }) =>
          server.openEnvironmentDeletionScope(repo, "octocat", () => current),
        async confirm(target) {
          expect(target).toEqual({
            repo: "octo/app",
            environment: "dev",
            provider: "azure",
            repoId: 7
          });
          if (scenario === "replaced") environmentId = 18;
          approved = true;
          if (scenario === "stale") current = false;
          return "approved";
        },
        control: unexpectedDeletion,
        redact: String
      });
      const result = await tool({ repo: "octo/app", environment: "dev" });
      expect(createReadOnlyExecutor).toHaveBeenCalledExactlyOnceWith("octocat");
      if (scenario === "unreadable" || scenario === "stale") {
        expect(result).toEqual({
          kind: "refused",
          code: "deployment-unreadable"
        });
        expect(save).not.toHaveBeenCalled();
        expect(withSelectedAccount).not.toHaveBeenCalled();
        return;
      }
      if (scenario === "invalid-id") {
        expect(result).toEqual({
          kind: "refused",
          code: "configuration-unreadable"
        });
        expect(save).not.toHaveBeenCalled();
        expect(withSelectedAccount).not.toHaveBeenCalled();
        return;
      }
      expect(run).toHaveBeenCalledTimes(4);
      expect(runOrThrow).toHaveBeenCalledTimes(6);
      if (scenario === "replaced") {
        expect(result).toEqual({ kind: "refused", code: "target-changed" });
        expect(operations.all()).toEqual([]);
        expect(withSelectedAccount).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ kind: "accepted" });
        await vi.waitFor(() =>
          expect(operations.all()).toEqual([
            expect.objectContaining({
              state: "failed",
              failure: expect.objectContaining({
                message: expect.stringContaining("Selected account revoked")
              })
            })
          ])
        );
        expect(withSelectedAccount).toHaveBeenCalledOnce();
      }
    }
  );
  it.each([
    ["saved account is unavailable", "removed"],
    [
      "no longer resolves the saved environment deletion to the same repository",
      "moved"
    ],
    ["Could not confirm the selected GitHub repository ID", "invalid-id"],
    ["The default branch changed after workflow verification", "branch-moved"],
    ["GitHub refused the delete-environment dispatch", "refused"]
  ])(
    "refuses recovery and retry without a panel when %s (%s)",
    async (diagnostic, scenario) => {
      const save = vi.fn(async (_envelope: { operations: unknown[] }) => {});
      const claimEnvironmentDispatch = vi.fn(
        async (_id: string, _generation: number) => {}
      );
      await configureOperationStore({
        ...disabledOperationStore(),
        durable: true,
        save,
        claimEnvironmentDispatch
      });
      const createServerForPanel = vi.fn(() => {
        throw new Error("Unexpected panel server");
      });
      const head = "a".repeat(40);
      const stableBranch = scenario === "refused";
      const workflowAvailable = stableBranch || scenario === "branch-moved";
      let observeGuard = false;
      let rerunStarted = false;
      let beforeGuardResponse: () => void = () => {};
      const historicalDispatchTime = Date.parse("2026-01-02T03:04:05Z");
      let headReads = 0;
      const readTemplate = (file: string) =>
        readFile(
          new URL(`../../../.github/extension/${file}`, import.meta.url),
          "utf8"
        );
      const generated =
        workflowAvailable ?
          await generateDeleteWorkflow("dev", {
            readTemplate: (_repo, path) =>
              readTemplate(path.split("/").pop() ?? "")
          })
        : {};
      const run = vi.fn(async (args: string[]) => {
        if (workflowAvailable) {
          const success = (stdout: string) => ({ code: 0, stdout, stderr: "" });
          const endpoint = args[1] ?? "";
          if (observeGuard && args[2] === "GET") {
            const details = {
              id: 21,
              display_title:
                "Radius - Delete Environment dev del-test-recovery",
              event: "workflow_dispatch",
              path: ".github/workflows/delete-environment.yml",
              head_branch: "release",
              head_sha: head,
              actor: { login: "octocat" },
              created_at: new Date(historicalDispatchTime).toISOString(),
              updated_at: "2026-01-02T03:05:00Z",
              run_attempt: rerunStarted ? 2 : 1,
              status: rerunStarted ? "in_progress" : "completed",
              conclusion: rerunStarted ? null : "failure"
            };
            const path = args[3];
            if (path.includes("/workflows/delete-environment.yml/runs?"))
              return success(
                JSON.stringify({ total_count: 1, workflow_runs: [details] })
              );
            if (path === "/repos/octo/app/actions/runs/21") {
              beforeGuardResponse();
              return success(JSON.stringify(details));
            }
            if (
              path ===
              "/repos/octo/app/actions/runs/21/attempts/1/jobs?per_page=100"
            )
              return success(
                JSON.stringify({
                  total_count: 1,
                  jobs: [
                    {
                      name: "Azure / Delete with Radius",
                      run_id: 21,
                      run_attempt: 1,
                      status: "completed",
                      conclusion: "failure",
                      steps: [
                        {
                          name: "Guard - environment has no deployed applications",
                          status: "completed",
                          conclusion: "failure"
                        },
                        {
                          name: "Delete Radius resource",
                          status: "completed",
                          conclusion: "skipped"
                        },
                        {
                          name: "Teardown",
                          status: "completed",
                          conclusion: "success"
                        }
                      ]
                    }
                  ]
                })
              );
            throw new Error(`Unexpected guard evidence read: ${path}`);
          }
          if (
            stableBranch &&
            args.slice(0, 3).join(" ") === "api --method POST"
          ) {
            expect(save.mock.calls.at(-1)?.[0].operations).toContainEqual(
              expect.objectContaining({
                deleteRecovery: expect.objectContaining({
                  selectedDispatchAttempts: expect.arrayContaining([
                    expect.objectContaining({ state: "unresolved" })
                  ])
                })
              })
            );
            return {
              code: 1,
              stderr: "gh: not found",
              stdout:
                "HTTP/2.0 404 Not Found\r\nX-GitHub-Request-Id: ABC:123\r\n\r\n{}"
            };
          }
          if (
            stableBranch &&
            endpoint ===
              "/repos/octo/app/deployments?per_page=100&environment=dev"
          )
            return success("");
          if (
            stableBranch &&
            endpoint ===
              "/repos/octo/app/environments/dev/variables?per_page=100"
          )
            return success("AZURE_CLIENT_ID\nAZURE_TENANT_ID\n");
          if (args[0] !== "api") throw new Error("Unexpected GH mutation");
          if (endpoint === "/repos/octo/app") {
            if (args[3] === ".id") return success("7");
            if (args[3] === ".default_branch") return success("release");
          }
          if (endpoint === "/repos/octo/app/git/ref/heads/release")
            return success(
              ++headReads % 2 === 1 || stableBranch ? head : "b".repeat(40)
            );
          const canonical = endpoint.match(
            /^\/repos\/radius-project\/ai-extensions\/contents\/\.github\/extension\/(delete[\w-]*\.yml)\?ref=(.+)$/
          );
          if (canonical?.[1] && canonical[2] === DELETE_RADIUS_REF)
            return success(
              Buffer.from(await readTemplate(canonical[1])).toString("base64")
            );
          const committed = endpoint.match(
            /^\/repos\/octo\/app\/contents\/\.github\/workflows\/(delete-environment[\w-]*\.yml)\?ref=(.+)$/
          );
          if (
            committed?.[1] &&
            committed[2] === head &&
            generated[committed[1]]
          )
            return success(
              Buffer.from(generated[committed[1]]).toString("base64")
            );
          throw new Error(`Unexpected selected GitHub read: ${endpoint}`);
        }
        expect(args).toEqual(["api", "/repos/octo/app", "--jq", ".id"]);
        return {
          code: 0,
          stdout: scenario === "invalid-id" ? "not an ID" : "8",
          stderr: ""
        };
      });
      const createReadOnlyExecutor = vi.fn(async () => ({
        login: "octocat",
        credentialSource: "injected" as const,
        requiresKeyringSwitch: false,
        scopes: [],
        verifyIdentity: async () => {},
        run,
        runOrThrow:
          stableBranch ?
            async (args: string[]) => {
              if (args[1] === "/repos/octo/app/environments/dev")
                return { code: 0, stdout: "17", stderr: "" };
              if (
                args[1] ===
                "/repos/octo/app/environments/dev/variables?per_page=100"
              )
                return {
                  code: 0,
                  stdout:
                    "AZURE_CLIENT_ID\tfixture-client\nAZURE_TENANT_ID\tfixture-tenant\n",
                  stderr: ""
                };
              return run(args);
            }
          : unexpectedDeletion,
        packageCredentials: () => {
          throw new Error("Unexpected GHCR call");
        },
        redact: String,
        errorMessage: String
      }));
      const accountLeaseCalls = vi.fn();
      async function withSelectedAccount<T>(
        login: string,
        context: GitHubAccountLeaseMetadata,
        work: (
          executor: SelectedGhExecutor,
          lease: GitHubAccountLease
        ) => Promise<T>
      ): Promise<GitHubAccountLeaseResult<T>> {
        accountLeaseCalls(login, context, work);
        if (scenario === "removed")
          throw new Error("The saved account is unavailable.");
        const executor = await createReadOnlyExecutor();
        const value = await work(executor, {
          release: unexpectedDeletion,
          retake: unexpectedDeletion
        });
        return {
          value,
          selectedLogin: executor.login,
          credentialSource: executor.credentialSource,
          switched: false,
          restoration: {
            state: "not_required",
            originalLogin: executor.login,
            currentLogin: executor.login,
            guidance: null
          }
        };
      }
      const runtime = createProductionCanvasServerRuntime({
        deploymentRuntime: createTestDeploymentRuntime(),
        awsEnabled: false,
        executionOwner: createEnvironmentExecutionOwner(),
        accountContext: createEnvironmentAccountContext("recovery-test", {
          createReadOnlyExecutor,
          withSelectedAccount
        }),
        environmentDeletionPorts: deletionPorts,
        serverDependencies: { createHttpServer: createServerForPanel }
      });
      const operation = createOperation({
        kind: "delete",
        repo: "octo/app",
        environment: "dev",
        provider: "azure",
        stages: buildDeleteStages()
      });
      operation.request = {
        repo: "octo/app",
        repoId: 7,
        environmentId: 17,
        clientId: "fixture-client",
        tenantId: "fixture-tenant",
        environment: "dev",
        provider: "azure",
        selectedOwner: "octocat"
      };
      operations.put(operation);
      const target = {
        operationId: operation.operationId,
        repo: "octo/app",
        environment: "dev",
        login: "octocat",
        isCurrent: () => true
      };
      for (const mismatch of [
        { login: "different" },
        { operationId: "missing" },
        { repo: "octo/other" },
        { environment: "prod" }
      ]) {
        expect(
          await runtime.controlSelectedEnvironmentDeletion({
            ...target,
            ...mismatch,
            command: "retry"
          })
        ).toMatchObject({ status: 404 });
      }
      expect(createReadOnlyExecutor).not.toHaveBeenCalled();
      let active = true;
      const stale = runtime.controlSelectedEnvironmentDeletion({
        ...target,
        isCurrent: () => active,
        command: "retry"
      });
      active = false;
      await expect(stale).resolves.toMatchObject({ status: 404 });
      expect(accountLeaseCalls).not.toHaveBeenCalled();
      expect(
        await runtime.controlSelectedEnvironmentDeletion({
          ...target,
          command: "status"
        })
      ).toMatchObject({
        status: 200,
        body: {
          operationId: operation.operationId,
          state: "running",
          retryable: false
        }
      });
      const earlyRetry = await runtime.controlSelectedEnvironmentDeletion({
        ...target,
        command: "retry"
      });
      expect(earlyRetry.status).toBeGreaterThanOrEqual(400);
      expect(accountLeaseCalls).not.toHaveBeenCalled();
      runtime.recoverSelectedEnvironmentDeletions();
      const expectedState = workflowAvailable ? "failed_partial" : "failed";
      await vi.waitFor(() => expect(operation.state).toBe(expectedState));
      expect(accountLeaseCalls).toHaveBeenCalledExactlyOnceWith(
        "octocat",
        { ownerKey: "recovery-test", operationId: operation.operationId },
        expect.any(Function)
      );
      expect(createServerForPanel).not.toHaveBeenCalled();
      expect(operation.failure.message).toContain(diagnostic);
      const latestStatus = await runtime.controlSelectedEnvironmentDeletion({
        ...target,
        command: "status"
      });
      expect(latestStatus).toMatchObject({
        status: 200,
        body: { terminal: true, message: expect.stringContaining(diagnostic) }
      });
      const evidence =
        "retryEvidence" in latestStatus.body ?
          latestStatus.body.retryEvidence
        : undefined;
      if (stableBranch) expect(evidence).toEqual(expect.any(String));
      setStageState(operation, STAGE_DELETE_RADIUS_ENV, "failed");
      const retry = await runtime.controlSelectedEnvironmentDeletion({
        ...target,
        command: "retry",
        retryEvidence: evidence
      });
      expect(retry).toMatchObject({
        status: 202,
        body: { operationId: operation.operationId }
      });
      await vi.waitFor(() => expect(operation.state).toBe(expectedState));
      expect(operation.failure.message).toContain(diagnostic);
      expect(accountLeaseCalls).toHaveBeenCalledTimes(2);
      if (stableBranch) {
        expect(
          run.mock.calls.filter(([args]) => args[2] === "POST")
        ).toHaveLength(2);
        expect(claimEnvironmentDispatch.mock.calls).toEqual([
          [operation.operationId, 1],
          [operation.operationId, 2]
        ]);
        expect(operation.request.selectedDispatchAttempts).toEqual([
          expect.objectContaining({ state: "refused", operationAttempt: 0 }),
          expect.objectContaining({ state: "refused", operationAttempt: 1 })
        ]);
        operation.request.selectedDispatchAttempts = [
          {
            state: "correlated",
            operationAttempt: 1,
            runId: 21,
            branch: "release",
            head,
            dispatchedAt: historicalDispatchTime,
            correlationId: "del-test-recovery"
          }
        ];
        observeGuard = true;
        const correlatedAttempts = operation.request.selectedDispatchAttempts;
        save.mockRejectedValueOnce(
          new Error("Fixture operation store is full")
        );
        await expect(
          runtime.controlSelectedEnvironmentDeletion({
            ...target,
            command: "status"
          })
        ).rejects.toThrow("Fixture operation store is full");
        expect(operation.request.selectedDispatchAttempts).toBe(
          correlatedAttempts
        );
        let current = true;
        beforeGuardResponse = () => {
          current = false;
        };
        expect(
          await runtime.controlSelectedEnvironmentDeletion({
            ...target,
            command: "status",
            isCurrent: () => current
          })
        ).toMatchObject({ status: 404 });
        expect(operation.request.selectedDispatchAttempts).toBe(
          correlatedAttempts
        );
        beforeGuardResponse = () => {};
        const guarded = await runtime.controlSelectedEnvironmentDeletion({
          ...target,
          command: "status"
        });
        expect(guarded).toMatchObject({
          status: 200,
          body: {
            retryable: true,
            retryEvidence: expect.any(String),
            message: expect.stringContaining("applications guard")
          }
        });
        rerunStarted = true;
        const guardedEvidence =
          "retryEvidence" in guarded.body ?
            guarded.body.retryEvidence
          : undefined;
        expect(
          await runtime.controlSelectedEnvironmentDeletion({
            ...target,
            command: "retry",
            retryEvidence: guardedEvidence
          })
        ).toMatchObject({
          status: 409,
          body: { code: "deletion-retry-evidence-changed" }
        });
        expect(
          await runtime.controlSelectedEnvironmentDeletion({
            ...target,
            command: "status"
          })
        ).toMatchObject({ status: 200, body: { retryable: false } });
        expect(
          run.mock.calls.filter(([args]) => args[2] === "POST")
        ).toHaveLength(2);
      } else if (scenario === "branch-moved") {
        expect(headReads).toBe(4);
        expect(operation.request?.selectedDispatchStarted).toBeUndefined();
        expect(run.mock.calls.every(([args]) => args[0] === "api")).toBe(true);
        operation.request.selectedDispatchStarted = true;
        expect(
          await runtime.controlSelectedEnvironmentDeletion({
            ...target,
            command: "status"
          })
        ).toMatchObject({
          status: 200,
          body: {
            retryable: false,
            message: expect.stringContaining("GitHub Actions")
          }
        });
        expect(
          await runtime.controlSelectedEnvironmentDeletion({
            ...target,
            command: "retry"
          })
        ).toMatchObject({
          status: 409,
          body: { code: "deletion-dispatch-unconfirmed" }
        });
        const priorAttempt = {
          state: "refused",
          operationAttempt: 1,
          dispatchedAt: 1234,
          correlationId: "del-ya-fixture",
          branch: "main",
          head: "a".repeat(40)
        };
        operation.request.selectedDispatchAttempts = [priorAttempt];
        const status = await runtime.controlSelectedEnvironmentDeletion({
          ...target,
          command: "status"
        });
        expect(status).toMatchObject({
          status: 200,
          body: { retryable: true, retryEvidence: expect.any(String) }
        });
        const retryEvidence =
          "retryEvidence" in status.body ?
            status.body.retryEvidence
          : undefined;
        operation.request.selectedDispatchAttempts = [
          priorAttempt,
          {
            ...priorAttempt,
            operationAttempt: 2,
            correlationId: "del-ya-following"
          }
        ];
        expect(
          await runtime.controlSelectedEnvironmentDeletion({
            ...target,
            command: "retry",
            retryEvidence
          })
        ).toMatchObject({
          status: 409,
          body: { code: "deletion-retry-evidence-changed" }
        });
        expect(accountLeaseCalls).toHaveBeenCalledTimes(2);
      } else {
        expect(run).toHaveBeenCalledTimes(scenario === "removed" ? 0 : 2);
      }
    }
  );
  it("refuses to retry a selected-owner deletion through the generic Canvas HTTP route", async () => {
    const server = runtime();
    const operation = createOperation({
      kind: "delete",
      repo: "octo/app",
      environment: "dev",
      provider: "azure",
      stages: buildDeleteStages()
    });
    operation.request = { selectedOwner: "octocat" };
    setStageState(operation, STAGE_DELETE_RADIUS_ENV, "failed");
    operation.state = "failed_partial";
    operations.put(operation);
    const entry = await server.getOrCreateServer(
      "selected-retry",
      "environment"
    );
    try {
      const response = await fetch(
        `${entry.baseUrl}/api/operations/${operation.operationId}/retry/deletion`,
        {
          method: "POST",
          headers: mutationHeaders(
            entry.baseUrl,
            entry.state.browserMutationNonce
          ),
          body: JSON.stringify({ authorizeSelectedDeletionRetry: true })
        }
      );
      expect(response.status).toBe(409);
      expect(await json(response)).toMatchObject({
        code: "selected-deletion-requires-chat"
      });
      expect(operation.state).toBe("failed_partial");
    } finally {
      await server.stopServer("selected-retry");
    }
  });

  it("retries only the unresolved state package using the saved owner's GitHub and GHCR credentials", async () => {
    await configureOperationStore({
      ...disabledOperationStore(),
      durable: true
    });
    await configureCredentialProvenanceStore({
      load: async () => [],
      read: unexpectedDeletion,
      write: unexpectedDeletion,
      remove: unexpectedDeletion,
      withLock: async (work) => work()
    });
    onTestFinished(() => configureCredentialProvenanceStore(null));
    const operation = createOperation({
      kind: "delete",
      repo: "octo/app",
      environment: "dev",
      provider: "azure",
      stages: buildDeleteStages()
    });
    operation.request = {
      repo: "octo/app",
      repoId: 7,
      environmentId: 17,
      clientId: "fixture-client",
      tenantId: "fixture-tenant",
      environment: "dev",
      provider: "azure",
      selectedOwner: "octocat",
      selectedDispatchStarted: true
    };
    const completedStageIds = new Set<string>();
    for (const stage of operation.stages) {
      if (stage.id === STAGE_DELETE_GITHUB_ENV) break;
      setStageState(operation, stage.id, "succeeded");
      completedStageIds.add(stage.id);
    }
    completedStageIds.add(STAGE_DELETE_GITHUB_ENV);
    operations.put(operation);

    let activeLease = false;
    const run = vi.fn(async (args: string[]) => {
      expect(activeLease).toBe(true);
      if (args[1] === "--method") {
        expect(args).toEqual([
          "api",
          "--method",
          "DELETE",
          "/repos/octo/app/environments/dev"
        ]);
        return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      }
      if (args[1] === "--paginate") {
        expect(args).toEqual([
          "api",
          "--paginate",
          "-H",
          "Accept: application/vnd.github+json",
          "/repos/octo/app/environments",
          "--jq",
          ".environments[].name"
        ]);
        return { code: 0, stdout: "prod\n", stderr: "" };
      }
      expect(args).toEqual(["api", "/repos/octo/app", "--jq", ".id"]);
      return { code: 0, stdout: "7", stderr: "" };
    });
    const packageCredentials = vi.fn(() => ({
      username: "octocat",
      token: "selected-fixture",
      source: "injected-token" as const,
      scopes: ["read:packages", "delete:packages"]
    }));
    const executor: SelectedGhExecutor = {
      login: "octocat",
      credentialSource: "injected",
      requiresKeyringSwitch: false,
      scopes: [],
      verifyIdentity: vi.fn(async () => {}),
      run,
      runOrThrow: async (args) => {
        const value = new Map([
          [
            "/repos/octo/app/environments/dev/variables?per_page=100",
            "AZURE_CLIENT_ID\tfixture-client\nAZURE_TENANT_ID\tfixture-tenant\n"
          ],
          ["/repos/octo/app/environments/dev", "17"],
          ["/repos/octo/app", "7"]
        ]).get(args[1] ?? "");
        if (!value) throw new Error("Unexpected selected environment read");
        return { code: 0, stdout: value, stderr: "" };
      },
      packageCredentials,
      redact: String,
      errorMessage: String
    };
    const createReadOnlyExecutor = vi.fn(async () => executor);
    let permitPackageRead = false;
    let packageDeleted = false;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, options) => {
        expect(activeLease).toBe(true);
        expect(new Headers(options?.headers).get("Authorization")).toBe(
          "Bearer selected-fixture"
        );
        const url = new URL(String(input));
        expect(url.origin).toBe("https://api.github.com");
        if (url.pathname === "/users/octo")
          return Response.json({ type: "User" });
        expect(url.pathname).toMatch(
          /^\/users\/octo\/packages\/container\/app-radius-state-dev-/
        );
        if (!permitPackageRead) return new Response(null, { status: 403 });
        if (options?.method === "DELETE") {
          packageDeleted = true;
          return new Response(null, { status: 204 });
        }
        return packageDeleted ?
            new Response(null, { status: 404 })
          : Response.json({
              visibility: "private",
              repository: { full_name: "octo/app" }
            });
      });
    const runtime = createProductionCanvasServerRuntime({
      deploymentRuntime: createTestDeploymentRuntime(),
      awsEnabled: false,
      executionOwner: createEnvironmentExecutionOwner(),
      accountContext: createEnvironmentAccountContext("package-retry-test", {
        createReadOnlyExecutor,
        async withSelectedAccount(login, metadata, work) {
          expect(login).toBe("octocat");
          expect(metadata.operationId).toBe(operation.operationId);
          activeLease = true;
          try {
            return {
              value: await work(executor, {
                release: unexpectedDeletion,
                retake: unexpectedDeletion
              }),
              selectedLogin: login,
              credentialSource: executor.credentialSource,
              switched: false,
              restoration: {
                state: "not_required",
                originalLogin: login,
                currentLogin: login,
                guidance: null
              }
            };
          } finally {
            activeLease = false;
          }
        }
      }),
      environmentDeletionPorts: deletionPorts
    });
    runtime.recoverSelectedEnvironmentDeletions();
    await vi.waitFor(() => {
      expect(operation.state).toBe("failed_partial");
      expect(activeLease).toBe(false);
    });
    expect(operation.failure?.code).toBe("state-package-delete-failed");
    expect(operation.stages).toContainEqual(
      expect.objectContaining({
        id: STAGE_DELETE_GITHUB_ENV,
        state: "succeeded"
      })
    );
    expect(packageDeleted).toBe(false);
    const completedSteps = operation.steps.filter((step: { stage: string }) =>
      completedStageIds.has(step.stage)
    );
    fetch.mockClear();
    run.mockClear();
    permitPackageRead = true;
    expect(
      await runtime.controlSelectedEnvironmentDeletion({
        command: "retry",
        operationId: operation.operationId,
        repo: "octo/app",
        environment: "dev",
        login: "octocat",
        isCurrent: () => true
      })
    ).toMatchObject({ status: 202 });
    await vi.waitFor(() => {
      expect(operation.state).toBe("succeeded");
      expect(activeLease).toBe(false);
    });
    expect(
      fetch.mock.calls.map(([, options]) => options?.method ?? "GET")
    ).toEqual(["GET", "GET", "DELETE", "GET"]);
    expect(
      operation.steps.filter((step: { stage: string }) =>
        completedStageIds.has(step.stage)
      )
    ).toEqual(completedSteps);
    expect(run.mock.calls.map(([args]) => args[1])).toEqual([
      "/repos/octo/app",
      "--paginate"
    ]);
    expect(packageCredentials).toHaveBeenCalledTimes(2);
  });

  it("reuses a loopback instance, updates its page, isolates instances, and cleans up idempotently", async () => {
    let now = 100;
    const createdStates: CanvasState[] = [];
    const server = runtime({
      now: () => ++now,
      createState: () => {
        const state = { contextRepo: `fixture/repo-${createdStates.length}` };
        createdStates.push(state);
        return state;
      }
    });

    let firstBaseUrl: string | undefined;
    try {
      const first = await server.getOrCreateServer("panel-a", "graph");
      firstBaseUrl = first.baseUrl;
      const reused = await server.getOrCreateServer("panel-a", "planned");
      const second = await server.getOrCreateServer("panel-b", "environment");
      expect(new URL(first.baseUrl).hostname).toBe("127.0.0.1");
      expect(Number(new URL(first.baseUrl).port)).toBeGreaterThan(0);
      expect(reused).toBe(first);
      expect(reused.url).toBe(`${first.baseUrl}/?page=planned`);
      expect(second.baseUrl).not.toBe(first.baseUrl);
      expect(createdStates).toHaveLength(2);
      expect(server.servers.size).toBe(2);

      const ping = await fetch(`${first.baseUrl}/api/ping`);
      expect(ping.status).toBe(200);
      expect(await json(ping)).toEqual({
        ok: true,
        instanceId: "panel-a"
      });
      expect(server.getLastWebviewActivityAt()).toBe(101);
    } finally {
      await Promise.allSettled([
        server.stopServer("panel-a", true),
        server.stopServer("panel-b", true)
      ]);
      await server.stopServer("panel-a", true);
    }

    expect(server.servers.size).toBe(0);
    if (!firstBaseUrl) throw new Error("The first server did not start");
    await expect(fetch(firstBaseUrl)).rejects.toThrow();
  });

  it("coalesces concurrent opens and permits a clean reopen after shutdown", async () => {
    const server = runtime();
    try {
      const [first, second] = await Promise.all([
        server.getOrCreateServer("single-flight", "graph"),
        server.getOrCreateServer("single-flight", "deploying")
      ]);
      expect(first).toBe(second);
      expect(first.page).toBe("deploying");
      await server.stopServer("single-flight", true);

      const reopened = await server.getOrCreateServer(
        "single-flight",
        "credentials"
      );
      expect(reopened).not.toBe(first);
      expect(reopened.page).toBe("credentials");
      expect((await fetch(reopened.baseUrl)).status).toBe(200);
    } finally {
      await server.stopServer("single-flight", true);
    }
  });

  it("fails startup dependencies closed without retaining a partial instance", async () => {
    const server = runtime({
      prepareIdentity: () => {
        throw new Error("identity preparation failed");
      }
    });

    await expect(server.getOrCreateServer("broken", "graph")).rejects.toThrow(
      "identity preparation failed"
    );
    expect(server.servers.size).toBe(0);
    await expect(server.stopServer("broken", true)).resolves.toBeUndefined();
  });

  it("falls back from a busy preferred port to an OS-assigned loopback port", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => {
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP address");
    }
    const server = runtime({ preferredPort: async () => address.port });

    try {
      const entry = await server.getOrCreateServer("fallback", "graph");
      expect(Number(new URL(entry.baseUrl).port)).not.toBe(address.port);
      expect((await fetch(`${entry.baseUrl}/api/ping`)).status).toBe(200);
    } finally {
      await Promise.allSettled([
        server.stopServer("fallback", true),
        new Promise<void>((resolve, reject) => {
          occupied.close((error) => (error ? reject(error) : resolve()));
        })
      ]);
    }
  });

  it("rejects malformed, unauthorized, cross-site, wrong-method, and unknown requests before side effects", async () => {
    const server = runtime();
    const entry = await server.getOrCreateServer("boundaries", "graph");
    const headers = mutationHeaders(
      entry.baseUrl,
      entry.state.browserMutationNonce
    );

    try {
      const missingNonce = await fetch(`${entry.baseUrl}/api/operations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      expect(missingNonce.status).toBe(403);
      expect(await json(missingNonce)).toMatchObject({
        code: "browser-mutation-validation-failed"
      });

      const crossSite = await fetch(`${entry.baseUrl}/api/operations`, {
        method: "POST",
        headers: {
          ...headers,
          "Sec-Fetch-Site": "cross-site"
        },
        body: "{}"
      });
      expect(crossSite.status).toBe(403);
      expect(await json(crossSite)).toEqual({
        error: "Cross-site request rejected.",
        code: "cross-site-forbidden"
      });

      const malformed = await fetch(`${entry.baseUrl}/api/operations`, {
        method: "POST",
        headers,
        body: "{"
      });
      expect(malformed.status).toBe(400);
      expect(await json(malformed)).toMatchObject({ code: "invalid-json" });

      const wrongMethod = await fetch(`${entry.baseUrl}/api/operations`, {
        method: "PUT"
      });
      const unknown = await fetch(`${entry.baseUrl}/api/not-a-route`);
      expect(wrongMethod.status).toBe(200);
      expect(wrongMethod.headers.get("content-type")).toBe(
        "text/html; charset=utf-8"
      );
      expect(unknown.status).toBe(200);
      expect(unknown.headers.get("content-type")).toBe(
        "text/html; charset=utf-8"
      );
      expect(operations.all()).toEqual([]);
    } finally {
      await server.stopServer("boundaries", true);
    }
  });

  it("exercises safe read contracts and operation lookup failures repeatedly", async () => {
    const server = runtime();
    const entry = await server.getOrCreateServer("reads", "environment");

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const latest = await fetch(`${entry.baseUrl}/api/operations`);
        expect(latest.status).toBe(200);
        expect(await json(latest)).toEqual({ operation: null });

        const byRepo = await fetch(
          `${entry.baseUrl}/api/operations?repo=fixture%2Fapp`
        );
        expect(byRepo.status).toBe(200);
        expect(await json(byRepo)).toEqual({ operation: null });

        const missing = await fetch(
          `${entry.baseUrl}/api/operations/missing-operation`
        );
        expect(missing.status).toBe(404);
        expect(await json(missing)).toEqual({ error: "Unknown operation." });

        const diagnostics = await fetch(
          `${entry.baseUrl}/api/operations/missing-operation/diagnostics`
        );
        expect(diagnostics.status).toBe(404);
        expect(await json(diagnostics)).toMatchObject({
          code: "unknown-operation"
        });

        const progress = await fetch(`${entry.baseUrl}/api/progress`);
        expect(progress.status).toBe(200);
        expect(await json(progress)).toEqual({ messages: [] });

        const notification = await fetch(
          `${entry.baseUrl}/api/deploy-notification`
        );
        expect(notification.status).toBe(200);
        expect(await json(notification)).toMatchObject({
          status: "pending",
          attemptId: "",
          repairing: false
        });
      }
    } finally {
      await server.stopServer("reads", true);
    }
  });

  it("serves explicit pages, redirects an implicit active deployment, and falls back safely", async () => {
    const server = runtime();
    const entry = await server.getOrCreateServer("pages", "environment");

    try {
      entry.state.deployStatus = "in_progress";
      const implicit = await fetch(entry.baseUrl);
      expect(implicit.status).toBe(200);
      expect(await implicit.text()).toContain(
        "<title>Deployments — Radius</title>"
      );

      const explicit = await fetch(`${entry.baseUrl}/?page=credentials`);
      expect(explicit.status).toBe(200);
      expect(await explicit.text()).toContain('id="pane-credentials"');
      expect(entry.state.activeSubtab).toBe("credentials");

      const environment = await fetch(`${entry.baseUrl}/?page=environment`);
      expect(environment.status).toBe(200);
      expect(await environment.text()).toContain('id="pane-environments"');
      expect(entry.state.activeSubtab).toBe("environments");

      const unknown = await fetch(`${entry.baseUrl}/?page=unknown`);
      expect(unknown.status).toBe(200);
      expect(await unknown.text()).toContain('id="pane-environments"');
    } finally {
      await server.stopServer("pages", true);
    }
  });

  it("delegates valid source opens and turns handler failures into explicit HTTP failures", async () => {
    const opened = vi.fn();
    setOpenSourceHandler(opened);
    const server = runtime({
      createState: () => ({ contextRepo: "fixture/app" })
    });
    const entry = await server.getOrCreateServer("source", "graph");
    const headers = mutationHeaders(
      entry.baseUrl,
      entry.state.browserMutationNonce
    );

    try {
      const success = await fetch(`${entry.baseUrl}/api/open-source`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "infra/main.bicep", line: "12" })
      });
      expect(success.status).toBe(200);
      expect(await json(success)).toEqual({ ok: true });
      expect(opened).toHaveBeenCalledExactlyOnceWith({
        path: "infra/main.bicep",
        line: 12,
        instanceId: "source",
        state: entry.state
      });

      setOpenSourceHandler(() => {
        throw new Error("editor unavailable");
      });
      const failed = await fetch(`${entry.baseUrl}/api/open-source`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "infra/main.bicep", line: 0 })
      });
      expect(failed.status).toBe(500);
      expect(await json(failed)).toEqual({
        ok: false,
        error: "editor unavailable"
      });

      const traversal = await fetch(`${entry.baseUrl}/api/open-source`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "../outside.bicep", line: 1 })
      });
      expect(traversal.status).toBe(400);
      expect(await json(traversal)).toEqual({
        ok: false,
        error: "invalid path"
      });
    } finally {
      await server.stopServer("source", true);
    }
  });

  it("fails safe read routes before reaching unavailable external dependencies", async () => {
    const server = runtime();
    const entry = await server.getOrCreateServer("safe-reads", "environment");

    try {
      const paths = [
        "/api/deployed-graph",
        "/api/deploy-status",
        "/api/list-environments",
        "/api/list-applications",
        "/api/list-deployments",
        "/api/delete-conflict",
        "/api/verify-status"
      ];
      for (const path of paths) {
        const response = await fetch(entry.baseUrl + path);
        expect([200, 400, 404], path).toContain(response.status);
        expect(response.headers.get("content-type"), path).toContain(
          "application/json"
        );
        await response.text();
      }
    } finally {
      await server.stopServer("safe-reads", true);
    }
  });

  it("returns validation failures for safe empty requests across route families without invoking external systems", async () => {
    const cliExec = vi.fn(
      (
        _command: string,
        args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(null, args.includes("--jq") ? "" : "[]", "");
        return new ChildProcess();
      }
    );
    setOpenSourceHandler(() => {
      throw new Error("Open source must not run for invalid input");
    });
    const runner = vi.fn(async () => {
      throw new Error("Environment runner must not start for invalid input");
    });
    const server = createProductionCanvasServerRuntime({
      deploymentRuntime: createTestDeploymentRuntime(),
      awsEnabled: false,
      executionOwner: createEnvironmentExecutionOwner(),
      accountContext: accountContext(),
      environmentOperationRunner: runner,
      environmentDeletionPorts: deletionPorts,
      cliExec,
      serverDependencies: {
        preferredPort: async () => 0,
        prepareIdentity: () => {}
      }
    });
    const entry = await server.getOrCreateServer("validation", "environment");
    const headers = mutationHeaders(
      entry.baseUrl,
      entry.state.browserMutationNonce
    );
    const post = (path: string, body = "{}") =>
      fetch(entry.baseUrl + path, {
        method: "POST",
        headers,
        body
      });

    try {
      const invalidRoutes = [
        "/api/open-source",
        "/api/run-remediation",
        "/api/github-account",
        "/api/delete-environment",
        "/api/operations",
        "/api/app-params",
        "/api/delete-deployment",
        "/api/abandon-deployment",
        "/api/deploy"
      ];
      for (const path of invalidRoutes) {
        const response = await post(path);
        expect(response.status, path).toBe(400);
        expect(response.headers.get("content-type"), path).toContain(
          "application/json"
        );
        expect(await json(response), path).toMatchObject({
          error: expect.any(String)
        });
      }

      const jsonRoutes: Array<[string, number[]]> = [
        ["/api/bypass-verification", [400, 404, 409]],
        ["/api/load-graph", [200, 400]],
        ["/api/plan-graph", [200, 400]],
        ["/api/diff-branches", [200, 400]],
        ["/api/discover", [200, 400]]
      ];
      for (const [path, statuses] of jsonRoutes) {
        const response = await post(path);
        expect(statuses, path).toContain(response.status);
        expect(response.headers.get("content-type"), path).toContain(
          "application/json"
        );
        expect(await json(response), path).toEqual(expect.any(Object));
      }

      const repositoryBranches = await post("/api/repo-branches");
      expect(repositoryBranches.status).toBe(200);
      expect(await json(repositoryBranches)).toEqual({ branches: [] });
      expect(cliExec).not.toHaveBeenCalled();

      const discoveredBranches = await post("/api/discover-branches");
      expect(discoveredBranches.status).toBe(200);
      expect(discoveredBranches.headers.get("content-type")).toContain(
        "application/json"
      );
      expect(await json(discoveredBranches)).toEqual({ branches: [] });
      expect(cliExec).toHaveBeenCalledExactlyOnceWith(
        "gh",
        ["api", "--paginate", "/repos//branches?per_page=100"],
        { timeout: 15000 },
        expect.any(Function)
      );

      for (const path of ["/api/azure-auto-setup", "/api/create-environment"]) {
        const response = await post(path);
        expect(response.status, path).toBe(200);
        expect(response.headers.get("content-type"), path).toContain(
          "text/html"
        );
        expect(await response.text(), path).toContain("<!doctype html>");
      }

      const reset = await fetch(`${entry.baseUrl}/api/deploy-reset`, {
        method: "POST",
        headers
      });
      expect(reset.status).toBe(200);
      expect(await json(reset)).toEqual({ ok: true });
      expect(runner).not.toHaveBeenCalled();
      expect(operations.all()).toEqual([]);
    } finally {
      await server.stopServer("validation", true);
    }
  });

  it("fails closed for missing operation actions without scheduling or mutation", async () => {
    const runner = vi.fn(async () => {
      throw new Error("Unexpected operation scheduling");
    });
    const server = createProductionCanvasServerRuntime({
      deploymentRuntime: createTestDeploymentRuntime(),
      awsEnabled: false,
      executionOwner: createEnvironmentExecutionOwner(),
      accountContext: accountContext(),
      environmentOperationRunner: runner,
      environmentDeletionPorts: deletionPorts,
      serverDependencies: {
        preferredPort: async () => 0,
        prepareIdentity: () => {}
      }
    });
    const entry = await server.getOrCreateServer("actions", "environment");
    const headers = mutationHeaders(
      entry.baseUrl,
      entry.state.browserMutationNonce
    );

    try {
      const paths = [
        "/api/operations/missing/resume/input-required",
        "/api/operations/missing/abandon",
        "/api/operations/missing/dismiss",
        "/api/operations/missing/stop",
        "/api/operations/missing/continue",
        "/api/operations/missing/cancel-workflow",
        "/api/operations/missing/rollback",
        "/api/operations/missing/exit",
        "/api/operations/missing/retry/cleanup"
      ];
      for (const path of paths) {
        const response = await fetch(entry.baseUrl + path, {
          method: "POST",
          headers,
          body:
            path.endsWith("/abandon") || path.endsWith("/dismiss") ? null : "{}"
        });
        expect(response.status, path).toBe(404);
        expect(await json(response), path).toMatchObject({
          error: "Unknown operation."
        });
      }
      expect(runner).not.toHaveBeenCalled();
      expect(operations.all()).toEqual([]);
    } finally {
      await server.stopServer("actions", true);
    }
  });

  it("previews bounded terminal operation diagnostic identifiers", async () => {
    const operation = {
      operationId: "op_diagnostics",
      schemaVersion: 6,
      repo: "fixture/app",
      environment: "dev",
      provider: "azure",
      state: "failed",
      currentStage: "verify",
      startedAt: "2026-10-15T18:00:00.000Z",
      lastActivityAt: "2026-10-15T18:01:00.000Z",
      endedAt: "2026-10-15T18:01:00.000Z",
      stages: [],
      control: {
        attempts: { setup: 1, verification: 0 },
        stop: { requestedAt: null, acknowledgedAt: null },
        commands: []
      },
      failure: null,
      setupArtifacts: {
        cleanup: { state: "not_needed", attempts: 0, results: [] }
      },
      providerRecovery: { state: "complete", mutations: [] },
      context: { githubLogin: "fixture-user" },
      journey: { resumeBranch: "feature/runtime-coverage" },
      dismissedAt: null
    };
    operations.put(operation);
    const server = runtime();
    const entry = await server.getOrCreateServer("diagnostics", "environment");

    try {
      const preview = await fetch(
        `${entry.baseUrl}/api/operations/${operation.operationId}/diagnostics?identifiers=preview`
      );
      expect(preview.status).toBe(200);
      const previewBody = await json(preview);
      expect(previewBody).toMatchObject({
        contextualIdentifiers: {
          repository: "fixture/app",
          environment: "dev"
        },
        contextFingerprint: expect.any(String)
      });
    } finally {
      await server.stopServer("diagnostics", true);
    }
  });

  it("accepts a cooperative stop and keeps the operation pollable without starting external work", async () => {
    const operation = createOperation({
      operationId: "op_stop",
      repo: "fixture/app",
      environment: "dev",
      provider: "azure",
      stages: buildStages()
    });
    operations.put(operation);
    const runner = vi.fn(async () => {
      throw new Error("Stop must not start environment work");
    });
    const server = createProductionCanvasServerRuntime({
      deploymentRuntime: createTestDeploymentRuntime(),
      awsEnabled: false,
      executionOwner: createEnvironmentExecutionOwner(),
      accountContext: accountContext(),
      environmentOperationRunner: runner,
      environmentDeletionPorts: deletionPorts,
      serverDependencies: {
        preferredPort: async () => 0,
        prepareIdentity: () => {}
      }
    });
    const entry = await server.getOrCreateServer("stop", "environment");
    const headers = mutationHeaders(
      entry.baseUrl,
      entry.state.browserMutationNonce
    );

    try {
      const stopped = await fetch(
        `${entry.baseUrl}/api/operations/${operation.operationId}/stop`,
        {
          method: "POST",
          headers,
          body: "{}"
        }
      );
      const stoppedBody = await json(stopped);
      expect({ status: stopped.status, body: stoppedBody }).toMatchObject({
        status: 202
      });
      expect(stoppedBody).toMatchObject({
        code: "operation-stop-pending",
        operation: {
          operationId: operation.operationId,
          stop: { requested: true }
        }
      });

      const poll = await fetch(
        `${entry.baseUrl}/api/operations/${operation.operationId}`
      );
      expect(poll.status).toBe(200);
      expect(await json(poll)).toMatchObject({
        operation: {
          operationId: operation.operationId,
          stop: { requested: true }
        }
      });
      expect(runner).not.toHaveBeenCalled();
    } finally {
      await server.stopServer("stop", true);
    }
  });

  it("exercises state-only deployment callbacks while refusing overlapping destructive requests", async () => {
    const server = runtime();
    const entry = await server.getOrCreateServer(
      "deploy-conflict",
      "deploying"
    );
    Object.assign(entry.state, {
      deployStatus: "in_progress",
      deployingRepo: "fixture/app",
      envName: "dev",
      deployAppName: "app",
      deployStartedAt: Date.now(),
      deployLogs: ["starting", "still running"],
      deployLogBase: 4,
      deployAttempt: {
        id: "attempt-1",
        targetRepo: "fixture/app",
        environment: "dev"
      },
      deploymentMutation: {
        repo: "fixture/app",
        environment: "dev",
        kind: "deploy",
        expiresAt: Date.now() + 60_000
      },
      deployingResources: [
        {
          id: "resource-1",
          name: "resource",
          type: "Applications.Core/containers",
          provider: "azure"
        }
      ]
    });
    const headers = mutationHeaders(
      entry.baseUrl,
      entry.state.browserMutationNonce
    );
    const validBody = JSON.stringify({
      targetRepo: "fixture/app",
      repo: "fixture/app",
      environment: "dev",
      application: "app",
      branch: "feature/runtime-coverage",
      provider: "azure"
    });
    const target = {
      repo: "fixture/app",
      environment: "dev",
      branch: "feature/runtime-coverage",
      provider: "azure",
      appFile: ".radius/app.bicep"
    };
    const owner = server.deploymentRuntime.owner;
    const reservation = owner.reserve(target, "deploy");
    if (!reservation) throw new Error("Unexpected reservation conflict");
    const invocation = owner.begin(
      target,
      structuredClone(entry.state),
      reservation
    );
    invocation.state.deployAttempt = {
      id: invocation.attemptId,
      targetRepo: target.repo,
      environment: target.environment
    };
    const done = createDeferred<void>();
    const work = owner.run(invocation, () => done.promise);
    owner.release(reservation);

    try {
      const status = await fetch(`${entry.baseUrl}/api/deploy-status?since=5`);
      expect(status.status).toBe(200);
      expect(await json(status)).toMatchObject({
        status: "in_progress",
        active: true,
        logBase: 4,
        logTotal: 6,
        logsNew: ["still running"],
        repairing: false
      });

      const deploy = await fetch(`${entry.baseUrl}/api/deploy`, {
        method: "POST",
        headers,
        body: validBody
      });
      expect(deploy.status).toBe(409);
      expect(await json(deploy)).toMatchObject({
        error: expect.stringContaining("in progress")
      });

      const deleteDeployment = await fetch(
        `${entry.baseUrl}/api/delete-deployment`,
        {
          method: "POST",
          headers,
          body: validBody
        }
      );
      expect(deleteDeployment.status).toBe(409);
      expect(await json(deleteDeployment)).toMatchObject({
        error: expect.stringContaining("already starting")
      });

      const abandon = await fetch(`${entry.baseUrl}/api/abandon-deployment`, {
        method: "POST",
        headers,
        body: validBody
      });
      expect(abandon.status).toBe(409);
      expect(await json(abandon)).toMatchObject({
        error: expect.stringContaining("already starting")
      });
    } finally {
      done.resolve();
      await work;
      await server.stopServer("deploy-conflict", true);
    }
  });
});
