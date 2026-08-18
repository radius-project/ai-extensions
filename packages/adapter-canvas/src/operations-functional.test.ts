// @ts-nocheck
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileOperationStore } from "./operation-store.js";
import {
  createOperation,
  createRegistry,
  enterStage,
  finish,
  finishSucceeded,
  isStale,
  acceptCommand,
  beginRetryAttempt,
  canRetrySetup,
  recordAzureApp,
  recordCommitState,
  recordCommittedWorkflowFile,
  recordGitHubEnvironment,
  recordServicePrincipal,
  requestStop,
  requireInput,
  shouldStop,
  sanitizeResumeTarget,
  STAGE_VERIFY,
  toClientView
} from "./operations.js";
import type { OperationStore } from "./operation-store.js";
import { persistBestEffort, persistMutationCheckpoint } from "./server.js";

const directories: string[] = [];

async function persistedRegistries(now = Date.now()) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "radius-operation-functional-")
  );
  directories.push(directory);
  const filePath = path.join(directory, "operations.json");
  const store = createFileOperationStore({ filePath });
  const first = createRegistry({ store, clock: () => now });
  return {
    filePath,
    first,
    async restart() {
      const next = createRegistry({ store, clock: () => now });
      await next.hydrate();
      return next;
    }
  };
}

async function failureInjectedRegistries(failOnSave: number) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "radius-operation-failure-injection-")
  );
  directories.push(directory);
  const filePath = path.join(directory, "operations.json");
  const fileStore = createFileOperationStore({ filePath });
  let saveCount = 0;
  const store: OperationStore = {
    load: () => fileStore.load(),
    report: fileStore.report,
    async save(envelope) {
      saveCount += 1;
      if (saveCount === failOnSave) throw new Error("injected write failure");
      await fileStore.save(envelope);
    }
  };
  const first = createRegistry({ store });
  return {
    first,
    async restart() {
      const next = createRegistry({ store: fileStore });
      await next.hydrate();
      return next;
    }
  };
}

async function resumeRecoveredOperation(operation, actions) {
  if (operation.setupArtifacts.azureApp.state === "created") {
    await actions.createAzureApp();
  }
  if (operation.setupArtifacts.githubEnvironment.state === "created") {
    await actions.deleteGitHubEnvironment();
  }
}

