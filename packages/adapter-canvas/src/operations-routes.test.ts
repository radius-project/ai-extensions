// @ts-nocheck
// End-to-end coverage for the operation status surface: a real loopback server,
// driven through the same routes the panel polls. The panel's whole design rests
// on the record outliving the request that created it, so this exercises the
// HTTP boundary rather than the module in isolation.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getOrCreateServer,
  onEnvironmentTasksSettled,
  setEnvironmentOperationTestRunner
} from "./server.js";
import {
  addLegacyStep,
  buildStages,
  createOperation,
  enterStage,
  finish,
  requireInput,
  operations,
  recordAzureApp,
  recordCommitState,
  recordCommittedWorkflowFile,
  recordCleanupState,
  recordGitHubEnvironment,
  recordServicePrincipal,
  setStageState,
  STAGE_CONFIGURE_ENVIRONMENT,
  STAGE_VERIFY
} from "./operations.js";

let baseUrl = "";
let entry = null;

beforeAll(async () => {
  entry = await getOrCreateServer("operations-routes-test", "environment");
  baseUrl = entry.baseUrl;
});

afterAll(() => {
  setEnvironmentOperationTestRunner(null);
  operations.clear();
  try {
    entry?.server?.close();
  } catch {
    /* best-effort */
  }
});

