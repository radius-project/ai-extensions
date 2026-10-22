import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../support/browser/fakes.js";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";
import {
  beginDeployAttempt,
  localDeploymentBlocksMutation
} from "../../../src/server.js";

describe("production deployment reservation HTTP binding", () => {
  it.each(["branch", "source", "secret"] as const)(
    "uses committed selected-account source and refuses unavailable %s before dispatch",
    async (failure) => {
      const executionOwner = createEnvironmentExecutionOwner();
      const commands: string[][] = [];
      const branch = "feature/model";
      const run = vi.fn(async (args: string[]) => {
        commands.push(args);
        const [command, path] = args;
        if (command !== "api") throw new Error("Unexpected mutation");
        if (
          path ===
            "/repos/fixture/app/environments/dev/variables?per_page=100" ||
          path === "/repos/fixture/app/deployments?per_page=100&environment=dev"
        )
          return { code: 0, stdout: "", stderr: "" };
        if (path === "/repos/fixture/app/git/ref/heads/feature%2Fmodel") {
          if (failure === "branch")
            return {
              code: 1,
              stdout: "",
              stderr: "HTTP 503: branch unavailable"
            };
          return {
            code: 0,
            stdout: JSON.stringify({ object: { sha: "a".repeat(40) } }),
            stderr: ""
          };
        }
        if (
          path ===
          "/repos/fixture/app/contents/apps/custom.bicep?ref=feature%2Fmodel"
        ) {
          if (failure === "source")
            return {
              code: 1,
              stdout: "",
              stderr: "HTTP 403: source unavailable"
            };
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              type: "file",
              encoding: "base64",
              content: Buffer.from(
                "@secure()\nparam dbPassword string\n"
              ).toString("base64")
            })
          };
        }
        if (path === "/repos/fixture/app/environments/dev/secrets") {
          expect(args).toEqual(["api", path, "--paginate", "--slurp"]);
          return {
            code: 1,
            stdout: "",
            stderr: "HTTP 403: secret listing unavailable"
          };
        }
        throw new Error(`Unexpected selected command: ${JSON.stringify(args)}`);
      });
      const executor = successfulSelectedGhExecutor({
        login: "fixture-user",
        run
      });
      const runtime = createTestCanvasServerRuntime({
        executionOwner,
        deploymentAccount: async () => ({
          state: "selected",
          login: executor.login,
          executor
        }),
        serverDependencies: {
          createState: () => ({
            contextRepo: "fixture/app",
            contextBranch: branch,
            envName: "dev",
            workspaceRepo: "fixture/app",
            workspaceBranch: branch,
            workspacePath: "/fixture/workspace",
            plannedResources: [{ id: "fixture", name: "api" }]
          })
        }
      });
      try {
        const panel = await runtime.getOrCreateServer("panel", "deploy");
        const response = await fetch(`${panel.baseUrl}/api/deploy`, {
          method: "POST",
          headers: {
            Origin: panel.baseUrl,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "X-Radius-Mutation-Nonce": String(panel.state.browserMutationNonce)
          },
          body: JSON.stringify({
            targetRepo: "fixture/app",
            environment: "dev",
            branch,
            provider: "aws",
            appFile: "apps/custom.bicep"
          })
        });
        expect(response.status).toBe(200);
        await expect.poll(() => panel.state.deployStatus).toBe("failed");
        await expect
          .poll(() =>
            runtime.deploymentOwner.activeReservation({
              repo: "fixture/app",
              environment: "dev"
            })
          )
          .toBeUndefined();
        expect(panel.state.deployErrorKind).toBe("dispatch-refused");
        expect(panel.state.deployDispatchEvidence).toBe("refused");
        expect(panel.state.deployError).toContain(
          failure === "branch" ? "branch unavailable"
          : failure === "source" ? "source unavailable"
          : "secret listing unavailable"
        );
        expect(
          commands.filter((args) => args[1]?.includes("/contents/"))
        ).toEqual(
          failure === "branch" ?
            []
          : [
              [
                "api",
                "/repos/fixture/app/contents/apps/custom.bicep?ref=feature%2Fmodel"
              ]
            ]
        );
        expect(commands.every((args) => args[0] === "api")).toBe(true);
        expect(commands.some((args) => args.includes("--method"))).toBe(false);
      } finally {
        executionOwner.shutdown();
        await runtime.stopServer("panel", true);
      }
    }
  );

  it.each(["unavailable", "stopped"] as const)(
    "surfaces %s account admission without creating an execution",
    async (state) => {
      const executionOwner = createEnvironmentExecutionOwner();
      const runtime = createTestCanvasServerRuntime({
        executionOwner,
        deploymentAccount: async () =>
          state === "unavailable" ?
            {
              state,
              message: "The selected account cannot access this repository."
            }
          : { state }
      });
      try {
        const panel = await runtime.getOrCreateServer("panel", "deploy");
        const response = await fetch(`${panel.baseUrl}/api/deploy`, {
          method: "POST",
          headers: {
            Origin: panel.baseUrl,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "X-Radius-Mutation-Nonce": String(panel.state.browserMutationNonce)
          },
          body: JSON.stringify({
            targetRepo: "fixture/app",
            environment: "dev",
            branch: "feature/model"
          })
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error:
            state === "unavailable" ?
              "The selected account cannot access this repository."
            : "GitHub account selection is stopped. Select and authorize an account before deploying."
        });
        expect(runtime.deploymentOwner.resolve()).toEqual({ kind: "missing" });
        expect(
          runtime.deploymentOwner.activeReservation({
            repo: "fixture/app",
            environment: "dev"
          })
        ).toBeUndefined();
      } finally {
        executionOwner.shutdown();
        await runtime.stopServer("panel", true);
      }
    }
  );

  it.each(["close", "shutdown"])(
    "pins actual request-started production reads and execution across %s",
    async (ending) => {
      const executionOwner = createEnvironmentExecutionOwner();
      const branchRead = createDeferred<void>();
      const finishBranch = createDeferred<void>();
      const branch = "feature/model&review=1";
      const run = vi.fn(async (args: string[]) => {
        const [command, path] = args;
        if (command !== "api")
          throw new Error(`Unexpected command: ${JSON.stringify(args)}`);
        if (
          path ===
            "/repos/fixture/app/environments/dev/variables?per_page=100" ||
          path === "/repos/fixture/app/deployments?per_page=100&environment=dev"
        )
          return { code: 0, stdout: "", stderr: "" };
        if (
          path ===
          `/repos/fixture/app/git/ref/heads/${encodeURIComponent(branch)}`
        ) {
          branchRead.resolve();
          await finishBranch.promise;
          return { code: 1, stdout: "", stderr: "HTTP 404" };
        }
        if (path === "/repos/fixture/app")
          return {
            code: 0,
            stdout: JSON.stringify({ default_branch: "trunk" }),
            stderr: ""
          };
        throw new Error(`Unexpected command: ${JSON.stringify(args)}`);
      });
      const executor = successfulSelectedGhExecutor({
        login: "fixture-user",
        run
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
            contextBranch: branch,
            envName: "dev",
            plannedResources: [{ id: "fixture", name: "api" }]
          })
        }
      });
      try {
        const panel = await runtime.getOrCreateServer("panel", "deploy");
        const response = await fetch(`${panel.baseUrl}/api/deploy`, {
          method: "POST",
          headers: {
            Origin: panel.baseUrl,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "X-Radius-Mutation-Nonce": String(panel.state.browserMutationNonce)
          },
          body: JSON.stringify({
            targetRepo: "fixture/app",
            environment: "dev",
            branch
          })
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        await branchRead.promise;
        const resolved = runtime.deploymentOwner.resolve();
        if (resolved.kind !== "resolved") throw new Error(resolved.kind);
        const execution = runtime.deploymentOwner.execution(
          resolved.invocation
        );
        if (!execution) throw new Error("Expected execution");
        expect(execution.executor).toBe(executor);
        expect(execution.state).not.toBe(panel.state);
        expect(
          runtime.deploymentOwner.activeReservation(resolved.invocation.target)
            ?.attemptId
        ).toBe(resolved.invocation.attemptId);
        await runtime.stopServer("panel", true);
        if (ending === "shutdown") executionOwner.shutdown();
        expect(execution.observation.stopped).toBe(ending === "shutdown");
        finishBranch.resolve();
        await expect
          .poll(() =>
            runtime.deploymentOwner.activeReservation(
              resolved.invocation.target
            )
          )
          .toBeUndefined();
        expect(account).toHaveBeenCalledTimes(1);
        expect(panel.state.deployStatus).toBe("in_progress");
        if (ending === "close") {
          expect(execution.state.deployStatus).toBe("failed");
          expect(execution.state.deployErrorKind).toBe("branch-not-pushed");
          const reopened = await runtime.getOrCreateServer(
            "panel",
            "deploying"
          );
          const status = await fetch(`${reopened.baseUrl}/api/deploy-status`);
          expect(await status.json()).toMatchObject({
            status: "failed",
            errorKind: "branch-not-pushed"
          });
          expect(reopened.state.deployAttempt?.id).toBe(
            resolved.invocation.attemptId
          );
          expect(account).toHaveBeenCalledTimes(1);
          expect(run).toHaveBeenCalledTimes(4);
        } else {
          expect(execution.state.deployStatus).toBe("in_progress");
          expect(run).toHaveBeenCalledTimes(3);
        }
      } finally {
        finishBranch.resolve();
        executionOwner.shutdown();
        await Promise.all(
          [...runtime.servers.keys()].map((id) => runtime.stopServer(id, true))
        );
      }
    }
  );

  it("reattaches a reopened panel to the runtime snapshot without replacing execution or its lease", async () => {
    const executionOwner = createEnvironmentExecutionOwner();
    const runtime = createTestCanvasServerRuntime({
      executionOwner,
      serverDependencies: {
        createState: () => ({
          contextRepo: "fixture/app",
          contextBranch: "feature/model",
          envName: "dev"
        })
      }
    });
    const target = {
      repo: "fixture/app",
      environment: "dev",
      branch: "feature/model",
      provider: "azure",
      appFile: ".radius/app.bicep",
      githubLogin: "fixture-user"
    };
    const owner = runtime.deploymentOwner;
    const reservation = owner.reserve(target, "deploy");
    if (!reservation) throw new Error("Expected reservation");
    try {
      const accepted = owner.begin({
        target,
        reservation,
        state: { deployStatus: "in_progress", deployLogs: [] },
        executor: successfulSelectedGhExecutor({
          login: target.githubLogin,
          run: async () => {
            throw new Error("Unexpected GitHub command");
          }
        })
      });
      if (accepted.kind !== "resolved") throw new Error(accepted.kind);
      const execution = owner.execution(accepted.invocation);
      if (!execution) throw new Error("Expected execution");
      const first = await runtime.getOrCreateServer("panel", "deploying");
      expect(first.state.deployAttempt?.id).toBe(accepted.invocation.attemptId);
      const observer = await runtime.getOrCreateServer("observer", "deploying");
      observer.state.plannedEnvironment = "staging";
      const detachedResponse = await fetch(
        `${observer.baseUrl}/api/deploy-notification`
      );
      expect(await detachedResponse.json()).toMatchObject({
        attemptId: "",
        status: "pending"
      });
      expect(observer.state.deployAttempt).toBeUndefined();
      expect(localDeploymentBlocksMutation(observer.state)).toBe(false);
      await runtime.stopServer("panel", true);
      expect(execution.observation.stopped).toBe(false);
      execution.state.deployStatus = "complete";
      owner.appendLog(accepted.invocation, "finished without a panel");
      expect(first.state.deployStatus).toBe("in_progress");
      expect(observer.state.deployStatus).toBeUndefined();
      const reopened = await runtime.getOrCreateServer("panel", "deploying");
      expect(reopened.state.deployLogs).toEqual(["finished without a panel"]);
      const response = await fetch(
        `${reopened.baseUrl}/api/deploy-notification`
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        attemptId: accepted.invocation.attemptId,
        generation: accepted.invocation.generation,
        status: "complete"
      });
      expect(owner.execution(accepted.invocation)).toBe(execution);
      expect(owner.activeReservation(target)).toBe(reservation);
      owner.release(reservation);
      beginDeployAttempt(reopened.state, {
        repo: target.repo,
        environment: target.environment,
        branch: target.branch,
        provider: target.provider,
        appFile: target.appFile,
        repairLoop: false
      });
      const manualId = reopened.state.deployAttempt?.id;
      expect(manualId).not.toBe(accepted.invocation.attemptId);
      for (let poll = 0; poll < 2; poll++) {
        const currentResponse = await fetch(
          `${reopened.baseUrl}/api/deploy-notification`
        );
        expect(await currentResponse.json()).toMatchObject({
          attemptId: manualId,
          status: "in_progress"
        });
        owner.publish(accepted.invocation);
      }
      expect(reopened.state.deployAttempt?.id).toBe(manualId);
    } finally {
      owner.release(reservation);
      executionOwner.shutdown();
      await Promise.all(
        [...runtime.servers.keys()].map((id) => runtime.stopServer(id, true))
      );
    }
  });

  it.each(
    ["deploy", "delete-deployment", "abandon-deployment"].flatMap((route) =>
      ["dev", "staging"].map((environment) => ({ route, environment }))
    )
  )(
    "refuses $route for the requested $environment target rather than the panel's remembered dev target",
    async ({ route, environment }) => {
      const executionOwner = createEnvironmentExecutionOwner();
      const runtime = createTestCanvasServerRuntime({
        executionOwner,
        serverDependencies: {
          createState: () => ({ contextRepo: "fixture/app", envName: "dev" })
        }
      });
      const reservation = runtime.deploymentOwner.reserve(
        { repo: "fixture/app", environment },
        "deploy"
      );
      if (!reservation) throw new Error("Expected reservation");
      const remembered =
        environment !== "dev" ?
          runtime.deploymentOwner.reserve(
            { repo: "fixture/app", environment: "dev" },
            "deploy"
          )
        : undefined;
      try {
        const owned = runtime.deploymentOwner.begin({
          reservation: remembered ?? reservation,
          target: {
            repo: "fixture/app",
            environment: "dev",
            branch: "feature/model",
            provider: "azure",
            appFile: ".radius/app.bicep",
            githubLogin: "fixture-user"
          },
          executor: successfulSelectedGhExecutor({
            login: "fixture-user",
            run: async () => {
              throw new Error("Unexpected GitHub command");
            }
          }),
          state: { deployStatus: "in_progress" }
        });
        if (owned.kind !== "resolved") throw new Error(owned.kind);
        const first = await runtime.getOrCreateServer("first", "deploy");
        const second = await runtime.getOrCreateServer("second", "deploy");
        expect(first.state.deploymentMutation).toBeUndefined();
        expect(second.state.deploymentMutation).toBeUndefined();
        const response = await fetch(`${second.baseUrl}/api/${route}`, {
          method: "POST",
          headers: {
            Origin: second.baseUrl,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "X-Radius-Mutation-Nonce": String(second.state.browserMutationNonce)
          },
          body: JSON.stringify({
            repo: "fixture/app",
            targetRepo: "fixture/app",
            environment,
            application: "app",
            branch: "feature/model"
          })
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: expect.stringContaining(
            `environment ${environment} is already in progress`
          )
        });
        expect(runtime.deploymentOwner.activeReservation(reservation)).toBe(
          reservation
        );
      } finally {
        runtime.deploymentOwner.release(reservation);
        if (remembered) runtime.deploymentOwner.release(remembered);
        executionOwner.shutdown();
        await Promise.all(
          [...runtime.servers.keys()].map((id) => runtime.stopServer(id, true))
        );
      }
    }
  );
});
