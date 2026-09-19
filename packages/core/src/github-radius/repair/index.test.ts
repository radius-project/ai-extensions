import { describe, expect, it, vi } from "vitest";
import {
  beginDeploymentAttempt,
  deploymentHandoffStatus,
  reportUnconfirmedDeployment,
  requestDeploymentRepair,
  resolveDeploymentRepair,
  DEPLOYMENT_HANDOFF_MAX_ATTEMPTS,
  DEPLOYMENT_HANDOFF_RETRY_DELAY_MS
} from "./index.js";
import type {
  DeploymentInteractionPorts,
  DeploymentRepairState
} from "./index.js";

function failedState(): DeploymentRepairState {
  return {
    deployStatus: "failed",
    deployAttempt: { id: "attempt-1" },
    deployingBranch: "feature",
    deployError: "Deployment failed",
    deployRunUrl: "https://example.test/run/1"
  };
}

function interactionPorts() {
  const scheduled: Array<() => void> = [];
  const deliver = vi.fn<DeploymentInteractionPorts["deliver"]>();
  const reportError = vi.fn<DeploymentInteractionPorts["reportError"]>();
  const scheduleRetry = vi.fn((callback: () => void, _delay: number) => {
    scheduled.push(callback);
  });
  return { deliver, reportError, scheduleRetry, scheduled };
}

describe("deployment repair admission", () => {
  it.each([undefined, null, "", 42])(
    "allows an unbound deployment: %s",
    (id) => {
      expect(resolveDeploymentRepair({}, id, 3)).toEqual({
        repairLoop: false,
        attemptId: "",
        repairAttempt: 0
      });
    }
  );

  it("refuses stale attempts without mutating the current attempt", () => {
    const state = failedState();
    expect(resolveDeploymentRepair(state, "old", 3).error).toContain(
      "no longer the current attempt"
    );
    expect(state).toEqual(failedState());
    expect(resolveDeploymentRepair({}, "old", 3).repairLoop).toBe(false);
  });

  it.each(["in_progress", "success", undefined])(
    "refuses a repair of a non-failed deployment: %s",
    (status) => {
      const state = { ...failedState(), deployStatus: status };
      const result = resolveDeploymentRepair(state, "attempt-1", 3);
      expect(result.repairLoop).toBe(false);
      expect(result.error).toContain(
        status === "in_progress" ? "still running" : "not in a failed state"
      );
    }
  );

  it.each(["https://example.test/run/1", ""])(
    "never repairs an uncertain execution, run link: %s",
    (url) => {
      const state = {
        ...failedState(),
        deployErrorKind: "run-unconfirmed",
        deployRunUrl: url
      };
      const result = resolveDeploymentRepair(state, "attempt-1", 3);
      expect(result.repairLoop).toBe(false);
      expect(result.error).toContain("a run may still be in flight");
      expect(result.error).toContain(url || "Actions tab");
    }
  );

  it.each([
    [undefined, 1, true],
    [2, 3, true],
    [3, 0, false]
  ] as const)(
    "enforces the repair budget after %s attempts",
    (attempts, expected, allowed) => {
      const state = { ...failedState(), deployRepairAttempts: attempts };
      const result = resolveDeploymentRepair(state, "attempt-1", 3);
      expect(result.repairLoop).toBe(allowed);
      expect(result.repairAttempt).toBe(expected);
      if (!allowed) expect(result.error).toContain("already used its 3");
    }
  );
});

