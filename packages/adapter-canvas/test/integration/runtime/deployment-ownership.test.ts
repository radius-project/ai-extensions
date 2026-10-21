import { describe, expect, it, vi } from "vitest";
import { bootstrapRadiusExtension } from "../../../src/runtime/bootstrap.js";
import { deliverDeploymentRepair } from "../../../src/runtime/deployment-repair-delivery.js";
import {
  redactCredentials,
  type DeploymentRepairState
} from "@radius-project/core";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../support/runtime/fakes.js";

describe("production deployment owner runtime binding", () => {
  it("delivers one explicit headless repair through SDK bootstrap and retries a rejected send", async () => {
    const fake = createFakeDependencies();
    const session = createFakeSession();
    const extension = await bootstrapRadiusExtension(fake.deps, {
      createCanvas: (declaration) => declaration,
      joinSession: async () => session
    });
    const state: DeploymentRepairState = {
      deployAttempt: { id: "attempt-1" },
      deployGeneration: 1,
      deployStatus: "failed"
    };
    const retries: (() => void)[] = [];
    const errors: unknown[] = [];
    try {
      const handoff = fake.capturedHostCallbacks.deployRepairHandoff;
      if (!handoff) throw new Error("Deployment repair was not registered");
      vi.mocked(session.send).mockRejectedValueOnce(
        new Error("Host unavailable")
      );
      const input = {
        repo: "fixture/app",
        branch: "feature/model",
        deployRunUrl: "https://github.com/fixture/app/actions/runs/42",
        error: "build failed; access_token=synthetic-value",
        instanceId: ""
      };
      const ports = {
        isCurrent: () => true,
        send: handoff,
        redactDiagnostic: redactCredentials,
        publish: () => {},
        retry: (callback: () => void) => retries.push(callback),
        reportError: (error: unknown) => errors.push(error)
      };
      expect(deliverDeploymentRepair(state, input, ports)).toBe(true);
      expect(deliverDeploymentRepair(state, input, ports)).toBe(false);
      await vi.waitFor(() =>
        expect(state.deployHandoffState).toBe("retryable")
      );
      expect(retries).toHaveLength(1);
      retries[0]();
      await vi.waitFor(() =>
        expect(state.deployHandoffState).toBe("delivered")
      );
      expect(state.deployHandoffAttempts).toBe(2);
      expect(state.deployRepairing).toBe(true);
      expect(session.send).toHaveBeenCalledTimes(2);
      expect(errors).toHaveLength(1);
      const prompts = JSON.stringify(vi.mocked(session.send).mock.calls);
      expect(prompts).toContain("attempt-1");
      expect(prompts).not.toContain("synthetic-value");
      expect(fake.deps.getOrCreateServer).not.toHaveBeenCalled();
    } finally {
      await extension.shutdown();
    }
  });

  it("delivers a refusal notice through SDK bootstrap without opening a panel", async () => {
    const fake = createFakeDependencies();
    const session = createFakeSession();
    const extension = await bootstrapRadiusExtension(fake.deps, {
      createCanvas: (declaration) => declaration,
      joinSession: async () => session
    });
    try {
      const notice = fake.capturedHostCallbacks.deployFailureNotice;
      if (!notice) throw new Error("Deployment notice was not registered");
      await notice({
        repo: "fixture/app",
        branch: "feature/model",
        deployRunUrl: "",
        error: "source unavailable; access_token=synthetic-value",
        instanceId: "headless-attempt",
        dispatchRefused: true
      });
      expect(session.send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          prompt: expect.stringContaining("No new workflow was started."),
          displayPrompt: expect.stringContaining("refused Radius deploy")
        })
      );
      expect(JSON.stringify(vi.mocked(session.send).mock.calls)).not.toContain(
        "synthetic-value"
      );
      expect(fake.deps.getOrCreateServer).not.toHaveBeenCalled();
    } finally {
      await extension.shutdown();
    }
  });

  it("stops its local observation on zero-panel SDK shutdown without clearing in-flight ownership", async () => {
    const executionOwner = createEnvironmentExecutionOwner();
    const runtime = createTestCanvasServerRuntime({ executionOwner });
    const owner = runtime.deploymentOwner;
    const target = {
      repo: "fixture/app",
      environment: "dev",
      branch: "feature/model",
      provider: "azure",
      appFile: ".radius/app.bicep",
      githubLogin: "fixture-user"
    };
    const reservation = owner.reserve(target, "deploy");
    if (!reservation) throw new Error("Expected reservation");
    const attempt = owner.begin({
      reservation,
      target,
      executor: successfulSelectedGhExecutor({
        login: target.githubLogin,
        run: async () => {
          throw new Error("Unexpected GitHub read");
        }
      }),
      state: { deployStatus: "in_progress" }
    });
    if (attempt.kind !== "resolved") throw new Error(attempt.kind);
    const observation = owner.execution(attempt.invocation)?.observation;
    const fake = createFakeDependencies();
    const session = createFakeSession({ close: vi.fn(async () => {}) });
    const extension = await bootstrapRadiusExtension(
      { ...fake.deps, ...runtime, executionOwner },
      {
        createCanvas: (declaration) => declaration,
        joinSession: async () => session
      }
    );
    let settle = () => {};
    const work = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const run = owner.run(
      attempt.invocation,
      () => work,
      () => owner.release(reservation)
    );
    try {
      await Promise.resolve();
      await extension.shutdown();
      expect(runtime.servers.size).toBe(0);
      expect(owner.stopped).toBe(true);
      expect(observation?.stopped).toBe(true);
      expect(owner.activeReservation(target)).toBe(reservation);
      expect(owner.snapshot(attempt.invocation)?.deployStatus).toBe(
        "in_progress"
      );
    } finally {
      settle();
      await run;
      await extension.shutdown();
    }
    expect(owner.activeReservation(target)).toBeUndefined();
  });
});
