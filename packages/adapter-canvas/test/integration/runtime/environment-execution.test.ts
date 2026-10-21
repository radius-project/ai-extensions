import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildProcess } from "node:child_process";
import { createHarness } from "@radius-project/adapter-shared/test-support/ghcr-bootstrap";
import * as gh from "../../../src/gh.js";
import { bootstrapRadiusExtension } from "../../../src/runtime/bootstrap.js";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createEnvironmentAccountContext } from "../../../src/runtime/environment-account-context.js";
import { createEnvironmentTools } from "../../../src/runtime/environment-tools.js";
import { createGitHubAccountCoordinator } from "../../../src/server/services/github-account-coordinator.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";
import { createRadiusExtension } from "../../../src/runtime/create-radius-extension.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import { stoppedSetup } from "../../support/server/operation-fixtures.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../support/runtime/fakes.js";
import {
  createOperation,
  buildDeleteStages,
  finish,
  operations,
  recordAzureApp,
  recordCommittedWorkflowFile,
  requireInput,
  requestStop,
  setCommandState,
  setStageState,
  STAGE_AUTHORIZE_IDENTITY,
  STAGE_CONFIGURE_ENVIRONMENT,
  STAGE_VERIFY
} from "../../../src/operations.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const context = (instanceId = "panel") => ({
  extensionId: "fixture:radius",
  canvasId: "radius",
  instanceId,
  input: { page: "environment" }
});

async function composition() {
  const owner = createEnvironmentExecutionOwner();
  const gate = deferred();
  const entered = deferred();
  const unexpectedAccount = async (): Promise<never> => {
    throw new Error("Unexpected external account access");
  };
  const accountContext = createEnvironmentAccountContext("runtime", {
    createReadOnlyExecutor: unexpectedAccount,
    withSelectedAccount: unexpectedAccount
  });
  const executor = successfulSelectedGhExecutor();
  const server = createTestCanvasServerRuntime({
    executionOwner: owner,
    accountContext,
    environmentOperationRunner: async (operationId) => {
      const releaseExecutor = accountContext.registerExecutor(
        operationId,
        executor
      );
      try {
        entered.resolve();
        await gate.promise;
      } finally {
        releaseExecutor();
      }
    }
  });
  const fake = createFakeDependencies();
  const deps = {
    ...fake.deps,
    ...server,
    executionOwner: owner,
    stopServer: vi.fn(server.stopServer)
  };
  const closeSession = vi.fn(async () => {});
  const session = createFakeSession({ close: closeSession });
  const joinSession = vi.fn(async () => session);
  const extension = await bootstrapRadiusExtension(deps, {
    createCanvas: (declaration) => declaration,
    joinSession
  });
  const canvas = extension.canvases[0];
  function recoverDelete() {
    const op = createOperation({
      operationId: "op_runtime",
      repo: "fixture/app",
      kind: "delete",
      provider: "azure",
      environment: "dev"
    });
    operations.put(op);
    return op;
  }
  async function settle() {
    gate.resolve();
    await new Promise<void>((resolve) => {
      const stop = owner.onEnvironmentTasksSettled("panel", () => {
        stop();
        resolve();
      });
    });
  }
  async function cleanup() {
    await settle();
    await extension.shutdown();
    await Promise.all(
      [...server.servers.keys()].map((id) => server.stopServer(id, true))
    );
  }
  return {
    owner,
    accountContext,
    executor,
    server,
    deps,
    session,
    closeSession,
    joinSession,
    extension,
    canvas,
    entered,
    recoverDelete,
    settle,
    cleanup
  };
}

