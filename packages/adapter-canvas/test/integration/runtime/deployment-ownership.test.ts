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
import { createGitHubAccountResolvers } from "../../../src/runtime/github-account-resolvers.js";
import { createGitHubAccountCoordinator } from "../../../src/server/services/github-account-coordinator.js";
import { createEnvironmentTools } from "../../../src/runtime/environment-tools.js";
import {
  setDeployRepairHandoff,
  setDeployFailureNotice
} from "../../../src/server.js";

describe("production deployment owner runtime binding", () => {
  it.each([
    "writer",
    "read-only",
    "installation-dispatch-denied",
    "workflow-write-denied",
    "secret-list-denied",
    "secret-write-denied"
  ] as const)(
    "uses production deployment eligibility through SDK and HTTP for %s",
    async (scenario) => {
      const conditionalWrite =
        scenario === "workflow-write-denied" ||
        scenario === "secret-list-denied" ||
        scenario === "secret-write-denied";
      const pipeline = createDeploymentPipelineRunner("success", {
        existingEnvironment: !conditionalWrite
      });
      const login =
        scenario === "installation-dispatch-denied" ? "fixture[bot]" : "writer";
      const dispatchEntered = createDeferred<void>();
      const dispatchReleased = createDeferred<void>();
      const denied = (args: string[]) =>
        (scenario === "workflow-write-denied" && args.includes("PUT")) ||
        (scenario === "secret-list-denied" && args[1]?.endsWith("/secrets")) ||
        (scenario === "secret-write-denied" && args[0] === "secret");
      const run = vi.fn(
        async (...[args, options]: Parameters<typeof pipeline.run>) => {
          if (args.join(" ") === "api repos/fixture/app")
            return {
              code: 0,
              stdout: JSON.stringify({
                permissions: { admin: false, push: scenario !== "read-only" }
              }),
              stderr: ""
            };
          const probes: Record<string, unknown> = {
            "repos/fixture/app/contents": [],
            "repos/fixture/app/actions/workflows?per_page=1": { workflows: [] },
            "repos/fixture/app/environments?per_page=1": { environments: [] },
            "repos/fixture/app/deployments?per_page=1": []
          };
          if (args[0] === "api" && args[1] in probes)
            return {
              code: 0,
              stdout: JSON.stringify(probes[args[1]]),
              stderr: ""
            };
          if (args[0] === "workflow") {
            dispatchEntered.resolve();
            await dispatchReleased.promise;
          }
          if (
            denied(args) ||
            (args[0] === "workflow" &&
              scenario === "installation-dispatch-denied")
          )
            return {
              code: 1,
              stdout: "",
              stderr: "HTTP 403: Resource not accessible by integration"
            };
          return pipeline.run(args, options);
        }
      );
      const executor = successfulSelectedGhExecutor({
        login,
        credentialSource:
          scenario === "installation-dispatch-denied" ? "injected" : "keyring",
        scopes: [],
        requiresKeyringSwitch: true,
        run
      });
      let setupAllowed = false;
      const keyring = vi.fn(async () => {
        if (!setupAllowed)
          throw new Error("Deployment must not access keyring state");
        return "writer";
      });
      const switchAccount = vi.fn(async (): Promise<never> => {
        throw new Error("Unexpected keyring switch");
      });
      const coordinator = createGitHubAccountCoordinator({
        createExecutor: async () => executor,
        getActiveKeyringLogin: keyring,
        switchKeyringAccount: switchAccount,
        resetIdentityCache: () => {}
      });
      const accounts = createGitHubAccountResolvers({
        coordinator,
        ownerKey: "permission-boundary",
        readIdentity: async () => ({
          accounts: [
            {
              login,
              hasWorkflow: false,
              hasPackages: false,
              switchable: true,
              acting: false
            }
          ]
        }),
        redactDiagnostic: (value) => value
      });
      const executionOwner = createEnvironmentExecutionOwner();
      const runtime = createTestCanvasServerRuntime({
        executionOwner,
        deploymentAccount: accounts.deployment,
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
      const extension = await bootstrapRadiusExtension(
        {
          ...fake.deps,
          ...runtime,
          executionOwner,
          deployment: runtime.deploymentOwner,
          environment: createEnvironmentTools({
            ...runtime.environmentServices,
            owner: executionOwner,
            session: fake.deps.session,
            account: accounts.setup,
            workspace: async () => ({
              repo: "fixture/app",
              branch: "feature/model"
            }),
            validateBranch: async () => {},
            redact: (value) => value,
            reportError: (error) => {
              throw error;
            }
          })
        },
        {
          createCanvas: (value) => value,
          joinSession: async () => createFakeSession()
        }
      );
      const target = { repo: "fixture/app", environment: "dev" };
      try {
        const panel = await runtime.getOrCreateServer(
          "permissions",
          "deploying"
        );
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
        const body = await response.json();
        if (scenario === "read-only") {
          expect(response.status).toBe(400);
          expect(body.error).toContain("verified access");
        } else {
          expect(response.status).toBe(200);
          if (!conditionalWrite) {
            await dispatchEntered.promise;
            vi.useFakeTimers();
            dispatchReleased.resolve();
            await vi.runAllTimersAsync();
            vi.useRealTimers();
          }
        }
        await vi.waitFor(
          () =>
            expect(
              runtime.deploymentOwner.activeReservation(target)
            ).toBeUndefined(),
          { timeout: 10000 }
        );
        const dispatches = run.mock.calls.filter(
          ([args]) => args[0] === "workflow"
        );
        expect(dispatches).toHaveLength(
          scenario === "read-only" || conditionalWrite ? 0 : 1
        );
        if (scenario !== "read-only") {
          const current = runtime.deploymentOwner.resolve();
          if (current.kind !== "resolved") throw new Error(current.kind);
          expect(current.invocation.target).toMatchObject({
            repo: target.repo,
            environment: target.environment,
            githubLogin: login,
            branch: "feature/model"
          });
          expect(
            runtime.deploymentOwner.execution(current.invocation)?.executor
          ).toBe(executor);
          expect(panel.state.deployStatus).toBe(
            scenario === "writer" ? "complete" : "failed"
          );
          if (scenario === "installation-dispatch-denied")
            expect(panel.state.deployErrorKind).toBe("dispatch-refused");
        }
        expect(keyring).not.toHaveBeenCalled();
        expect(switchAccount).not.toHaveBeenCalled();
        if (conditionalWrite) {
          expect(denied(run.mock.calls.at(-1)?.[0] ?? [])).toBe(true);
          expect(panel.state.deployError).toBeTruthy();
        } else
          expect(
            run.mock.calls.some(
              ([args]) =>
                args.includes("PUT") ||
                args[0] === "secret" ||
                args.some((arg) =>
                  /\/secrets|actions\/permissions|actions\/variables/.test(arg)
                )
            )
          ).toBe(false);
        expect(pipeline.unexpected).toEqual([]);
        if (scenario === "writer") {
          // Setup uses its lease and strict policy, unlike deployment.
          setupAllowed = true;
          const tool = extension.tools.find(
            (entry) => entry.name === "radius_setup_environment"
          );
          if (!tool) throw new Error("Missing setup tool");
          const result = JSON.parse(
            String(
              await tool.handler({
                ...target,
                provider: "aws",
                roleArn: "arn:aws:iam::123456789012:role/fixture",
                accountId: "123456789012",
                region: "us-west-2",
                cluster: "fixture-eks"
              })
            )
          );
          expect(result).toMatchObject({
            kind: "interaction_required",
            code: "github-reauthorization-required"
          });
          expect(
            run.mock.calls.filter(([args]) => args[0] === "workflow")
          ).toHaveLength(1);
        }
      } finally {
        dispatchReleased.resolve();
        vi.useRealTimers();
        await extension.shutdown();
      }
    }
  );
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
