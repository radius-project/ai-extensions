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
  recordAzureApp,
  recordGitHubEnvironment,
  requireInput,
  sanitizeResumeTarget,
  STAGE_VERIFY,
  toClientView
} from "./operations.js";
import type { OperationStore } from "./operation-store.js";
import { persistMutationCheckpoint } from "./server.js";

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
  if (operation.setupArtifacts.azure.app.state === "created") {
    await actions.createAzureApp();
  }
  if (operation.setupArtifacts.github.environment.state === "created") {
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
    op.lastActivityAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await first.persist();

    const restored = await restart();
    const recovered = restored.get(op.operationId);
    expect(recovered).toMatchObject({
      state: "running",
      recoveryState: "waiting_input",
      inputRequired: { code: "app-selection-required" }
    });
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
      /RAW_STDERR|TOKEN_SECRET|COMMAND_OUTPUT|evidence/
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
      state: "failed",
      failure: { code: "operation-interrupted" },
      setupArtifacts: {
        azure: { app: { state: "not_started" } },
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
      state: "failed",
      setupArtifacts: {
        github: { environment: { state: "not_started" } },
        cleanup: { state: "not_needed" }
      }
    });
    expect(putCalls).toBe(1);
    expect(deleteCalls).toBe(0);
  });
});
