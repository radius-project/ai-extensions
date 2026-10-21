import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectDeploymentOutcome,
  type DeploymentOutcomePorts
} from "./deployment-outcome.js";
import {
  createWorkflowReadContext,
  createWorkflowReadCooldowns,
  WorkflowReadInterruptedError,
  type WorkflowReadClock,
  type WorkflowReadDecision
} from "./workflow-read-policy.js";
import type { DeploymentRunDetail } from "./deployment-monitor.js";
import { redactCredentials } from "./credential-redaction.js";

const target = { repo: "acme/app", runId: 42 };
const run: DeploymentRunDetail = {
  status: "completed",
  conclusion: "success",
  steps: []
};
const failureContext = { provider: "azure", resourcesTouched: true };
type Graph = readonly { name: string }[];

afterEach(() => vi.useRealTimers());

function fixture() {
  let current = true;
  const ports = {
    isCurrent: () => current,
    readGraph: vi.fn<DeploymentOutcomePorts<Graph>["readGraph"]>(async () => ({
      graph: [{ name: "api" }],
      status: "ok"
    })),
    projectGraph: vi.fn<DeploymentOutcomePorts<Graph>["projectGraph"]>(() => [
      { name: "api" }
    ]),
    readDecision: vi.fn<DeploymentOutcomePorts<Graph>["readDecision"]>(
      () => undefined
    ),
    onGraph: vi.fn<DeploymentOutcomePorts<Graph>["onGraph"]>(async () => {}),
    readLog: vi.fn<DeploymentOutcomePorts<Graph>["readLog"]>(async () => null),
    readControlPlaneLog: vi.fn(async () => null),
    redactDiagnostic: redactCredentials,
    sleep: vi.fn(async (_milliseconds: number) => {})
  };
  return {
    ports,
    stop: () => {
      current = false;
    },
    collect: (detail: DeploymentRunDetail = run) =>
      collectDeploymentOutcome(target, detail, failureContext, ports)
  };
}

function budget(timeout = 15000) {
  vi.useFakeTimers();
  const start = Date.now();
  let stopped = false;
  const sleep = vi.fn<WorkflowReadClock["sleep"]>(
    (ms, cancellation) =>
      new Promise<void>((resolve) => {
        let detach = () => {};
        const finish = () => {
          clearTimeout(timer);
          detach();
          resolve();
        };
        const timer = setTimeout(finish, ms);
        detach = cancellation?.onStop?.(finish) ?? (() => {});
        if (cancellation?.stopped?.()) finish();
      })
  );
  const clock: WorkflowReadClock = {
    monotonic: () => Date.now() - start,
    wall: () => Date.now(),
    jitter: () => 0,
    sleep
  };
  const context = createWorkflowReadContext({
    clock,
    cooldowns: createWorkflowReadCooldowns(clock.monotonic),
    timeout,
    stopped: () => stopped
  });
  return {
    context,
    sleep,
    advance: (ms: number) => {
      vi.advanceTimersByTime(ms);
    },
    stop: () => {
      stopped = true;
    }
  };
}