async function postJson(path, body) {
  const res = await fetch(baseUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /api/operations server-owned execution", () => {
  it("notifies a settlement listener registered after tasks have already settled", async () => {
    const listener = vi.fn();
    const stop = onEnvironmentTasksSettled("operations-routes-test", listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it("isolates a throwing settlement listener from later listeners", async () => {
    const throwing = vi.fn(() => {
      throw new Error("listener failed");
    });
    const following = vi.fn();
    const stopThrowing = onEnvironmentTasksSettled(
      "operations-routes-test",
      throwing
    );
    const stopFollowing = onEnvironmentTasksSettled(
      "operations-routes-test",
      following
    );
    await Promise.resolve();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(following).toHaveBeenCalledTimes(1);
    stopThrowing();
    stopFollowing();
  });

  it("returns 202 before the scheduled task completes and finishes without polling", async () => {
    operations.clear();
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const runner = vi.fn(async (operationId) => {
      await blocked;
      finish(operations.get(operationId), "succeeded");
      await operations.persist();
    });
    setEnvironmentOperationTestRunner(runner);

    const started = await postJson("/api/operations", {
      repo: "contoso/detached",
      environment: "dev",
      provider: "azure",
      clientId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      subscriptionId: "33333333-3333-3333-3333-333333333333",
      resourceGroup: "rg-dev",
      cluster: "aks-dev"
    });

    expect(started.status).toBe(202);
    expect(started.body.operationId).toMatch(/^op_/);
    expect(started.body.statusUrl).toContain(started.body.operationId);
    expect(operations.get(started.body.operationId)?.state).toBe("running");

    release();
    await vi.waitFor(() => {
      expect(operations.get(started.body.operationId)?.state).toBe("succeeded");
    });
  });

  it("returns the active operation id on a conflicting start", async () => {
    operations.clear();
    setEnvironmentOperationTestRunner(async () => {});
    const first = await postJson("/api/operations", {
      repo: "contoso/conflict",
      environment: "dev",
      provider: "azure",
      clientId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      subscriptionId: "33333333-3333-3333-3333-333333333333",
      resourceGroup: "rg-dev",
      cluster: "aks-dev"
    });
    const second = await postJson("/api/operations", {
      repo: "contoso/conflict",
      environment: "prod",
      provider: "azure",
      clientId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      subscriptionId: "33333333-3333-3333-3333-333333333333",
      resourceGroup: "rg-dev",
      cluster: "aks-dev"
    });
    expect(first.status).toBe(202);
    expect(second).toMatchObject({
      status: 409,
      body: {
        code: "operation-in-progress",
        operationId: first.body.operationId
      }
    });
  });

  it("normalizes the environment name before persisting the operation", async () => {
    operations.clear();
    setEnvironmentOperationTestRunner(async () => {});
    const started = await postJson("/api/operations", {
      repo: "contoso/normalized",
      environment: "  dev  ",
      provider: "azure",
      clientId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      subscriptionId: "33333333-3333-3333-3333-333333333333",
      resourceGroup: "rg-dev",
      cluster: "aks-dev"
    });

    expect(started.status).toBe(202);
    expect(operations.get(started.body.operationId)?.environment).toBe("dev");
  });

  it.each(["/api/azure-auto-setup", "/api/create-environment"])(
    "rejects direct calls to the internal mutation route %s",
    async (path) => {
      const response = await postJson(path, {});
      expect(response).toMatchObject({
        status: 403,
        body: { code: "server-owned-operation-required" }
      });
    }
  );

  it("resumes only the prompt currently owned by the operation", async () => {
    operations.clear();
    setEnvironmentOperationTestRunner(async () => {});
    const op = seed("contoso/resume");
    op.request = { azure: {}, environment: {}, needsAzureCredentials: true };
    requireInput(op, {
      code: "service-management-reference-required",
      checkpoint: "azure-service-management-reference",
      message: "Enter the Service Management Reference."
    });

    const wrong = await postJson(
      `/api/operations/${encodeURIComponent(op.operationId)}/resume/app-selection-required`,
      {
        checkpoint: "azure-service-management-reference",
        repo: op.repo,
        environment: op.environment,
        provider: op.provider,
        appId: "app-1"
      }
    );
    expect(wrong.status).toBe(409);

    const missingContext = await postJson(
      `/api/operations/${encodeURIComponent(op.operationId)}/resume/service-management-reference-required`,
      {
        checkpoint: "azure-service-management-reference",
        serviceManagementReference: "11111111-1111-1111-1111-111111111111"
      }
    );
    expect(missingContext.status).toBe(409);

    const resumed = await postJson(
      `/api/operations/${encodeURIComponent(op.operationId)}/resume/service-management-reference-required`,
      {
        checkpoint: "azure-service-management-reference",
        repo: op.repo,
        environment: op.environment,
        provider: op.provider,
        serviceManagementReference: "11111111-1111-1111-1111-111111111111"
      }
    );
    expect(resumed.status).toBe(202);
    expect(op.state).toBe("running");
    expect(op.request.azure.serviceManagementReference).toBe(
      "11111111-1111-1111-1111-111111111111"
    );
  });

  it("preserves the resume refusal ladder over the real loopback server", async () => {
    operations.clear();
    setEnvironmentOperationTestRunner(async () => {});

    const unknown = await postJson(
      "/api/operations/op-missing/resume/app-selection-required",
      {}
    );
    expect(unknown).toMatchObject({
      status: 404,
      body: { code: "unknown-operation" }
    });

    const expired = seed("contoso/expired");
    finish(expired, "failed_partial", {
      failure: {
        code: "operation-input-expired",
        message: "The requested input expired."
      }
    });
    const expiredResponse = await postJson(
      `/api/operations/${expired.operationId}/resume/app-selection-required`,
      {}
    );
    expect(expiredResponse).toMatchObject({
      status: 410,
      body: {
        code: "operation-input-expired",
        operation: { operationId: expired.operationId }
      }
    });

    const malformed = seed("contoso/malformed");
    malformed.request = {
      azure: {},
      environment: {},
      needsAzureCredentials: true
    };
    requireInput(malformed, {
      code: "app-selection-required",
      checkpoint: "azure-app-selection",
      message: "Choose an app."
    });
    const malformedResponse = await fetch(
      `${baseUrl}/api/operations/${malformed.operationId}/resume/app-selection-required`,
      { method: "POST", body: "{not json" }
    );
    expect(malformedResponse.status).toBe(409);
    expect(await malformedResponse.json()).toMatchObject({
      code: "operation-resume-mismatch"
    });

    const unsupported = seed("contoso/unsupported");
    unsupported.request = {
      azure: {},
      environment: {},
      needsAzureCredentials: true
    };
    requireInput(unsupported, {
      code: "future-prompt",
      checkpoint: "future-checkpoint",
      message: "Supply future input."
    });
    const unsupportedResponse = await postJson(
      `/api/operations/${unsupported.operationId}/resume/future-prompt`,
      {
        checkpoint: "future-checkpoint",
        repo: unsupported.repo,
        environment: unsupported.environment,
        provider: unsupported.provider
      }
    );
    expect(unsupportedResponse).toMatchObject({
      status: 400,
      body: { code: "unsupported-resume" }
    });
  });

  it("abandons an input wait and releases the repository lock", async () => {
    operations.clear();
    setEnvironmentOperationTestRunner(async () => {});
    const op = seed("contoso/abandon");
    requireInput(op, {
      code: "app-selection-required",
      checkpoint: "azure-app-selection",
      message: "Choose an app."
    });

    const abandoned = await postJson(
      `/api/operations/${encodeURIComponent(op.operationId)}/abandon`,
      {}
    );
    expect(abandoned.status).toBe(200);
    expect(op.state).toBe("cancelled");
    expect(operations.running(op.repo)).toBeNull();
  });

  it("refuses abandon for an unknown or non-waiting operation", async () => {
    operations.clear();
    setEnvironmentOperationTestRunner(async () => {});
    const unknown = await postJson("/api/operations/op-missing/abandon", {});
    expect(unknown).toMatchObject({
      status: 404,
      body: { code: "unknown-operation" }
    });

    const running = seed("contoso/not-waiting");
    const refused = await postJson(
      `/api/operations/${running.operationId}/abandon`,
      {}
    );
    expect(refused).toMatchObject({
      status: 409,
      body: { code: "operation-abandon-mismatch" }
    });
  });
});

async function getJson(path) {
  const res = await fetch(baseUrl + path);
  return { status: res.status, body: await res.json() };
}

function seed(repo, { environment = "dev", stages } = {}) {
  const op = createOperation({
    provider: "azure",
    repo,
    environment,
    stages: stages || buildStages()
  });
  operations.start(op);
  return op;
}

describe("GET /api/operations", () => {
  it("reports nothing rather than 404 when a repo has no operation", async () => {
    // The panel polls this on every page load; an absent operation is the
    // normal case, not an error.
    const { status, body } = await getJson(
      "/api/operations?repo=nobody%2Fnothing"
    );
    expect(status).toBe(200);
    expect(body.operation).toBeNull();
  });

  it("serves a running operation with its stages, steps and summary", async () => {
    const op = seed("contoso/live");
    addLegacyStep(op, "Acting on GitHub as @octocat.");
    addLegacyStep(op, "Creating App Registration radius-contoso-live...");
    addLegacyStep(op, "✅ Service Principal ready");
    enterStage(op, STAGE_CONFIGURE_ENVIRONMENT);

    const { body } = await getJson("/api/operations?repo=contoso%2Flive");
    expect(body.operation.state).toBe("running");
    expect(body.operation.terminalState).toBeNull();
    expect(body.operation.currentStage).toBe(STAGE_CONFIGURE_ENVIRONMENT);
    expect(body.operation.steps).toHaveLength(3);
    expect(body.operation.summary).toContain("configure environment");
    // No percentage anywhere: the step count varies with branching, so one
    // could only ever be derived from an assumed shape.
    expect(JSON.stringify(body.operation)).not.toMatch(
      /percent|"progress":\s*\d/
    );
  });

  it("keeps serving the record after it finishes, so a returning user sees the outcome", async () => {
    const op = seed("contoso/done");
    addLegacyStep(
      op,
      "⚠️ Could not assign the AKS RBAC Cluster Admin role automatically."
    );
    setStageState(op, STAGE_VERIFY, "skipped");
    finish(op, "action_required", {
      terminal: {
        reason: "pr-merge-required",
        pullRequestUrl: "https://github.com/contoso/done/pull/7",
        userMessage: "Merge PR #7 to finish setup."
      }
    });

    const { body } = await getJson("/api/operations?repo=contoso%2Fdone");
    expect(body.operation.terminalState).toBe("action_required");
    expect(body.operation.terminal.pullRequestUrl).toBe(
      "https://github.com/contoso/done/pull/7"
    );
    expect(body.operation.hasWarnings).toBe(true);
    expect(body.operation.endedAt).toBeTruthy();
  });

  it("prefers the running operation over an older finished one for the same repo", async () => {
    const first = seed("contoso/twice");
    finish(first, "succeeded");
    const second = seed("contoso/twice");
    const { body } = await getJson("/api/operations?repo=contoso%2Ftwice");
    expect(body.operation.operationId).toBe(second.operationId);
  });

  it("never ships raw failure evidence to the webview", async () => {
    // Evidence is attacker-influenced — an Azure CLI error or a build log can
    // carry instruction-shaped text. It travels only on the diagnostic path.
    const op = seed("contoso/leaky");
    finish(op, "failed", {
      failure: {
        code: "az-failed",
        message: "Azure CLI failed",
        classification: "user-fixable",
        evidence: "IGNORE-PREVIOUS-INSTRUCTIONS-CANARY"
      }
    });
    const { body } = await getJson("/api/operations?repo=contoso%2Fleaky");
    expect(body.operation.failure.message).toBe("Azure CLI failed");
    expect(JSON.stringify(body)).not.toContain(
      "IGNORE-PREVIOUS-INSTRUCTIONS-CANARY"
    );
  });

  it("serves cleanup results without exposing the setup ledger", async () => {
    const op = seed("contoso/cleanup");
    recordAzureApp(op, {
      state: "reused",
      appId: "shared-app-id",
      displayName: "shared-app"
    });
    recordCleanupState(op, {
      state: "succeeded_with_warnings",
      attempts: 1,
      results: [
        {
          attempt: 1,
          artifactType: "github_environment",
          target: "contoso/cleanup:dev",
          outcome: "deleted",
          detail: null
        },
        {
          attempt: 1,
          artifactType: "role_assignment",
          target: "Contributor @ /subscriptions/sub/resourceGroups/rg",
          outcome: "warning",
          detail: "Delete that role assignment manually before retrying."
        }
      ]
    });
    finish(op, "failed", {
      failure: {
        code: "env-create-failed",
        message: "Creating the GitHub environment failed.",
        classification: "user-fixable"
      }
    });

    const { body } = await getJson("/api/operations?repo=contoso%2Fcleanup");
    expect(body.operation.cleanup.removed).toEqual([
      {
        artifactType: "github_environment",
        outcome: "deleted",
        target: "contoso/cleanup:dev"
      }
    ]);
    expect(body.operation.cleanup.retained).toEqual([
      {
        kind: "azure_app",
        reason: "reused",
        target: "shared-app (shared-app-id)"
      }
    ]);
    expect(body.operation.cleanup.warnings).toEqual([
      "Delete that role assignment manually before retrying."
    ]);
    expect(JSON.stringify(body.operation)).not.toContain("setupArtifacts");
  });

  it("surfaces retained artifacts and retry guidance after a post-commit verify failure", async () => {
    const op = seed("contoso/post-commit");
    recordAzureApp(op, {
      state: "created",
      appId: "app-1",
      displayName: "radius-deploy-contoso-post-commit"
    });
    recordServicePrincipal(op, {
      state: "created",
      appId: "app-1",
      objectId: "sp-1"
    });
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "contoso/post-commit",
      name: "dev"
    });
    recordCommittedWorkflowFile(op, {
      path: ".github/workflows/radius-verify-credentials.yml",
      branch: "main",
      mode: "default_branch"
    });
    recordCommitState(op, {
      mode: "default_branch",
      branch: "main",
      baseBranch: "main"
    });
    recordCleanupState(op, { state: "not_needed" });
    finish(op, "failed_partial", {
      failure: {
        code: "verify-run-failed",
        message:
          "Credential verification failed after the workflows were committed.",
        classification: "user-fixable"
      }
    });

    const { body } = await getJson(
      "/api/operations?repo=contoso%2Fpost-commit"
    );
    expect(body.operation.cleanup.rollbackBeforeCommit).toBe(false);
    expect(body.operation.cleanup.retry).toEqual({
      startsCleanly: false,
      state: "reuses_retained_artifacts",
      guidance:
        "Retry will reuse the resources that were already written before the failure."
    });
    expect(body.operation.cleanup.retained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "azure_app",
          reason: "retained",
          target: "radius-deploy-contoso-post-commit (app-1)"
        }),
        expect.objectContaining({
          kind: "service_principal",
          reason: "retained",
          target:
            "Service Principal for radius-deploy-contoso-post-commit (app-1)"
        }),
        expect.objectContaining({
          kind: "github_environment",
          reason: "retained",
          target: "contoso/post-commit:dev"
        })
      ])
    );
  });
});

