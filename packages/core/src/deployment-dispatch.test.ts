import { describe, expect, it, vi } from "vitest";
import {
  coordinateDeploymentDispatch,
  type DeploymentDispatchCommand,
  type DeploymentDispatchPorts
} from "./deployment-dispatch.js";

const TARGET = {
  repo: "fixture/app",
  branch: "feature/selected",
  environment: "dev",
  workflowFile: "deploy.yml"
};
const ACCEPTED: DeploymentDispatchCommand = {
  result: { code: 0, stdout: "", stderr: "" },
  credentialSource: "keyring"
};
const NOT_REGISTERED: DeploymentDispatchCommand = {
  result: { code: 1, stdout: "", stderr: "HTTP 404: workflow not found" },
  credentialSource: "keyring"
};

function fixture() {
  let current = true;
  let time = 1000;
  const ports = {
    isCurrent: () => current,
    latestRunId: vi.fn<DeploymentDispatchPorts["latestRunId"]>(async () => 42),
    dispatch: vi.fn<DeploymentDispatchPorts["dispatch"]>(async () => ACCEPTED),
    sleep: vi.fn(async (milliseconds: number) => {
      time += milliseconds;
    }),
    now: () => time,
    errorMessage: (error: unknown) =>
      error instanceof Error ? error.message : String(error)
  };
  return {
    ports,
    stop: () => {
      current = false;
    }
  };
}

