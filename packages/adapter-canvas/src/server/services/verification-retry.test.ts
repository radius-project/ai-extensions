import { describe, expect, it, vi } from "vitest";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import { isGitHubRateLimitError } from "../../deploy.js";
import {
  monitorVerificationWithSelectedAccount,
  runVerificationRetry,
  type SelectedVerificationMonitorDependencies,
  type VerificationRetryDependencies,
  type VerificationRetryOperation
} from "./verification-retry.js";

interface Journal {
  createdLogins: string[];
  registered: string[];
  unregistered: string[];
  dispatches: Array<{ args: string[]; timeout: number | undefined }>;
  steps: Array<{ text: string; stage?: string }>;
  commands: Array<{ state: string; outcome?: string | null }>;
  persisted: number;
  monitored: string[];
}

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

function dependencies(
  overrides: Partial<VerificationRetryDependencies> = {}
): VerificationRetryDependencies & { journal: Journal } {
  const journal: Journal = {
    createdLogins: [],
    registered: [],
    unregistered: [],
    dispatches: [],
    steps: [],
    commands: [],
    persisted: 0,
    monitored: []
  };
  const executor = successfulSelectedGhExecutor({
    login: "alice",
    run: async (args, commandOptions) => {
      journal.dispatches.push({ args, timeout: commandOptions?.timeout });
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  const base: VerificationRetryDependencies = {
    createExecutor: async (login) => {
      journal.createdLogins.push(login);
      return executor;
    },
    registerExecutor: (operationId) => {
      journal.registered.push(operationId);
    },
    unregisterExecutor: (operationId) => {
      journal.unregistered.push(operationId);
    },
    buildDispatchArgs: ({ workflowFile, targetRepo, envName, ref }) => [
      "workflow",
      "run",
      workflowFile,
      "--repo",
      targetRepo,
      "--ref",
      ref,
      "-f",
      `environment=${envName}`
    ],
    now: () => 12345,
    verifyWorkflowFile: "radius-verify-credentials.yml",
    stageVerify: "verify",
    addStep: (_operation, text, stage) => {
      journal.steps.push({ text, ...(stage ? { stage } : {}) });
    },
    setCommandState: (_operation, _commandId, state, outcome) => {
      journal.commands.push({ state, ...(outcome ? { outcome } : {}) });
    },
    finish: (target, state, options) => {
      target.state = state;
      target.failure = options.failure;
      target.endedAt = "finished";
    },
    persist: async () => {
      journal.persisted += 1;
    },
    monitor: async (operationId) => {
      journal.monitored.push(operationId);
    },
    currentState: () => "succeeded",
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  };
  return Object.assign(base, overrides, { journal });
}

describe("verification retry selected account", () => {
  it("uses the selected executor for dispatch and keeps it registered through monitoring", async () => {
    const op = operation();
    let registeredDuringMonitor = false;
    const deps = dependencies({
      registerExecutor: (operationId) => {
        deps.journal.registered.push(operationId);
      },
      monitor: async (operationId) => {
        registeredDuringMonitor = deps.journal.registered.includes(operationId);
        deps.journal.monitored.push(operationId);
      }
    });

    await runVerificationRetry(op, "cmd-1", deps);

    expect(deps.journal.createdLogins).toEqual(["alice"]);
    expect(deps.journal.dispatches).toEqual([
      {
        args: [
          "workflow",
          "run",
          "radius-verify-credentials.yml",
          "--repo",
          "contoso/store",
          "--ref",
          "main",
          "-f",
          "environment=dev"
        ],
        timeout: 30000
      }
    ]);
    expect(registeredDuringMonitor).toBe(true);
    expect(deps.journal.unregistered).toEqual(["op_retry"]);
    expect(op.verification).toEqual({
      dispatchedAt: 12345,
      workflow: "radius-verify-credentials.yml",
      ref: "main",
      environment: "dev",
      runId: null,
      runUrl: null
    });
    expect(deps.journal.commands).toEqual([
      { state: "running" },
      { state: "finished", outcome: "succeeded" }
    ]);
    expect(deps.journal.persisted).toBe(2);
  });

  it("unregisters the selected executor after monitoring terminalizes lost repository access", async () => {
    const op = operation();
    const deps = dependencies({
      monitor: async (operationId) => {
        deps.journal.monitored.push(operationId);
        op.state = "failed_partial";
        op.endedAt = "finished";
        op.failure = {
          code: "verification-retry-github-account-unavailable"
        };
      },
      currentState: () => String(op.state)
    });

    await runVerificationRetry(op, "cmd-1", deps);

    expect(deps.journal.dispatches).toHaveLength(1);
    expect(deps.journal.monitored).toEqual(["op_retry"]);
    expect(deps.journal.commands).toEqual([
      { state: "running" },
      { state: "finished", outcome: "failed_partial" }
    ]);
    expect(deps.journal.unregistered).toEqual(["op_retry"]);
    expect(op.failure).toMatchObject({
      code: "verification-retry-github-account-unavailable"
    });
  });

  it("fails closed when a legacy record has no selected login", async () => {
    const op = operation({ context: undefined });
    const createExecutor = vi.fn();
    const deps = dependencies({ createExecutor });

    await runVerificationRetry(op, "cmd-1", deps);

    expect(createExecutor).not.toHaveBeenCalled();
    expect(op.failure).toMatchObject({
      code: "verification-retry-github-account-unavailable",
      message:
        "Radius could not use the saved GitHub account to retry credential verification. Start a new environment setup after re-checking the GitHub account.",
      evidence:
        "The operation has no saved GitHub account. Start a new environment setup after re-checking the account."
    });
    expect(deps.journal.dispatches).toEqual([]);
    expect(deps.journal.monitored).toEqual([]);
    expect(deps.journal.persisted).toBe(1);
  });

  it("reports selected credential acquisition failure without ambient fallback", async () => {
    const op = operation();
    const deps = dependencies({
      createExecutor: () => Promise.reject(new Error("credential unavailable"))
    });

    await runVerificationRetry(op, "cmd-1", deps);

    expect(op.failure).toMatchObject({
      code: "verification-retry-github-account-unavailable",
      evidence: "credential unavailable",
      message:
        "Radius could not use @alice to retry credential verification. Re-check that account and try again."
    });
    expect(deps.journal.registered).toEqual([]);
    expect(deps.journal.dispatches).toEqual([]);
  });

  it("preserves the legacy target defaults while using the selected executor", async () => {
    const op = operation({
      repo: undefined,
      environment: undefined,
      context: { githubLogin: " alice " },
      verification: undefined
    });
    const deps = dependencies({
      createExecutor: async (login) =>
        successfulSelectedGhExecutor({
          login,
          run: async (args, commandOptions) => {
            deps.journal.dispatches.push({
              args,
              timeout: commandOptions?.timeout
            });
            return { code: "0", stdout: "", stderr: "" };
          }
        })
    });

    await runVerificationRetry(op, "cmd-1", deps);

    expect(deps.journal.dispatches[0]).toEqual({
      args: [
        "workflow",
        "run",
        "radius-verify-credentials.yml",
        "--repo",
        "",
        "--ref",
        "",
        "-f",
        "environment="
      ],
      timeout: 30000
    });
    expect(op.verification).toMatchObject({
      workflow: "radius-verify-credentials.yml",
      ref: "",
      environment: ""
    });
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

      expect(expired).toHaveBeenCalledWith(
        op,
        expect.stringContaining("secondary rate limit")
      );
      expect(unavailable).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
      expect(deps.registered).toEqual([]);
    });

    it("does not register an executor acquired after the dispatch deadline", async () => {
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

      expect(expired).toHaveBeenCalledWith(
        op,
        "GitHub rate limiting prevented Radius from reacquiring the selected account."
      );
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

  it.each([
    {
      label: "stderr",
      stdout: "",
      stderr: "workflow scope missing",
      evidence: "workflow scope missing"
    },
    {
      label: "stdout",
      stdout: "permission denied",
      stderr: "",
      evidence: "permission denied"
    },
    {
      label: "no command detail",
      stdout: "",
      stderr: "",
      evidence: "The selected GitHub account request failed."
    }
  ])(
    "surfaces dispatch failure from selected-account $label and unregisters it",
    async ({ stdout, stderr, evidence }) => {
      const op = operation();
      const deps = dependencies({
        createExecutor: async () =>
          successfulSelectedGhExecutor({
            login: "alice",
            run: async () => ({
              code: 1,
              stdout,
              stderr
            })
          })
      });

      await runVerificationRetry(op, "cmd-1", deps);

      expect(op.failure).toMatchObject({
        code: "verify-dispatch-failed",
        evidence,
        message:
          "Radius could not dispatch the credential verification workflow again as @alice. Re-check that account and try again."
      });
      expect(deps.journal.commands).toEqual([
        { state: "finished", outcome: "dispatch-failed" }
      ]);
      expect(deps.journal.monitored).toEqual([]);
      expect(deps.journal.unregistered).toEqual(["op_retry"]);
    }
  );

  it("unregisters the selected executor when monitoring fails", async () => {
    const op = operation();
    const deps = dependencies({
      monitor: () => Promise.reject(new Error("monitor failed"))
    });

    await expect(runVerificationRetry(op, "cmd-1", deps)).rejects.toThrow(
      "monitor failed"
    );
    expect(deps.journal.unregistered).toEqual(["op_retry"]);
  });

  it("does nothing for an operation that already ended", async () => {
    const op = operation({ endedAt: "already-finished" });
    const createExecutor = vi.fn();
    const deps = dependencies({ createExecutor });

    await runVerificationRetry(op, "cmd-1", deps);

    expect(createExecutor).not.toHaveBeenCalled();
    expect(deps.journal.persisted).toBe(0);
  });
});
