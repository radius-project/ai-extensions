import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import type { SelectedGhExecutor } from "../../../src/gh.js";
import { BARE_GH_COMMAND_PRESENTATION } from "../../../src/gh-command-display.js";
import { createProductionDeploymentExecutionOwner } from "../../../src/runtime/production-deployment-execution-owner.js";
import {
  createProductionDeploymentMonitor,
  type ProductionDeploymentMonitorPorts
} from "../../../src/runtime/production-deployment-monitor.js";
import { createDeploymentPresentation } from "../../../src/server/services/deployment-presentation.js";
import type { CanvasState } from "../../../src/shared.js";
import { createDeferred } from "../../support/browser/fakes.js";
import { createDeploymentPipelineRunner } from "../../support/runtime/deployment.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";

afterEach(() => vi.useRealTimers());

function fixture(
  conclusion: "success" | "failure" | "uncertain" = "success",
  recovery?: {
    state: CanvasState;
    run: SelectedGhExecutor["run"];
    buildGraph: ProductionDeploymentMonitorPorts["buildGraph"];
  },
  preparationFailure?: "generation" | "synchronization"
) {
  const pipeline = createDeploymentPipelineRunner(conclusion);
  const detailStarted = createDeferred<void>();
  const detailGate = createDeferred<void>();
  let dispatched = false;
  let synchronizing = false;
  const run = vi.fn<SelectedGhExecutor["run"]>(async (args, options) => {
    if (args[0] === "api" && args[1] === "/repos/fixture/app")
      synchronizing = true;
    if (
      preparationFailure === "generation" &&
      args[0] === "api" &&
      args[1].includes(
        "/radius-project/ai-extensions/contents/.github/extension/run-rad-commands.yml"
      )
    )
      return { code: 1, stdout: "", stderr: "HTTP 503: template unavailable" };
    if (
      preparationFailure === "synchronization" &&
      synchronizing &&
      args[0] === "api" &&
      args[1].startsWith("/repos/fixture/app/contents/.github/workflows/") &&
      args[1].endsWith("?ref=feature%2Fmodel")
    )
      return { code: 1, stdout: "", stderr: "HTTP 404: branch disappeared" };
    if (
      preparationFailure === "synchronization" &&
      synchronizing &&
      args[0] === "api" &&
      args[1] === "/repos/fixture/app/git/ref/heads/feature%2Fmodel"
    )
      return { code: 1, stdout: "", stderr: "HTTP 404: branch disappeared" };
    if (recovery && args[0] === "api" && /\/contents\/apps\//.test(args[1]))
      return recovery.run(args, options);
    if (args[0] === "workflow") dispatched = true;
    if (args[0] === "run" && args[1] === "list")
      return {
        code: 0,
        stdout: JSON.stringify(
          (dispatched ? [99, 42, 41] : [41]).map((databaseId) => ({
            databaseId,
            createdAt: new Date().toISOString()
          }))
        ),
        stderr: ""
      };
    if (args[1] === "repos/fixture/app/actions/runs/42") {
      detailStarted.resolve();
      await detailGate.promise;
    }
    return pipeline.run(args, options);
  });
  const executor = successfulSelectedGhExecutor({
    login: "fixture-user",
    run
  });
  const release = vi.fn();
  const owner = createProductionDeploymentExecutionOwner();
  const presentation = createDeploymentPresentation(owner);
  const target = {
    repo: "fixture/app",
    environment: "dev",
    branch: "feature/model",
    provider: "aws",
    appFile: "apps/custom.bicep",
    githubLogin: executor.login
  };
  const reservation = owner.reserve(target, "deploy");
  if (!reservation) throw new Error("Missing deployment reservation.");
  const begun = owner.begin({
    reservation,
    target,
    executor,
    state: {
      deployStatus: "in_progress",
      envName: target.environment,
      appFile: target.appFile,
      plannedRepo: target.repo,
      plannedBranch: target.branch,
      plannedEnvironment: target.environment,
      plannedProvider: target.provider,
      deployingResources: [{ id: "app", name: "app", type: "application" }],
      deployParams: { appFile: target.appFile },
      deployLogs: [],
      ...recovery?.state
    }
  });
  if (begun.kind !== "resolved") throw new Error(begun.kind);
  const execution = owner.execution(begun.invocation);
  if (!execution) throw new Error("Missing owned execution.");
  if (!recovery)
    execution.state.deployingResources = [
      { id: "app", name: "app", type: "application" }
    ];
  const log = (message: string) => owner.appendLog(begun.invocation, message);
  const monitor = createProductionDeploymentMonitor(execution, {
    owner,
    ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION,
    runAz: async () => {
      throw new Error("Unexpected Azure command.");
    },
    invalidateDeployListCache: vi.fn(),
    reportWorkflowProgress: log,
    buildGraph: recovery?.buildGraph
  });
  const settled = vi.fn(() => {
    owner.publish(begun.invocation);
    owner.release(reservation);
    release();
  });
  const work = vi.fn(() =>
    monitor.run({
      entry: execution,
      repo: execution.invocation.target.repo,
      branch: execution.invocation.target.branch,
      provider: execution.invocation.target.provider,
      requestedEnvironment: execution.invocation.target.environment,
      resources: [{ id: "app", name: "app", type: "application" }],
      log,
      isCurrent: () => owner.execution(begun.invocation) === execution
    })
  );
  return {
    pipeline,
    run,
    executor,
    release,
    owner,
    presentation,
    target,
    reservation,
    execution,
    detailStarted,
    detailGate,
    work,
    settled,
    start: () => owner.run(begun.invocation, work, settled),
    dispose: () => {
      detailGate.resolve();
      presentation.dispose();
      owner.shutdown();
      owner.release(reservation);
    }
  };
}

describe("production deployment owner and monitor composition", () => {
  it.each(["generation", "synchronization"] as const)(
    "publishes required workflow %s refusal without starting dispatch or observation",
    async (failure) => {
      const f = fixture("success", undefined, failure);
      const panel: CanvasState = {};
      try {
        f.presentation.attach("observer", panel, f.execution.invocation);
        f.detailGate.resolve();
        await f.start();
        expect(f.execution.state).toMatchObject({
          deployStatus: "failed",
          deployErrorKind: "dispatch-refused",
          deployDispatchEvidence: "refused"
        });
        expect(panel).toMatchObject({
          deployStatus: "failed",
          deployErrorKind: "dispatch-refused",
          deployDispatchEvidence: "refused"
        });
        expect(f.execution.state.deployRunId).toBeUndefined();
        expect(f.execution.state.deployDispatchReference).toBeUndefined();
        const commands = f.run.mock.calls.map(([args]) => args);
        expect(
          commands.filter(
            (args) =>
              args[0] === "workflow" ||
              args[0] === "run" ||
              args[1]?.includes("/actions/runs/")
          )
        ).toEqual([]);
        if (failure === "generation") {
          expect(panel.deployError).toContain("template unavailable");
          expect(commands.filter((args) => args.includes("PUT"))).toEqual([]);
        } else {
          expect(panel.deployError).toContain(
            ".github/workflows/run-rad-commands.yml on feature/model"
          );
          expect(
            commands.filter(
              (args) =>
                args[1] === "/repos/fixture/app/git/ref/heads/feature%2Fmodel"
            )
          ).toHaveLength(2);
          const writes = f.run.mock.calls
            .filter(([args]) => args.includes("PUT"))
            .map(([args, options]) => ({
              path: args[3],
              branch: JSON.parse(options?.stdin ?? "{}").branch
            }));
          expect(writes).toEqual([
            {
              path: "/repos/fixture/app/contents/.github/workflows/run-rad-commands.yml",
              branch: "trunk"
            },
            {
              path: "/repos/fixture/app/contents/.github/workflows/run-rad-commands-azure.yml",
              branch: "trunk"
            }
          ]);
        }
        expect(f.execution.invocation.generation).toBe(1);
        expect(f.work).toHaveBeenCalledOnce();
        expect(f.settled).toHaveBeenCalledOnce();
        expect(f.release).toHaveBeenCalledOnce();
        expect(f.owner.activeReservation(f.target)).toBeUndefined();
        expect(f.pipeline.unexpected).toEqual([]);
      } finally {
        f.dispose();
      }
    }
  );

  it("ignores a matching workspace and later panel retargeting throughout committed graph, secret, dispatch and observation", async () => {
    vi.useFakeTimers();
    const workspace = fs.mkdtempSync(join(tmpdir(), "deployment-selection-"));
    fs.mkdirSync(join(workspace, "apps"));
    fs.writeFileSync(
      join(workspace, "apps", "custom.bicep"),
      "wrong workspace model"
    );
    const state: CanvasState = {
      envName: "staging",
      appFile: "old.bicep",
      deployParams: { environment: "staging", appFile: "old.bicep" },
      workspaceRepo: "fixture/app",
      workspaceBranch: "feature/model",
      workspacePath: workspace,
      deployingResources: [{ id: "wrong", name: "wrong" }]
    };
    const model =
      "@secure()\nparam password string\nparam environment string\nresource app 'Radius.Core/applications@2025-08-01' = { name: 'committed' }";
    const compile = vi.fn<
      NonNullable<ProductionDeploymentMonitorPorts["buildGraph"]>
    >(async (content, file, options) => {
      expect(content).toBe(model);
      expect(file).toBe("apps/custom.bicep");
      expect(options?.cleanupRadArtifactsDir).toBe(true);
      const dir = options?.radArtifactsDir;
      if (!dir) throw new Error("Missing staged artifacts");
      try {
        expect(fs.readFileSync(join(dir, "custom-types.tgz"), "utf8")).toBe(
          "fixture bytes"
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return [
        {
          id: "committed",
          name: "committed",
          type: "Radius.Core/applications"
        }
      ];
    });
    const reads = vi.fn<SelectedGhExecutor["run"]>(async (args) => {
      const content =
        args[1].endsWith("/custom.bicep?ref=feature%2Fmodel") ? model
        : args[1].endsWith("/bicepconfig.json?ref=feature%2Fmodel") ?
          JSON.stringify({ extensions: { custom: "./custom-types.tgz" } })
        : args[1].endsWith("/custom-types.tgz?ref=feature%2Fmodel") ?
          "fixture bytes"
        : undefined;
      if (content === undefined)
        throw new Error("Wrong committed selection: " + args.join(" "));
      return {
        code: 0,
        stdout: JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from(content).toString("base64")
        }),
        stderr: ""
      };
    });
    const f = fixture("success", { state, run: reads, buildGraph: compile });
    try {
      state.envName = "retargeted";
      state.contextRepo = "fixture/other";
      f.detailGate.resolve();
      const task = f.start();
      await vi.runAllTimersAsync();
      await task;
      expect(compile).toHaveBeenCalledOnce();
      expect(f.execution.state.deployStatus).toBe("complete");
      expect(f.execution.state.deployEnvName).toBe("dev");
      expect(f.execution.executor.login).toBe("fixture-user");
      expect(f.release).toHaveBeenCalledOnce();
      expect(
        fs.readFileSync(join(workspace, "apps", "custom.bicep"), "utf8")
      ).toBe("wrong workspace model");
      const commands = f.run.mock.calls.map(([args]) => args);
      expect(commands.find((args) => args[0] === "secret")).toEqual([
        "secret",
        "set",
        "RADIUS_DEPLOY_PARAMS",
        "--env",
        "dev",
        "--repo",
        "fixture/app"
      ]);
      expect(
        commands.find((args) => args[0] === "workflow")?.join(" ")
      ).toContain("apps/custom.bicep");
      expect(
        commands
          .filter((args) => args[1]?.includes("artifacts?"))
          .map((args) => args[1])
      ).toEqual([
        "/repos/fixture/app/actions/runs/42/artifacts?per_page=100",
        "/repos/fixture/app/actions/runs/42/artifacts?per_page=100"
      ]);
      expect(commands.some((args) => args.join(" ").includes("staging"))).toBe(
        false
      );
      expect(state.deployParams?.appFile).toBe("old.bicep");
    } finally {
      f.dispose();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["config", "shutdown"],
    ["config", "replacement"],
    ["artifact", "shutdown"],
    ["artifact", "replacement"]
  ] as const)(
    "retains the lease and fences the %s read across %s",
    async (stage, retirement) => {
      const started = createDeferred<void>();
      const resume = createDeferred<void>();
      const created = vi.spyOn(fs, "mkdtempSync");
      const removed = vi.spyOn(fs, "rmSync");
      syncBuiltinESMExports();
      const compile = vi.fn(async () => []);
      const reads = vi.fn<SelectedGhExecutor["run"]>(async (args) => {
        const artifact = args[1].includes("custom-types.tgz");
        const config = args[1].includes("bicepconfig.json");
        if (
          (stage === "config" && config) ||
          (stage === "artifact" && artifact)
        ) {
          started.resolve();
          await resume.promise;
        }
        const content =
          artifact ? "fixture bytes"
          : config ?
            JSON.stringify({ extensions: { custom: "./custom-types.tgz" } })
          : "model";
        return {
          code: 0,
          stdout: JSON.stringify({
            type: "file",
            encoding: "base64",
            content: Buffer.from(content).toString("base64")
          }),
          stderr: ""
        };
      });
      const f = fixture("success", {
        state: {},
        run: reads,
        buildGraph: compile
      });
      const task = f.start();
      const rejected = expect(task).rejects.toMatchObject({
        reason: "cancelled"
      });
      try {
        await started.promise;
        expect(f.release).not.toHaveBeenCalled();
        if (stage === "artifact") {
          expect(created).toHaveBeenCalledOnce();
          expect(fs.existsSync(created.mock.results[0].value)).toBe(true);
        }
        let replacement;
        if (retirement === "shutdown") {
          f.owner.shutdown();
          expect(f.owner.activeReservation(f.target)).toBe(f.reservation);
        } else {
          f.owner.release(f.reservation);
          replacement = f.owner.reserve(f.target, "deploy");
          if (!replacement) throw new Error("Missing replacement");
          f.owner.begin({
            reservation: replacement,
            target: f.target,
            executor: f.executor,
            state: { deployLogs: ["replacement"] }
          });
        }
        resume.resolve();
        await rejected;
        expect(compile).not.toHaveBeenCalled();
        expect(f.release).toHaveBeenCalledOnce();
        expect(f.run).toHaveBeenCalledTimes(stage === "config" ? 2 : 3);
        expect(f.execution.state.deployingResources).toEqual([]);
        if (stage === "artifact") {
          const dir = created.mock.results[0].value;
          expect(removed).toHaveBeenCalledExactlyOnceWith(dir, {
            recursive: true,
            force: true
          });
          expect(fs.existsSync(dir)).toBe(false);
        } else expect(created).not.toHaveBeenCalled();
        if (replacement) {
          expect(f.owner.activeReservation(f.target)).toBe(replacement);
          const next = f.owner.resolve(f.target);
          if (next.kind !== "resolved") throw new Error(next.kind);
          expect(f.owner.snapshot(next.invocation)?.deployLogs).toEqual([
            "replacement"
          ]);
          f.owner.release(replacement);
        }
      } finally {
        resume.resolve();
        f.dispose();
        vi.restoreAllMocks();
        syncBuiltinESMExports();
      }
    }
  );

  it("shares one selected-account attempt across detached observers and selects the first exact-workflow run above the baseline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first: CanvasState = {};
    const second: CanvasState = {};
    try {
      f.presentation.attach("first", first, f.execution.invocation);
      f.presentation.attach("second", second, f.execution.invocation);
      const completed = f.start();
      expect(f.start()).toBe(completed);
      await vi.waitFor(() => expect(f.execution.state.deployRunId).toBe(42), {
        timeout: 10000
      });
      await f.detailStarted.promise;
      expect(f.work).toHaveBeenCalledOnce();
      expect(f.owner.activeReservation(f.target)).toBe(f.reservation);
      expect(f.owner.reserve(f.target, "delete")).toBeUndefined();
      expect(f.release).not.toHaveBeenCalled();
      expect(f.execution.executor).toBe(f.executor);
      expect(f.execution.state.deployRunId).toBe(42);
      expect(first.deployRunId).toBe(42);
      expect(second.deployRunId).toBe(42);
      expect(f.execution.invocation.target).toEqual(f.target);
      expect(Object.isFrozen(f.execution.invocation.target)).toBe(true);
      f.target.repo = "fixture/retargeted";
      f.target.environment = "other";
      expect(f.execution.invocation.target.repo).toBe("fixture/app");
      expect(f.execution.invocation.target.environment).toBe("dev");
      f.presentation.detach("first");
      f.presentation.detach("second");
      expect(f.execution.observation.stopped).toBe(false);
      f.detailGate.resolve();
      await vi.runAllTimersAsync();
      await completed;
      expect(f.execution.state).toMatchObject({
        deployStatus: "complete",
        deployDispatchEvidence: "accepted",
        deployRunId: 42
      });
      expect(f.execution.state.deployLogs?.join("\n")).toContain(
        "Deployed graph not available"
      );
      expect(first.deployStatus).toBe("in_progress");
      const reopened: CanvasState = {
        contextRepo: "fixture/app",
        contextBranch: "feature/model",
        envName: "dev"
      };
      f.presentation.synchronize("reopened", reopened);
      expect(reopened.deployStatus).toBe("complete");
      expect(reopened.deployDispatchReference).toEqual(
        f.execution.state.deployDispatchReference
      );
      expect(f.settled).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
      expect(
        f.owner.activeReservation(f.execution.invocation.target)
      ).toBeUndefined();
      const lists = f.run.mock.calls
        .map(([args]) => args)
        .filter((args) => args[0] === "run" && args[1] === "list");
      expect(lists).toEqual([
        expect.arrayContaining(["--repo", "fixture/app", "--limit", "20"]),
        expect.arrayContaining([
          "--repo",
          "fixture/app",
          "--workflow=run-rad-commands.yml"
        ])
      ]);
      expect(lists[0].some((arg) => arg.startsWith("--workflow"))).toBe(false);
      expect(
        f.run.mock.calls.filter(([args]) => args[0] === "workflow")
      ).toHaveLength(1);
      expect(f.pipeline.unexpected).toEqual([]);
    } finally {
      f.dispose();
    }
  });

  it.each(["failure", "uncertain"] as const)(
    "retains %s evidence without dispatching again or running repair",
    async (conclusion) => {
      vi.useFakeTimers();
      const f = fixture(conclusion);
      try {
        f.detailGate.resolve();
        const completed = f.start();
        await vi.runAllTimersAsync();
        await completed;
        expect(f.execution.state.deployStatus).toBe("failed");
        if (conclusion === "uncertain") {
          expect(f.execution.state.deployErrorKind).toBe("run-unconfirmed");
          expect(f.execution.state.deployDispatchEvidence).toBe("uncertain");
          expect(f.execution.state.deployRunId).toBeUndefined();
        } else {
          expect(f.execution.state.deployRunId).toBe(42);
          expect(f.execution.state.deployError).toContain("deployment failed");
        }
        expect(
          f.run.mock.calls.filter(([args]) => args[0] === "workflow")
        ).toHaveLength(1);
        expect(f.pipeline.unexpected).toEqual([]);
        expect(f.release).toHaveBeenCalledOnce();
        expect(f.owner.activeReservation(f.target)).toBeUndefined();
      } finally {
        f.dispose();
      }
    }
  );

  it("fences a held read from a replaced generation without releasing the replacement reservation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const completed = f.start();
      const rejected = expect(completed).rejects.toMatchObject({
        reason: "cancelled"
      });
      await vi.waitFor(() => expect(f.execution.state.deployRunId).toBe(42), {
        timeout: 10000
      });
      await f.detailStarted.promise;
      f.owner.release(f.reservation);
      const replacement = f.owner.reserve(f.target, "deploy");
      if (!replacement) throw new Error("Missing replacement reservation.");
      const next = f.owner.begin({
        reservation: replacement,
        target: f.target,
        previous: f.execution.invocation,
        repair: true,
        executor: successfulSelectedGhExecutor({
          login: f.executor.login,
          run: async () => {
            throw new Error("Replacement must not execute.");
          }
        }),
        state: { deployStatus: "in_progress", deployLogs: ["replacement"] }
      });
      if (next.kind !== "resolved") throw new Error(next.kind);
      const callsBeforeReplacement = f.run.mock.calls.length;
      f.detailGate.resolve();
      await rejected;
      expect(f.run).toHaveBeenCalledTimes(callsBeforeReplacement);
      expect(f.execution.observation.stopped).toBe(true);
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.owner.activeReservation(f.target)).toBe(replacement);
      expect(f.owner.snapshot(next.invocation)).toMatchObject({
        deployStatus: "in_progress",
        deployLogs: ["replacement"],
        deployGeneration: next.invocation.generation
      });
      expect(next.invocation.generation).toBeGreaterThan(
        f.execution.invocation.generation
      );
      expect(f.owner.execution(f.execution.invocation)).toBeUndefined();
      f.owner.release(replacement);
    } finally {
      f.dispose();
    }
  });

  it("stops observation at shutdown but retains the lease until the held read settles", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const completed = f.start();
      const rejected = expect(completed).rejects.toMatchObject({
        reason: "cancelled"
      });
      await vi.waitFor(() => expect(f.execution.state.deployRunId).toBe(42), {
        timeout: 10000
      });
      await f.detailStarted.promise;
      const callsBeforeShutdown = f.run.mock.calls.length;
      f.owner.shutdown();
      expect(f.execution.observation.stopped).toBe(true);
      expect(f.owner.resolve()).toEqual({ kind: "shutdown" });
      expect(f.owner.activeReservation(f.target)).toBe(f.reservation);
      expect(f.release).not.toHaveBeenCalled();
      f.detailGate.resolve();
      await rejected;
      expect(f.run).toHaveBeenCalledTimes(callsBeforeShutdown);
      expect(f.execution.state.deployStatus).toBe("in_progress");
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.settled).toHaveBeenCalledOnce();
      expect(f.owner.activeReservation(f.target)).toBeUndefined();
    } finally {
      f.dispose();
    }
  });
});