afterEach(() => {
  operations.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("real server and fake SDK runtime ownership", () => {
  it.each(["resume", "continue"] as const)(
    "retains saved %s work when runtime shutdown races admission persistence",
    async (action) => {
      const owner = createEnvironmentExecutionOwner();
      const unexpected = async (): Promise<never> => {
        throw new Error("Unexpected account acquisition");
      };
      const runner = vi.fn(unexpected);
      const accountContext = createEnvironmentAccountContext("runtime", {
        createReadOnlyExecutor: unexpected,
        withSelectedAccount: unexpected
      });
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext,
        environmentOperationRunner: runner
      });
      const op =
        action === "continue" ? stoppedSetup() : (
          createOperation({
            operationId: "shutdown-resume",
            repo: "fixture/app",
            environment: "dev",
            provider: "azure"
          })
        );
      if (action === "resume") {
        op.request = { azure: {} };
        requireInput(op, {
          code: "app-selection-required",
          checkpoint: "selection"
        });
      }
      operations.put(op);
      vi.spyOn(operations, "persist").mockImplementation(async () => {
        owner.shutdown();
      });
      const result =
        action === "resume" ?
          await runtime.operationResume(
            { operationId: op.operationId, code: "app-selection-required" },
            async () => ({
              repo: op.repo,
              environment: op.environment,
              provider: "azure",
              checkpoint: "selection",
              appId: "chosen-app"
            })
          )
        : await runtime.operationControl({
            operationId: op.operationId,
            command: "continue"
          });
      expect(result).toMatchObject({
        status: 503,
        body: { code: "operation-shutting-down" }
      });
      expect(op.endedAt).toBeNull();
      expect(op.failure).toBeNull();
      expect(runner).not.toHaveBeenCalled();
      expect(runtime.servers.size).toBe(0);
    }
  );

  it.each(["azure", "configuration"] as const)(
    "stops the real %s service at its safe boundary without starting failure cleanup",
    async (stage) => {
      const owner = createEnvironmentExecutionOwner();
      let repositoryReads = 0;
      const run = vi.fn(async (args: string[]) => {
        const endpoint = args[1];
        if (args[0] !== "api")
          throw new Error(`Unexpected command: ${args.join(" ")}`);
        if (endpoint === "user")
          return { code: 0, stdout: '{"login":"saved-account"}', stderr: "" };
        if (
          endpoint === "repos/fixture/app" ||
          endpoint === "/repos/fixture/app"
        ) {
          repositoryReads++;
          if (repositoryReads === 2) {
            owner.shutdown();
            return {
              code: 1,
              stdout: "",
              stderr: "HTTP 403: repository unavailable"
            };
          }
          return {
            code: 0,
            stdout: '{"full_name":"fixture/app","permissions":{"admin":true}}',
            stderr: ""
          };
        }
        if (endpoint === "/repos/fixture/app/environments/dev")
          return { code: 0, stdout: '{"name":"dev","id":17}', stderr: "" };
        if (args.includes("/repos/fixture/app/environments?per_page=100"))
          return { code: 0, stdout: "", stderr: "" };
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        requiresKeyringSwitch: false,
        run
      });
      const accountContext = createEnvironmentAccountContext(
        "runtime",
        createGitHubAccountCoordinator({
          createExecutor: async () => executor,
          getActiveKeyringLogin: async () => "saved-account",
          switchKeyringAccount: async () => {
            throw new Error("Unexpected switch");
          },
          resetIdentityCache: () => {}
        })
      );
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext
      });
      const op = createOperation({
        operationId: "shutdown-boundary",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      op.context.githubLogin = "saved-account";
      op.currentStage =
        stage === "azure" ?
          STAGE_AUTHORIZE_IDENTITY
        : STAGE_CONFIGURE_ENVIRONMENT;
      op.request = {
        needsAzureCredentials: stage === "azure",
        azure: {
          repo: op.repo,
          environment: op.environment,
          resourceGroup: "fixture-group",
          cluster: "fixture-cluster",
          subscriptionId: "11111111-1111-4111-8111-111111111111"
        },
        environment: {
          repo: op.repo,
          environment: op.environment,
          provider: "azure"
        }
      };
      operations.put(op);
      vi.spyOn(operations, "persist").mockResolvedValue(undefined);
      runtime.setupExecution.scheduleEnvironmentOperation(op);
      await new Promise<void>((resolve) => {
        const stop = owner.onEnvironmentTasksSettled(undefined, () => {
          stop();
          resolve();
        });
      });
      expect(
        repositoryReads,
        JSON.stringify({ failure: op.failure, calls: run.mock.calls })
      ).toBe(2);
      expect(op.endedAt).toBeNull();
      expect(op.failure).toBeNull();
      expect(op.executionActive).toBe(false);
      expect(accountContext.getExecutor(op.operationId)).toBeUndefined();
      expect(run.mock.calls.every(([args]) => !args.includes("--method"))).toBe(
        true
      );
      expect(runtime.servers.size).toBe(0);
    }
  );

  it.each([
    ["azure", "service"],
    ["configuration", "service"],
    ["azure", "tool"],
    ["configuration", "tool"]
  ] as const)(
    "persists an acknowledged %s write via %s during shutdown before releasing its selected executor",
    async (stage, entry) => {
      const owner = createEnvironmentExecutionOwner();
      const entered = deferred();
      const writeGate = deferred();
      const persisted = deferred();
      const persistGate = deferred();
      const appId = "22222222-2222-4222-8222-222222222222";
      const success = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      let acknowledged = false;
      const run = vi.fn(async (args: string[]) => {
        if (
          stage === "configuration" &&
          args.slice(0, 3).join(" ") === "variable set RADIUS_MANAGED"
        ) {
          entered.resolve();
          await writeGate.promise;
          acknowledged = true;
          return success();
        }
        if (args[0] !== "api")
          throw new Error(`Unexpected GitHub command: ${args.join(" ")}`);
        const endpoint = args[1]?.replace(/^\//, "");
        if (endpoint === "user") return success('{"login":"saved-account"}');
        if (endpoint === "repos/fixture/app")
          return success(
            '{"id":23,"name":"app","full_name":"fixture/app","default_branch":"main","owner":{"id":11,"login":"fixture","type":"User"},"permissions":{"admin":true}}'
          );
        if (endpoint === "repos/fixture/app/environments/dev")
          return success('{"name":"dev","id":17}');
        if (args.includes("/repos/fixture/app/environments?per_page=100"))
          return success();
        if (endpoint === "repos/fixture/app/actions/oidc/customization/sub")
          return success('{"use_default":true,"use_immutable_subject":false}');
        if (
          endpoint ===
            "repos/fixture/app/environments/dev/variables/AZURE_CLIENT_ID" ||
          endpoint ===
            "repos/fixture/app/environments/dev/variables/RADIUS_MANAGED"
        )
          return acknowledged ?
              success('{"name":"RADIUS_MANAGED","value":"true"}')
            : { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
        throw new Error(`Unexpected GitHub command: ${args.join(" ")}`);
      });
      const runAz = vi.fn(async (args: string[]) => {
        const command = args.slice(0, 3).join(" ");
        if (stage === "azure" && command === "ad app create") {
          entered.resolve();
          await writeGate.promise;
          acknowledged = true;
          return success(appId);
        }
        if (args.slice(0, 2).join(" ") === "account set") return success();
        if (args.slice(0, 2).join(" ") === "account show")
          return success(
            '{"id":"11111111-1111-4111-8111-111111111111","tenantId":"33333333-3333-4333-8333-333333333333","user":{"type":"user","name":"fixture@example.test"}}'
          );
        if (command === "ad signed-in-user show")
          return success("44444444-4444-4444-8444-444444444444");
        if (command === "ad app list") return success("[]");
        throw new Error(`Unexpected Azure command: ${args.join(" ")}`);
      });
      vi.spyOn(gh, "cliExec").mockImplementation(
        (command, args, _options, callback) => {
          if (command !== "az")
            throw new Error(`Unexpected executable: ${command}`);
          void runAz(args).then(
            (result) => callback(null, result.stdout, result.stderr),
            (error: unknown) =>
              callback(
                error instanceof Error ? error : new Error(String(error)),
                "",
                ""
              )
          );
          return new ChildProcess();
        }
      );
      const ghcr = createHarness({ finalRepository: "fixture/app" });
      const fetchImpl: typeof ghcr.fetchImpl = async (input, options) => {
        const url = new URL(input);
        if (url.origin === "https://api.github.com") {
          url.host = "api.test";
          if (url.pathname === "/users/fixture") url.pathname = "/users/acme";
        } else if (url.origin === "https://ghcr.io") {
          url.host = "registry.test";
        } else {
          throw new Error(`Unexpected fetch: ${url.href}`);
        }
        const response = await ghcr.fetchImpl(url.href, options);
        return {
          ok: response.ok,
          status: response.status,
          headers: {
            get: (name) =>
              response.headers
                .get(name)
                ?.replaceAll("registry.test", "ghcr.io") ?? null
          },
          text: () => response.text(),
          json: () => response.json(),
          arrayBuffer: () => response.arrayBuffer()
        };
      };
      vi.stubGlobal("fetch", fetchImpl);
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        requiresKeyringSwitch: false,
        run
      });
      const accountContext = createEnvironmentAccountContext(
        "runtime",
        createGitHubAccountCoordinator({
          createExecutor: async () => executor,
          getActiveKeyringLogin: async () => "saved-account",
          switchKeyringAccount: async () => {
            throw new Error("Unexpected account switch");
          },
          resetIdentityCache: () => {}
        })
      );
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext
      });
      let op = createOperation({
        operationId: "shutdown-write",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      op.context.githubLogin = "saved-account";
      op.currentStage =
        stage === "azure" ?
          STAGE_AUTHORIZE_IDENTITY
        : STAGE_CONFIGURE_ENVIRONMENT;
      op.request = {
        needsAzureCredentials: stage === "azure",
        azure: {
          repo: op.repo,
          environment: op.environment,
          resourceGroup: "fixture-group",
          cluster: "fixture-cluster",
          subscriptionId: "11111111-1111-4111-8111-111111111111"
        },
        environment: {
          repo: op.repo,
          environment: op.environment,
          provider: "azure"
        }
      };
      if (entry === "service") operations.put(op);
      const fake = createFakeDependencies();
      const extension = await bootstrapRadiusExtension(
        {
          ...fake.deps,
          ...runtime,
          executionOwner: owner,
          environment: createEnvironmentTools({
            ...runtime.environmentServices,
            owner,
            session: fake.deps.session,
            account: async () => ({
              state: "selected",
              login: executor.login,
              executor
            }),
            workspace: async () => ({
              repo: "fixture/app",
              branch: "feature/setup"
            }),
            validateBranch: async () => {},
            redact: (value) => value,
            reportError: (error) => {
              throw error;
            }
          })
        },
        {
          createCanvas: (declaration) => declaration,
          joinSession: async () => createFakeSession()
        }
      );
      const snapshots: (typeof op)[] = [];
      vi.spyOn(operations, "persist").mockImplementation(async () => {
        snapshots.push(structuredClone(operations.latest("fixture/app")));
        if (acknowledged) {
          persisted.resolve();
          await persistGate.promise;
        }
      });
      let completed = Promise.resolve();
      try {
        if (entry === "service")
          runtime.setupExecution.scheduleEnvironmentOperation(op);
        else {
          const tool = extension.tools.find(
            ({ name }) => name === "radius_setup_environment"
          );
          if (!tool) throw new Error("Missing registered setup tool");
          const result = JSON.parse(
            String(
              await tool.handler({
                repo: "fixture/app",
                environment: "dev",
                provider: "azure",
                tenantId: "33333333-3333-4333-8333-333333333333",
                subscriptionId: "11111111-1111-4111-8111-111111111111",
                resourceGroup: "fixture-group",
                cluster: "fixture-cluster",
                ...(stage === "configuration" ?
                  { clientId: appId }
                : { createNew: true })
              })
            )
          );
          expect(result).toMatchObject({ kind: "accepted" });
          op = operations.get(result.operation.operationId);
        }
        completed = new Promise<void>((resolve) => {
          const stop = owner.onEnvironmentTasksSettled(undefined, () => {
            stop();
            resolve();
          });
        });
        await Promise.race([entered.promise, completed]);
        const diagnostics = JSON.stringify({
          failure: op.failure,
          gh: run.mock.calls,
          az: runAz.mock.calls
        });
        expect(op.executionActive, diagnostics).toBe(true);
        expect(accountContext.getExecutor(op.operationId), diagnostics).toBe(
          executor
        );
        owner.shutdown();
        expect(accountContext.getExecutor(op.operationId)).toBe(executor);
        const callsAtShutdown = {
          gh: run.mock.calls.length,
          az: runAz.mock.calls.length,
          fetch: ghcr.calls.length
        };
        writeGate.resolve();
        await Promise.race([persisted.promise, completed]);
        expect(acknowledged).toBe(true);
        expect(accountContext.getExecutor(op.operationId)).toBe(executor);
        persistGate.resolve();
        await completed;
        expect(op.endedAt).toBeNull();
        expect(op.failure).toBeNull();
        expect(op.executionActive).toBe(false);
        expect(accountContext.getExecutor(op.operationId)).toBeUndefined();
        expect(runAz.mock.calls.slice(callsAtShutdown.az)).toEqual([]);
        expect(
          run.mock.calls
            .slice(callsAtShutdown.gh)
            .every(([args]) => args[0] === "api" && !args.includes("--method"))
        ).toBe(true);
        expect(ghcr.calls.slice(callsAtShutdown.fetch)).toEqual([]);
        expect(snapshots.at(-1)?.providerRecovery.mutations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind:
                stage === "azure" ?
                  "azure_application.create"
                : "github_environment_variable.put",
              status: "confirmed"
            })
          ])
        );
        expect(snapshots.at(-1)?.setupArtifacts).toMatchObject(
          stage === "azure" ?
            {
              azureApp: { state: "created", origin: "this_operation", appId }
            }
          : {
              githubEnvironmentVariables: [
                {
                  name: "RADIUS_MANAGED",
                  previousKnown: true,
                  previousValue: null
                }
              ]
            }
        );
        expect(runtime.servers.size).toBe(0);
      } finally {
        writeGate.resolve();
        persistGate.resolve();
        await completed;
        owner.shutdown();
        await extension.shutdown();
      }
    }
  );

  it("detaches a closed panel immediately while its setup and account remain owned", async () => {
    const runtime = await composition();
    const register = vi.spyOn(runtime.accountContext, "registerExecutor");
    const op = runtime.recoverDelete();
    op.kind = "create";
    op.recoveryState = "provider_reconciliation_pending";
    try {
      await runtime.canvas.open(context());
      await runtime.entered.promise;
      const original = runtime.server.servers.get("panel");
      await runtime.canvas.onClose(context());
      expect(runtime.server.servers.size).toBe(0);
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(true);
      expect(runtime.accountContext.getExecutor(op.operationId)).toBe(
        runtime.executor
      );
      expect(op.executionActive).toBe(true);
      await runtime.canvas.open(context());
      expect(runtime.server.servers.get("panel")).not.toBe(original);
      expect(register).toHaveBeenCalledOnce();
      await runtime.settle();
      expect(
        runtime.accountContext.getExecutor(op.operationId)
      ).toBeUndefined();
      expect(runtime.server.servers.has("panel")).toBe(true);
      expect(register).toHaveBeenCalledOnce();
    } finally {
      await runtime.cleanup();
    }
  });

  it("stops no-panel admission on SDK shutdown without releasing an in-flight task's executor", async () => {
    const runtime = await composition();
    const op = runtime.recoverDelete();
    op.kind = "create";
    runtime.server.setupExecution.scheduleEnvironmentOperation(op);
    const completed = new Promise<void>((resolve) => {
      const stop = runtime.owner.onEnvironmentTasksSettled(undefined, () => {
        stop();
        resolve();
      });
    });
    try {
      await runtime.entered.promise;
      await runtime.extension.shutdown();
      expect(runtime.session.close).toHaveBeenCalledOnce();
      expect(runtime.owner.hasActiveEnvironmentTasks(undefined)).toBe(true);
      expect(runtime.accountContext.getExecutor(op.operationId)).toBe(
        runtime.executor
      );
      expect(
        runtime.server.setupExecution.scheduleEnvironmentOperation({
          operationId: "later"
        })
      ).toBe(false);
      expect(runtime.server.servers.size).toBe(0);
    } finally {
      await runtime.settle();
      await completed;
      await runtime.cleanup();
    }
    expect(runtime.accountContext.getExecutor(op.operationId)).toBeUndefined();
    expect(op.endedAt).toBeNull();
  });

  it("resumes tied setup input through the production runtime with no presentation", async () => {
    const runtime = await composition();
    const op = runtime.recoverDelete();
    op.kind = "create";
    op.request = { azure: {} };
    requireInput(op, {
      code: "app-selection-required",
      checkpoint: "selection"
    });
    vi.spyOn(operations, "persist").mockResolvedValue(undefined);
    let completed: Promise<void> | undefined;
    try {
      const result = await runtime.server.operationResume(
        { operationId: op.operationId, code: "app-selection-required" },
        async () => ({
          repo: op.repo,
          environment: op.environment,
          provider: "azure",
          checkpoint: "selection",
          createNew: false,
          appId: "selected-app"
        })
      );
      expect(result.status).toBe(202);
      completed = new Promise<void>((resolve) => {
        const stop = runtime.owner.onEnvironmentTasksSettled(undefined, () => {
          stop();
          resolve();
        });
      });
      await runtime.entered.promise;
      expect(op.request.azure.appId).toBe("selected-app");
      expect(op.inputRequired).toBeNull();
      expect(runtime.server.servers.size).toBe(0);
    } finally {
      await runtime.settle();
      await completed;
      await runtime.cleanup();
    }
  });

  it("shares headless recovery across panel close and reopen without another executor", async () => {
    const runtime = await composition();
    const register = vi.spyOn(runtime.accountContext, "registerExecutor");
    const op = runtime.recoverDelete();
    op.kind = "create";
    op.recoveryState = "provider_reconciliation_pending";
    runtime.server.setupExecution.recoverOperation(op);
    const completed = new Promise<void>((resolve) => {
      const stop = runtime.owner.onEnvironmentTasksSettled(undefined, () => {
        stop();
        resolve();
      });
    });
    try {
      await runtime.entered.promise;
      await runtime.canvas.open(context("a"));
      expect(register).toHaveBeenCalledOnce();
      expect(runtime.owner.hasActiveEnvironmentTasks(undefined)).toBe(true);
      expect(runtime.owner.hasActiveEnvironmentTasks("a")).toBe(false);
      await runtime.canvas.onClose(context("a"));
      await vi.waitFor(() =>
        expect(runtime.server.servers.has("a")).toBe(false)
      );
      await runtime.canvas.open(context("b"));
      expect(runtime.owner.hasActiveEnvironmentTasks("b")).toBe(false);
      expect(register).toHaveBeenCalledOnce();
      expect(runtime.accountContext.getExecutor(op.operationId)).toBe(
        runtime.executor
      );
      expect(op.executionActive).toBe(true);
      await runtime.settle();
      await completed;
      expect(register).toHaveBeenCalledOnce();
      expect(
        runtime.accountContext.getExecutor(op.operationId)
      ).toBeUndefined();
      expect(op.executionActive).toBe(false);
      expect(runtime.server.servers.has("b")).toBe(true);
    } finally {
      await runtime.settle();
      await completed;
      await runtime.cleanup();
    }
  });

  it.each([
    "setup",
    "recovered-verification",
    "verification-retry",
    "verification-shutdown",
    "retry-shutdown"
  ] as const)(
    "keeps a replacement executor after the old %s finalizer settles",
    async (kind) => {
      const owner = createEnvironmentExecutionOwner();
      const entered = deferred();
      const gate = deferred();
      const unexpected = async (): Promise<never> => {
        throw new Error("Unexpected account or command access");
      };
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        requiresKeyringSwitch: false,
        run: async (args) => {
          const endpoint = args.find((arg) => arg.startsWith("repos/"));
          let body: object;
          if (endpoint === "repos/fixture/app/actions/runs/17") {
            entered.resolve();
            await gate.promise;
            body = { status: "completed", conclusion: "success" };
          } else if (
            endpoint ===
            "repos/fixture/app/actions/runs/17/jobs?per_page=100&page=1"
          ) {
            body = { jobs: [] };
          } else {
            throw new Error(`Unexpected selected command: ${args.join(" ")}`);
          }
          expect(args).toEqual([
            "api",
            endpoint,
            "--include",
            "--method",
            "GET"
          ]);
          return {
            code: 0,
            stdout:
              "HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n" +
              JSON.stringify(body),
            stderr: ""
          };
        }
      });
      const coordinator = createGitHubAccountCoordinator({
        createExecutor: async (login) => {
          expect(login).toBe("saved-account");
          return executor;
        },
        getActiveKeyringLogin: async () => "original",
        switchKeyringAccount: unexpected,
        resetIdentityCache: () => {}
      });
      const accountContext = createEnvironmentAccountContext(
        "runtime",
        coordinator
      );
      const op = createOperation({
        operationId: "executor-replacement",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      op.context.githubLogin = "saved-account";
      if (kind === "setup") {
        requestStop(op);
      } else {
        op.currentStage = STAGE_VERIFY;
        op.recoveryState = "verification_pending";
        op.verification = {
          dispatchedAt: Date.now(),
          workflow: "verify.yml",
          ref: "topic",
          environment: "dev",
          runId: "17",
          accountUnavailablePhase: "monitor"
        };
        if (kind === "verification-retry" || kind === "retry-shutdown") {
          recordAzureApp(op, { state: "reused", appId: "fixture-app" });
          recordCommittedWorkflowFile(op, {
            path: ".github/workflows/verify.yml",
            mode: "default_branch",
            branch: "topic"
          });
          finish(op, "failed_partial", {
            failure: { code: "verification-retry-github-account-unavailable" }
          });
        }
      }
      operations.put(op);
      vi.spyOn(operations, "persist").mockImplementation(async () => {
        if (
          kind === "setup" ||
          (kind === "retry-shutdown" &&
            accountContext.getExecutor(op.operationId))
        ) {
          entered.resolve();
          await gate.promise;
        }
      });
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext
      });
      if (kind === "setup") {
        runtime.setupExecution.scheduleEnvironmentOperation(op);
      } else if (kind !== "verification-retry" && kind !== "retry-shutdown") {
        runtime.setupExecution.recoverOperation(op);
      } else {
        const accepted = await runtime.operationControl({
          operationId: op.operationId,
          command: "retry",
          retryKind: "verification"
        });
        expect(accepted.status, JSON.stringify(accepted)).toBe(202);
      }
      const completed = new Promise<void>((resolve) => {
        const stop = owner.onEnvironmentTasksSettled(undefined, () => {
          stop();
          resolve();
        });
      });
      let releaseReplacement: (() => void) | undefined;
      try {
        await Promise.race([entered.promise, completed]);
        expect(
          accountContext.getExecutor(op.operationId),
          JSON.stringify(op.failure)
        ).toBe(executor);
        const replacement = successfulSelectedGhExecutor({
          login: "saved-account"
        });
        releaseReplacement = accountContext.registerExecutor(
          op.operationId,
          replacement
        );
        if (kind === "verification-shutdown" || kind === "retry-shutdown")
          owner.shutdown();
        gate.resolve();
        await completed;
        expect(accountContext.getExecutor(op.operationId)).toBe(replacement);
        expect(op.state).toBe(
          kind === "setup" ? "cancelled"
          : kind === "verification-shutdown" || kind === "retry-shutdown" ?
            "running"
          : "succeeded"
        );
        if (kind === "verification-shutdown" || kind === "retry-shutdown")
          expect(op.endedAt).toBeNull();
        expect(runtime.servers.size).toBe(0);
      } finally {
        gate.resolve();
        await completed;
        releaseReplacement?.();
      }
      expect(accountContext.getExecutor(op.operationId)).toBeUndefined();
    }
  );

  it("constructs and executes pinned setup without a panel identity or automatic recovery", async () => {
    const owner = createEnvironmentExecutionOwner();
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected external command");
    };
    const executor = successfulSelectedGhExecutor({
      login: "saved-account",
      requiresKeyringSwitch: false,
      run: unexpected
    });
    const coordinator = createGitHubAccountCoordinator({
      createExecutor: async (login) => {
        expect(login).toBe("saved-account");
        return executor;
      },
      getActiveKeyringLogin: async () => "original",
      switchKeyringAccount: unexpected,
      resetIdentityCache: () => {}
    });
    const lease = vi.spyOn(coordinator, "withSelectedAccount");
    const accountContext = createEnvironmentAccountContext(
      "headless-production",
      coordinator
    );
    const op = createOperation({
      operationId: "panel-free-setup",
      repo: "fixture/app",
      environment: "dev",
      provider: "azure"
    });
    op.context.githubLogin = "saved-account";
    op.request = { github: { login: "not-the-saved-account" } };
    requestStop(op);
    operations.put(op);
    const recovered = stoppedSetup();
    recovered.providerRecovery = { state: "rollback_pending" };
    operations.put(recovered);
    const before = structuredClone(recovered);
    const persist = vi
      .spyOn(operations, "persist")
      .mockResolvedValue(undefined);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(unexpected);
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      accountContext
    });
    const fake = createFakeDependencies();
    const session = createFakeSession();
    const extension = await bootstrapRadiusExtension(
      { ...fake.deps, ...runtime, executionOwner: owner },
      {
        createCanvas: (declaration) => declaration,
        joinSession: async () => session
      }
    );
    try {
      expect(runtime.servers.size).toBe(0);
      expect(persist).not.toHaveBeenCalled();
      expect(recovered).toEqual(before);
      expect(lease).not.toHaveBeenCalled();
      runtime.setupExecution.scheduleEnvironmentOperation(op);
      await new Promise<void>((resolve) => {
        const stop = owner.onEnvironmentTasksSettled(undefined, () => {
          stop();
          resolve();
        });
      });
      expect(op.state).toBe("cancelled");
      expect(lease).toHaveBeenCalledWith(
        "saved-account",
        { ownerKey: "headless-production", operationId: op.operationId },
        expect.any(Function),
        30000
      );
      expect(accountContext.getExecutor(op.operationId)).toBeUndefined();
      expect(runtime.servers.size).toBe(0);
      expect(recovered).toEqual(before);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await extension.shutdown();
    }
  });

  it("admits direct setup cleanup without a panel but leaves deletion on its server-ready path", async () => {
    const owner = createEnvironmentExecutionOwner();
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected account or transport access");
    };
    const accountContext = createEnvironmentAccountContext("direct-runtime", {
      createReadOnlyExecutor: unexpected,
      withSelectedAccount: unexpected
    });
    const runner = vi.fn(async (operationId: string) => {
      finish(operations.get(operationId), "cancelled");
    });
    vi.spyOn(operations, "persist").mockResolvedValue(undefined);
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      accountContext,
      environmentOperationRunner: runner
    });
    const op = stoppedSetup();
    operations.put(op);
    const result = await runtime.operationControl({
      operationId: op.operationId,
      command: "rollback"
    });
    expect(result.status).toBe(202);
    await new Promise<void>((resolve) => {
      const stop = owner.onEnvironmentTasksSettled(undefined, () => {
        stop();
        resolve();
      });
    });
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      op.operationId,
      result.body.commandId
    );
    expect(op.state).toBe("cancelled");
    expect(runtime.servers.size).toBe(0);

    const deletion = createOperation({
      operationId: "server-only-delete",
      repo: "fixture/other-app",
      environment: "dev",
      provider: "azure",
      kind: "delete",
      stages: buildDeleteStages()
    });
    deletion.stages[0].state = "succeeded";
    setStageState(deletion, deletion.stages[1].id, "failed");
    finish(deletion, "failed_partial", {
      failure: { code: "credential-delete-failed" }
    });
    operations.put(deletion);
    runtime.setupExecution.recoverOperation(deletion);
    const retry = await runtime.operationControl({
      operationId: deletion.operationId,
      command: "retry",
      retryKind: "deletion"
    });
    expect(retry.status).toBe(202);
    expect(deletion.failure).toMatchObject({
      code: "operation-scheduling-failed",
      evidence: "No runtime setup task runner was available."
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(owner.hasActiveEnvironmentTasks(undefined)).toBe(false);
    expect(runtime.servers.size).toBe(0);
  });

  it.each([false, true])(
    "admits cleanup authorized by active setup after panel detach=%s",
    async (detachPanel) => {
      const owner = createEnvironmentExecutionOwner();
      const unexpected = async (): Promise<never> => {
        throw new Error("Unexpected account or transport access");
      };
      const accountContext = createEnvironmentAccountContext(
        "recovery-runtime",
        {
          createReadOnlyExecutor: unexpected,
          withSelectedAccount: unexpected
        }
      );
      const op = createOperation({
        operationId: "active-recovery",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      operations.put(op);
      const setupEntered = deferred();
      const setupGate = deferred();
      const cleanupEntered = deferred();
      const runner = vi.fn(async (_operationId: string, commandId?: string) => {
        if (commandId === undefined) {
          setupEntered.resolve();
          await setupGate.promise;
          recordAzureApp(op, {
            state: "created",
            appId: "fixture-app",
            displayName: "radius-deploy"
          });
          finish(op, "failed");
          op.providerRecovery = { state: "rollback_pending" };
        } else {
          setCommandState(op, commandId, "finished");
          finish(op, "cancelled");
          op.providerRecovery = { state: "complete" };
          cleanupEntered.resolve();
        }
      });
      const persist = vi
        .spyOn(operations, "persist")
        .mockResolvedValue(undefined);
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(unexpected);
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext,
        environmentOperationRunner: runner
      });
      expect(persist).not.toHaveBeenCalled();
      const fake = createFakeDependencies();
      const extension = await bootstrapRadiusExtension(
        { ...fake.deps, ...runtime, executionOwner: owner },
        {
          createCanvas: (declaration) => declaration,
          joinSession: async () => createFakeSession()
        }
      );
      try {
        if (detachPanel) {
          op.recoveryState = "provider_reconciliation_pending";
          await extension.canvases[0].open(context());
        } else runtime.setupExecution.scheduleEnvironmentOperation(op);
        await setupEntered.promise;
        if (detachPanel) {
          await extension.canvases[0].onClose(context());
          expect(runtime.servers.size).toBe(0);
          expect(owner.hasActiveEnvironmentTasks("panel")).toBe(true);
        }
        setupGate.resolve();
        await cleanupEntered.promise;
        await new Promise<void>((resolve) => {
          const stop = owner.onEnvironmentTasksSettled(undefined, () => {
            stop();
            resolve();
          });
        });
        expect(runner.mock.calls).toEqual([
          [op.operationId],
          [op.operationId, expect.any(String)]
        ]);
        expect(op.control.commands).toEqual([
          expect.objectContaining({ kind: "rollback" })
        ]);
        expect(persist).toHaveBeenCalled();
        expect(op.state).toBe("cancelled");
        expect(runtime.servers.size).toBe(0);
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        setupGate.resolve();
        await extension.shutdown();
      }
    }
  );

  it("binds direct controls and input continuation without starting recovery or a server", async () => {
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected account or transport access");
    };
    const accountContext = createEnvironmentAccountContext("control-runtime", {
      createReadOnlyExecutor: unexpected,
      withSelectedAccount: unexpected
    });
    const op = stoppedSetup();
    op.providerRecovery = { state: "rollback_pending" };
    operations.put(op);
    const persist = vi
      .spyOn(operations, "persist")
      .mockResolvedValue(undefined);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(unexpected);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = createTestCanvasServerRuntime({
      executionOwner: createEnvironmentExecutionOwner(),
      accountContext
    });
    expect(runtime.servers.size).toBe(0);
    expect(persist).not.toHaveBeenCalled();
    expect(op.control.commands).toEqual([]);
    const rollback = await runtime.operationControl({
      instanceId: "detached",
      operationId: op.operationId,
      command: "rollback"
    });
    expect(rollback).toMatchObject({
      status: 503,
      body: { code: "operation-command-unscheduled" }
    });
    expect(op.state).toBe("cancelled");
    expect(op.control.commands).toEqual([]);

    const pending = createOperation({
      operationId: "headless-input",
      repo: "fixture/app",
      environment: "dev",
      provider: "azure"
    });
    pending.request = { azure: {} };
    requireInput(pending, {
      code: "app-selection-required",
      checkpoint: "selection"
    });
    operations.put(pending);
    const resumed = await runtime.operationResume(
      {
        instanceId: "detached",
        operationId: pending.operationId,
        code: "app-selection-required"
      },
      async () => ({
        repo: "fixture/app",
        environment: "dev",
        provider: "azure",
        checkpoint: "selection",
        appId: "chosen-app"
      })
    );
    expect(resumed.status).toBe(202);
    expect(pending.request.azure.appId).toBe("chosen-app");
    expect(pending.state).toBe("failed");
    expect(pending.failure.code).toBe("operation-scheduling-failed");
    expect(persist).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledTimes(2);
    expect(fetcher).not.toHaveBeenCalled();
    expect(runtime.servers.size).toBe(0);
  });

  it("observes a pinned verification through production composition without a panel or HTTP server", async () => {
    const owner = createEnvironmentExecutionOwner();
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected account acquisition");
    };
    const accountContext = createEnvironmentAccountContext(
      "verification-runtime",
      {
        createReadOnlyExecutor: unexpected,
        withSelectedAccount: unexpected
      }
    );
    const run = vi.fn(async (args: string[]) => {
      const endpoint = args.find((arg) => arg.startsWith("repos/"));
      const result =
        endpoint === "repos/fixture/app/actions/runs/17" ?
          { status: "completed", conclusion: "success" }
        : (
          endpoint ===
          "repos/fixture/app/actions/runs/17/jobs?per_page=100&page=1"
        ) ?
          { jobs: [] }
        : undefined;
      if (args[0] !== "api" || result === undefined) {
        throw new Error(`Unexpected GitHub command: ${args.join(" ")}`);
      }
      expect(args).toEqual(["api", endpoint, "--include", "--method", "GET"]);
      return {
        code: 0,
        stdout:
          "HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n" +
          JSON.stringify(result),
        stderr: ""
      };
    });
    const executor = successfulSelectedGhExecutor({
      login: "saved-account",
      run
    });
    const server = createTestCanvasServerRuntime({
      executionOwner: owner,
      accountContext
    });
    const op = createOperation({
      operationId: "headless-verification",
      repo: "fixture/app",
      environment: "dev",
      provider: "azure"
    });
    op.currentStage = STAGE_VERIFY;
    op.context.githubLogin = executor.login;
    op.verification = {
      runId: "17",
      dispatchedAt: Date.now(),
      workflow: "verify.yml",
      ref: "topic",
      environment: "dev"
    };
    operations.put(op);
    const releaseExecutor = accountContext.registerExecutor(
      op.operationId,
      executor
    );
    const persist = vi
      .spyOn(operations, "persist")
      .mockResolvedValue(undefined);
    try {
      expect(server.servers.size).toBe(0);
      expect(run).not.toHaveBeenCalled();
      const outcome = await server.verificationStatus({
        repo: op.repo,
        environment: op.environment,
        operationId: op.operationId
      });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        status: 200,
        body: { state: "success", runId: "17" }
      });
      expect(server.servers.size).toBe(0);
      expect(op.state).toBe("succeeded");
      expect(persist).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledTimes(2);
      expect(accountContext.getExecutor(op.operationId)).toBe(executor);
    } finally {
      releaseExecutor();
    }
  });

  it("requires an explicit owner before runtime construction", () => {
    const fake = createFakeDependencies();
    const invalid = { ...fake.deps };
    Reflect.deleteProperty(invalid, "executionOwner");
    expect(() => createRadiusExtension(invalid)).toThrow("executionOwner");
  });

  it("constructs panel-free, then retains the same owner and transport across close/reopen", async () => {
    const runtime = await composition();
    try {
      expect(runtime.joinSession).toHaveBeenCalledOnce();
      expect(runtime.server.servers.size).toBe(0);
      expect(runtime.accountContext.getExecutor("op_runtime")).toBeUndefined();
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
      runtime.recoverDelete();
      const first = await runtime.canvas.open(context());
      await runtime.entered.promise;
      await runtime.canvas.onClose(context("wrong"));
      await runtime.canvas.onClose(context());
      expect(runtime.deps.stopServer).not.toHaveBeenCalled();
      expect(runtime.accountContext.getExecutor("op_runtime")).toBe(
        runtime.executor
      );
      const reopened = await runtime.canvas.open(context());
      expect(reopened.url).toBe(first.url);
      expect(runtime.accountContext.getExecutor("op_runtime")).toBe(
        runtime.executor
      );
      await runtime.settle();
      expect(runtime.accountContext.getExecutor("op_runtime")).toBeUndefined();
      expect(runtime.deps.stopServer).not.toHaveBeenCalled();
      await runtime.canvas.onClose(context());
      expect(runtime.deps.stopServer).toHaveBeenCalledExactlyOnceWith("panel");
      expect(runtime.server.servers.size).toBe(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("retains the existing 46-minute forced-close boundary without draining work", async () => {
    const runtime = await composition();
    try {
      runtime.recoverDelete();
      await runtime.canvas.open(context());
      await runtime.entered.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await runtime.canvas.onClose(context());
      await vi.advanceTimersByTimeAsync(46 * 60 * 1000 - 1);
      expect(runtime.deps.stopServer).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.deps.stopServer).toHaveBeenCalledExactlyOnceWith("panel");
      expect(runtime.owner.isShuttingDown("panel")).toBe(true);
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(true);
      vi.useRealTimers();
      await runtime.settle();
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
    } finally {
      vi.useRealTimers();
      await runtime.cleanup();
    }
  });

  it("keeps same-ID replacement active queries but fences the old deferred close", async () => {
    const runtime = await composition();
    try {
      const op = runtime.recoverDelete();
      await runtime.canvas.open(context());
      await runtime.entered.promise;
      await runtime.canvas.onClose(context());
      const old = runtime.server.servers.get("panel");
      await runtime.server.stopServer("panel", true);
      // Do not recover the record again: the old attachment's work stays live.
      op.kind = "create";
      await runtime.canvas.open(context());
      expect(runtime.server.servers.get("panel")).not.toBe(old);
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(true);
      await runtime.settle();
      expect(runtime.server.servers.has("panel")).toBe(true);
      expect(runtime.deps.stopServer).not.toHaveBeenCalled();
    } finally {
      await runtime.cleanup();
    }
  });

  it("reports a physical stop failure without losing task settlement", async () => {
    const runtime = await composition();
    try {
      runtime.recoverDelete();
      await runtime.canvas.open(context());
      await runtime.entered.promise;
      runtime.deps.stopServer.mockRejectedValueOnce(new Error("stop failed"));
      await runtime.canvas.onClose(context());
      await runtime.settle();
      await vi.waitFor(() =>
        expect(runtime.deps.logError).toHaveBeenCalledWith(
          "Could not stop Radius canvas: Error: stop failed"
        )
      );
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });

  it("revalidates rollback ownership after panel replacement without the old transport", async () => {
    const runtime = await composition();
    const fetcher = vi.spyOn(globalThis, "fetch");
    const report = vi.spyOn(operations, "report");
    try {
      const op = runtime.recoverDelete();
      await runtime.canvas.open(context());
      await runtime.entered.promise;
      const original = runtime.server.servers.get("panel")!;
      await runtime.server.stopServer("panel", true);
      op.kind = "create";
      await runtime.canvas.open(context());
      const replacement = runtime.server.servers.get("panel")!;
      expect(replacement.baseUrl).not.toBe(original.baseUrl);
      finish(op, "failed");
      op.providerRecovery = { state: "rollback_pending", mutations: [] };
      await runtime.settle();
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({
            scope: "provider-recovery-auto-rollback",
            message:
              "Radius did not create any resources it can prove it owns in this attempt."
          })
        )
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(runtime.server.servers.get("panel")).toBe(replacement);
      expect(runtime.owner.isShuttingDown("panel")).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });

  it("marks before stop and keeps the two bounded shutdown phases and idempotence", async () => {
    const runtime = await composition();
    const stopped = deferred();
    const sessionClosed = deferred();
    try {
      runtime.recoverDelete();
      await runtime.canvas.open(context());
      await runtime.entered.promise;
      runtime.deps.stopServer.mockImplementation(async (id, force) => {
        expect(runtime.owner.isShuttingDown(id)).toBe(true);
        expect(force).toBe(true);
        await stopped.promise;
        await runtime.server.stopServer(id, force);
      });
      runtime.closeSession.mockImplementation(() => sessionClosed.promise);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const shutdown = runtime.extension.shutdown();
      expect(runtime.extension.shutdown()).toBe(shutdown);
      await vi.advanceTimersByTimeAsync(1999);
      expect(runtime.session.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.session.close).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2000);
      await shutdown;
      expect(runtime.owner.hasActiveEnvironmentTasks("panel")).toBe(true);
      expect(runtime.deps.stopServer).toHaveBeenCalledOnce();
      stopped.resolve();
      sessionClosed.resolve();
      vi.useRealTimers();
      await runtime.settle();
    } finally {
      stopped.resolve();
      sessionClosed.resolve();
      vi.useRealTimers();
      await runtime.cleanup();
    }
  });
});
