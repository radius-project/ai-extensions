import { describe, expect, it, vi } from "vitest";
import {
  discoverDeploymentRun,
  monitorDeploymentRun,
  type DeploymentDiscoveryPorts,
  type DeploymentDiscoveryTarget,
  type DeploymentMonitorPorts,
  type DeploymentRunDetail
} from "./deployment-monitor.js";
import { WorkflowReadInterruptedError } from "./workflow-read-policy.js";

const target = { repo: "acme/app", runId: 42 };
const discovery: DeploymentDiscoveryTarget = {
  repo: target.repo,
  workflowFile: "deploy.yml",
  dispatchedAt: 100,
  baselineRunId: 41
};
const completed: DeploymentRunDetail = {
  status: "completed",
  conclusion: "success",
  steps: []
};

function lifetime() {
  let current = true;
  return {
    isCurrent: () => current,
    stop: () => {
      current = false;
    },
    sleep: vi.fn(async (_milliseconds: number) => {})
  };
}

function observer() {
  return {
    ...lifetime(),
    readRun: vi.fn<DeploymentMonitorPorts["readRun"]>(async () => completed),
    onObservation: vi.fn<DeploymentMonitorPorts["onObservation"]>(() => {}),
    onProgress: vi.fn<DeploymentMonitorPorts["onProgress"]>(async () => {})
  };
}

function discoverer() {
  return {
    ...lifetime(),
    findRun: vi.fn<DeploymentDiscoveryPorts["findRun"]>(async () => 42)
  };
}

describe("deployment run discovery", () => {
  it("captures the dispatch identity and returns the first discovered run", async () => {
    const input = { ...discovery };
    const ports = discoverer();
    ports.findRun.mockImplementationOnce(async (selected) => {
      input.repo = "other/repo";
      input.baselineRunId = 99;
      expect(selected).toEqual(discovery);
      return null;
    });
    expect(await discoverDeploymentRun(input, ports)).toBe(42);
    expect(ports.findRun.mock.calls.map(([value]) => value)).toEqual([
      discovery,
      discovery
    ]);
    expect(ports.sleep).toHaveBeenCalledExactlyOnceWith(5000);
  });

  it("keeps the existing 24-read bound and final discovery wait", async () => {
    const ports = discoverer();
    ports.findRun.mockResolvedValue(null);
    expect(await discoverDeploymentRun(discovery, ports)).toBeNull();
    expect(ports.findRun).toHaveBeenCalledTimes(24);
    expect(ports.sleep).toHaveBeenCalledTimes(24);
    expect(ports.sleep.mock.calls.every(([delay]) => delay === 5000)).toBe(
      true
    );
  });

  it("accepts a run found on the last allowed read without another wait", async () => {
    const ports = discoverer();
    let reads = 0;
    ports.findRun.mockImplementation(async () =>
      ++reads === 24 ? "42" : null
    );
    expect(await discoverDeploymentRun(discovery, ports)).toBe("42");
    expect(ports.sleep).toHaveBeenCalledTimes(23);
  });

  it.each(["before", "read", "wait"] as const)(
    "fences a stopped discovery at %s",
    async (stage) => {
      const ports = discoverer();
      if (stage === "before") ports.stop();
      if (stage === "read")
        ports.findRun.mockImplementation(async () => {
          ports.stop();
          return 42;
        });
      if (stage === "wait") {
        ports.findRun.mockResolvedValue(null);
        ports.sleep.mockImplementation(async () => ports.stop());
      }
      await expect(
        discoverDeploymentRun(discovery, ports)
      ).rejects.toMatchObject({
        reason: "cancelled"
      });
      expect(ports.findRun).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
    }
  );

  it.each(["read", "wait"] as const)(
    "does not mistake a failed discovery %s for confirmed absence",
    async (stage) => {
      const ports = discoverer();
      const error = new Error("Workflow observation unavailable");
      if (stage === "read") ports.findRun.mockRejectedValue(error);
      else {
        ports.findRun.mockResolvedValue(null);
        ports.sleep.mockRejectedValue(error);
      }
      await expect(discoverDeploymentRun(discovery, ports)).rejects.toBe(error);
      expect(ports.findRun).toHaveBeenCalledTimes(1);
    }
  );
});