describe("GET /api/operations/{id}", () => {
  it("resolves a record by id", async () => {
    const op = seed("contoso/byid");
    const { status, body } = await getJson(
      `/api/operations/${encodeURIComponent(op.operationId)}`
    );
    expect(status).toBe(200);
    expect(body.operation.operationId).toBe(op.operationId);
  });

  describe("GET /api/verify-status operation identity", () => {
    it("rejects an unknown operation id instead of adopting a repository run", async () => {
      const { status, body } = await getJson(
        "/api/verify-status?repo=contoso%2Fstore&environment=dev&operationId=op_missing"
      );
      expect(status).toBe(200);
      expect(body).toEqual({
        state: "expired",
        terminal: true,
        error: "The verification operation does not match this request."
      });
    });

    it("rejects incomplete verification identity instead of adopting a run", async () => {
      const op = seed("contoso/incomplete-identity");
      enterStage(op, STAGE_VERIFY);
      op.verification = { dispatchedAt: Date.now() };

      const { body } = await getJson(
        `/api/verify-status?repo=contoso%2Fincomplete-identity&environment=dev&operationId=${encodeURIComponent(op.operationId)}`
      );

      expect(body).toEqual({
        state: "expired",
        terminal: true,
        error: "The verification operation has incomplete dispatch identity."
      });
    });

    it("keeps the persisted workflow identity on an operation-bound lookup", async () => {
      const op = seed("contoso/workflow-identity");
      enterStage(op, STAGE_VERIFY);
      op.verification = {
        dispatchedAt: Date.now(),
        workflow: "renamed-verify.yml",
        ref: "main",
        environment: "dev",
        runId: "12345",
        runUrl:
          "https://github.com/contoso/workflow-identity/actions/runs/12345"
      };

      const { status, body } = await getJson(
        `/api/verify-status?repo=contoso%2Fworkflow-identity&environment=dev&operationId=${encodeURIComponent(op.operationId)}`
      );

      expect(status).toBe(200);
      expect(body.runId).toBe("12345");
      expect(body.runUrl).toBe(
        "https://github.com/contoso/workflow-identity/actions/runs/12345"
      );
    });
  });

  it("404s an unknown id instead of inventing an empty record", async () => {
    const { status, body } = await getJson("/api/operations/op_does-not-exist");
    expect(status).toBe(404);
    expect(body.error).toBeTruthy();
  });
});