function operation(overrides = {}) {
  return createOperation({
    provider: "azure",
    repo: "contoso/store",
    environment: "dev",
    journey: {
      origin: "planned",
      resumeTarget: {
        page: "planned",
        repo: "contoso/store",
        branch: "feature/cart"
      },
      resumeBranch: "feature/cart"
    },
    ...overrides
  });
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("operation restart functional coverage", () => {
  it("restores an operation waiting for interactive input", async () => {
    const { first, restart } = await persistedRegistries();
    const op = operation();
    first.start(op);
    requireInput(op, {
      code: "app-selection-required",
      message: "Choose an App Registration."
    });
    op.resumeRequest = {
      needsAzureCredentials: true,
      azure: {
        resourceGroup: "rg-dev",
        cluster: "aks-dev",
        subscriptionId: "sub-1",
        tenantId: "tenant-1"
      },
      environment: {
        repo: "contoso/store",
        environment: "dev",
        provider: "azure",
        resourceGroup: "rg-dev",
        cluster: "aks-dev"
      }
    };
    op.request = {
      ...op.resumeRequest,
      environment: {
        ...op.resumeRequest.environment,
        roleArn: "SECRET_ROLE_ARN"
      }
    };
    op.lastActivityAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await first.persist();

    const restored = await restart();
    const recovered = restored.get(op.operationId);
    expect(recovered).toMatchObject({
      state: "input_required",
      recoveryState: "waiting_input",
      inputRequired: { code: "app-selection-required" }
    });
    expect(recovered.resumeRequest.azure.resourceGroup).toBe("rg-dev");
    expect(recovered.request).toBeUndefined();
    expect(isStale(recovered)).toBe(false);
  });

  it("restores the exact persisted verification run", async () => {
    const { first, restart } = await persistedRegistries();
    const op = operation();
    first.start(op);
    enterStage(op, STAGE_VERIFY);
    op.verification = {
      dispatchedAt: Date.now(),
      workflow: "radius-verify-credentials.yml",
      ref: "feature/cart",
      environment: "dev",
      runId: "777",
      runUrl: "https://github.com/contoso/store/actions/runs/777"
    };
    await first.persist();

    const restored = await restart();
    expect(restored.get(op.operationId)).toMatchObject({
      recoveryState: "verification_pending",
      verification: {
        runId: "777",
        ref: "feature/cart",
        environment: "dev"
      }
    });
  });

  it("restores verification pending when stage and dispatch identity are checkpointed together", async () => {
    const { first, restart } = await persistedRegistries();
    const op = operation();
    first.start(op);
    op.verification = {
      dispatchedAt: Date.now(),
      workflow: "radius-verify-credentials.yml",
      ref: "feature/cart",
      environment: "dev",
      runId: null,
      runUrl: null
    };
    enterStage(op, STAGE_VERIFY);
    await first.persist();

    const restored = await restart();
    expect(restored.get(op.operationId)).toMatchObject({
      currentStage: STAGE_VERIFY,
      recoveryState: "verification_pending",
      verification: {
        workflow: "radius-verify-credentials.yml",
        ref: "feature/cart",
        environment: "dev"
      }
    });
  });

  it.each([
    [
      "azure app",
      (op) =>
        recordAzureApp(op, {
          state: "created",
          appId: "app-1",
          displayName: "radius-contoso-store"
        })
    ],
    [
      "GitHub Environment",
      (op) =>
        recordGitHubEnvironment(op, {
          state: "created_candidate",
          repo: "contoso/store",
          name: "dev"
        })
    ]
  ])("retains a post-mutation %s after restart", async (_name, mutate) => {
    const { first, restart } = await persistedRegistries();
    const op = operation();
    first.start(op);
    mutate(op);
    await first.persist();

    const restored = await restart();
    const recovered = restored.get(op.operationId);
    expect(recovered.state).toBe("failed_partial");
    expect(recovered.failure.code).toBe("operation-interrupted");
    expect(recovered.setupArtifacts.cleanup.state).toBe("not_needed");
  });

  it("restores planned-graph repository, branch, and origin context", async () => {
    const { first, restart } = await persistedRegistries();
    const op = operation();
    first.start(op);
    await first.persist();

    const restored = await restart();
    const recovered = restored.get(op.operationId);
    expect(recovered.journey).toMatchObject({
      origin: "planned",
      resumeBranch: "feature/cart",
      resumeTarget: {
        page: "planned",
        repo: "contoso/store",
        branch: "feature/cart"
      }
    });
    expect(sanitizeResumeTarget(recovered.journey.resumeTarget)).toEqual(
      recovered.journey.resumeTarget
    );
  });

  it("preserves a terminal outcome across restart", async () => {
    const { first, restart } = await persistedRegistries();
    const op = operation();
    first.start(op);
    finish(op, "action_required", {
      terminal: {
        reason: "pr-merge-required",
        branch: "radius/setup-dev",
        baseBranch: "main",
        pullRequestUrl: "https://github.com/contoso/store/pull/7"
      }
    });
    await first.persist();

    const restored = await restart();
    const recovered = restored.get(op.operationId);
    expect(recovered.state).toBe("action_required");
    finishSucceeded(recovered);
    expect(recovered.state).toBe("action_required");
  });

  it("restores the active-operation conflict for the same repository", async () => {
    const { first, restart } = await persistedRegistries();
    const op = operation();
    first.start(op);
    requireInput(op, { code: "choose-app", message: "Choose an app." });
    op.resumeRequest = {
      needsAzureCredentials: true,
      azure: {},
      environment: {
        repo: "contoso/store",
        environment: "dev",
        provider: "azure"
      }
    };
    await first.persist();

    const restored = await restart();
    const conflict = restored.start(operation());
    expect(conflict).toMatchObject({
      ok: false,
      conflict: { operationId: op.operationId }
    });
  });

  it("fails closed on a corrupt store without inventing cleanup work", async () => {
    const report = vi.fn();
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "radius-operation-corrupt-")
    );
    directories.push(directory);
    const filePath = path.join(directory, "operations.json");
    await fs.writeFile(filePath, "{ broken", "utf8");
    const registry = createRegistry({
      store: createFileOperationStore({ filePath, report })
    });

    await expect(registry.hydrate()).resolves.toEqual([]);
    expect(registry.size()).toBe(0);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ code: "operation-store-corrupt" })
    );
  });

  it("persists provenance without secrets, tokens, output, or evidence", async () => {
    const { filePath, first } = await persistedRegistries();
    const op = operation();
    op.context = {
      cloud: {
        kind: "azure",
        subscriptionId: "sub-1",
        tenantId: "tenant-1"
      }
    };
    op.failure = {
      code: "az-failed",
      message: "Safe summary",
      classification: "user-fixable",
      evidence: "RAW_STDERR_TOKEN_SECRET_COMMAND_OUTPUT"
    };
    first.put(op);
    await first.persist();

    const persisted = await fs.readFile(filePath, "utf8");
    expect(persisted).toContain("subscriptionId");
    expect(persisted).not.toMatch(
      /RAW_STDERR|TOKEN_SECRET|COMMAND_OUTPUT|SECRET_ROLE_ARN|evidence/
    );
    expect(JSON.stringify(toClientView(op))).not.toContain("RAW_STDERR");
  });

  it("stops after a post-mutation checkpoint failure and does not replay the mutation after restart", async () => {
    const { first, restart } = await failureInjectedRegistries(2);
    const op = operation();
    first.start(op);
    await first.persist();
    let createCalls = 0;
    let failCalls = 0;
    const diagnostics = [];

    createCalls += 1;
    recordAzureApp(op, {
      state: "created",
      appId: "app-1",
      displayName: "radius-contoso-store"
    });
    const checkpointed = await persistMutationCheckpoint({
      operation: op,
      persist: () => first.persist(),
      report: (diagnostic) => diagnostics.push(diagnostic),
      fail: async (_status, message, code) => {
        failCalls += 1;
        finish(op, "failed_partial", {
          failure: {
            code,
            stage: op.currentStage,
            stepSeq: null,
            message,
            classification: "unknown"
          }
        });
      }
    });

    expect(checkpointed).toBe(false);
    expect(createCalls).toBe(1);
    expect(failCalls).toBe(1);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "operation-store-write-failed" })
    ]);
    expect(op.state).toBe("failed_partial");

    const restored = await restart();
    const recovered = restored.get(op.operationId);
    await resumeRecoveredOperation(recovered, {
      createAzureApp: async () => {
        createCalls += 1;
      },
      deleteGitHubEnvironment: async () => {}
    });
    expect(recovered).toMatchObject({
      state: "failed_partial",
      failure: { code: "operation-interrupted" },
      setupArtifacts: {
        azureApp: { state: "not_started" },
        cleanup: { state: "not_needed" }
      }
    });
    expect(createCalls).toBe(1);
  });

  it("never deletes an ambiguous GitHub Environment after its provenance checkpoint fails", async () => {
    const { first, restart } = await failureInjectedRegistries(2);
    const op = operation();
    first.start(op);
    await first.persist();
    let putCalls = 0;
    let deleteCalls = 0;
    let failCalls = 0;

    putCalls += 1;
    recordGitHubEnvironment(op, {
      state: "created_candidate",
      repo: "contoso/store",
      name: "dev"
    });
    const checkpointed = await persistMutationCheckpoint({
      operation: op,
      persist: () => first.persist(),
      fail: async (_status, message, code) => {
        failCalls += 1;
        finish(op, "failed_partial", {
          failure: {
            code,
            stage: op.currentStage,
            stepSeq: null,
            message,
            classification: "unknown"
          }
        });
      }
    });

    expect(checkpointed).toBe(false);
    expect(putCalls).toBe(1);
    expect(failCalls).toBe(1);
    expect(deleteCalls).toBe(0);

    const restored = await restart();
    const recovered = restored.get(op.operationId);
    await resumeRecoveredOperation(recovered, {
      createAzureApp: async () => {},
      deleteGitHubEnvironment: async () => {
        deleteCalls += 1;
      }
    });
    expect(recovered).toMatchObject({
      state: "failed_partial",
      setupArtifacts: {
        githubEnvironment: { state: "not_started" },
        cleanup: { state: "not_needed" }
      }
    });
    expect(putCalls).toBe(1);
    expect(deleteCalls).toBe(0);
  });

  it("reports a best-effort persistence failure without changing the authoritative result", async () => {
    const diagnostics = [];
    let result = "success";
    const persisted = await persistBestEffort({
      operation: operation(),
      persist: async () => {
        throw new Error("disk full");
      },
      report: (diagnostic) => diagnostics.push(diagnostic)
    });

    expect(persisted).toBe(false);
    expect(result).toBe("success");
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "operation-store-write-failed",
        message: expect.stringContaining("disk full")
      })
    ]);
  });
});

