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
import { createDeferred } from "../../support/browser/fakes.js";
import { createDeploymentPipelineRunner } from "../../support/runtime/deployment.js";
import {
  setDeployRepairHandoff,
  setDeployFailureNotice
} from "../../../src/server.js";

describe("production deployment owner runtime binding", () => {
  it.each(["failure", "uncertain", "shutdown"] as const)(
    "retains a request-started selected write across SDK close and %s",
    async (outcome) => {
      const executionOwner = createEnvironmentExecutionOwner();
      const pipeline = createDeploymentPipelineRunner(
        outcome === "failure" ? "failure" : "uncertain"
      );
      const writing = createDeferred<void>();
      const written = createDeferred<void>();
      const executor = successfulSelectedGhExecutor({
        login: "fixture-user",
        requiresKeyringSwitch: true,
        run: async (args, options) => {
          if (args[0] === "workflow") {
            writing.resolve();
            await written.promise;
          }
          return pipeline.run(args, options);
        }
      });
      const account = vi.fn(async () => ({
        state: "selected" as const,
        login: executor.login,
        executor
      }));
      const runtime = createTestCanvasServerRuntime({
        executionOwner,
        deploymentAccount: account,
        serverDependencies: {
          createState: () => ({
            contextRepo: "fixture/app",
            contextBranch: "feature/model",
            envName: "dev",
            plannedResources: [{ id: "app", name: "app", type: "application" }]
          })
        }
      });
      const fake = createFakeDependencies();
      const session = createFakeSession();
      vi.mocked(session.send).mockRejectedValueOnce(
        new Error("Host unavailable")
      );
      const extension = await bootstrapRadiusExtension(
        {
          ...fake.deps,
          ...runtime,
          executionOwner,
          deployment: runtime.deploymentOwner,
          hostCallbacks: {
            ...fake.deps.hostCallbacks,
            setDeployRepairHandoff,
            setDeployFailureNotice
          }
        },
        {
          createCanvas: (declaration) => declaration,
          joinSession: async () => session
        }
      );
      const target = { repo: "fixture/app", environment: "dev" };
      try {
        const panel = await runtime.getOrCreateServer("panel", "deploying");
        const response = await fetch(`${panel.baseUrl}/api/deploy`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Radius-Mutation-Nonce": String(panel.state.browserMutationNonce)
          },
          body: JSON.stringify({
            targetRepo: target.repo,
            environment: target.environment,
            branch: "feature/model",
            provider: "aws",
            appFile: "apps/custom.bicep"
          })
        });
        expect(response.status).toBe(200);
        await response.text();
        await writing.promise;
        const current = runtime.deploymentOwner.resolve();
        if (current.kind !== "resolved") throw new Error(current.kind);
        const execution = runtime.deploymentOwner.execution(current.invocation);
        if (!execution) throw new Error("Missing owned deployment.");
        const reservation = runtime.deploymentOwner.activeReservation(target);
        await extension.canvases[0].onClose?.({
          instanceId: "panel",
          extensionId: "fixture:radius",
          canvasId: "radius"
        });
        expect(runtime.servers.size).toBe(0);
        expect(execution.observation.stopped).toBe(false);
        expect(execution.executor).toBe(executor);
        expect(runtime.deploymentOwner.activeReservation(target)).toBe(
          reservation
        );
        if (outcome === "shutdown") await extension.shutdown();
        vi.useFakeTimers();
        written.resolve();
        await vi.runAllTimersAsync();
        vi.useRealTimers();
        await vi.waitFor(
          () =>
            expect(
              runtime.deploymentOwner.activeReservation(target)
            ).toBeUndefined(),
          { timeout: 10000 }
        );
        expect(
          pipeline.run.mock.calls.filter(([args]) => args[0] === "workflow")
        ).toHaveLength(1);
        expect(account).toHaveBeenCalledOnce();
        expect(panel.state.deployStatus).toBe("in_progress");
        if (outcome === "shutdown") {
          expect(execution.observation.stopped).toBe(true);
          expect(session.send).not.toHaveBeenCalled();
          expect(execution.state.deployStatus).toBe("in_progress");
          expect(
            pipeline.run.mock.calls.some(([args]) => args[0] === "run")
          ).toBe(true);
          expect(pipeline.run.mock.calls.at(-1)?.[0][0]).toBe("workflow");
        } else {
          const field =
            outcome === "failure" ? "deployHandoffState" : "deployNoticeState";
          await vi.waitFor(
            () => expect(execution.state[field]).toBe("delivered"),
            { timeout: 5000 }
          );
          expect(session.send).toHaveBeenCalledTimes(2);
          const reopened = await runtime.getOrCreateServer(
            "panel",
            "deploying"
          );
          const status = await fetch(`${reopened.baseUrl}/api/deploy-status`);
          expect(await status.json()).toMatchObject({
            status: "failed",
            attempt: { id: current.invocation.attemptId }
          });
          expect(reopened.state[field]).toBe("delivered");
          expect(account).toHaveBeenCalledOnce();
          expect(session.send).toHaveBeenCalledTimes(2);
        }
        expect(pipeline.unexpected).toEqual([]);
      } finally {
        written.resolve();
        vi.useRealTimers();
        await extension.shutdown();
        setDeployRepairHandoff(null);
        setDeployFailureNotice(null);
      }
    }
  );
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
