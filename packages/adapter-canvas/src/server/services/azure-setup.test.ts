import { describe, expect, it, vi } from "vitest";
import { createAzureAutoSetupTestDependencies } from "../../../test/support/server/azure-auto-setup.js";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import {
  createOperation,
  finish,
  prepareProviderMutation,
  requireInput,
  setAzureAppCreateContinuation
} from "../../operations.js";
import { persistMutationCheckpoint } from "./setup-checkpoint.js";
import { ProviderMutationRecoveryError } from "./provider-mutation-recovery.js";
import { createAzureSetupService } from "./azure-setup.js";
import { setupStageResult } from "./setup-outcome.js";
import type { AzureAutoSetupDependencies } from "../routes/azure-auto-setup-types.js";
import { buildEnvironmentSuffix } from "@radius-project/core";
import { resolveOidcSubject } from "../../azure-oidc.js";
import {
  createAzureAppCreateContinuation,
  normalizeAzureAppCreateContinuation
} from "../../azure-app-create-continuation.js";

const request = {
  repo: "octo/app",
  environment: "dev",
  resourceGroup: "resources",
  cluster: "cluster",
  subscriptionId: "22222222-2222-2222-2222-222222222222"
};

function fixture() {
  const operation = createOperation({
    operationId: "op-service",
    repo: request.repo,
    environment: request.environment,
    provider: "azure"
  });
  operation.currentStage = "authorize_identity";
  const finalize = vi.fn<AzureAutoSetupDependencies["finalizeSetupFailure"]>(
    async (_op, input) => ({
      status: input.status,
      body: { error: input.error, code: input.code }
    })
  );
  const dependencies = createAzureAutoSetupTestDependencies({
    operations: {
      get: (id) => (id === operation.operationId ? operation : undefined),
      report: vi.fn(),
      persist: vi.fn(async () => {})
    },
    finalizeSetupFailure: finalize
  });
  return { operation, dependencies, finalize };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("initial Azure identity shutdown", () => {
  function initialFixture() {
    const test = fixture();
    let stopped = false;
    const calls: string[] = [];
    test.dependencies.isStopped = () => stopped;
    test.dependencies.external.preflightRepoAdmin = async () => "";
    test.dependencies.external.preflightGhcrPackageWriteAccess = async () => ({
      ok: true
    });
    test.dependencies.external.runAz = async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "account" && args[1] === "set")
        return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "account" && args[1] === "show")
        return {
          code: 0,
          stdout: JSON.stringify({
            id: request.subscriptionId,
            tenantId: "11111111-1111-1111-1111-111111111111",
            user: { type: "user" }
          }),
          stderr: ""
        };
      throw new Error(`Unexpected Azure command ${args.join(" ")}`);
    };
    test.dependencies.external.runGitHubJson = async (path) => {
      calls.push(path);
      if (path === "/repos/octo/app")
        return {
          ok: true,
          status: 200,
          json: { full_name: "octo/app", id: 5, owner: { id: 7 } }
        };
      if (path.endsWith("/actions/oidc/customization/sub"))
        return { ok: true, status: 200, json: { use_default: true } };
      if (path.endsWith("/variables/AZURE_CLIENT_ID"))
        return {
          ok: true,
          status: 200,
          json: { value: "33333333-3333-3333-3333-333333333333" }
        };
      throw new Error(`Unexpected GitHub request ${path}`);
    };
    return {
      ...test,
      calls,
      stop: () => {
        stopped = true;
      },
      run: () =>
        createAzureSetupService(test.dependencies)({
          data: { ...request, operationId: test.operation.operationId }
        })
    };
  }

  describe.each(["account", "repository", "customization", "client-id"])(
    "held %s read",
    (boundary) => {
      it.each(["success", "malformed", "refused", "rejected"] as const)(
        "rejects late %s without another request or terminal persistence",
        async (result) => {
          const test = initialFixture();
          const entered = deferred();
          const released = deferred();
          async function hold() {
            entered.resolve();
            await released.promise;
            if (result === "rejected") throw new Error("read unavailable");
          }
          const az = test.dependencies.external.runAz;
          const github = test.dependencies.external.runGitHubJson;
          test.dependencies.external.runAz = async (args) => {
            const response = await az(args);
            if (boundary === "account" && args[1] === "show") {
              await hold();
              if (result === "malformed") return { ...response, stdout: "{" };
              if (result === "refused") return { ...response, code: 1 };
            }
            return response;
          };
          test.dependencies.external.runGitHubJson = async (...args) => {
            const response = await github(...args);
            const path = args[0];
            if (
              (boundary === "repository" && path === "/repos/octo/app") ||
              (boundary === "customization" && path.endsWith("/sub")) ||
              (boundary === "client-id" && path.endsWith("/AZURE_CLIENT_ID"))
            ) {
              await hold();
              if (result === "malformed")
                return { ok: true, status: 200, json: null };
              if (result === "refused")
                return { ok: false, status: 403, json: null };
            }
            return response;
          };
          const rejected = expect(test.run()).rejects.toMatchObject({
            code: "setup-execution-interrupted"
          });
          try {
            await entered.promise;
            const issued = [...test.calls];
            const checkpoint = structuredClone(test.operation);
            const persist = vi.mocked(test.dependencies.operations.persist);
            const saves = persist.mock.calls.length;
            test.stop();
            released.resolve();
            await rejected;
            expect(test.calls).toEqual(issued);
            expect(test.operation).toEqual(checkpoint);
            expect(persist).toHaveBeenCalledTimes(saves);
            expect(test.finalize).not.toHaveBeenCalled();
          } finally {
            released.resolve();
          }
        }
      );
    }
  );

  it("checks admission after selected identity verification", async () => {
    const test = initialFixture();
    const github = vi.fn();
    test.dependencies.external.runGitHubJson = async (
      _path,
      _executor,
      beforeExecute
    ) => {
      test.stop();
      beforeExecute?.();
      github();
      return { ok: false, status: 403, json: null };
    };
    await expect(test.run()).rejects.toMatchObject({
      code: "setup-execution-interrupted"
    });
    expect(github).not.toHaveBeenCalled();
    expect(test.finalize).not.toHaveBeenCalled();
  });

  it("prevents the next OIDC attempt after shutdown during existing backoff", async () => {
    vi.useFakeTimers();
    try {
      const test = initialFixture();
      const received = deferred();
      const read = vi.fn(async () => {
        received.resolve();
        return { ok: false, status: 503, json: null };
      });
      test.dependencies.external.runGitHubJson = read;
      const rejected = expect(test.run()).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      await received.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      test.stop();
      await vi.advanceTimersByTimeAsync(300);
      await vi.runAllTimersAsync();
      await rejected;
      expect(read).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(test.finalize).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("accepted Azure continuation shutdown", () => {
  async function continuationFixture(caller: "user" | "servicePrincipal") {
    const test = fixture();
    const executor = successfulSelectedGhExecutor();
    const calls: string[] = [];
    let stopped = false;
    const account = {
      id: request.subscriptionId,
      tenantId: "11111111-1111-1111-1111-111111111111",
      user: {
        type: caller,
        name: "55555555-5555-5555-5555-555555555555"
      }
    };
    const github = async (path: string) => {
      if (path === "/repos/octo/app")
        return {
          ok: true,
          status: 200,
          json: { full_name: "octo/app", id: 5, owner: { id: 7 } }
        };
      if (path === "/repos/octo/app/actions/oidc/customization/sub")
        return { ok: false, status: 404, json: null };
      throw new Error(`Unexpected GitHub request ${path}`);
    };
    const oidc = await resolveOidcSubject(
      {
        targetRepo: request.repo,
        envName: "dev",
        suffix: buildEnvironmentSuffix("dev")
      },
      github
    );
    const saved = createAzureAppCreateContinuation(
      {
        operationId: test.operation.operationId,
        request: {
          repo: request.repo,
          environment: "dev",
          operationEnvironment: "dev",
          requestedSubscriptionId: request.subscriptionId,
          requestedTenantId: "",
          resourceGroup: request.resourceGroup,
          clusterName: request.cluster,
          clusterResourceGroup: "",
          explicitAppId: "",
          createNewApp: false,
          appNameProvided: false,
          requestedAppName: "",
          requestedClientId: ""
        },
        githubExecutor: executor,
        resolved: {
          subscriptionId: request.subscriptionId,
          tenantId: account.tenantId,
          oidcSuffix: buildEnvironmentSuffix("dev"),
          oidc,
          callerIdentity:
            caller === "user" ?
              { kind: "user" }
            : { kind: "servicePrincipal", appId: account.user.name }
        }
      },
      "radius-deploy-octo-app",
      "44444444-4444-4444-4444-444444444444",
      "2026-10-14T10:00:00.000Z"
    );
    if (!saved) throw new Error("Invalid continuation fixture");
    test.operation.state = "running";
    test.operation.azureAppCreateContinuation = {
      ...saved,
      acceptedPrompt: saved.prompt
    };
    expect(
      normalizeAzureAppCreateContinuation(
        test.operation.azureAppCreateContinuation
      )
    ).not.toBeNull();
    test.dependencies.isStopped = () => stopped;
    test.dependencies.external.getSelectedGitHubExecutor = () => executor;
    executor.verifyIdentity = async () => {
      calls.push("identity");
    };
    test.dependencies.external.runAz = async (args) => {
      calls.push(args[0] === "account" ? "account" : "caller");
      if (args[0] === "account")
        return { code: 0, stdout: JSON.stringify(account), stderr: "" };
      if (
        args[0] === "ad" &&
        args[1] === (caller === "user" ? "signed-in-user" : "sp") &&
        args[2] === "show"
      )
        return { code: 0, stdout: saved.resolved.callerObjectId, stderr: "" };
      throw new Error(`Unexpected Azure command ${args.join(" ")}`);
    };
    test.dependencies.external.runGitHubJson = async (path) => {
      calls.push(path.endsWith("/sub") ? "customization" : "repository");
      return github(path);
    };
    test.dependencies.external.preflightRepoAdmin = async () => {
      calls.push("preflight");
      return "";
    };
    test.dependencies.external.preflightGhcrPackageWriteAccess = async () => {
      calls.push("packages");
      return { ok: true };
    };
    return {
      ...test,
      executor,
      calls,
      stop: () => {
        stopped = true;
      },
      run: () =>
        createAzureSetupService(test.dependencies)({
          data: {
            ...request,
            operationId: test.operation.operationId,
            serviceManagementReference: "66666666-6666-6666-6666-666666666666"
          }
        })
    };
  }

  it.each(["user", "servicePrincipal"] as const)(
    "does not consume accepted input when already stopped (%s)",
    async (caller) => {
      const test = await continuationFixture(caller);
      test.operation.inputRequired =
        test.operation.azureAppCreateContinuation.prompt;
      const before = structuredClone(test.operation);
      test.dependencies.operations.resumeAfterInput = vi.fn();
      test.dependencies.operations.enterStage = vi.fn();
      test.stop();
      await expect(test.run()).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      expect(test.operation).toEqual(before);
      expect(test.calls).toEqual([]);
      expect(
        test.dependencies.operations.resumeAfterInput
      ).not.toHaveBeenCalled();
      expect(test.dependencies.operations.enterStage).not.toHaveBeenCalled();
      expect(test.finalize).not.toHaveBeenCalled();
    }
  );

  for (const caller of ["user", "servicePrincipal"] as const) {
    it.each([
      "identity",
      "account",
      "caller",
      "repository",
      "customization"
    ] as const)(
      `stops after held ${caller} %s validation without another call or checkpoint`,
      async (boundary) => {
        const test = await continuationFixture(caller);
        const entered = deferred();
        const release = deferred();
        const hold = async <T>(name: string, work: () => Promise<T>) => {
          const result = await work();
          if (name === boundary) {
            entered.resolve();
            await release.promise;
          }
          return result;
        };
        const verify = test.executor.verifyIdentity;
        test.executor.verifyIdentity = () => hold("identity", verify);
        const az = test.dependencies.external.runAz;
        test.dependencies.external.runAz = (args) =>
          hold(args[0] === "account" ? "account" : "caller", () => az(args));
        const github = test.dependencies.external.runGitHubJson;
        test.dependencies.external.runGitHubJson = (path, executor) =>
          hold(path.endsWith("/sub") ? "customization" : "repository", () =>
            github(path, executor)
          );
        const pending = test.run();
        const rejection = expect(pending).rejects.toMatchObject({
          code: "setup-execution-interrupted"
        });
        await entered.promise;
        const issued = [...test.calls];
        test.stop();
        release.resolve();
        await rejection;
        expect(test.calls).toEqual(issued);
        expect(test.finalize).not.toHaveBeenCalled();
        expect(test.dependencies.operations.persist).not.toHaveBeenCalled();
      }
    );
  }
  it.each([
    "identity",
    "account",
    "caller",
    "repository",
    "customization",
    "preflight",
    "packages"
  ] as const)(
    "interruption wins over a rejected %s read without failure cleanup",
    async (boundary) => {
      const test = await continuationFixture("user");
      const reject = async () => {
        test.stop();
        throw new Error("read denied");
      };
      if (boundary === "identity") test.executor.verifyIdentity = reject;
      if (boundary === "account" || boundary === "caller") {
        const az = test.dependencies.external.runAz;
        test.dependencies.external.runAz = (args) =>
          (args[0] === "account") === (boundary === "account") ?
            reject()
          : az(args);
      }
      if (boundary === "repository" || boundary === "customization") {
        const github = test.dependencies.external.runGitHubJson;
        test.dependencies.external.runGitHubJson = (path) =>
          path.endsWith("/sub") === (boundary === "customization") ?
            reject()
          : github(path);
      }
      if (boundary === "preflight" || boundary === "packages") {
        test.dependencies.external.runAz = async () => ({
          code: 0,
          stdout: "{}",
          stderr: ""
        });
        if (boundary === "preflight")
          test.dependencies.external.preflightRepoAdmin = reject;
        else
          test.dependencies.external.preflightGhcrPackageWriteAccess = reject;
      }
      await expect(test.run()).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      expect(test.finalize).not.toHaveBeenCalled();
      expect(test.dependencies.operations.persist).not.toHaveBeenCalled();
    }
  );

  it.each(["mismatch", "malformed", "failed"] as const)(
    "does not interpret late %s account evidence as a continuation fallback",
    async (result) => {
      const test = await continuationFixture("user");
      test.dependencies.external.runAz = async () => {
        test.stop();
        return {
          code: result === "failed" ? 1 : 0,
          stdout:
            result === "malformed" ? "{"
            : result === "mismatch" ?
              JSON.stringify({
                id: "77777777-7777-4777-8777-777777777777",
                tenantId: "11111111-1111-1111-1111-111111111111",
                user: { type: "user" }
              })
            : "",
          stderr: "denied"
        };
      };
      await expect(test.run()).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      expect(test.calls).toEqual(["identity"]);
      expect(test.finalize).not.toHaveBeenCalled();
    }
  );

  it.each(["preflight", "packages"] as const)(
    "does not interpret late %s denial or launch the next phase",
    async (boundary) => {
      const test = await continuationFixture("user");
      test.dependencies.external.runAz = async () => ({
        code: 0,
        stdout: "{}",
        stderr: ""
      });
      if (boundary === "preflight")
        test.dependencies.external.preflightRepoAdmin = async () => {
          test.stop();
          return "denied";
        };
      else
        test.dependencies.external.preflightGhcrPackageWriteAccess =
          async () => {
            test.stop();
            return { ok: false, status: 403, error: "denied", code: "denied" };
          };
      await expect(test.run()).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      expect(test.finalize).not.toHaveBeenCalled();
      expect(test.dependencies.operations.persist).not.toHaveBeenCalled();
    }
  );

  it.each(["response", "delay"] as const)(
    "stops OIDC retry admission after shutdown during %s",
    async (boundary) => {
      vi.useFakeTimers();
      try {
        const test = await continuationFixture("user");
        const received = deferred();
        const read = vi.fn(async () => {
          if (boundary === "response") test.stop();
          received.resolve();
          return { ok: false, status: 503, json: null };
        });
        test.dependencies.external.runGitHubJson = read;
        const pending = test.run();
        const rejected = expect(pending).rejects.toMatchObject({
          code: "setup-execution-interrupted"
        });
        await received.promise;
        if (boundary === "delay") {
          await vi.advanceTimersByTimeAsync(0);
          expect(vi.getTimerCount()).toBe(1);
          test.stop();
          await vi.advanceTimersByTimeAsync(300);
        }
        await rejected;
        expect(read).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        expect(test.finalize).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    }
  );
});

describe("transport-independent Azure setup", () => {
  it("does not restore a prompt continuation after the operation terminalizes during app creation", async () => {
    const test = fixture();
    const calls: string[] = [];
    test.dependencies.operations.requireInput = requireInput;
    test.dependencies.operations.setAzureAppCreateContinuation =
      setAzureAppCreateContinuation;
    test.dependencies.persistMutationCheckpoint = persistMutationCheckpoint;
    test.dependencies.external.preflightRepoAdmin = async () => "";
    test.dependencies.external.preflightGhcrPackageWriteAccess = async () => ({
      ok: true,
      credentials: {}
    });
    test.dependencies.external.runGitHubJson = async (path) => {
      if (path === "/repos/octo/app") {
        return {
          ok: true,
          status: 200,
          json: { full_name: "octo/app", id: 5, owner: { id: 7 } }
        };
      }
      if (
        path === "/repos/octo/app/actions/oidc/customization/sub" ||
        path === "/repos/octo/app/environments/dev/variables/AZURE_CLIENT_ID"
      ) {
        return { ok: false, status: 404, json: null };
      }
      throw new Error(`Unspecified GitHub request: ${path}`);
    };
    test.dependencies.external.runAz = async (args) => {
      const command = args.join(" ");
      calls.push(command);
      if (command.startsWith("account set ")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "account show --output json") {
        return {
          code: 0,
          stdout: JSON.stringify({
            id: request.subscriptionId,
            tenantId: "11111111-1111-1111-1111-111111111111",
            user: { type: "user", name: "fixture@example.test" }
          }),
          stderr: ""
        };
      }
      if (command.startsWith("ad app list ")) {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (command.startsWith("ad signed-in-user show ")) {
        return {
          code: 0,
          stdout: "44444444-4444-4444-4444-444444444444",
          stderr: ""
        };
      }
      if (command.startsWith("ad app create ")) {
        finish(test.operation, "failed", {
          failure: { code: "operation-closed", message: "Operation closed." }
        });
        return {
          code: 1,
          stdout: "",
          stderr: "ServiceManagementReference is required by directory policy"
        };
      }
      throw new Error(`Unspecified Azure request: ${command}`);
    };
    const result = await createAzureSetupService(test.dependencies)({
      data: { ...request, operationId: test.operation.operationId }
    });
    expect(result).toMatchObject({
      kind: "input-required",
      status: 400,
      body: { code: "service-management-reference-required" }
    });
    expect(test.operation.state).toBe("failed");
    expect(test.operation.inputRequired).toBeUndefined();
    expect(test.operation.azureAppCreateContinuation).toBeUndefined();
    expect(
      calls.filter((command) => command.startsWith("ad app create "))
    ).toHaveLength(1);
    expect(calls.at(-1)).toMatch(/^ad app create /);
    expect(test.finalize).not.toHaveBeenCalled();
  });

  it("constructs and executes without a server, panel, or HTTP authorization callback", async () => {
    const test = fixture();
    const dependencies = test.dependencies;
    expect(dependencies).not.toHaveProperty("isServerOwnedRequest");
    const service = createAzureSetupService(dependencies);
    const result = await service({
      data: { ...request, operationId: "foreign-operation" }
    });
    expect(result).toMatchObject({
      kind: "failed",
      status: 409,
      body: { code: "operation-continuation-mismatch" }
    });
    expect(test.finalize.mock.calls[0]?.[0]).toBeNull();
    expect(dependencies.operations.persist).not.toHaveBeenCalled();
  });

  it("retains the service-owned selected-executor lookup and missing-binding refusal", async () => {
    const test = fixture();
    const selected = vi.fn(() => null);
    test.dependencies.external.getSelectedGitHubExecutor = selected;
    const result = await createAzureSetupService(test.dependencies)({
      data: { ...request, operationId: test.operation.operationId }
    });

    expect(selected).toHaveBeenCalledExactlyOnceWith(
      test.operation.operationId
    );
    expect(result).toMatchObject({
      kind: "failed",
      status: 409,
      body: { code: "github-selection-unavailable" }
    });
    expect(test.finalize).toHaveBeenCalledOnce();
  });

  it("honors a pending stop before finalizing a missing selected-account binding", async () => {
    const test = fixture();
    test.dependencies.external.getSelectedGitHubExecutor = () => null;
    test.dependencies.honorStopBoundary = async ({ operation, persist }) => {
      expect(operation).toBe(test.operation);
      await persist();
      return false;
    };
    const result = await createAzureSetupService(test.dependencies)({
      data: { ...request, operationId: test.operation.operationId }
    });
    expect(result).toMatchObject({
      kind: "stopped",
      status: 200,
      body: { boundary: "before-azure-failure-cleanup" }
    });
    expect(test.finalize).not.toHaveBeenCalled();
  });

  it.each([
    "provider-mutation-outcome-unknown",
    "provider-mutation-manual-required"
  ] as const)(
    "classifies %s inside the service and never exports the raw exception",
    async (code) => {
      const test = fixture();
      prepareProviderMutation(test.operation, {
        kind: "azure_application.create",
        target: "pending-create"
      });
      const error = new ProviderMutationRecoveryError(
        "private recovery detail",
        code
      );
      test.dependencies.external.getSelectedGitHubExecutor = () => ({
        ...successfulSelectedGhExecutor(),
        verifyIdentity: async () => {
          throw error;
        }
      });
      test.dependencies.finalizeSetupFailure = vi.fn(async () => ({
        status: 400,
        body: { error: "public failure", code }
      }));
      const result = await createAzureSetupService(test.dependencies)({
        data: { ...request, operationId: test.operation.operationId }
      });
      if (code === "provider-mutation-outcome-unknown") {
        expect(result).toMatchObject({ kind: "reconciling", status: 202 });
        expect(setupStageResult(result)).toEqual({
          kind: "reconciling",
          message: error.message
        });
        expect(test.dependencies.finalizeSetupFailure).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ kind: "failed", status: 400 });
        expect(() => setupStageResult(result)).toThrow("public failure");
        try {
          setupStageResult(result);
        } catch (caught) {
          expect(caught?.constructor).toBe(Error);
        }
        expect(test.dependencies.finalizeSetupFailure).toHaveBeenCalledOnce();
      }
      expect(test.dependencies.operations.persist).not.toHaveBeenCalled();
    }
  );

  it.each([
    new Error("failure"),
    "failure",
    Object.assign(new Error("failure"), { stack: "" })
  ])(
    "settles an escaped finalizer failure once and keeps diagnostics private: %s",
    async (error) => {
      const test = fixture();
      test.dependencies.finalizeSetupFailure = vi.fn(async () => {
        throw error;
      });
      const result = await createAzureSetupService(test.dependencies)({
        data: {}
      });
      expect(result).toMatchObject({
        kind: "failed",
        status: 500,
        body: { code: "setup-handler-failed" }
      });
      expect(test.dependencies.finalizeSetupFailure).toHaveBeenCalledOnce();
      expect(
        test.dependencies.operations.report
      ).toHaveBeenCalledExactlyOnceWith({
        code: "setup-handler-failed",
        message: "failure"
      });
    }
  );

  it.each(["failure", Object.assign(new Error("failure"), { stack: "" })])(
    "preserves malformed-input finalization evidence for %s",
    async (error) => {
      const test = fixture();
      const result = await createAzureSetupService(test.dependencies)({
        error
      });
      expect(result).toMatchObject({
        kind: "failed",
        status: 400,
        body: { code: "setup-unhandled", error: "failure" }
      });
      expect(test.finalize).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ evidence: null })
      );
    }
  );

  it("honors a stop during selected-account failure without cleanup", async () => {
    const test = fixture();
    test.dependencies.external.getSelectedGitHubExecutor = () => ({
      ...successfulSelectedGhExecutor(),
      verifyIdentity: async () => {
        throw new Error("selected identity changed");
      }
    });
    test.dependencies.honorStopBoundary = async (input) => {
      expect(input.boundary).toBe("before-azure-failure-cleanup");
      await input.persist();
      input.report({ code: "stop-recorded", message: "Stopped safely." });
      return false;
    };
    const result = await createAzureSetupService(test.dependencies)({
      data: { ...request, operationId: test.operation.operationId }
    });
    expect(result).toMatchObject({ kind: "stopped", status: 200 });
    expect(test.finalize).not.toHaveBeenCalled();
    expect(test.dependencies.operations.persist).toHaveBeenCalledOnce();
    expect(test.dependencies.operations.report).toHaveBeenCalledWith({
      code: "stop-recorded",
      message: "Stopped safely."
    });
  });
});
