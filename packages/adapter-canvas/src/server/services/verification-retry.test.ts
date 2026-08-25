import { describe, expect, it, vi } from "vitest";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import { isGitHubRateLimitError } from "../../deploy.js";
import {
  acquireSelectedExecutor,
  monitorVerificationWithSelectedAccount,
  shouldResumeKnownVerificationRun,
  shouldReuseVerificationDispatch,
  verificationAcquisitionDeadline,
  verificationAcquisitionExpiredCopy,
  verificationRetryTargetPhase,
  verificationTrackingDeadline,
  type SelectedVerificationMonitorDependencies,
  type VerificationRetryOperation
} from "./verification-retry.js";

function operation(
  overrides: Partial<VerificationRetryOperation> = {}
): VerificationRetryOperation {
  return {
    operationId: "op_retry",
    repo: "contoso/store",
    environment: "dev",
    context: { githubLogin: "alice" },
    verification: {
      dispatchedAt: 123,
      workflow: "radius-verify-credentials.yml",
      ref: "main",
      environment: "dev",
      runId: "41",
      runUrl: "https://github.com/contoso/store/actions/runs/41"
    },
    state: "running",
    ...overrides
  };
}

describe("verification retry selected account", () => {
  it("keeps a fresh tracking deadline when resuming an older known run", () => {
    expect(
      verificationTrackingDeadline(
        operation({
          verification: {
            dispatchedAt: 1,
            trackingDeadline: 9_000
          }
        }),
        () => 5_000
      )
    ).toBe(9_000);
    expect(
      verificationTrackingDeadline(
        operation({
          verification: {
            dispatchedAt: 1_000,
            acquisitionDeadline: 9_000
          }
        }),
        () => 5_000
      )
    ).toBe(1_000 + 45 * 60 * 1000);
    expect(
      verificationTrackingDeadline(operation({ verification: {} }), () => 5_000)
    ).toBe(5_000 + 45 * 60 * 1000);
  });

  it("keeps acquisition and tracking deadlines independent", () => {
    expect(
      verificationAcquisitionDeadline(
        operation({
          verification: {
            dispatchedAt: 1_000,
            acquisitionDeadline: 9_000,
            trackingDeadline: 12_000
          }
        }),
        () => 5_000
      )
    ).toBe(9_000);
    expect(
      verificationAcquisitionDeadline(
        operation({ verification: { trackingDeadline: 12_000 } }),
        () => 5_000
      )
    ).toBe(12_000);
  });

  it.each([
    {
      action: "start" as const,
      cause: "deadline_elapsed" as const,
      phrase: "acquisition deadline elapsed"
    },
    {
      action: "start" as const,
      cause: "rate_limited" as const,
      phrase: "rate-limit acquisition window expired"
    },
    {
      action: "resume" as const,
      cause: "deadline_elapsed" as const,
      phrase: "acquisition deadline elapsed"
    },
    {
      action: "resume" as const,
      cause: "rate_limited" as const,
      phrase: "rate-limit acquisition window expired"
    }
  ])("renders $action copy for $cause", ({ action, cause, phrase }) => {
    const copy = verificationAcquisitionExpiredCopy(action, {
      state: "expired",
      cause,
      detail: "evidence"
    });

    expect(copy.step).toContain("❌");
    expect(copy.message).toContain(phrase);
  });

  it.each([
    ["prepared", null, true],
    ["outcome_unknown", null, true],
    ["confirmed", null, true],
    ["confirmed", "41", false],
    ["not_applied", null, false]
  ])(
    "reuses a %s dispatch only while its selected-account outcome remains unresolved",
    (previousStatus, runId, expected) => {
      expect(
        shouldReuseVerificationDispatch({
          accountUnavailablePhase: "dispatch",
          previousStatus,
          runId
        })
      ).toBe(expected);
    }
  );

  it("does not reuse a dispatch from an earlier acquisition or retry generation", () => {
    expect(
      shouldReuseVerificationDispatch({
        accountUnavailablePhase: "acquisition",
        previousStatus: "outcome_unknown",
        runId: null
      })
    ).toBe(false);
    expect(
      shouldReuseVerificationDispatch({
        accountUnavailablePhase: "dispatch",
        previousStatus: "not_applied",
        runId: null
      })
    ).toBe(false);
  });

  it("preserves monitoring and dispatch targets across repeated acquisition failures", () => {
    expect(verificationRetryTargetPhase("monitor")).toBe("monitor");
    expect(verificationRetryTargetPhase("dispatch")).toBe("dispatch");
    expect(verificationRetryTargetPhase("acquisition")).toBe("acquisition");
    expect(verificationRetryTargetPhase(null)).toBe("acquisition");
    expect(
      shouldResumeKnownVerificationRun({
        accountUnavailablePhase: "monitor",
        runId: "41"
      })
    ).toBe(true);
    expect(
      shouldResumeKnownVerificationRun({
        accountUnavailablePhase: "dispatch",
        runId: "41"
      })
    ).toBe(false);
    expect(
      shouldResumeKnownVerificationRun({
        accountUnavailablePhase: "monitor",
        runId: null
      })
    ).toBe(false);
  });

  it("expires before acquiring when the durable deadline has elapsed", async () => {
    const createExecutor = vi.fn();

    const result = await acquireSelectedExecutor("alice", 100, {
      createExecutor,
      isRateLimitError: isGitHubRateLimitError,
      now: () => 100,
      sleep: () => Promise.resolve(),
      errorMessage: (error) => String(error)
    });

    expect(result).toEqual({
      state: "expired",
      cause: "deadline_elapsed",
      detail: "The selected GitHub account acquisition deadline elapsed."
    });
    expect(createExecutor).not.toHaveBeenCalled();
  });

  describe("recovered verification selected account", () => {
    function monitorDependencies(
      overrides: Partial<SelectedVerificationMonitorDependencies> = {}
    ): SelectedVerificationMonitorDependencies & {
      registered: string[];
      unregistered: string[];
    } {
      const registered: string[] = [];
      const unregistered: string[] = [];
      const base: SelectedVerificationMonitorDependencies = {
        createExecutor: () =>
          Promise.resolve(successfulSelectedGhExecutor({ login: "alice" })),
        registerExecutor: (operationId) => {
          registered.push(operationId);
        },
        unregisterExecutor: (operationId) => {
          unregistered.push(operationId);
        },
        monitor: () => Promise.resolve(),
        accountUnavailable: () => Promise.resolve(),
        trackingExpired: () => Promise.resolve(),
        isRateLimitError: isGitHubRateLimitError,
        now: () => 0,
        sleep: () => Promise.resolve(),
        errorMessage: (error) =>
          error instanceof Error ? error.message : String(error)
      };
      return Object.assign(base, overrides, { registered, unregistered });
    }

    it("keeps the selected executor registered through recovered monitoring", async () => {
      const op = operation();
      let registeredDuringMonitor = false;
      const deps = monitorDependencies({
        monitor: async (operationId) => {
          registeredDuringMonitor = deps.registered.includes(operationId);
        }
      });

      await monitorVerificationWithSelectedAccount(op, deps);

      expect(registeredDuringMonitor).toBe(true);
      expect(deps.unregistered).toEqual(["op_retry"]);
    });

    it("runs recovery discovery on the registered executor before monitoring", async () => {
      const beforeMonitor = vi.fn(() => Promise.resolve(false));
      const monitor = vi.fn();
      const deps = monitorDependencies({ beforeMonitor, monitor });

      await monitorVerificationWithSelectedAccount(operation(), deps);

      expect(beforeMonitor).toHaveBeenCalledTimes(1);
      expect(deps.registered).toEqual(["op_retry"]);
      expect(monitor).not.toHaveBeenCalled();
      expect(deps.unregistered).toEqual(["op_retry"]);
    });

    it("maps recovered credential failure to account-specific handling", async () => {
      const unavailable = vi.fn(() => Promise.resolve());
      const monitor = vi.fn();
      const deps = monitorDependencies({
        createExecutor: () =>
          Promise.reject(new Error("credential unavailable")),
        monitor,
        accountUnavailable: unavailable
      });
      const op = operation();

      await monitorVerificationWithSelectedAccount(op, deps);

      expect(unavailable).toHaveBeenCalledWith(
        op,
        "alice",
        "credential unavailable"
      );
      expect(monitor).not.toHaveBeenCalled();
      expect(deps.registered).toEqual([]);
    });

    it("terminalizes ordinary selected-account acquisition HTTP 403", async () => {
      const unavailable = vi.fn(() => Promise.resolve());
      const deps = monitorDependencies({
        createExecutor: () =>
          Promise.reject(
            new Error(
              "GitHub identity verification failed for @alice: gh: Forbidden (HTTP 403)"
            )
          ),
        accountUnavailable: unavailable
      });
      const op = operation();

      await monitorVerificationWithSelectedAccount(op, deps);

      expect(unavailable).toHaveBeenCalledWith(
        op,
        "alice",
        expect.stringContaining("Forbidden (HTTP 403)")
      );
      expect(deps.registered).toEqual([]);
    });

    it.each([
      "GitHub identity verification failed: secondary rate limit (HTTP 403); Retry-After: 1",
      "GitHub identity verification failed: Too Many Requests (HTTP 429)"
    ])(
      "retries rate-limited selected-account acquisition without terminalizing",
      async (message) => {
        let attempts = 0;
        const unavailable = vi.fn(() => Promise.resolve());
        const expired = vi.fn(() => Promise.resolve());
        const sleeps: number[] = [];
        const monitor = vi.fn(() => Promise.resolve());
        const deps = monitorDependencies({
          createExecutor: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error(message);
            return successfulSelectedGhExecutor({ login: "alice" });
          },
          accountUnavailable: unavailable,
          trackingExpired: expired,
          sleep: async (milliseconds) => {
            sleeps.push(milliseconds);
          },
          monitor
        });

        await monitorVerificationWithSelectedAccount(operation(), deps);

        expect(attempts).toBe(2);
        expect(sleeps).toEqual([1000]);
        expect(unavailable).not.toHaveBeenCalled();
        expect(expired).not.toHaveBeenCalled();
        expect(monitor).toHaveBeenCalledWith("op_retry");
        expect(deps.unregistered).toEqual(["op_retry"]);
      }
    );

    it("expires bounded acquisition retry without calling it account loss", async () => {
      const unavailable = vi.fn(() => Promise.resolve());
      const expired = vi.fn(() => Promise.resolve());
      const sleep = vi.fn(() => Promise.resolve());
      let clockReads = 0;
      const deps = monitorDependencies({
        createExecutor: () =>
          Promise.reject(
            new Error(
              "GitHub identity verification failed: secondary rate limit (HTTP 403)"
            )
          ),
        accountUnavailable: unavailable,
        trackingExpired: expired,
        now: () => {
          clockReads += 1;
          return clockReads === 1 ? 0 : 123 + 45 * 60 * 1000;
        },
        sleep
      });
      const op = operation();

      await monitorVerificationWithSelectedAccount(op, deps);

      expect(expired).toHaveBeenCalledWith(op, {
        state: "expired",
        cause: "rate_limited",
        detail:
          "GitHub identity verification failed: secondary rate limit (HTTP 403)"
      });
      expect(unavailable).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
      expect(deps.registered).toEqual([]);
    });

    it("does not register an executor acquired after the acquisition deadline", async () => {
      const expired = vi.fn(() => Promise.resolve());
      let clockReads = 0;
      const deps = monitorDependencies({
        trackingExpired: expired,
        now: () => {
          clockReads += 1;
          return clockReads === 1 ? 0 : 123 + 45 * 60 * 1000;
        }
      });
      const op = operation();

      await monitorVerificationWithSelectedAccount(op, deps);

      expect(expired).toHaveBeenCalledWith(op, {
        state: "expired",
        cause: "deadline_elapsed",
        detail: "The selected GitHub account acquisition deadline elapsed."
      });
      expect(deps.registered).toEqual([]);
      expect(deps.unregistered).toEqual([]);
    });

    it("fails a legacy recovered operation without falling back to ambient GitHub", async () => {
      const createExecutor = vi.fn();
      const monitor = vi.fn();
      const unavailable = vi.fn(() => Promise.resolve());
      const deps = monitorDependencies({
        createExecutor,
        monitor,
        accountUnavailable: unavailable
      });
      const op = operation({ context: undefined });

      await monitorVerificationWithSelectedAccount(op, deps);

      expect(unavailable).toHaveBeenCalledWith(
        op,
        "",
        "The operation has no saved GitHub account."
      );
      expect(createExecutor).not.toHaveBeenCalled();
      expect(monitor).not.toHaveBeenCalled();
    });

    it("unregisters the selected executor when recovered monitoring fails", async () => {
      const deps = monitorDependencies({
        monitor: () => Promise.reject(new Error("monitor failed"))
      });

      await expect(
        monitorVerificationWithSelectedAccount(operation(), deps)
      ).rejects.toThrow("monitor failed");
      expect(deps.unregistered).toEqual(["op_retry"]);
    });
  });
});