describe("deployment terminal evidence", () => {
  it("returns confirmed success and a projected graph without failure diagnostics", async () => {
    const f = fixture();
    const outcome = await f.collect();
    expect(outcome).toEqual({
      kind: "success",
      conclusion: "success",
      graph: { deployed: [{ name: "api" }], graphStatus: "ok" }
    });
    expect(f.ports.onGraph).toHaveBeenCalledExactlyOnceWith(outcome.graph);
    expect(f.ports.readLog).not.toHaveBeenCalled();
    expect(f.ports.readControlPlaneLog).not.toHaveBeenCalled();
  });

  it.each(["auth", "malformed"])(
    "retains success without retrying a graph with status %s",
    async (status) => {
      const f = fixture();
      f.ports.readGraph.mockResolvedValue({ graph: null, status });
      expect(await f.collect()).toMatchObject({
        kind: "success",
        graph: { deployed: null, graphStatus: status }
      });
      expect(f.ports.readGraph).toHaveBeenCalledTimes(1);
      expect(f.ports.sleep).not.toHaveBeenCalled();
    }
  );

  it("retries absent graph evidence exactly twice and preserves success", async () => {
    const f = fixture();
    f.ports.readGraph.mockResolvedValue({ graph: null, status: "missing" });
    expect(await f.collect()).toMatchObject({
      kind: "success",
      graph: { deployed: null, graphStatus: "missing" }
    });
    expect(f.ports.readGraph).toHaveBeenCalledTimes(3);
    expect(f.ports.sleep.mock.calls).toEqual([[5000], [5000]]);
  });

  it("accepts a graph finalized on the last permitted read", async () => {
    const f = fixture();
    f.ports.readGraph
      .mockResolvedValueOnce({ graph: null, status: "missing" })
      .mockResolvedValueOnce({ graph: null, status: "missing" });
    expect(await f.collect()).toMatchObject({
      kind: "success",
      graph: { deployed: [{ name: "api" }], graphStatus: "ok" }
    });
    expect(f.ports.readGraph).toHaveBeenCalledTimes(3);
  });

  it("does not retain rejected producer data or projection errors", async () => {
    const f = fixture();
    f.ports.projectGraph.mockImplementation(() => {
      throw new Error("unsafe producer data");
    });
    const result = await f.collect();
    expect(result).toEqual({
      kind: "success",
      conclusion: "success",
      graph: { deployed: null, graphStatus: "malformed" }
    });
    expect(f.ports.readGraph).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    { state: "ready" },
    { state: "deferred", reason: "not-before", notBefore: 10000 },
    { state: "exhausted", reason: "attempts" }
  ] satisfies (WorkflowReadDecision | undefined)[])(
    "retains success with safe unavailable graph metadata %j",
    async (decision) => {
      const f = fixture();
      const error = new Error("raw artifact diagnostics");
      f.ports.readGraph.mockResolvedValue({
        graph: null,
        status: "error",
        error
      });
      f.ports.readDecision.mockReturnValue(decision);
      const result = await f.collect();
      expect(result.kind).toBe("success");
      expect(result.graph).toEqual({
        deployed: null,
        graphStatus: "unavailable",
        ...(decision && decision.state !== "ready" ?
          { note: `Artifact evidence ${decision.state}: ${decision.reason}.` }
        : {})
      });
      expect(f.ports.readDecision).toHaveBeenCalledExactlyOnceWith(error);
      expect(JSON.stringify(result)).not.toContain("raw artifact diagnostics");
    }
  );

  it.each([
    new Error("read failed"),
    new WorkflowReadInterruptedError("elapsed")
  ])("retains success when graph reading throws %s", async (error) => {
    const f = fixture();
    f.ports.readGraph.mockRejectedValue(error);
    expect(await f.collect()).toMatchObject({
      kind: "success",
      graph: { deployed: null, graphStatus: "unavailable" }
    });
    expect(f.ports.readGraph).toHaveBeenCalledTimes(1);
  });

  it("does not collect or present evidence for an unconfirmed workflow", async () => {
    const f = fixture();
    await expect(f.collect({ ...run, conclusion: "unknown" })).rejects.toThrow(
      "The workflow outcome could not be confirmed."
    );
    expect(f.ports.readGraph).not.toHaveBeenCalled();
    expect(f.ports.onGraph).not.toHaveBeenCalled();
  });

  it.each([
    "before",
    "graph",
    "projection",
    "presentation",
    "diagnostics"
  ] as const)("fences ownership retirement at %s", async (stage) => {
    const f = fixture();
    if (stage === "before") f.stop();
    if (stage === "graph")
      f.ports.readGraph.mockImplementation(async () => {
        f.stop();
        return { graph: null, status: "missing" };
      });
    if (stage === "projection")
      f.ports.projectGraph.mockImplementation(() => {
        f.stop();
        return [{ name: "api" }];
      });
    if (stage === "presentation")
      f.ports.onGraph.mockImplementation(async () => f.stop());
    if (stage === "diagnostics")
      f.ports.readLog.mockImplementation(async () => {
        f.stop();
        return null;
      });
    await expect(
      f.collect({ ...run, conclusion: "failure" })
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(f.ports.readControlPlaneLog).not.toHaveBeenCalled();
    expect(f.ports.readLog).toHaveBeenCalledTimes(
      stage === "diagnostics" ? 1 : 0
    );
  });

  it("propagates explicit graph cancellation instead of presenting unavailable evidence", async () => {
    const f = fixture();
    f.ports.readGraph.mockRejectedValue(
      new WorkflowReadInterruptedError("cancelled")
    );
    await expect(f.collect()).rejects.toMatchObject({ reason: "cancelled" });
    expect(f.ports.onGraph).not.toHaveBeenCalled();
  });

  it("fences a late graph failure after retirement", async () => {
    const f = fixture();
    f.ports.readGraph.mockImplementation(async () => {
      f.stop();
      throw new Error("late read failure");
    });
    await expect(f.collect()).rejects.toMatchObject({ reason: "cancelled" });
    expect(f.ports.onGraph).not.toHaveBeenCalled();
  });

  it("fences the retry wait before issuing another graph read", async () => {
    const f = fixture();
    f.ports.readGraph.mockResolvedValue({ graph: null, status: "missing" });
    f.ports.sleep.mockImplementation(async () => f.stop());
    await expect(f.collect()).rejects.toMatchObject({ reason: "cancelled" });
    expect(f.ports.readGraph).toHaveBeenCalledTimes(1);
  });

  it("propagates presentation failure rather than fabricating a workflow failure", async () => {
    const f = fixture();
    f.ports.onGraph.mockRejectedValue(new Error("presentation failed"));
    await expect(f.collect()).rejects.toThrow("presentation failed");
    expect(f.ports.readLog).not.toHaveBeenCalled();
  });

  it("captures terminal identity and failure policy before graph reads", async () => {
    const f = fixture();
    const selected = { ...target };
    const detail: DeploymentRunDetail = {
      status: "completed",
      conclusion: "failure",
      steps: [{ name: "Build", conclusion: "failure" }],
      jobs: [
        { name: "build", steps: [{ name: "Build", conclusion: "failure" }] },
        { name: "pending" }
      ]
    };
    const context = { ...failureContext };
    f.ports.readGraph.mockImplementation(async () => {
      selected.repo = "wrong/repo";
      selected.runId = 99;
      detail.conclusion = "success";
      detail.steps[0].name = "Changed";
      if (detail.jobs?.[0].steps) detail.jobs[0].steps[0].name = "Changed";
      context.provider = "aws";
      return { graph: null, status: "auth" };
    });
    const result = await collectDeploymentOutcome(
      selected,
      detail,
      context,
      f.ports
    );
    expect(result.kind).toBe("failure");
    if (result.kind !== "failure") throw new Error("Expected failure evidence");
    expect(result.failure.message).toContain("Failed step: Build.");
    expect(result.failure.message).toContain(
      "https://github.com/acme/app/actions/runs/42"
    );
    expect(result.failure.message).not.toContain("Changed");
    expect(f.ports.readLog.mock.calls).toEqual([
      [target.repo, target.runId],
      [target.repo, target.runId],
      [target.repo, target.runId]
    ]);
    expect(f.ports.sleep.mock.calls).toEqual([[1000], [2000]]);
  });
});

describe("terminal observation budgets", () => {
  it("uses the shared budget for graph finalization, never an unowned timer", async () => {
    const f = fixture();
    const b = budget();
    f.ports.readGraph.mockResolvedValueOnce({ graph: null, status: "missing" });
    const pending = collectDeploymentOutcome(target, run, failureContext, {
      ...f.ports,
      context: b.context
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({
      kind: "success",
      graph: { deployed: [{ name: "api" }], graphStatus: "ok" }
    });
    expect(f.ports.sleep).not.toHaveBeenCalled();
    expect(b.sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 15000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([4999, 5000])(
    "does not start a graph wait with %s ms remaining",
    async (timeout) => {
      const f = fixture();
      const b = budget(timeout);
      f.ports.readGraph.mockResolvedValue({ graph: null, status: "missing" });
      expect(
        await collectDeploymentOutcome(target, run, failureContext, {
          ...f.ports,
          context: b.context
        })
      ).toMatchObject({ kind: "success" });
      expect(f.ports.readGraph).toHaveBeenCalledTimes(1);
      expect(b.sleep).not.toHaveBeenCalled();
    }
  );

  it("keeps success when a delayed graph wait exceeds the deadline", async () => {
    const f = fixture();
    const b = budget(10000);
    f.ports.readGraph.mockResolvedValue({ graph: null, status: "missing" });
    b.sleep.mockImplementation(async () => b.advance(10000));
    expect(
      await collectDeploymentOutcome(target, run, failureContext, {
        ...f.ports,
        context: b.context
      })
    ).toMatchObject({
      kind: "success",
      graph: {
        graphStatus: "unavailable",
        note: "Artifact evidence exhausted: elapsed."
      }
    });
    expect(f.ports.readGraph).toHaveBeenCalledTimes(1);
  });

  it.each(["cancelled", "unexpected"] as const)(
    "propagates %s graph waits without another read",
    async (reason) => {
      const f = fixture();
      const b = budget();
      const error =
        reason === "cancelled" ?
          new WorkflowReadInterruptedError("cancelled")
        : new Error("clock failed");
      f.ports.readGraph.mockResolvedValue({ graph: null, status: "missing" });
      b.sleep.mockRejectedValue(error);
      await expect(
        collectDeploymentOutcome(target, run, failureContext, {
          ...f.ports,
          context: b.context
        })
      ).rejects.toBe(error);
      expect(f.ports.readGraph).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects a stopped observation even when invocation identity is current", async () => {
    const f = fixture();
    const b = budget();
    b.stop();
    await expect(
      collectDeploymentOutcome(target, run, failureContext, {
        ...f.ports,
        context: b.context
      })
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(f.ports.readGraph).not.toHaveBeenCalled();
  });

  it.each([1000, 10000])(
    "bounds failure diagnostic retry waits with %s ms remaining",
    async (timeout) => {
      const f = fixture();
      const b = budget(timeout);
      const pending = collectDeploymentOutcome(
        target,
        { ...run, conclusion: "failure" },
        failureContext,
        { ...f.ports, context: b.context }
      );
      await vi.advanceTimersByTimeAsync(3000);
      const result = await pending;
      expect(result.kind).toBe("failure");
      expect(b.sleep.mock.calls.map(([ms]) => ms)).toEqual(
        timeout === 1000 ? [] : [1000, 10000, 2000, 9000]
      );
      expect(f.ports.readLog).toHaveBeenCalledTimes(timeout === 1000 ? 1 : 3);
      expect(f.ports.sleep).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
