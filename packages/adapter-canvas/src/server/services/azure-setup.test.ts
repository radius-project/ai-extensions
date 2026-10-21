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