describe("GET /api/operations without a repo — the status chip's lookup", () => {
  // The chip renders in the page shell, which has no repository in scope. A
  // canvas instance is scoped to one workspace, so asking for "whatever
  // matters right now" is well defined.
  it("returns nothing on a quiet canvas", async () => {
    operations.clear();
    const { status, body } = await getJson("/api/operations");
    expect(status).toBe(200);
    expect(body.operation).toBeNull();
  });

  it("surfaces a live operation the user may have navigated away from", async () => {
    operations.clear();
    const op = seed("contoso/wandered", { environment: "staging" });
    addLegacyStep(op, "Creating GitHub environment staging...");
    const { body } = await getJson("/api/operations");
    expect(body.operation.operationId).toBe(op.operationId);
    expect(body.operation.environment).toBe("staging");
    expect(body.operation.state).toBe("running");
    operations.clear();
  });

  it("still reports the outcome once the operation has finished", async () => {
    operations.clear();
    const op = seed("contoso/finished", { environment: "prod" });
    finish(op, "succeeded");
    const { body } = await getJson("/api/operations");
    expect(body.operation.terminalState).toBe("succeeded");
    expect(body.operation.summary).toContain("prod");
    operations.clear();
  });

  it("goes quiet for an abandoned operation instead of offering an unresolvable spinner", async () => {
    // A setup spans two POSTs, so a user who walks away between them leaves
    // a record that nobody is driving. Showing it would reproduce exactly
    // the spinner this work exists to remove.
    operations.clear();
    const op = seed("contoso/abandoned");
    op.lastActivityAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const { body } = await getJson("/api/operations");
    expect(body.operation).toBeNull();
    operations.clear();
  });
});
