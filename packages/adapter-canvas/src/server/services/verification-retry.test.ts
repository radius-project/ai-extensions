import { describe, expect, it } from "vitest";
import {
  runVerificationRetry,
  type VerificationRetryOperation,
  type VerificationRetryPorts
} from "./verification-retry.js";

function operation(): VerificationRetryOperation {
  return {
    operationId: "op-verify",
    repo: "octo/app",
    environment: "dev",
    state: "running",
    verification: {
      dispatchedAt: 1,
      workflow: "radius-verify-credentials.yml",
      ref: "main",
      environment: "dev",
      runId: "42",
      runUrl: "https://github.com/octo/app/actions/runs/42"
    }
  };
}

function harness(overrides: Partial<VerificationRetryPorts> = {}): {
  events: string[];
  ports: VerificationRetryPorts;
} {
  const events: string[] = [];
  const ports: VerificationRetryPorts = {
    workflowFile: "radius-verify-credentials.yml",
    now: () => 100,
    dispatch: async (input) => {
      events.push(`dispatch:${input.ref}`);
      return { code: 0, stdout: "", stderr: "" };
    },
    addStep: (_operation, message) => events.push(`step:${message}`),
    setCommandState: (_operation, _commandId, state, outcome) =>
      events.push(`command:${state}:${outcome || ""}`),
    finishFailed: () => events.push("finish:failed"),
    save: async () => {
      events.push("save");
      return true;
    },
    stopBoundary: async ({ boundary }) => {
      events.push(`stop:${boundary}`);
      return true;
    },
    monitor: async () => {
      events.push("monitor");
    },
    currentState: () => "succeeded",
    ...overrides
  };
  return { events, ports };
}

describe("runVerificationRetry", () => {
  it("does not dispatch when Stop wins before the scheduled retry starts", async () => {
    const test = harness({
      stopBoundary: async ({ boundary, beforePersist }) => {
        test.events.push(`stop:${boundary}`);
        beforePersist();
        return false;
      }
    });

    await runVerificationRetry(operation(), "command-1", test.ports);

    expect(test.events).toEqual([
      "stop:before-verification-retry-dispatch",
      "command:finished:cancelled"
    ]);
  });

  it("persists a completed dispatch before honoring Stop and skips monitoring", async () => {
    let stopped = false;
    const test = harness({
      dispatch: async () => {
        test.events.push("dispatch");
        stopped = true;
        return { code: 0, stdout: "", stderr: "" };
      },
      stopBoundary: async ({ boundary, beforePersist }) => {
        test.events.push(`stop:${boundary}`);
        if (!stopped) return true;
        beforePersist();
        return false;
      }
    });
    const target = operation();

    await runVerificationRetry(target, "command-1", test.ports);

    expect(target.verification).toEqual({
      dispatchedAt: 100,
      workflow: "radius-verify-credentials.yml",
      ref: "main",
      environment: "dev",
      runId: null,
      runUrl: null
    });
    expect(test.events).toEqual([
      "stop:before-verification-retry-dispatch",
      "dispatch",
      "step:✅ Verify workflow dispatched again.",
      "command:running:",
      "save",
      "stop:after-verification-retry-dispatch",
      "command:finished:cancelled"
    ]);
  });

  it("records a dispatch failure when no Stop is pending", async () => {
    const test = harness({
      dispatch: async () => ({
        code: 1,
        stdout: "",
        stderr: "workflow missing"
      })
    });

    await runVerificationRetry(operation(), "command-1", test.ports);

    expect(test.events).toContain(
      "step:❌ Could not dispatch the verify workflow again."
    );
    expect(test.events).toContain("command:finished:dispatch-failed");
    expect(test.events).toContain("finish:failed");
    expect(test.events.at(-1)).toBe("save");
  });

  it("honors Stop after a failed in-flight dispatch instead of reporting another failure", async () => {
    let stopped = false;
    const test = harness({
      dispatch: async () => {
        stopped = true;
        return { code: 1, stdout: "", stderr: "workflow missing" };
      },
      stopBoundary: async ({ boundary, beforePersist }) => {
        test.events.push(`stop:${boundary}`);
        if (!stopped) return true;
        beforePersist();
        return false;
      }
    });

    await runVerificationRetry(operation(), "command-1", test.ports);

    expect(test.events).toContain("command:finished:cancelled");
    expect(test.events).not.toContain("command:finished:dispatch-failed");
    expect(test.events).not.toContain("finish:failed");
  });

  it.each([
    ["stdout detail", "cli failed", "cli failed"],
    ["default detail", "", "The GitHub CLI request failed."]
  ])(
    "records %s when dispatch stderr is empty",
    async (_case, stdout, expectedEvidence) => {
      let failure: Record<string, unknown> | null = null;
      const test = harness({
        dispatch: async () => ({ code: 1, stdout, stderr: "" }),
        finishFailed: (_operation, value) => {
          failure = value;
        }
      });

      await runVerificationRetry(operation(), "command-1", test.ports);

      expect(failure).toMatchObject({ evidence: expectedEvidence });
    }
  );

  it("monitors a successful dispatch and closes the command with its result", async () => {
    const test = harness();

    await runVerificationRetry(operation(), "command-1", test.ports);

    expect(test.events).toEqual([
      "stop:before-verification-retry-dispatch",
      "dispatch:main",
      "step:✅ Verify workflow dispatched again.",
      "command:running:",
      "save",
      "stop:after-verification-retry-dispatch",
      "monitor",
      "command:finished:succeeded",
      "save"
    ]);
  });

  it("does not monitor until the new dispatch identity is durable", async () => {
    let saves = 0;
    const test = harness({
      save: async () => {
        saves += 1;
        test.events.push(`save:${saves}`);
        return saves > 1;
      }
    });

    await runVerificationRetry(operation(), "command-1", test.ports);

    expect(test.events).toContain("command:finished:persistence-failed");
    expect(test.events).toContain("finish:failed");
    expect(test.events).not.toContain("monitor");
  });

  it("does nothing for an operation that already ended", async () => {
    const test = harness();
    const target = operation();
    target.endedAt = "2026-08-22T00:00:00Z";

    await runVerificationRetry(target, "command-1", test.ports);

    expect(test.events).toEqual([]);
  });

  it("uses saved-operation fallbacks and accepts a string success code", async () => {
    let dispatchInput: Record<string, unknown> | null = null;
    const test = harness({
      dispatch: async (input) => {
        dispatchInput = input;
        return { code: "0", stdout: "", stderr: "" };
      },
      currentState: () => null
    });
    const target = operation();
    target.environment = "prod";
    delete target.verification;

    await runVerificationRetry(target, "command-1", test.ports);

    expect(dispatchInput).toEqual({
      workflowFile: "radius-verify-credentials.yml",
      targetRepo: "octo/app",
      envName: "prod",
      ref: ""
    });
    expect(test.events).toContain("command:finished:");
  });
});
