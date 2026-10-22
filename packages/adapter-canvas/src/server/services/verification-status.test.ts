import { describe, expect, it, vi } from "vitest";
import { redactCredentials } from "@radius-project/core";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import {
  addLegacyStep,
  createOperation,
  finish,
  finishSucceeded,
  hasCompleteVerificationIdentity,
  isTerminalState,
  STAGE_VERIFY
} from "../../operations.js";
import {
  extractErrorLines,
  extractGitHubActionsStepLog,
  explainOidcEnterpriseClaim,
  explainNoSubscriptions,
  isSelectedGhAuthorizationError
} from "../../deploy.js";
import { createWorkflowObservationScope } from "./workflow-observation-scope.js";
import {
  createVerificationStatusService,
  observeVerificationStatus,
  type VerificationStatusDependencies
} from "./verification-status.js";

function fixture() {
  const operation = createOperation({
    operationId: "setup-status",
    repo: "fixture/app",
    environment: "dev",
    provider: "azure"
  });
  operation.currentStage = STAGE_VERIFY;
  operation.context.githubLogin = "saved-account";
  operation.verification = {
    runId: 17,
    workflow: "verify.yml",
    ref: "topic",
    environment: "dev",
    dispatchedAt: 100
  };
  const executor = successfulSelectedGhExecutor({ login: "saved-account" });
  const getRunDetail = vi.fn<VerificationStatusDependencies["getRunDetail"]>(
    async () => ({ status: "completed", conclusion: "success" })
  );
  const dependencies: VerificationStatusDependencies = {
    getOperation: () => operation,
    getSelectedGitHubExecutor: () => executor,
    isSelectedGitHubAuthorizationError: isSelectedGhAuthorizationError,
    hasCompleteVerificationIdentity,
    getRunDetail,
    fetchRunLog: async () => {
      throw new Error("Unexpected diagnostic read");
    },
    extractErrorLines,
    extractGitHubActionsStepLog,
    explainOidcEnterpriseClaim,
    explainNoSubscriptions,
    addLegacyStep,
    isTerminalState,
    finish,
    finishSucceeded,
    persistBestEffort: async ({ persist }) => {
      await persist();
      return true;
    },
    persistOperations: vi.fn(async () => {}),
    reportOperationDiagnostic: vi.fn(),
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    stageVerify: STAGE_VERIFY,
    redactDiagnostic: redactCredentials
  };
  const scope = createWorkflowObservationScope(() => {
    throw new Error("Verification must not read deployment artifacts");
  });
  const createScope = vi.fn(() => scope);
  const service = createVerificationStatusService(dependencies, createScope);
  const input = {
    repo: operation.repo,
    operationId: operation.operationId,
    environment: operation.environment
  };
  return {
    operation,
    executor,
    dependencies,
    getRunDetail,
    scope,
    createScope,
    service,
    input
  };
}

describe("direct verification binding", () => {
  it("constructs without observation or side effects and owns only its call lifetime", async () => {
    const f = fixture();
    expect(f.createScope).not.toHaveBeenCalled();
    expect(f.getRunDetail).not.toHaveBeenCalled();
    expect(await f.service(f.input)).toMatchObject({
      status: 200,
      body: { state: "success", runId: 17 }
    });
    expect(f.operation.state).toBe("succeeded");
    expect(f.createScope).toHaveBeenCalledOnce();
    expect(f.scope.stopped).toBe(true);
    expect(f.dependencies.persistOperations).toHaveBeenCalledOnce();
  });

  it("does not dispose an observation lifetime supplied by its runtime owner", async () => {
    const f = fixture();
    try {
      await f.service({ ...f.input, observation: f.scope });
      expect(f.scope.stopped).toBe(false);
      expect(f.createScope).not.toHaveBeenCalled();
    } finally {
      f.scope.stop();
    }
  });

  it("closes its observation after a provider read rejects", async () => {
    const f = fixture();
    f.getRunDetail.mockRejectedValue(new Error("provider unavailable"));
    expect(await f.service(f.input)).toEqual({
      status: 200,
      body: { state: "unknown", error: "provider unavailable" }
    });
    expect(f.scope.stopped).toBe(true);
    expect(f.operation.state).not.toBe("succeeded");
  });

  it.each(["operation", "repository"] as const)(
    "refuses a missing %s without provider reads",
    async (missing) => {
      const f = fixture();
      const result = await f.service({
        ...f.input,
        ...(missing === "operation" ? { operationId: "" } : { repo: "" })
      });
      expect(result.body.state).toBe(
        missing === "operation" ? "expired" : "unknown"
      );
      expect(f.getRunDetail).not.toHaveBeenCalled();
      expect(f.scope.stopped).toBe(true);
    }
  );

  it.each([undefined, null, {}, ""])(
    "does not substitute a legacy run for incomplete saved run %j",
    async (runId) => {
      const f = fixture();
      f.operation.verification.runId = runId;
      const compatibility = vi.fn(() => ({ runId: 99 }));
      const legacyInput = { ...f.input, compatibility };
      const result = await f.service(legacyInput);
      expect(result.body).toEqual({ state: "pending", runId: null });
      expect(compatibility).not.toHaveBeenCalled();
      expect(f.getRunDetail).not.toHaveBeenCalled();
    }
  );

  it("keeps acquisition-pending distinct from invalid dispatch identity", async () => {
    const f = fixture();
    f.operation.verification.acquisitionPending = true;
    expect(await f.service(f.input)).toMatchObject({
      body: { state: "pending", runId: null }
    });
    expect(f.getRunDetail).not.toHaveBeenCalled();
    expect(f.operation.state).not.toBe("failed_partial");
  });

  it("retains the HTTP adapter's explicit legacy fallback without selected-operation mutation", async () => {
    const f = fixture();
    try {
      const result = await observeVerificationStatus(
        {
          repo: f.input.repo,
          operationId: "",
          compatibility: () => ({ runId: "99", observation: f.scope })
        },
        f.dependencies
      );
      expect(result.body).toMatchObject({ state: "success", runId: "99" });
      expect(f.getRunDetail).toHaveBeenCalledWith(
        f.input.repo,
        "99",
        undefined,
        expect.any(Object)
      );
      expect(f.dependencies.persistOperations).not.toHaveBeenCalled();
      expect(f.scope.stopped).toBe(false);
    } finally {
      f.scope.stop();
    }
  });

  it("preserves the stopped-observation HTTP status without leaking internal metadata", async () => {
    const f = fixture();
    f.getRunDetail.mockImplementation(async () => {
      f.scope.stop();
      return { status: "completed", conclusion: "success" };
    });
    expect(await f.service(f.input)).toEqual({
      status: 503,
      body: { state: "pending", error: "Workflow observation stopped." }
    });
    expect(f.dependencies.persistOperations).not.toHaveBeenCalled();
  });
});
