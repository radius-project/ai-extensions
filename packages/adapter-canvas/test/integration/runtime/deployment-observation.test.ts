import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectedGhExecutor } from "../../../src/gh.js";
import { BARE_GH_COMMAND_PRESENTATION } from "../../../src/gh-command-display.js";
import { createProductionDeploymentExecutionOwner } from "../../../src/runtime/production-deployment-execution-owner.js";
import { createProductionDeploymentMonitor } from "../../../src/runtime/production-deployment-monitor.js";
import { createDeploymentPresentation } from "../../../src/server/services/deployment-presentation.js";
import type { CanvasState } from "../../../src/shared.js";
import { createDeferred } from "../../support/browser/fakes.js";
import { createDeploymentPipelineRunner } from "../../support/runtime/deployment.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";

afterEach(() => vi.useRealTimers());

function fixture(conclusion: "success" | "failure" | "uncertain" = "success") {
  const pipeline = createDeploymentPipelineRunner(conclusion);
  const detailStarted = createDeferred<void>();
  const detailGate = createDeferred<void>();
  let dispatched = false;
  const run = vi.fn<SelectedGhExecutor["run"]>(async (args, options) => {
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
      deployParams: { appFile: target.appFile },
      deployLogs: []
    }
  });
  if (begun.kind !== "resolved") throw new Error(begun.kind);
  const execution = owner.execution(begun.invocation);
  if (!execution) throw new Error("Missing owned execution.");
  const log = (message: string) => owner.appendLog(begun.invocation, message);
  const monitor = createProductionDeploymentMonitor(execution, {
    owner,
    ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION,
    runAz: async () => {
      throw new Error("Unexpected Azure command.");
    },
    invalidateDeployListCache: vi.fn(),
    reportWorkflowProgress: log
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