describe("deployment dispatch coordination", () => {
  it.each([null, 42, "9007199254740991"])(
    "pins successful baseline %s and the selected target before dispatch",
    async (baseline) => {
      const { ports } = fixture();
      const target = { ...TARGET };
      ports.latestRunId.mockImplementation(async () => {
        target.branch = "changed";
        return baseline;
      });
      const outcome = await coordinateDeploymentDispatch(target, false, ports);
      expect(outcome).toEqual({
        kind: "accepted",
        reference: { ...TARGET, baselineRunId: baseline, dispatchedAt: 1000 },
        command: ACCEPTED
      });
      expect(ports.dispatch).toHaveBeenCalledTimes(1);
      expect(ports.sleep).not.toHaveBeenCalled();
    }
  );

  it.each([
    0,
    -1,
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "9007199254740993",
    "",
    "0",
    " 2",
    "2.5"
  ])("refuses malformed baseline %s before dispatch", async (baseline) => {
    const { ports } = fixture();
    ports.latestRunId.mockResolvedValue(baseline);
    expect(await coordinateDeploymentDispatch(TARGET, false, ports)).toEqual({
      kind: "refused",
      reason: "baseline-unavailable",
      message: "The workflow run baseline is malformed."
    });
    expect(ports.dispatch).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "refuses an unavailable baseline without a time-window fallback (after rejection: %s)",
    async (afterRejection) => {
      const { ports } = fixture();
      if (afterRejection) ports.latestRunId.mockResolvedValueOnce(42);
      ports.latestRunId.mockRejectedValue(new Error("run list unavailable"));
      ports.dispatch.mockResolvedValue(NOT_REGISTERED);
      expect(
        await coordinateDeploymentDispatch(TARGET, afterRejection, ports)
      ).toEqual({
        kind: "refused",
        reason: "baseline-unavailable",
        message: "run list unavailable"
      });
      expect(ports.dispatch).toHaveBeenCalledTimes(afterRejection ? 1 : 0);
    }
  );

  it.each([false, true])(
    "bounds registration retries and refreshes discovery evidence (exhausted: %s)",
    async (exhausted) => {
      const { ports } = fixture();
      let latest = 41;
      ports.latestRunId.mockImplementation(async () => ++latest);
      ports.dispatch.mockResolvedValueOnce(NOT_REGISTERED);
      ports.dispatch.mockResolvedValueOnce(NOT_REGISTERED);
      ports.dispatch.mockResolvedValueOnce(
        exhausted ? NOT_REGISTERED : ACCEPTED
      );
      const outcome = await coordinateDeploymentDispatch(TARGET, true, ports);
      expect(outcome).toMatchObject({
        kind: exhausted ? "refused" : "accepted",
        reference: { ...TARGET, baselineRunId: 44, dispatchedAt: 11000 }
      });
      expect(ports.sleep.mock.calls).toEqual([[3000], [2000], [5000]]);
      expect(ports.latestRunId).toHaveBeenCalledTimes(3);
      expect(ports.dispatch).toHaveBeenCalledTimes(3);
    }
  );

  it.each([
    { code: 1, stderr: "HTTP 403: forbidden", kind: "refused" },
    { code: 1, stderr: "HTTP 408: request timeout", kind: "uncertain" },
    { code: 1, stderr: "HTTP 499: request closed", kind: "uncertain" },
    { code: 1, stderr: "missing workflow scope", kind: "refused" },
    { code: "ENOENT", stderr: "command unavailable", kind: "refused" },
    { code: 1, stderr: "host not found", kind: "uncertain" },
    { code: 1, stderr: "could not resolve host", kind: "uncertain" },
    { code: 1, stderr: "could not resolve to a Repository", kind: "uncertain" },
    { code: 1, stderr: "No ref found for: feature", kind: "refused" },
    { code: 1, stderr: "no commit found for the ref feature", kind: "refused" },
    {
      code: 1,
      stderr: "could not resolve to a Commit with the SHA of feature",
      kind: "refused"
    },
    { code: 1, stderr: "", kind: "uncertain" },
    { code: 1, stderr: "connection reset", kind: "uncertain" }
  ])(
    "does not retry $stderr and reports $kind evidence",
    async ({ code, stderr, kind }) => {
      const { ports } = fixture();
      ports.dispatch.mockResolvedValue({
        result: { code, stderr, stdout: "" },
        credentialSource: "injected"
      });
      expect(
        await coordinateDeploymentDispatch(TARGET, true, ports)
      ).toMatchObject({
        kind,
        reference: { ...TARGET, baselineRunId: 42, dispatchedAt: 4000 },
        command: { credentialSource: "injected" }
      });
      expect(ports.dispatch).toHaveBeenCalledTimes(1);
      expect(ports.sleep.mock.calls).toEqual([[3000]]);
    }
  );

  it("does not retry an existing workflow's 404", async () => {
    const { ports } = fixture();
    ports.dispatch.mockResolvedValue(NOT_REGISTERED);
    expect(
      await coordinateDeploymentDispatch(TARGET, false, ports)
    ).toMatchObject({
      kind: "refused"
    });
    expect(ports.dispatch).toHaveBeenCalledTimes(1);
    expect(ports.sleep).not.toHaveBeenCalled();
  });

  it.each([0, 1])(
    "treats a timed-out command with code %s as uncertain even with a rejection diagnostic",
    async (code) => {
      const { ports } = fixture();
      ports.dispatch.mockResolvedValue({
        result: {
          code,
          stdout: "",
          stderr: "HTTP 404: not found",
          timedOut: true
        },
        credentialSource: "keyring"
      });
      expect(
        await coordinateDeploymentDispatch(TARGET, true, ports)
      ).toMatchObject({
        kind: "uncertain",
        reference: { ...TARGET, baselineRunId: 42, dispatchedAt: 4000 }
      });
      expect(ports.dispatch).toHaveBeenCalledTimes(1);
    }
  );

  it("retains uncertainty when the dispatch port throws rather than returning evidence", async () => {
    const { ports } = fixture();
    ports.dispatch.mockRejectedValue(new Error("transport closed"));
    expect(await coordinateDeploymentDispatch(TARGET, true, ports)).toEqual({
      kind: "uncertain",
      reason: "dispatch",
      reference: { ...TARGET, baselineRunId: 42, dispatchedAt: 4000 },
      message: "transport closed"
    });
    expect(ports.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "before",
    "wait",
    "baseline",
    "failed-baseline",
    "dispatch"
  ] as const)("fences replacement or shutdown during %s", async (phase) => {
    const { ports, stop } = fixture();
    if (phase === "before") stop();
    if (phase === "wait") ports.sleep.mockImplementation(async () => stop());
    if (phase === "baseline" || phase === "failed-baseline") {
      ports.latestRunId.mockImplementation(async () => {
        stop();
        if (phase === "failed-baseline") throw new Error("stopped");
        return 42;
      });
    }
    if (phase === "dispatch") {
      ports.dispatch.mockImplementation(async () => {
        stop();
        return ACCEPTED;
      });
    }
    const outcome = await coordinateDeploymentDispatch(TARGET, true, ports);
    expect(outcome).toMatchObject({
      kind: phase === "dispatch" ? "uncertain" : "refused",
      ...(phase === "dispatch" ? {} : { reason: "cancelled" })
    });
    expect(ports.dispatch).toHaveBeenCalledTimes(phase === "dispatch" ? 1 : 0);
  });

  it("propagates a clock failure before dispatch", async () => {
    const { ports } = fixture();
    ports.sleep.mockRejectedValue(new Error("clock unavailable"));
    await expect(
      coordinateDeploymentDispatch(TARGET, true, ports)
    ).rejects.toThrow("clock unavailable");
    expect(ports.latestRunId).not.toHaveBeenCalled();
    expect(ports.dispatch).not.toHaveBeenCalled();
  });
});
