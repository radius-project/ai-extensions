import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { radArtifactsDirForSelection } from "../../../src/remote-rad-artifacts.js";
import {
  createDeploymentToolHarness,
  createDeploymentPipelineRunner
} from "../../support/runtime/deployment.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";
import { createDeferred } from "../../support/browser/fakes.js";
import { createDeploymentNotifications } from "../../../src/runtime/deployment-notifications.js";
import { createDeploymentPresentation } from "../../../src/server/services/deployment-presentation.js";
import type { CanvasState } from "../../../src/shared.js";
import { createProductionDeploymentTools } from "../../../src/runtime/production-deployment-tools.js";
import { BARE_GH_COMMAND_PRESENTATION } from "../../../src/gh-command-display.js";
import { createProductionDeploymentExecutionOwner } from "../../../src/runtime/production-deployment-execution-owner.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createDeploymentAccountResolver } from "../../../src/runtime/deployment-account.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";
import { createGitHubAccountResolvers } from "../../../src/runtime/github-account-resolvers.js";
import { createGitHubAccountCoordinator } from "../../../src/server/services/github-account-coordinator.js";
import { createEnvironmentTools } from "../../../src/runtime/environment-tools.js";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Direct deployment must not fetch loopback HTTP.")
  );
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.useRealTimers();
});