describe("deployment attempt transitions", () => {
  const input = {
    repo: "example/app",
    branch: "feature",
    environment: "test",
    provider: "azure",
    appFile: ".radius/app.bicep",
    repairLoop: false
  };

  it("synchronously replaces stale evidence and starts a fresh identity", () => {
    const state: DeploymentRepairState = {
      ...failedState(),
      deployGeneration: 3,
      deployRepairAttempts: 2,
      deployHandoffAttempts: 2,
      deployNoticeAttempts: 2,
      deployedGraph: [{ id: "old" }],
      deployedGraphRepo: "example/old"
    };
    const createId = vi.fn(() => "attempt-2");
    beginDeploymentAttempt(state, input, createId);
    expect(createId).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      deployStatus: "in_progress",
      deployGeneration: 4,
      deployError: null,
      deployErrorKind: null,
      deployRunUrl: null,
      deployedGraph: null,
      deployRepairing: false,
      deployHandoffState: "idle",
      deployHandoffAttempts: 0,
      deployNoticeState: "idle",
      deployNoticeAttempts: 0,
      deployRepairAttempts: 0,
      deployAttempt: { id: "attempt-2", targetRepo: input.repo }
    });
    expect(state.deployedGraphRepo).toBeUndefined();
  });

  it.each([undefined, 1])(
    "preserves repair identity and delivery budget: %s",
    (attempts) => {
      const state = {
        ...failedState(),
        deployHandoffAttempts: attempts,
        deployRepairAttempts: attempts
      };
      const createId = vi.fn(() => "unexpected");
      beginDeploymentAttempt(
        state,
        { ...input, repairLoop: true, attemptId: "attempt-1" },
        createId
      );
      expect(createId).not.toHaveBeenCalled();
      expect(state).toMatchObject({
        deployGeneration: 1,
        deployRepairing: true,
        deployHandoffState: "delivered",
        deployHandoffAttempts: attempts || 0,
        deployRepairAttempts: (attempts || 0) + 1,
        deployAttempt: { id: "attempt-1" }
      });
    }
  );
});

