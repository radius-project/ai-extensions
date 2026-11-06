import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeploymentRuntime,
  type DeploymentRuntime,
  type DeploymentRuntimePorts
} from "./runtime-deployment.js";
import { createWorkflowObservationScope } from "./workflow-observation-scope.js";
import type { DeployMonitorRequest } from "./deployment-monitor.js";

const target = {
  repo: "fixture/app",
  branch: "topic",
  environment: "dev",
  provider: "azure",
  appFile: ".radius/app.bicep"
};
const runtimes: DeploymentRuntime[] = [];
const releaseHeld: (() => void)[] = [];

function held() {
  let resolve: () => void = () => {
    throw new Error("uninitialized");
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releaseHeld.push(resolve);
  return { promise, resolve };
}

function fixture(
  overrides: Partial<DeploymentRuntimePorts> = {},
  monitor?: (request: DeployMonitorRequest) => Promise<void>
) {
  let id = 0;
  const run = vi.fn(
    monitor ??
      (async (request: DeployMonitorRequest) => {
        request.entry.state.deployStatus = "complete";
      })
  );
  const resolveDeployment = vi.fn(async () => null);
  const sendRepair = vi.fn(async () => {});
  const sendNotice = vi.fn(async () => {});
  const reportError = vi.fn();
  const createExecution = vi.fn(() => ({
    monitor: { run },
    observation: createWorkflowObservationScope(() => {
      throw new Error("No artifact reads expected");
    })
  }));
  const runtime = createDeploymentRuntime({
    now: () => 0,
    id: () => String(++id),
    reportError,
    awsEnabled: false,
    resolveDefaultBranch: async () => "release",
    normalizeAppFile: (path) => path,
    resolveDeployment,
    statusBlocksMutation: (status) => status === "deploying",
    createExecution,
    delivery: {
      sendRepair,
      sendNotice,
      redactDiagnostic: (value) => value,
      reportDiagnostic: vi.fn()
    },
    ...overrides
  });
  runtimes.push(runtime);
  return {
    runtime,
    run,
    resolveDeployment,
    sendRepair,
    sendNotice,
    reportError,
    createExecution
  };
}

afterEach(async () => {
  for (const release of releaseHeld.splice(0)) release();
  vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) await runtime.owner.shutdown(100);
});