describe("read-only deployment monitoring", () => {
  it.each([
    "success",
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "neutral",
    "skipped",
    "stale",
    "startup_failure"
  ])(
    "returns confirmed %s evidence without another poll",
    async (conclusion) => {
      const ports = observer();
      const detail = { ...completed, conclusion };
      ports.readRun.mockResolvedValue(detail);
      expect(await monitorDeploymentRun(target, ports)).toEqual({
        kind: "completed",
        detail
      });
      expect(ports.onObservation).toHaveBeenCalledExactlyOnceWith(detail);
      expect(ports.onProgress).toHaveBeenCalledExactlyOnceWith(detail);
      expect(ports.sleep).not.toHaveBeenCalled();
    }
  );

  it("pins repository and run across unavailable, pending, protected and running reads", async () => {
    const input = { ...target };
    const ports = observer();
    const details: (DeploymentRunDetail | null)[] = [
      null,
      { status: "queued", steps: [] },
      { status: "waiting", steps: [] },
      { status: "in_progress", conclusion: "success", steps: [] },
      completed
    ];
    ports.readRun.mockImplementation(async (selected) => {
      expect(selected).toEqual(target);
      input.repo = "other/repo";
      input.runId = 99;
      const detail = details.shift();
      if (detail === undefined) throw new Error("Unexpected read");
      return detail;
    });
    expect(await monitorDeploymentRun(input, ports)).toEqual({
      kind: "completed",
      detail: completed
    });
    expect(ports.sleep).toHaveBeenCalledTimes(4);
    expect(ports.onObservation).toHaveBeenCalledTimes(5);
  });

  it.each(["future_conclusion", " success ", " unknown "])(
    "does not interpret unsupported conclusion %s as a workflow failure",
    async (conclusion) => {
      const ports = observer();
      ports.readRun.mockResolvedValue({ ...completed, conclusion });
      expect(await monitorDeploymentRun(target, ports)).toEqual({
        kind: "unconfirmed",
        reason: "unsupported-conclusion",
        completionObserved: true
      });
      expect(ports.onObservation).toHaveBeenCalledTimes(1);
      expect(ports.onProgress).not.toHaveBeenCalled();
      expect(ports.sleep).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, null, "", " "])(
    "waits for a conclusion when completed evidence contains %s",
    async (conclusion) => {
      const ports = observer();
      ports.readRun.mockResolvedValueOnce({ ...completed, conclusion });
      expect(await monitorDeploymentRun(target, ports)).toEqual({
        kind: "completed",
        detail: completed
      });
      expect(ports.sleep).toHaveBeenCalledExactlyOnceWith(5000);
    }
  );

  it.each([false, true])(
    "bounds polling at 240 reads with completionObserved=%s",
    async (completionObserved) => {
      const ports = observer();
      ports.readRun.mockResolvedValue(null);
      if (completionObserved)
        ports.readRun.mockResolvedValueOnce({
          status: "completed",
          conclusion: null,
          steps: []
        });
      expect(await monitorDeploymentRun(target, ports)).toEqual({
        kind: "unconfirmed",
        reason: "poll-limit",
        completionObserved
      });
      expect(ports.readRun).toHaveBeenCalledTimes(240);
      expect(ports.sleep).toHaveBeenCalledTimes(240);
      expect(ports.sleep.mock.calls.every(([delay]) => delay === 5000)).toBe(
        true
      );
    }
  );

  it("accepts completion at the final poll without a terminal wait", async () => {
    const ports = observer();
    let polls = 0;
    ports.readRun.mockImplementation(async () =>
      ++polls === 240 ? completed : null
    );
    expect(await monitorDeploymentRun(target, ports)).toEqual({
      kind: "completed",
      detail: completed
    });
    expect(ports.sleep).toHaveBeenCalledTimes(239);
  });

  it.each(["before", "read", "observation", "progress", "wait"] as const)(
    "fences a replaced monitor at %s",
    async (stage) => {
      const ports = observer();
      if (stage === "before") ports.stop();
      if (stage === "read")
        ports.readRun.mockImplementation(async () => {
          ports.stop();
          return completed;
        });
      if (stage === "observation")
        ports.onObservation.mockImplementation(() => ports.stop());
      if (stage === "progress")
        ports.onProgress.mockImplementation(async () => ports.stop());
      if (stage === "wait") {
        ports.readRun.mockResolvedValue(null);
        ports.sleep.mockImplementation(async () => ports.stop());
      }
      await expect(monitorDeploymentRun(target, ports)).rejects.toMatchObject({
        reason: "cancelled"
      });
      expect(ports.readRun).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
      expect(ports.onObservation).toHaveBeenCalledTimes(
        stage === "before" || stage === "read" ? 0 : 1
      );
    }
  );

  it.each(["read", "observation", "progress", "wait"] as const)(
    "propagates failed %s without reporting a remote outcome or retrying",
    async (stage) => {
      const ports = observer();
      const error = new WorkflowReadInterruptedError("elapsed");
      if (stage === "read") ports.readRun.mockRejectedValue(error);
      if (stage === "observation")
        ports.onObservation.mockImplementation(() => {
          throw error;
        });
      if (stage === "progress") ports.onProgress.mockRejectedValue(error);
      if (stage === "wait") {
        ports.readRun.mockResolvedValue(null);
        ports.sleep.mockRejectedValue(error);
      }
      await expect(monitorDeploymentRun(target, ports)).rejects.toBe(error);
      expect(ports.readRun).toHaveBeenCalledTimes(1);
    }
  );
});