describe.each([
  {
    name: "repair",
    invoke: requestDeploymentRepair,
    stateKey: "deployHandoffState",
    attemptsKey: "deployHandoffAttempts",
    errorKind: undefined
  },
  {
    name: "notice",
    invoke: reportUnconfirmedDeployment,
    stateKey: "deployNoticeState",
    attemptsKey: "deployNoticeAttempts",
    errorKind: "run-unconfirmed"
  }
] as const)(
  "$name delivery",
  ({ name, invoke, stateKey, attemptsKey, errorKind }) => {
    function state(): DeploymentRepairState {
      return { ...failedState(), deployErrorKind: errorKind };
    }

    it("delivers once and records ownership only for repairs", async () => {
      const current = state();
      const ports = interactionPorts();
      expect(invoke(current, "example/app", ports)).toBe(true);
      expect(invoke(current, "example/app", ports)).toBe(false);
      expect(current[stateKey]).toBe("pending");
      await Promise.resolve();
      expect(current[stateKey]).toBe("delivered");
      expect(Boolean(current.deployRepairing)).toBe(name === "repair");
      expect(invoke(current, "example/app", ports)).toBe(false);
      expect(ports.deliver).toHaveBeenCalledExactlyOnceWith({
        repo: "example/app",
        branch: "feature",
        error: "Deployment failed",
        deployRunUrl: "https://example.test/run/1",
        attemptId: "attempt-1"
      });
    });

    it("supports an attempt-less context without inventing target information", async () => {
      const current: DeploymentRepairState = {
        deployStatus: "failed",
        deployErrorKind: errorKind
      };
      const ports = interactionPorts();
      invoke(current, "", ports);
      await Promise.resolve();
      expect(current[stateKey]).toBe("delivered");
      expect(ports.deliver).toHaveBeenCalledWith({
        repo: "",
        branch: "",
        error: "",
        deployRunUrl: "",
        attemptId: ""
      });
    });

    it.each(["pending", "failed"])(
      "does not repeat %s delivery",
      (deliveryState) => {
        const current = { ...state(), [stateKey]: deliveryState };
        const ports = interactionPorts();
        expect(invoke(current, "example/app", ports)).toBe(false);
        expect(ports.deliver).not.toHaveBeenCalled();
      }
    );

    it("retries rejected delivery within a bounded budget", async () => {
      const current = state();
      const ports = interactionPorts();
      const error = new Error("Delivery unavailable");
      ports.deliver.mockRejectedValue(error);
      invoke(current, "example/app", ports);
      for (
        let attempt = 1;
        attempt <= DEPLOYMENT_HANDOFF_MAX_ATTEMPTS;
        attempt++
      ) {
        await Promise.resolve();
        expect(current[attemptsKey]).toBe(attempt);
        expect(current[stateKey]).toBe(
          attempt === DEPLOYMENT_HANDOFF_MAX_ATTEMPTS ? "failed" : "retryable"
        );
        ports.scheduled.shift()?.();
      }
      expect(ports.reportError).toHaveBeenCalledTimes(3);
      expect(ports.scheduleRetry).toHaveBeenCalledTimes(2);
      expect(ports.scheduleRetry).toHaveBeenCalledWith(
        expect.any(Function),
        DEPLOYMENT_HANDOFF_RETRY_DELAY_MS
      );
      expect(ports.scheduled).toHaveLength(0);
    });

    it("surfaces synchronous delivery failures and schedules retry", () => {
      const current = state();
      const ports = interactionPorts();
      const error = new Error("Rejected");
      ports.deliver.mockImplementation(() => {
        throw error;
      });
      expect(invoke(current, "example/app", ports)).toBe(false);
      expect(current[stateKey]).toBe("retryable");
      expect(ports.reportError).toHaveBeenCalledWith(error);
    });

    it.each([false, true])(
      "ignores stale asynchronous settlement, rejected: %s",
      async (reject) => {
        const current = state();
        const ports = interactionPorts();
        let settle: () => void = () => {
          throw new Error("Delivery has not started.");
        };
        const delivery = new Promise<void>((resolve, rejectDelivery) => {
          settle =
            reject ? () => rejectDelivery(new Error("Old failure")) : resolve;
        });
        ports.deliver.mockReturnValue(delivery);
        invoke(current, "example/app", ports);
        current.deployAttempt = { id: "new-attempt" };
        current[stateKey] = "idle";
        settle();
        await Promise.resolve();
        expect(current[stateKey]).toBe("idle");
        expect(ports.scheduleRetry).not.toHaveBeenCalled();
      }
    );

    it("revokes a retry when the attempt is replaced during backoff", async () => {
      const current = state();
      const ports = interactionPorts();
      ports.deliver.mockRejectedValue(new Error("Unavailable"));
      invoke(current, "example/app", ports);
      await Promise.resolve();
      current.deployAttempt = { id: "new-attempt" };
      ports.scheduled.shift()?.();
      expect(ports.deliver).toHaveBeenCalledOnce();
    });

    it("never starts an interaction for a running deployment", () => {
      const current = { ...state(), deployStatus: "in_progress" };
      const ports = interactionPorts();
      expect(invoke(current, "example/app", ports)).toBe(false);
      expect(ports.deliver).not.toHaveBeenCalled();
    });
  }
);

describe("repair and notice policies", () => {
  it.each([
    "branch-not-pushed",
    "oidc-subject-missing",
    "oidc-subject-case-mismatch",
    "cloud-auth-drift",
    "run-unconfirmed"
  ])("excludes non-model failure %s from repair", (kind) => {
    const state = { ...failedState(), deployErrorKind: kind };
    expect(
      requestDeploymentRepair(state, "example/app", interactionPorts())
    ).toBe(false);
  });

  it("does not issue an uncertainty notice for a confirmed failure", () => {
    expect(
      reportUnconfirmedDeployment(
        failedState(),
        "example/app",
        interactionPorts()
      )
    ).toBe(false);
  });

  it.each([undefined, "idle", "pending", "retryable", "failed", "delivered"])(
    "observes handoff state without issuing interactions: %s",
    (state) => {
      expect(deploymentHandoffStatus({ deployHandoffState: state })).toEqual({
        state: state || "idle",
        attempts: 0,
        maxAttempts: 3,
        pending: state === "pending" || state === "retryable"
      });
      expect(
        deploymentHandoffStatus({ deployHandoffAttempts: 2 }).attempts
      ).toBe(2);
    }
  );
});