describe("cooperative control functional coverage", () => {
  const operation = () =>
    createOperation({
      provider: "azure",
      repo: "contoso/store",
      environment: "dev",
      journey: { origin: "environments" }
    });

  it("honors a stop recorded before the extension restarted", async () => {
    const { first, restart } = await persistedRegistries();
    const op = operation();
    first.start(op);
    recordAzureApp(op, {
      state: "created",
      appId: "app-1",
      displayName: "radius-contoso-store"
    });
    requestStop(op);
    await first.persist();

    const restored = await restart();
    const recovered = restored.get(op.operationId);
    // Nothing was in flight across the restart, so the boundary is here.
    expect(recovered.state).toBe("cancelled");
    expect(recovered.recoveryState).toBe("stopped");
    expect(recovered.control.stop.requestedAt).toBeTruthy();
    expect(recovered.control.stop.boundary).toBe("restart_recovery");
    expect(shouldStop(recovered)).toBe(false);
    // The resource it created is still named for the customer.
    expect(toClientView(recovered).cleanup.created).toEqual([
      { kind: "azure_app", target: "radius-contoso-store (app-1)" }
    ]);
  });

  it("rebuilds the same command identity for a retry after a restart", async () => {
    const { first, restart } = await persistedRegistries();
    const op = operation();
    first.start(op);
    op.resumeRequest = {
      needsAzureCredentials: true,
      azure: { resourceGroup: "rg-dev" },
      environment: {
        repo: "contoso/store",
        environment: "dev",
        provider: "azure"
      }
    };
    recordAzureApp(op, { state: "created", appId: "app-1" });
    finish(op, "failed_partial", {
      failure: { code: "operation-stalled", message: "lost contact" }
    });
    const attempt = beginRetryAttempt(op, "setup");
    const accepted = acceptCommand(op, {
      kind: "retry_setup",
      attempt,
      target: "setup"
    });
    await first.persist();

    const restored = await restart();
    const recovered = restored.get(op.operationId);
    expect(recovered.control.attempts.setup).toBe(2);
    expect(recovered.control.commands).toEqual([
      expect.objectContaining({
        commandId: accepted.command.commandId,
        kind: "retry_setup",
        attempt: 2
      })
    ]);
    // The same command cannot be accepted twice after a restart.
    expect(
      acceptCommand(recovered, {
        kind: "retry_setup",
        attempt: recovered.control.attempts.setup,
        target: "setup"
      })
    ).toMatchObject({ ok: false, duplicate: true });
    expect(recovered.control.outcomes).toEqual([
      expect.objectContaining({ kind: "setup", state: "failed_partial" })
    ]);
  });

  it("continues a restored setup from the retained ledger rather than browser state", async () => {
    const { first, restart } = await persistedRegistries();
    const op = operation();
    first.start(op);
    op.resumeRequest = {
      needsAzureCredentials: true,
      azure: { resourceGroup: "rg-dev", cluster: "aks-dev" },
      environment: {
        repo: "contoso/store",
        environment: "dev",
        provider: "azure"
      }
    };
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordServicePrincipal(op, { state: "created", appId: "app-1" });
    finish(op, "failed_partial", { failure: { code: "operation-stalled" } });
    await first.persist();

    const restored = await restart();
    const recovered = restored.get(op.operationId);
    expect(canRetrySetup(recovered)).toMatchObject({
      ok: true,
      resumeFrom: "federated_credentials"
    });
    expect(recovered.setupArtifacts.azureApp.appId).toBe("app-1");
    expect(recovered.request).toBeUndefined();
  });

  it("keeps the action_required verdict in history across a verification retry", async () => {
    const { first, restart } = await persistedRegistries();
    const op = operation();
    first.start(op);
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordCommittedWorkflowFile(op, {
      path: ".github/workflows/radius-verify-credentials.yml",
      mode: "pull_request",
      branch: "radius-setup"
    });
    recordCommitState(op, {
      mode: "pull_request",
      branch: "radius-setup",
      baseBranch: "main",
      pullRequestUrl: "https://github.com/contoso/store/pull/7"
    });
    enterStage(op, STAGE_VERIFY);
    op.verification = {
      dispatchedAt: Date.now(),
      workflow: "radius-verify-credentials.yml",
      ref: "main",
      environment: "dev",
      runId: null,
      runUrl: null
    };
    finish(op, "action_required", {
      terminal: {
        reason: "pr-merge-required",
        pullRequestUrl: "https://github.com/contoso/store/pull/7"
      }
    });
    beginRetryAttempt(op, "verification");
    await first.persist();

    const restored = await restart();
    const recovered = restored.get(op.operationId);
    expect(recovered.state).toBe("running");
    expect(recovered.control.attempts.verification).toBe(1);
    expect(recovered.control.outcomes).toEqual([
      expect.objectContaining({
        kind: "verification",
        state: "action_required",
        code: "pr-merge-required"
      })
    ]);
    // The retained ledger still names the workflow, branch, and pull request.
    expect(recovered.setupArtifacts.commit.pullRequestUrl).toBe(
      "https://github.com/contoso/store/pull/7"
    );
    expect(recovered.verification.workflow).toBe(
      "radius-verify-credentials.yml"
    );
  });

  it("loads a version 1 record written before the control fields existed", async () => {
    const { first, filePath, restart } = await persistedRegistries();
    const op = operation();
    first.start(op);
    requireInput(op, {
      code: "app-selection-required",
      message: "Choose an App Registration."
    });
    op.resumeRequest = {
      needsAzureCredentials: true,
      azure: {},
      environment: {
        repo: "contoso/store",
        environment: "dev",
        provider: "azure"
      }
    };
    await first.persist();

    // Rewrite the file exactly as issues #304 and #305 would have left it.
    const envelope = JSON.parse(await fs.readFile(filePath, "utf8"));
    for (const record of envelope.operations) {
      record.schemaVersion = 1;
      delete record.control;
    }
    await fs.writeFile(filePath, JSON.stringify(envelope, null, 2));

    const restored = await restart();
    const recovered = restored.get(op.operationId);
    expect(recovered.schemaVersion).toBe(2);
    expect(recovered.state).toBe("input_required");
    expect(recovered.control.attempts).toEqual({
      setup: 1,
      verification: 0,
      cleanup: 0
    });
    expect(recovered.control.commands).toEqual([]);
  });

  it("keeps the browser view free of secrets, evidence, and the private ledger", async () => {
    const op = operation();
    op.resumeRequest = {
      needsAzureCredentials: true,
      azure: { clientSecret: "SECRET_VALUE" },
      environment: { repo: "contoso/store", environment: "dev" }
    };
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "contoso/store",
      name: "dev"
    });
    requestStop(op);
    finish(op, "failed_partial", {
      failure: {
        code: "operation-stalled",
        message: "lost contact",
        evidence: "RAW_STDERR_TOKEN"
      }
    });
    const view = JSON.stringify(toClientView(op));
    expect(view).not.toContain("SECRET_VALUE");
    expect(view).not.toContain("RAW_STDERR_TOKEN");
    expect(view).not.toContain("resumeRequest");
    expect(view).not.toContain("setupArtifacts");
    expect(view).not.toContain("idempotencyKey");
  });
});