describe("panel-independent deployment runtime", () => {
  it("refuses incomplete production bindings during construction", () => {
    expect(() => fixture({ awsEnabled: undefined })).toThrow(
      "requires awsEnabled"
    );
    expect(() => fixture({ createExecution: undefined })).toThrow(
      "createExecution"
    );
  });

  it("refuses missing targets, unavailable repairs and ambiguous repeats before external reads", async () => {
    const { runtime, resolveDeployment } = fixture();
    expect(await runtime.start({})).toMatchObject({ ok: false, status: 400 });
    expect(await runtime.start({ attemptId: "foreign" })).toMatchObject({
      ok: false,
      status: 409
    });
    expect(resolveDeployment).not.toHaveBeenCalled();
    await runtime.start(target);
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    await runtime.start({ ...target, environment: "other" });
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(await runtime.start({})).toMatchObject({ ok: false, status: 400 });
    expect(resolveDeployment).toHaveBeenCalledTimes(2);
    expect((await runtime.start(target)).ok).toBe(true);
  });

  it("resolves a missing branch from GitHub when no workspace or prior target supplies it", async () => {
    const { runtime } = fixture();
    const result = await runtime.start({ ...target, branch: "" });
    if (!result.ok) throw new Error(result.error);
    expect(result.invocation.target.branch).toBe("release");
  });

  it("does not continue branch discovery after shutdown during a remote lookup", async () => {
    const gate = held();
    const entered = held();
    const resolveDefaultBranch = vi.fn(async () => "main");
    const { runtime } = fixture({
      resolveDefaultBranch,
      resolveDeployment: async () => {
        entered.resolve();
        await gate.promise;
        return null;
      }
    });
    const start = runtime.start({ ...target, branch: "" });
    await entered.promise;
    const stopping = runtime.owner.shutdown(100);
    gate.resolve();
    expect(await start).toMatchObject({ ok: false, status: 409 });
    await stopping;
    expect(resolveDefaultBranch).not.toHaveBeenCalled();
  });

  it("rejects a late branch lookup after shutdown", async () => {
    const gate = held();
    const entered = held();
    const { runtime, run } = fixture({
      resolveDefaultBranch: async () => {
        entered.resolve();
        await gate.promise;
        return "late";
      }
    });
    const start = runtime.start({ ...target, branch: "" });
    await entered.promise;
    const stopping = runtime.owner.shutdown(100);
    gate.resolve();
    expect(await start).toMatchObject({ ok: false, status: 409 });
    await stopping;
    expect(run).not.toHaveBeenCalled();
  });

  it("accounts for bounded repair delivery retries and stops them at shutdown", async () => {
    vi.useFakeTimers();
    const sendRepair = vi.fn(async () => {
      throw new Error("delivery unavailable");
    });
    const { runtime } = fixture(
      {
        delivery: {
          sendRepair,
          redactDiagnostic: (value) => value,
          reportDiagnostic: vi.fn()
        }
      },
      async ({ entry }) => {
        entry.state.deployStatus = "failed";
      }
    );
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendRepair).toHaveBeenCalledTimes(1);
    expect(runtime.owner.hasActiveWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sendRepair).toHaveBeenCalledTimes(2);
    const stopped = await runtime.owner.shutdown(100);
    expect(stopped.complete).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(sendRepair).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks a monitor that returns without an outcome as unconfirmed", async () => {
    const { runtime, sendNotice } = fixture({}, async () => {});
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(result.invocation.state.deployError).toContain("without confirming");
    expect(sendNotice).toHaveBeenCalledOnce();
  });

  it("publishes pending, retryable and delivered repair state to attached views", async () => {
    vi.useFakeTimers();
    const finishMonitor = held();
    const finishDelivery = held();
    let attempts = 0;
    const sendRepair = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("delivery unavailable");
      await finishDelivery.promise;
    });
    const { runtime } = fixture(
      {
        delivery: {
          sendRepair,
          redactDiagnostic: (value) => value,
          reportDiagnostic: vi.fn()
        }
      },
      async ({ entry }) => {
        await finishMonitor.promise;
        entry.state.deployStatus = "failed";
        entry.state.deployError = "model validation failed";
      }
    );
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    const changes: {
      handoff: string | undefined;
      repairing: boolean | undefined;
    }[] = [];
    const detach = runtime.owner.subscribe(result.invocation, ({ state }) => {
      changes.push({
        handoff: state.deployHandoffState,
        repairing: state.deployRepairing
      });
    });
    try {
      finishMonitor.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(changes).toContainEqual({ handoff: "pending", repairing: false });
      expect(changes.at(-1)).toEqual({
        handoff: "retryable",
        repairing: false
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(sendRepair).toHaveBeenCalledTimes(2);
      expect(changes.at(-1)).toEqual({ handoff: "pending", repairing: false });
      finishDelivery.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(changes.at(-1)).toEqual({ handoff: "delivered", repairing: true });
      expect(runtime.owner.hasActiveWork()).toBe(false);
    } finally {
      detach();
    }
  });

  it("surfaces execution construction failures without leaving the target active", async () => {
    const { runtime } = fixture({
      createExecution: () => {
        throw new Error("execution unavailable");
      }
    });
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(result.invocation.state.deployError).toContain(
      "execution unavailable"
    );
    expect(runtime.owner.reserve(target, "delete")).not.toBeNull();
  });

  it("admits without any panel and returns observation-only identity", async () => {
    const { runtime, run, resolveDeployment } = fixture();
    const result = await runtime.start(target);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.invocation.target).toEqual(target);
    expect(
      runtime.owner.lookup({ observationId: result.invocation.observationId })
    ).toMatchObject({ kind: "found" });
    expect(
      runtime.owner.lookup({ attemptId: result.invocation.observationId })
    ).toEqual({ kind: "missing" });
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.invocation.state.deployStatus).toBe("complete");
    expect(resolveDeployment).toHaveBeenCalledWith("fixture/app", "dev", "app");
  });

  it("captures trusted workspace context before asynchronous admission", async () => {
    const { runtime, createExecution } = fixture();
    const workspace = {
      repo: "fixture/app",
      branch: "topic",
      workspacePath: "fixture-workspace"
    };
    const pending = runtime.start({ environment: "dev" }, { workspace });
    workspace.branch = "changed";
    const result = await pending;
    if (!result.ok) throw new Error(result.error);
    expect(result.invocation.target.branch).toBe("topic");
    expect(createExecution).toHaveBeenCalledWith(result.invocation, {
      repo: "fixture/app",
      branch: "topic",
      workspacePath: "fixture-workspace"
    });
  });

  it("detaches a view without stopping the monitor or unlocking its target", async () => {
    const gate = held();
    const { runtime } = fixture({}, async ({ entry }) => {
      await gate.promise;
      entry.state.deployStatus = "complete";
    });
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    const detach = runtime.owner.subscribe(result.invocation, vi.fn());
    detach();
    expect(runtime.owner.retire(result.invocation)).toBe(false);
    expect(runtime.owner.reserve(target, "delete")).toBeNull();
    expect(await runtime.start(target)).toMatchObject({
      ok: false,
      status: 409
    });
    const independent = await runtime.start({
      ...target,
      environment: "other"
    });
    expect(independent.ok).toBe(true);
    gate.resolve();
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(result.invocation.state.deployStatus).toBe("complete");
  });

  it.each(["empty", "failed"] as const)(
    "never guesses main when branch lookup is %s",
    async (mode) => {
      const { runtime, run } = fixture({
        resolveDefaultBranch: async () => {
          if (mode === "failed") throw new Error("unavailable");
          return " ";
        }
      });
      const result = await runtime.start({ ...target, branch: "" });
      expect(result).toMatchObject({ ok: false, status: 503 });
      expect(run).not.toHaveBeenCalled();
      expect(runtime.owner.lookup()).toEqual({ kind: "missing" });
      expect(runtime.owner.reserve(target, "delete")).not.toBeNull();
    }
  );

  it("blocks admission on an unavailable or active remote deployment", async () => {
    const lookup = vi
      .fn<DeploymentRuntimePorts["resolveDeployment"]>()
      .mockRejectedValueOnce(new Error("GitHub unavailable"))
      .mockResolvedValueOnce({ status: "deploying" });
    const { runtime, run } = fixture({ resolveDeployment: lookup });
    expect(await runtime.start(target)).toMatchObject({
      ok: false,
      status: 503
    });
    expect(await runtime.start(target)).toMatchObject({
      ok: false,
      status: 409
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps admission alive and refuses late lookup after shutdown", async () => {
    const gate = held();
    const entered = held();
    const { runtime, run } = fixture({
      resolveDeployment: async () => {
        entered.resolve();
        await gate.promise;
        return null;
      }
    });
    const start = runtime.start(target);
    await entered.promise;
    expect(runtime.owner.hasActiveWork()).toBe(true);
    const stop = runtime.owner.shutdown(100);
    gate.resolve();
    expect(await start).toMatchObject({ ok: false, status: 409 });
    expect(await stop).toEqual({ complete: true, pending: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports monitor crashes as unconfirmed notices, never model repair", async () => {
    const { runtime, sendRepair, sendNotice, reportError } = fixture(
      {},
      async () => {
        throw new Error("monitor unavailable");
      }
    );
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(result.invocation.state).toMatchObject({
      deployStatus: "failed",
      deployErrorKind: "run-unconfirmed"
    });
    expect(reportError).toHaveBeenCalledOnce();
    expect(result.invocation.state.deployLogs).toEqual([
      "\u274c Deploy monitor stopped unexpectedly: monitor unavailable"
    ]);
    expect(sendNotice).toHaveBeenCalledOnce();
    expect(sendRepair).not.toHaveBeenCalled();
    expect(
      await runtime.start({ attemptId: result.invocation.attemptId })
    ).toMatchObject({ ok: false, status: 409 });
  });

  it.each(["target lookup", "branch lookup", "monitor"] as const)(
    "redacts non-Error rejections from %s",
    async (boundary) => {
      const rejected = () => Promise.reject("fixture-private");
      const redactDiagnostic = (value: string) =>
        value.replaceAll("fixture-private", "[redacted]");
      const { runtime } = fixture(
        {
          ...(boundary === "target lookup" ?
            { resolveDeployment: rejected }
          : {}),
          ...(boundary === "branch lookup" ?
            { resolveDefaultBranch: rejected }
          : {}),
          delivery: { redactDiagnostic, reportDiagnostic: vi.fn() }
        },
        boundary === "monitor" ? rejected : undefined
      );
      const result = await runtime.start({ ...target, branch: "" });
      if (boundary === "monitor") {
        if (!result.ok) throw new Error(result.error);
        await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
        expect(result.invocation.state.deployError).toContain("[redacted]");
        expect(result.invocation.state.deployError).not.toContain(
          "fixture-private"
        );
        expect(result.invocation.state.deployErrorKind).toBe("run-unconfirmed");
      } else {
        expect(result).toMatchObject({
          ok: false,
          status: 503,
          error: expect.stringContaining("[redacted]")
        });
        expect(JSON.stringify(result)).not.toContain("fixture-private");
      }
    }
  );

  it("stops publishing late monitor progress and repair after shutdown", async () => {
    const entered = held();
    const gate = held();
    const { runtime, sendRepair, sendNotice } = fixture(
      {},
      async ({ entry, log }) => {
        log("before shutdown");
        entered.resolve();
        await gate.promise;
        log("late progress");
        entry.state.deployStatus = "failed";
        entry.state.deployError = "model failure after shutdown";
      }
    );
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    await entered.promise;
    const stopping = runtime.owner.shutdown(100);
    gate.resolve();
    expect(await stopping).toEqual({ complete: true, pending: [] });
    expect(result.invocation.state.deployLogs).toEqual(["before shutdown"]);
    expect(sendRepair).not.toHaveBeenCalled();
    expect(sendNotice).not.toHaveBeenCalled();
  });

  it("repairs a confirmed failure with a new observation and the existing loop budget", async () => {
    const { runtime, sendRepair } = fixture({}, async ({ entry }) => {
      entry.state.deployStatus = "failed";
      entry.state.deployError = "model validation failed";
    });
    const first = await runtime.start(target);
    if (!first.ok) throw new Error(first.error);
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(sendRepair).toHaveBeenCalledOnce();
    const second = await runtime.start({
      attemptId: first.invocation.attemptId
    });
    if (!second.ok) throw new Error(second.error);
    expect(second.repairAttempt).toBe(1);
    expect(second.repairAttemptCap).toBe(5);
    expect(second.invocation.generation).toBe(2);
    expect(second.invocation.observationId).not.toBe(
      first.invocation.observationId
    );
    expect(
      runtime.owner.lookup({ observationId: first.invocation.observationId })
    ).toEqual({ kind: "missing" });
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(sendRepair).toHaveBeenCalledOnce();
  });

  it("preserves optional display resources and bounded logs without sharing the view's arrays", async () => {
    const { runtime } = fixture({}, async ({ entry, log }) => {
      for (let index = 0; index < 4002; index++) log(`line ${index}`);
      entry.state.deployStatus = "complete";
    });
    const resources = [{ name: "db", outputResources: [{ name: "storage" }] }];
    const result = await runtime.start(target, { resources });
    if (!result.ok) throw new Error(result.error);
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(resources).toEqual([
      { name: "db", outputResources: [{ name: "storage" }] }
    ]);
    expect(result.invocation.state.deployingResources).toEqual([
      {
        name: "db",
        deployStatus: "pending",
        outputResources: [{ name: "storage", deployStatus: "pending" }]
      }
    ]);
    expect(result.invocation.state.deployLogBase).toBe(2);
    expect(result.invocation.state.deployLogs).toHaveLength(4000);
  });
});
