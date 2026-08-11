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
      dispatchedAt: 1234,
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
});