describe("registered direct deployment tools", () => {
  it.each(["zero-panel", "final-panel-close"] as const)(
    "retains custom-file deployment, repair and keepalive through unsettled work after %s",
    async (lifecycle) => {
      vi.useFakeTimers();
      const sdk = await createRuntimeSdkHarness();
      const pipeline = createDeploymentPipelineRunner("failure", {
        existingEnvironment: true
      });
      const dispatchEntered = createDeferred<void>();
      const dispatchReleased = createDeferred<void>();
      const sendReleased = createDeferred<void>();
      const deployment = createDeploymentToolHarness({
        owner: createProductionDeploymentExecutionOwner(),
        run: async (args, options) => {
          if (args[1]?.includes("/contents/") && args[1].includes(".bicep?"))
            expect(args[1]).toBe(
              "/repos/fixture/app/contents/apps/custom.bicep?ref=feature%2Fmodel"
            );
          if (args[0] === "workflow") {
            dispatchEntered.resolve();
            await dispatchReleased.promise;
          }
          return pipeline.run(args, options);
        }
      });
      const executionOwner = createEnvironmentExecutionOwner();
      const runtime = createTestCanvasServerRuntime({
        executionOwner,
        deploymentOwner: deployment.owner,
        deploymentAccount: deployment.account
      });
      const invalidate = vi.spyOn(runtime, "invalidateDeploymentListCache");
      const compile = vi.fn(async () => []);
      sdk.deps.deployment = createProductionDeploymentTools({
        owner: deployment.owner,
        account: deployment.account,
        session: sdk.deps.session,
        ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION,
        runAz: async () => {
          throw new Error("Unexpected Azure command.");
        },
        buildGraph: compile,
        readRadArtifacts: async () => ({ dir: "", remote: false }),
        reportError: deployment.reportError,
        redactDiagnostic: (value) => value,
        reportWorkflowProgress: vi.fn(),
        invalidateDeployListCache: invalidate
      });
      const send = vi.mocked(sdk.session.send);
      send
        .mockRejectedValueOnce(new Error("Temporary host delivery failure"))
        .mockImplementationOnce(() => sendReleased.promise);
      const start = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy"
      );
      const status = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy_status"
      );
      if (!start || !status) throw new Error("Missing deployment tools.");
      try {
        if (lifecycle === "final-panel-close") await sdk.host.open("radius");
        expect(
          await start.handler({
            repo: "fixture/app",
            environment: "dev",
            branch: "feature/model",
            provider: "aws",
            appFile: "apps/custom.bicep"
          })
        ).toContain("started");
        await dispatchEntered.promise;
        const first = deployment.owner.resolve();
        if (first.kind !== "resolved") throw new Error(first.kind);
        if (lifecycle === "final-panel-close") await sdk.host.close("radius");
        expect(sdk.servers.size).toBe(0);
        if (lifecycle === "zero-panel")
          expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
        const snapshot = vi.mocked(sdk.session.metadata?.snapshot);
        if (!snapshot) throw new Error("Missing metadata fixture.");
        snapshot.mockClear();
        await vi.advanceTimersByTimeAsync(240000);
        expect(snapshot).toHaveBeenCalledTimes(2);
        expect(sdk.deps.deployment.hasPendingWork()).toBe(true);
        dispatchReleased.resolve();
        for (let tick = 0; tick < 100 && send.mock.calls.length < 2; tick++)
          await vi.advanceTimersByTimeAsync(1000);
        expect(send).toHaveBeenCalledTimes(2);
        expect(
          deployment.owner.activeReservation(deployment.target)
        ).toBeUndefined();
        expect(sdk.deps.deployment.hasPendingWork()).toBe(true);
        snapshot.mockClear();
        await vi.advanceTimersByTimeAsync(240000);
        expect(snapshot).toHaveBeenCalledTimes(2);
        sendReleased.resolve();
        await vi.waitFor(() =>
          expect(sdk.deps.deployment.hasPendingWork()).toBe(false)
        );
        expect(deployment.reportError).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "Temporary host delivery failure"
          })
        );
        snapshot.mockClear();
        await vi.advanceTimersByTimeAsync(240000);
        expect(snapshot).not.toHaveBeenCalled();

        expect(
          await start.handler({ attemptId: first.invocation.attemptId })
        ).toContain("automatic repair attempt 1 of 5");
        for (
          let tick = 0;
          tick < 100 && sdk.deps.deployment.hasPendingWork();
          tick++
        )
          await vi.advanceTimersByTimeAsync(1000);
        const repaired = deployment.owner.resolve({
          attemptId: first.invocation.attemptId
        });
        if (repaired.kind !== "resolved") throw new Error(repaired.kind);
        expect(repaired.invocation.target).toEqual(first.invocation.target);
        expect(repaired.invocation.generation).toBeGreaterThan(
          first.invocation.generation
        );
        expect(deployment.account.mock.calls[1][0].savedLogin).toBe(
          "fixture-user"
        );
        expect(deployment.owner.execution(repaired.invocation)?.executor).toBe(
          deployment.executor
        );
        expect(
          JSON.parse(
            String(
              await status.handler({
                attemptId: repaired.invocation.attemptId
              })
            )
          )
        ).toMatchObject({
          status: "failed",
          deployRunUrl: "https://github.com/fixture/app/actions/runs/43"
        });
        expect(compile).toHaveBeenCalledTimes(2);
        for (const call of compile.mock.calls)
          expect(call).toEqual([
            expect.stringContaining("param environment string"),
            "apps/custom.bicep",
            expect.any(Object)
          ]);
        const commands = pipeline.run.mock.calls.map(([args]) => args);
        expect(commands.filter((args) => args[0] === "workflow")).toHaveLength(
          2
        );
        for (const args of commands.filter((args) => args[0] === "workflow")) {
          expect(args).toEqual(
            expect.arrayContaining([
              "--repo",
              "fixture/app",
              "--ref",
              "feature/model",
              "environment=dev"
            ])
          );
          expect(args.join(" ")).toContain("apps/custom.bicep");
        }
        expect(
          commands
            .filter((args) => args[1]?.includes("/artifacts?"))
            .every((args) =>
              /\/repos\/fixture\/app\/actions\/runs\/(42|43)\/artifacts\?/.test(
                args[1]
              )
            )
        ).toBe(true);
        expect(invalidate).toHaveBeenCalledTimes(2);
        expect(invalidate).toHaveBeenNthCalledWith(1, "fixture/app");
        expect(invalidate).toHaveBeenNthCalledWith(2, "fixture/app");
        expect(pipeline.unexpected).toEqual([]);
        expect(
          commands.some((args) => args.includes("PUT") || args[0] === "secret")
        ).toBe(false);
        await sdk.extension.shutdown("test");
        snapshot.mockClear();
        await vi.advanceTimersByTimeAsync(240000);
        expect(snapshot).not.toHaveBeenCalled();
      } finally {
        dispatchReleased.resolve();
        sendReleased.resolve();
        executionOwner.shutdown();
        await sdk.extension.shutdown("test");
      }
    }
  );

  it.each(["shutdown", "replacement"] as const)(
    "cleans selected staged artifacts and prevents late registered-tool work after %s",
    async (retirement) => {
      const sdk = await createRuntimeSdkHarness();
      const pipeline = createDeploymentPipelineRunner("success", {
        existingEnvironment: true
      });
      const staged = createDeferred<void>();
      const released = createDeferred<void>();
      let stagedDir = "";
      const removed = vi.spyOn(fs, "rmSync");
      syncBuiltinESMExports();
      const deployment = createDeploymentToolHarness({
        owner: createProductionDeploymentExecutionOwner(),
        run: async (args, options) => {
          if (args[1]?.includes("/contents/apps/")) {
            const content =
              args[1].endsWith("/custom.bicep?ref=feature%2Fmodel") ?
                "param environment string\nresource app 'Radius.Core/applications@2025-08-01' = { name: 'custom' }"
              : args[1].endsWith("/bicepconfig.json?ref=feature%2Fmodel") ?
                JSON.stringify({ extensions: { custom: "./custom-types.tgz" } })
              : args[1].endsWith("/custom-types.tgz?ref=feature%2Fmodel") ?
                "fixture types"
              : undefined;
            if (content === undefined)
              throw new Error("Unexpected selected source");
            return {
              code: 0,
              stdout: JSON.stringify({
                type: "file",
                encoding: "base64",
                content: Buffer.from(content).toString("base64")
              }),
              stderr: ""
            };
          }
          return pipeline.run(args, options);
        }
      });
      const compile = vi.fn(async () => []);
      sdk.deps.deployment = createProductionDeploymentTools({
        owner: deployment.owner,
        account: deployment.account,
        session: sdk.deps.session,
        ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION,
        runAz: async () => {
          throw new Error("Unexpected Azure command.");
        },
        buildGraph: compile,
        readRadArtifacts: async (input) => {
          if (!("github" in input))
            throw new Error("Expected selected remote artifacts.");
          const result = await radArtifactsDirForSelection(input);
          stagedDir = result.dir;
          expect(result.remote).toBe(true);
          staged.resolve();
          await released.promise;
          return result;
        },
        reportError: deployment.reportError,
        redactDiagnostic: (value) => value,
        reportWorkflowProgress: vi.fn(),
        invalidateDeployListCache: vi.fn()
      });
      const start = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy"
      );
      if (!start) throw new Error("Missing deployment tool.");
      try {
        await start.handler({
          repo: "fixture/app",
          environment: "dev",
          branch: "feature/model",
          provider: "aws",
          appFile: "apps/custom.bicep"
        });
        await staged.promise;
        const first = deployment.owner.resolve();
        if (first.kind !== "resolved") throw new Error(first.kind);
        const execution = deployment.owner.execution(first.invocation);
        const lease = deployment.owner.activeReservation(
          first.invocation.target
        );
        if (!execution || !lease)
          throw new Error("Missing admitted execution.");
        expect(fs.existsSync(stagedDir)).toBe(true);
        const calls = deployment.run.mock.calls.length;
        let replacement;
        if (retirement === "shutdown") {
          await sdk.extension.shutdown("test");
          expect(
            deployment.owner.activeReservation(first.invocation.target)
          ).toBe(lease);
        } else {
          deployment.owner.release(lease);
          replacement = deployment.owner.reserve(
            first.invocation.target,
            "deploy"
          );
          if (!replacement) throw new Error("Missing replacement lease.");
          expect(
            deployment.owner.begin({
              target: first.invocation.target,
              executor: deployment.executor,
              reservation: replacement,
              state: { deployLogs: ["replacement"] }
            }).kind
          ).toBe("resolved");
        }
        released.resolve();
        await vi.waitFor(() => expect(fs.existsSync(stagedDir)).toBe(false));
        expect(
          removed.mock.calls.filter(([path]) => path === stagedDir)
        ).toEqual([[stagedDir, { recursive: true, force: true }]]);
        expect(compile).not.toHaveBeenCalled();
        expect(deployment.run).toHaveBeenCalledTimes(calls);
        expect(
          pipeline.run.mock.calls.some(
            ([args]) =>
              args[0] === "workflow" || args.join(" ").includes("recipe")
          )
        ).toBe(false);
        expect(execution.state.deployingResources).toEqual([]);
        expect(execution.executor).toBe(deployment.executor);
        expect(sdk.session.send).not.toHaveBeenCalled();
        if (replacement) {
          expect(
            deployment.owner.activeReservation(first.invocation.target)
          ).toBe(replacement);
          const next = deployment.owner.resolve();
          if (next.kind !== "resolved") throw new Error(next.kind);
          expect(
            deployment.owner.snapshot(next.invocation)?.deployLogs
          ).toEqual(["replacement"]);
          deployment.owner.release(replacement);
        } else
          await vi.waitFor(() =>
            expect(
              deployment.owner.activeReservation(first.invocation.target)
            ).toBeUndefined()
          );
        expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
      } finally {
        released.resolve();
        await sdk.extension.shutdown("test");
      }
    }
  );

  it.each(["writer", "read-only", "installation-dispatch-denied"] as const)(
    "uses real eligibility for %s through registered panel-free deployment tools",
    async (scenario) => {
      vi.useFakeTimers();
      const sdk = await createRuntimeSdkHarness();
      const pipeline = createDeploymentPipelineRunner("success", {
        existingEnvironment: true
      });
      const login =
        scenario === "installation-dispatch-denied" ? "fixture[bot]" : "writer";
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
          if (
            args[0] === "workflow" &&
            scenario === "installation-dispatch-denied"
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
        scopes: [],
        credentialSource:
          scenario === "installation-dispatch-denied" ? "injected" : "keyring",
        requiresKeyringSwitch: true,
        run
      });
      let setupAllowed = false;
      const keyring = vi.fn(async () => {
        if (!setupAllowed)
          throw new Error("Deployment must not access keyring state");
        return login;
      });
      const switchAccount = vi.fn(async (): Promise<never> => {
        throw new Error("Unexpected keyring switch");
      });
      const createExecutor = vi.fn(async (selected: string) => {
        expect(selected).toBe(login);
        return executor;
      });
      const accounts = createGitHubAccountResolvers({
        coordinator: createGitHubAccountCoordinator({
          createExecutor,
          getActiveKeyringLogin: keyring,
          switchKeyringAccount: switchAccount,
          resetIdentityCache: () => {}
        }),
        ownerKey: "direct-permission-boundary",
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
      const owner = createProductionDeploymentExecutionOwner();
      const executionOwner = createEnvironmentExecutionOwner();
      const runtime = createTestCanvasServerRuntime({
        executionOwner,
        deploymentOwner: owner,
        deploymentAccount: accounts.deployment
      });
      sdk.deps.deployment = createProductionDeploymentTools({
        owner,
        account: accounts.deployment,
        session: sdk.deps.session,
        ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION,
        runAz: async () => {
          throw new Error("Unscripted Azure command");
        },
        buildGraph: async () => [],
        readRadArtifacts: async () => ({
          dir: "fixture-artifacts",
          remote: true
        }),
        reportError: (error) => {
          throw error;
        },
        redactDiagnostic: (value) => value,
        reportWorkflowProgress: vi.fn(),
        invalidateDeployListCache: runtime.invalidateDeploymentListCache
      });
      sdk.deps.environment = createEnvironmentTools({
        ...runtime.environmentServices,
        owner: executionOwner,
        session: sdk.deps.session,
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
      });
      const start = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy"
      );
      const status = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy_status"
      );
      const setup = sdk.extension.tools.find(
        ({ name }) => name === "radius_setup_environment"
      );
      if (!start || !status || !setup)
        throw new Error("Missing registered deployment or setup tools");
      const target = { repo: "fixture/app", environment: "dev" };
      try {
        const result = await start.handler({
          ...target,
          branch: "feature/model",
          provider: "aws",
          appFile: "apps/custom.bicep"
        });
        if (scenario === "read-only") {
          expect(result).toContain("verified access");
          expect(owner.resolve()).toEqual({ kind: "missing" });
        } else {
          expect(result).toContain("started");
          for (
            let tick = 0;
            tick < 100 && owner.activeReservation(target);
            tick++
          )
            await vi.advanceTimersByTimeAsync(1000);
          const current = owner.resolve();
          if (current.kind !== "resolved") throw new Error(current.kind);
          expect(current.invocation.target).toMatchObject({
            ...target,
            githubLogin: login,
            branch: "feature/model"
          });
          expect(owner.execution(current.invocation)?.executor).toBe(executor);
          expect(
            JSON.parse(
              String(
                await status.handler({
                  attemptId: current.invocation.attemptId
                })
              )
            )
          ).toMatchObject(
            scenario === "writer" ?
              { status: "success", errorKind: null }
            : { status: "failed", errorKind: "dispatch-refused" }
          );
        }
        expect(owner.activeReservation(target)).toBeUndefined();
        const dispatches = run.mock.calls.filter(
          ([args]) => args[0] === "workflow"
        );
        expect(dispatches).toHaveLength(scenario === "read-only" ? 0 : 1);
        if (scenario !== "read-only")
          expect(dispatches[0][0]).toEqual(
            expect.arrayContaining([
              "--repo",
              "fixture/app",
              "--ref",
              "feature/model",
              "environment=dev"
            ])
          );
        expect(keyring).not.toHaveBeenCalled();
        expect(switchAccount).not.toHaveBeenCalled();
        expect(
          run.mock.calls.some(
            ([args]) =>
              args.includes("PUT") ||
              args[0] === "secret" ||
              args.some((arg) =>
                /\/secrets|actions\/permissions|actions\/variables|ghcr/.test(
                  arg
                )
              )
          )
        ).toBe(false);
        expect(pipeline.unexpected).toEqual([]);
        if (scenario === "writer") {
          setupAllowed = true;
          expect(
            JSON.parse(
              String(
                await setup.handler({
                  ...target,
                  provider: "aws",
                  roleArn: "arn:aws:iam::123456789012:role/fixture",
                  accountId: "123456789012",
                  region: "us-west-2",
                  cluster: "fixture-eks"
                })
              )
            )
          ).toMatchObject({
            kind: "interaction_required",
            code: "github-reauthorization-required"
          });
          expect(
            run.mock.calls.filter(([args]) => args[0] === "workflow")
          ).toHaveLength(1);
        }
        expect(runtime.servers.size).toBe(0);
        expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
      } finally {
        executionOwner.shutdown();
        await sdk.extension.shutdown("test");
      }
    }
  );

  it.each(["success", "uncertain"] as const)(
    "runs the registered production deployment pipeline to %s without a panel or local transport",
    async (conclusion) => {
      vi.useFakeTimers();
      const sdk = await createRuntimeSdkHarness();
      const pipeline = createDeploymentPipelineRunner(conclusion);
      const deployment = createDeploymentToolHarness({
        owner: createProductionDeploymentExecutionOwner(),
        run: pipeline.run
      });
      const executionOwner = createEnvironmentExecutionOwner();
      const runtime = createTestCanvasServerRuntime({
        executionOwner,
        deploymentOwner: deployment.owner,
        deploymentAccount: deployment.account
      });
      const invalidate = vi.spyOn(runtime, "invalidateDeploymentListCache");
      sdk.deps.deployment = createProductionDeploymentTools({
        owner: deployment.owner,
        account: deployment.account,
        session: sdk.deps.session,
        ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION,
        runAz: async () => {
          throw new Error("Unscripted Azure command");
        },
        buildGraph: async () => [],
        readRadArtifacts: async () => ({
          dir: "fixture-artifacts",
          remote: true
        }),
        reportError: deployment.reportError,
        redactDiagnostic: (value) => value,
        reportWorkflowProgress: vi.fn(),
        invalidateDeployListCache: invalidate
      });
      const start = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy"
      );
      const status = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy_status"
      );
      if (!start || !status)
        throw new Error("Missing registered deployment tools");
      try {
        expect(
          await start.handler({
            repo: "fixture/app",
            environment: "dev",
            branch: "feature/model",
            provider: "aws",
            appFile: "apps/custom.bicep"
          })
        ).toContain("started");
        for (
          let tick = 0;
          tick < 100 && deployment.owner.activeReservation(deployment.target);
          tick++
        )
          await vi.advanceTimersByTimeAsync(1000);
        expect(
          deployment.owner.activeReservation(deployment.target)
        ).toBeUndefined();
        const selected = deployment.owner.resolve();
        if (selected.kind !== "resolved") throw new Error(selected.kind);
        expect(
          JSON.parse(
            String(
              await status.handler({ attemptId: selected.invocation.attemptId })
            )
          )
        ).toMatchObject(
          conclusion === "success" ?
            {
              status: "success",
              errorKind: null,
              deployRunUrl: "https://github.com/fixture/app/actions/runs/42"
            }
          : { status: "failed", errorKind: "run-unconfirmed" }
        );
        expect(pipeline.unexpected).toEqual([]);
        expect(
          pipeline.run.mock.calls.filter(([args]) => args[0] === "workflow")
        ).toHaveLength(1);
        expect(sdk.session.send).toHaveBeenCalledTimes(
          conclusion === "success" ? 0 : 1
        );
        expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
        expect(runtime.servers.size).toBe(0);
        if (conclusion === "success")
          expect(invalidate).toHaveBeenCalledWith("fixture/app");
        else expect(invalidate).not.toHaveBeenCalled();
      } finally {
        executionOwner.shutdown();
        await sdk.extension.shutdown("test");
      }
    }
  );

  it.each([
    "ambiguous",
    "wrong-executor",
    "unavailable-saved",
    "saved"
  ] as const)(
    "uses real account selection and fails closed for %s through registered handlers",
    async (selection) => {
      const sdk = await createRuntimeSdkHarness();
      const deployment = createDeploymentToolHarness();
      const prior = deployment.seed({
        deployStatus: "failed",
        deployError: "model failure"
      });
      const check = vi.fn(async () =>
        selection === "unavailable-saved" ?
          {
            state: "unavailable" as const,
            message: "Saved account unavailable."
          }
        : { state: "eligible" as const }
      );
      const readIdentity = vi.fn(async () => ({
        accounts: ["fixture-user", "other-user"].map((login) => ({
          login,
          hasWorkflow: true,
          hasPackages: true,
          switchable: true,
          acting: login === "other-user"
        }))
      }));
      const createExecutor = vi.fn(async () =>
        selection === "wrong-executor" ?
          successfulSelectedGhExecutor({ login: "other-user" })
        : deployment.executor
      );
      deployment.account.mockImplementation(
        createDeploymentAccountResolver({
          readIdentity,
          check,
          createExecutor,
          redactDiagnostic: (value) => value
        })
      );
      sdk.deps.deployment = deployment.tools;
      const start = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy"
      );
      if (!start) throw new Error("Missing registered deploy tool");
      try {
        const result = await start.handler(
          selection === "ambiguous" ?
            { repo: "fixture/app", environment: "dev", branch: "release" }
          : { attemptId: prior.invocation.attemptId }
        );
        if (selection === "saved") {
          expect(result).toContain("automatic repair attempt 1 of 5");
          expect(createExecutor).toHaveBeenCalledExactlyOnceWith(
            "fixture-user"
          );
          expect(deployment.monitor).toHaveBeenCalledOnce();
          expect(
            deployment.owner.resolve({ attemptId: prior.invocation.attemptId })
          ).toMatchObject({
            kind: "resolved",
            invocation: {
              target: { githubLogin: "fixture-user", branch: "feature/model" }
            }
          });
        } else {
          expect(result).toMatch(
            /choice-required|no longer matches|Saved account unavailable/
          );
          expect(deployment.monitor).not.toHaveBeenCalled();
          expect(deployment.run).not.toHaveBeenCalled();
          if (selection !== "wrong-executor")
            expect(createExecutor).not.toHaveBeenCalled();
        }
        if (selection !== "ambiguous") {
          expect(readIdentity).not.toHaveBeenCalled();
          expect(check).toHaveBeenCalledWith("fixture-user", {
            repo: "fixture/app",
            environment: "dev"
          });
        }
        expect(sdk.servers.size).toBe(0);
        expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
      } finally {
        await sdk.extension.shutdown("test");
      }
    }
  );

  it("shuts down the production monitor while a selected command is pending without sending a late notification", async () => {
    const sdk = await createRuntimeSdkHarness();
    const pipeline = createDeploymentPipelineRunner("success");
    const pending = createDeferred<void>();
    let readingBranch = false;
    const deployment = createDeploymentToolHarness({
      owner: createProductionDeploymentExecutionOwner(),
      run: async (args, options) => {
        if (args[1].includes("/git/ref/heads/")) {
          readingBranch = true;
          await pending.promise;
        }
        return pipeline.run(args, options);
      }
    });
    sdk.deps.deployment = createProductionDeploymentTools({
      owner: deployment.owner,
      account: deployment.account,
      session: sdk.deps.session,
      ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION,
      runAz: async () => {
        throw new Error("Unscripted Azure command");
      },
      buildGraph: async () => [],
      readRadArtifacts: async () => ({
        dir: "fixture-artifacts",
        remote: true
      }),
      reportError: deployment.reportError,
      redactDiagnostic: (value) => value,
      reportWorkflowProgress: vi.fn(),
      invalidateDeployListCache: vi.fn()
    });
    const start = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy"
    );
    if (!start) throw new Error("Missing registered deploy tool");
    try {
      await start.handler({
        repo: "fixture/app",
        environment: "dev",
        branch: "feature/model",
        provider: "aws"
      });
      await vi.waitFor(() => expect(readingBranch).toBe(true));
      await sdk.extension.shutdown("test");
      expect(
        deployment.owner.activeReservation(deployment.target)
      ).toBeDefined();
      pending.resolve();
      await vi.waitFor(() =>
        expect(
          deployment.owner.activeReservation(deployment.target)
        ).toBeUndefined()
      );
      expect(sdk.session.send).not.toHaveBeenCalled();
      expect(
        pipeline.run.mock.calls.some(([args]) => args[0] === "workflow")
      ).toBe(false);
    } finally {
      pending.resolve();
      await sdk.extension.shutdown("test");
    }
  });

  it.each([undefined, "unsupported"])(
    "returns explicit unavailable guidance through the registered status handler for %s",
    async (deployStatus) => {
      const sdk = await createRuntimeSdkHarness();
      const deployment = createDeploymentToolHarness();
      sdk.deps.deployment = deployment.tools;
      const execution = deployment.seed();
      execution.state.deployStatus = deployStatus;
      const status = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy_status"
      );
      if (!status) throw new Error("Missing registered status tool");
      try {
        expect(
          await status.handler({ attemptId: execution.invocation.attemptId })
        ).toContain("Deployment status is unavailable");
        expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
      } finally {
        await sdk.extension.shutdown("test");
      }
    }
  );

  it("routes the SDK handler through the actual production monitor and session-holder notification with a shared panel owner", async () => {
    const sdk = await createRuntimeSdkHarness();
    const deployment = createDeploymentToolHarness();
    const admission = deployment.run.getMockImplementation();
    if (!admission) throw new Error("Missing admission fixture");
    deployment.run.mockImplementation(async (args, options) => {
      if (args[0] === "api" && args[1].includes("/contents/"))
        return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      if (args[0] === "api" && args[1].includes("/git/ref/heads/"))
        return { code: 1, stdout: "", stderr: "HTTP 403: branch unavailable" };
      return admission(args, options);
    });
    sdk.deps.deployment = createProductionDeploymentTools({
      owner: deployment.owner,
      account: deployment.account,
      session: sdk.deps.session,
      ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION,
      runAz: async () => {
        throw new Error("Unscripted Azure command");
      },
      reportError: deployment.reportError,
      redactDiagnostic: (value) => value,
      reportWorkflowProgress: vi.fn(),
      invalidateDeployListCache: vi.fn()
    });
    const start = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy"
    );
    const status = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy_status"
    );
    if (!start || !status)
      throw new Error("Missing registered deployment tools");
    const presentation = createDeploymentPresentation(deployment.owner);
    try {
      await start.handler({
        repo: "fixture/app",
        environment: "dev",
        branch: "feature/model",
        provider: "aws"
      });
      const selected = deployment.owner.resolve();
      if (selected.kind !== "resolved") throw new Error(selected.kind);
      const panel: CanvasState = {};
      presentation.attach("production-panel", panel, selected.invocation);
      await vi.waitFor(() =>
        expect(
          deployment.owner.activeReservation(deployment.target)
        ).toBeUndefined()
      );
      expect(
        JSON.parse(
          String(
            await status.handler({ attemptId: selected.invocation.attemptId })
          )
        )
      ).toMatchObject({
        status: "failed",
        errorKind: "dispatch-refused"
      });
      expect(panel.deployErrorKind).toBe("dispatch-refused");
      expect(sdk.session.send).toHaveBeenCalledOnce();
      expect(sdk.session.send).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("branch unavailable")
        })
      );
      expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
      expect(deployment.monitor).not.toHaveBeenCalled();
    } finally {
      presentation.detach("production-panel");
      await sdk.extension.shutdown("test");
    }
  });

  it.each([
    ["pending", "pending"],
    ["in_progress", "in_progress"],
    ["complete", "success"],
    ["failed", "failed"]
  ])(
    "serializes owned %s as %s without renaming the attached Canvas state",
    async (canvasStatus, toolStatus) => {
      const sdk = await createRuntimeSdkHarness();
      const deployment = createDeploymentToolHarness();
      sdk.deps.deployment = deployment.tools;
      const execution = deployment.seed({
        deployStatus: canvasStatus,
        deployRunUrl: "https://github.com/fixture/app/actions/runs/42",
        deployStartedAt: 1700000000000,
        deployFinishedAt:
          canvasStatus === "complete" || canvasStatus === "failed" ?
            1700000060000
          : undefined
      });
      const presentation = createDeploymentPresentation(deployment.owner);
      const panel: CanvasState = {};
      presentation.attach("status-panel", panel, execution.invocation);
      const status = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy_status"
      );
      if (!status) throw new Error("Missing registered status tool");
      try {
        expect(
          JSON.parse(
            String(
              await status.handler({
                attemptId: execution.invocation.attemptId
              })
            )
          )
        ).toEqual({
          status: toolStatus,
          attemptId: execution.invocation.attemptId,
          errorKind: null,
          deployRunUrl: "https://github.com/fixture/app/actions/runs/42",
          startedAt: 1700000000000,
          finishedAt:
            canvasStatus === "complete" || canvasStatus === "failed" ?
              1700000060000
            : null
        });
        expect(panel.deployStatus).toBe(canvasStatus);
        expect(execution.state.deployStatus).toBe(canvasStatus);
        expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
      } finally {
        presentation.detach("status-panel");
        await sdk.extension.shutdown("test");
      }
    }
  );

  it("starts, repeats and observes a named attempt without opening a panel or fetching loopback HTTP", async () => {
    const sdk = await createRuntimeSdkHarness();
    const deployment = createDeploymentToolHarness();
    sdk.deps.deployment = deployment.tools;
    const start = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy"
    );
    const status = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy_status"
    );
    if (!start || !status)
      throw new Error("Missing registered deployment tools");
    try {
      expect(
        await start.handler({
          repo: "fixture/app",
          environment: "dev",
          branch: "feature/model"
        })
      ).toContain("started");
      await vi.waitFor(() =>
        expect(
          deployment.owner.activeReservation(deployment.target)
        ).toBeUndefined()
      );
      const first = deployment.owner.resolve();
      if (first.kind !== "resolved") throw new Error(first.kind);
      expect(
        JSON.parse(
          String(
            await status.handler({ attemptId: first.invocation.attemptId })
          )
        )
      ).toMatchObject({ status: "success" });
      expect(await start.handler({})).toContain("started");
      expect(deployment.monitor).toHaveBeenCalledTimes(2);
      expect(
        await start.handler({ attemptId: first.invocation.attemptId })
      ).toContain("no longer active");
      expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
      expect(sdk.servers.size).toBe(0);
    } finally {
      await sdk.extension.shutdown("test");
    }
  });

  it("shares one repair claim with an attached presentation and reports SDK delivery rejection", async () => {
    const sdk = await createRuntimeSdkHarness();
    const deployment = createDeploymentToolHarness();
    sdk.deps.deployment = deployment.tools;
    const pending = createDeferred<void>();
    const send = vi.mocked(sdk.session.send);
    send.mockImplementation(() => pending.promise);
    const notifications = createDeploymentNotifications({
      owner: deployment.owner,
      repair: (input) => {
        const callback = sdk.capturedHostCallbacks.deployRepairHandoff;
        if (!callback) throw new Error("Repair callback was not registered.");
        return callback(input);
      },
      notice: vi.fn(),
      reportError: deployment.reportError
    });
    deployment.notify.mockImplementation(notifications);
    const execution = deployment.seed({
      deployStatus: "failed",
      deployError: "model failure"
    });
    const panel: CanvasState = {};
    const presentation = createDeploymentPresentation(deployment.owner);
    presentation.attach("attached-panel", panel, execution.invocation);
    const status = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy_status"
    );
    if (!status) throw new Error("Missing registered status tool");
    try {
      await status.handler({ attemptId: execution.invocation.attemptId });
      notifications(execution);
      expect(send).toHaveBeenCalledOnce();
      expect(panel.deployHandoffState).toBe("pending");
      pending.reject(new Error("SDK unavailable"));
      await vi.waitFor(() =>
        expect(panel.deployHandoffState).toBe("retryable")
      );
      expect(deployment.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "SDK unavailable" })
      );
    } finally {
      presentation.detach("attached-panel");
      await sdk.extension.shutdown("test");
    }
  });

  it("stops a tool-started monitor during zero-panel SDK shutdown without releasing its lease before settlement", async () => {
    const sdk = await createRuntimeSdkHarness();
    const deployment = createDeploymentToolHarness();
    sdk.deps.deployment = deployment.tools;
    const pending = createDeferred<void>();
    deployment.monitor.mockImplementation(() => pending.promise);
    const start = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy"
    );
    if (!start) throw new Error("Missing registered deploy tool");
    try {
      await start.handler({
        repo: "fixture/app",
        environment: "dev",
        branch: "feature/model"
      });
      const selected = deployment.owner.resolve();
      if (selected.kind !== "resolved") throw new Error(selected.kind);
      const execution = deployment.owner.execution(selected.invocation);
      await sdk.extension.shutdown("test");
      expect(execution?.observation.stopped).toBe(true);
      expect(
        deployment.owner.activeReservation(deployment.target)
      ).toBeDefined();
      pending.resolve();
      await vi.waitFor(() =>
        expect(
          deployment.owner.activeReservation(deployment.target)
        ).toBeUndefined()
      );
      expect(deployment.notify).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
      await sdk.extension.shutdown("test");
    }
  });
});
