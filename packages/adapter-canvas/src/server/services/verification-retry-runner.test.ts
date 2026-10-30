import { describe, expect, it, vi } from "vitest";
import type { SelectedGhExecutor } from "../../gh.js";
import { providerMutationRecord } from "../../operations.js";
import {
  isGitHubRateLimitError,
  isSelectedGhAuthorizationError,
  SelectedGhAuthorizationError
} from "../../deploy.js";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import {
  runVerificationRetry,
  type VerificationRetryRunnerDependencies
} from "./verification-retry-runner.js";
import type { VerificationRetryOperation } from "./verification-retry.js";

const NOW = Date.parse("2026-08-25T00:00:00Z");
const TRACKING_WINDOW_MS = 45 * 60 * 1000;

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("verification retry runtime shutdown", () => {
  it.each(["baseline", "rejection"] as const)(
    "holds the selected executor until late %s authorization settles",
    async (phase) => {
      const op = operation();
      const entered = deferred();
      const gate = deferred();
      let stopped = false;
      const dependencies = runnerDependencies({
        isStopped: () => stopped,
        run: async (args) => ({
          code: phase === "baseline" || args[0] === "workflow" ? 1 : 0,
          stdout: "[]",
          stderr: "HTTP 403"
        }),
        selectedCommandAuthorizationError: async () => {
          entered.resolve();
          await gate.promise;
          throw new SelectedGhAuthorizationError("alice", 403, "late denial");
        }
      });
      const pending = runVerificationRetry(op, "retry", dependencies);
      try {
        await entered.promise;
        stopped = true;
        expect(dependencies.journal.unregistered).toEqual([]);
      } finally {
        gate.resolve();
        await pending;
      }
      expect(dependencies.journal.monitored).toEqual([]);
      expect(dependencies.journal.unregistered).toEqual([op.operationId]);
      expect(op.endedAt).toBeNull();
      expect(
        dependencies.journal.commands.every(
          (entry) => entry.state !== "finished"
        )
      ).toBe(true);
    }
  );
  it("refuses a second command target after the first command left an unknown dispatch", async () => {
    const op = operation();
    let stopped = false;
    const dependencies = runnerDependencies({
      isStopped: () => stopped,
      run: async (args) => {
        if (args[0] === "run") return { code: 0, stdout: "[]", stderr: "" };
        stopped = true;
        return { code: 1, stdout: "", stderr: "timeout", timedOut: true };
      }
    });
    await runVerificationRetry(op, "first-command", dependencies);
    const firstTarget = op.verification?.dispatchMutationTarget;
    expect(typeof firstTarget).toBe("string");
    const first = providerMutationRecord(
      op,
      "github_workflow.dispatch_retry",
      String(firstTarget)
    );
    expect(first?.status).toBe("outcome_unknown");
    const second = runnerDependencies();
    await runVerificationRetry(op, "second-command", second);
    expect(second.journal.calls).toEqual([]);
    expect(second.journal.monitored).toEqual([]);
    expect(
      providerMutationRecord(
        op,
        "github_workflow.dispatch_retry",
        String(firstTarget)
      )?.status
    ).toBe("manual_required");
    expect(second.journal.commands.at(-1)?.outcome).toBe("manual-required");
  });
  it.each([
    "baseline",
    "authorization",
    "authorization-error",
    "rejection-authorization",
    "accepted-persist",
    "accepted-persist-failed",
    "known-persist"
  ] as const)(
    "retains resumability when shutdown reaches %s",
    async (boundary) => {
      const op = operation();
      if (boundary === "known-persist")
        op.verification = {
          ...op.verification,
          runId: "41",
          accountUnavailablePhase: "monitor"
        };
      let stopped = false;
      const dependencies = runnerDependencies({
        isStopped: () => stopped,
        run: async (args) => {
          if (boundary === "baseline") {
            stopped = true;
            throw new SelectedGhAuthorizationError("alice", 403, "late denial");
          }
          if (args[0] === "run")
            return {
              code: boundary.startsWith("authorization") ? 1 : 0,
              stdout: "[]",
              stderr: "HTTP 403"
            };
          return {
            code: boundary === "rejection-authorization" ? 1 : 0,
            stdout: "https://github.com/contoso/store/actions/runs/41",
            stderr: "HTTP 403"
          };
        },
        selectedCommandAuthorizationError: async () => {
          stopped = true;
          if (boundary === "authorization-error")
            throw new Error("late identity failure");
          return new SelectedGhAuthorizationError("alice", 403, "denied");
        }
      });
      const persist = dependencies.persist;
      dependencies.persist = async (target) => {
        const result = await persist(target);
        if (dependencies.journal.persists === 2) {
          stopped = true;
          if (boundary === "accepted-persist-failed") return false;
        }
        return result;
      };
      await runVerificationRetry(op, "retry", dependencies);
      expect(dependencies.journal.monitored).toEqual([]);
      expect(dependencies.journal.unregistered).toEqual([op.operationId]);
      if (boundary === "accepted-persist-failed")
        expect(dependencies.journal.commands.at(-1)?.outcome).toBe(
          "persistence-failed"
        );
      else {
        expect(op.endedAt).toBeNull();
        expect(
          dependencies.journal.commands.every(
            (entry) => entry.state !== "finished"
          )
        ).toBe(true);
      }
    }
  );
  it("leaves acquired-command recovery pending when account acquisition is stopped", async () => {
    const op = operation();
    let stopped = false;
    const dependencies = runnerDependencies({
      isStopped: () => stopped,
      createExecutor: async () => {
        stopped = true;
        throw new Error("Session closed");
      }
    });
    await runVerificationRetry(op, "retry", dependencies);
    expect(op.endedAt).toBeNull();
    expect(dependencies.journal.registered).toEqual([]);
    expect(dependencies.journal.calls).toEqual([]);
    expect(
      dependencies.journal.commands.every((entry) => entry.state !== "finished")
    ).toBe(true);
  });

  it.each([false, true])(
    "does not finish a retry when its %s known-run monitor stops locally",
    async (knownRun) => {
      const op = operation();
      if (knownRun)
        op.verification = {
          ...op.verification,
          runId: "41",
          accountUnavailablePhase: "monitor"
        };
      let stopped = false;
      const dependencies = runnerDependencies({
        isStopped: () => stopped,
        monitor: async () => {
          stopped = true;
        }
      });
      await runVerificationRetry(op, "retry", dependencies);
      expect(stopped).toBe(true);
      expect(op.endedAt).toBeNull();
      expect(dependencies.journal.unregistered).toEqual([op.operationId]);
      expect(
        dependencies.journal.commands.every(
          (entry) => entry.state !== "finished"
        )
      ).toBe(true);
    }
  );
});

interface RunnerJournal {
  calls: Array<{ args: string[]; timeout?: number }>;
  registered: string[];
  unregistered: string[];
  steps: Array<{ text: string; stage?: string }>;
  commands: Array<{ state: string; outcome?: string | null }>;
  persists: number;
  journalPersists: number;
  monitored: string[];
  sleeps: number[];
  boundaries: string[];
}

function operation(
  overrides: Partial<VerificationRetryOperation> = {}
): VerificationRetryOperation {
  return {
    operationId: "op_retry",
    repo: "contoso/store",
    environment: "dev",
    endedAt: null,
    context: { githubLogin: "alice" },
    verification: {
      dispatchedAt: NOW - 1000,
      workflow: "radius-verify-credentials.yml",
      ref: "main",
      environment: "dev",
      event: "workflow_dispatch",
      operationMarker: "op_retry",
      runId: null,
      runUrl: null
    },
    state: "running",
    ...overrides
  };
}

function exactRun(runId = 41): string {
  return JSON.stringify([
    {
      databaseId: runId,
      createdAt: new Date(NOW).toISOString(),
      displayTitle: "Radius verify dev [op_retry]",
      event: "workflow_dispatch",
      headBranch: "main"
    }
  ]);
}

function defaultRun(journal: RunnerJournal): SelectedGhExecutor["run"] {
  return async (args, options) => {
    journal.calls.push({ args, timeout: options?.timeout });
    if (args[0] === "workflow") {
      return {
        code: 0,
        stdout: "https://github.com/contoso/store/actions/runs/41\n",
        stderr: ""
      };
    }
    if (args[0] === "run" && args[1] === "list") {
      const json = args[args.indexOf("--json") + 1];
      return json === "databaseId" ?
          { code: 0, stdout: '[{"databaseId":40}]', stderr: "" }
        : { code: 0, stdout: exactRun(), stderr: "" };
    }
    throw new Error(`Unmodeled selected gh command: ${JSON.stringify(args)}`);
  };
}

function runnerDependencies(
  overrides: Partial<VerificationRetryRunnerDependencies> & {
    run?: SelectedGhExecutor["run"];
  } = {}
): VerificationRetryRunnerDependencies & { journal: RunnerJournal } {
  const journal: RunnerJournal = {
    calls: [],
    registered: [],
    unregistered: [],
    steps: [],
    commands: [],
    persists: 0,
    journalPersists: 0,
    monitored: [],
    sleeps: [],
    boundaries: []
  };
  const executor = successfulSelectedGhExecutor({
    login: "alice",
    run: overrides.run || defaultRun(journal)
  });
  const base: VerificationRetryRunnerDependencies = {
    createExecutor: () => Promise.resolve(executor),
    registerExecutor: (operationId) => {
      journal.registered.push(operationId);
      return () => {
        journal.unregistered.push(operationId);
      };
    },
    stopBoundary: async ({ boundary }) => {
      journal.boundaries.push(boundary);
      return true;
    },
    buildDispatchArgs: ({
      workflowFile,
      targetRepo,
      envName,
      ref,
      operationMarker
    }) => [
      "workflow",
      "run",
      workflowFile,
      "--repo",
      targetRepo,
      "--ref",
      ref,
      "-f",
      `environment=${envName}`,
      "-f",
      `radius_operation=${operationMarker}`
    ],
    selectedCommandAuthorizationError: async (
      selectedExecutor,
      _repo,
      result
    ) => {
      if (!/HTTP (401|403|404)/.test(`${result.stderr}\n${result.stdout}`)) {
        return null;
      }
      return new SelectedGhAuthorizationError(
        selectedExecutor.login,
        result.stderr.includes("404") ? 404
        : result.stderr.includes("401") ? 401
        : 403,
        result.stderr || result.stdout
      );
    },
    isAuthorizationError: isSelectedGhAuthorizationError,
    isRateLimitError: isGitHubRateLimitError,
    now: () => NOW,
    sleep: async (milliseconds) => {
      journal.sleeps.push(milliseconds);
    },
    verifyWorkflowFile: "radius-verify-credentials.yml",
    stageVerify: "verify",
    addStep: (_target, text, stage) => {
      journal.steps.push({ text, ...(stage ? { stage } : {}) });
    },
    setCommandState: (_target, _commandId, state, outcome) => {
      journal.commands.push({ state, ...(outcome ? { outcome } : {}) });
    },
    finish: (target, state, options) => {
      target.state = state;
      target.endedAt = "finished";
      if ("failure" in options) target.failure = options.failure;
      if ("terminal" in options) target.terminal = options.terminal;
    },
    persist: async () => {
      journal.persists += 1;
      return true;
    },
    persistJournal: async () => {
      journal.journalPersists += 1;
    },
    monitor: async (operationId) => {
      journal.monitored.push(operationId);
    },
    currentState: () => "succeeded",
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  };
  const { run: _run, ...dependencyOverrides } = overrides;
  return Object.assign(base, dependencyOverrides, { journal });
}

describe("selected-account verification retry runner", () => {
  it("honors Stop before starting a new verification dispatch", async () => {
    const target = operation();
    const dependencies = runnerDependencies({
      stopBoundary: async ({ boundary, beforePersist }) => {
        dependencies.journal.boundaries.push(boundary);
        if (boundary !== "before-verification-dispatch-attempt:1") {
          return true;
        }
        beforePersist();
        target.state = "cancelled";
        target.endedAt = "finished";
        return false;
      }
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(dependencies.journal.calls.map((entry) => entry.args[0])).toEqual([
      "run"
    ]);
    expect(dependencies.journal.commands).toContainEqual({
      state: "finished",
      outcome: "cancelled"
    });
    expect(
      providerMutationRecord(
        target,
        "github_workflow.dispatch_retry",
        "contoso/store:radius-verify-credentials.yml:main:dev:cmd-1"
      )
    ).toMatchObject({
      status: "not_applied"
    });
  });

  it("does not cancel a dispatch that has already started", async () => {
    const target = operation();
    const dependencies = runnerDependencies({
      stopBoundary: async ({ boundary, beforePersist }) => {
        dependencies.journal.boundaries.push(boundary);
        if (boundary !== "after-verification-retry-dispatch") return true;
        beforePersist();
        target.state = "cancelled";
        target.endedAt = "finished";
        return false;
      }
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(dependencies.journal.calls.map((entry) => entry.args[0])).toEqual([
      "run",
      "workflow"
    ]);
    expect(target.providerRecovery).toMatchObject({
      mutations: [
        expect.objectContaining({
          kind: "github_workflow.dispatch_retry",
          status: "confirmed"
        })
      ]
    });
    expect(dependencies.journal.monitored).toEqual([]);
  });

  it("journals and dispatches the exact marked run before monitoring it", async () => {
    const target = operation();
    let registeredDuringMonitor = false;
    const dependencies = runnerDependencies({
      monitor: async (operationId) => {
        registeredDuringMonitor =
          dependencies.journal.registered.includes(operationId) &&
          dependencies.journal.unregistered.length === 0;
        dependencies.journal.monitored.push(operationId);
      }
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(dependencies.journal.calls.map((entry) => entry.args[0])).toEqual([
      "run",
      "workflow"
    ]);
    expect(dependencies.journal.calls[1]).toMatchObject({
      args: expect.arrayContaining(["radius_operation=op_retry"]),
      timeout: 30000
    });
    expect(target.providerRecovery).toMatchObject({
      mutations: [
        expect.objectContaining({
          kind: "github_workflow.dispatch_retry",
          status: "confirmed",
          providerIdempotencyKey: "op_retry"
        })
      ]
    });
    expect(target.verification).toMatchObject({
      baselineRunId: 40,
      runId: "41",
      runUrl: "https://github.com/contoso/store/actions/runs/41",
      trackingDeadline: NOW + TRACKING_WINDOW_MS,
      acquisitionDeadline: NOW + TRACKING_WINDOW_MS
    });
    expect(registeredDuringMonitor).toBe(true);
    expect(dependencies.journal.unregistered).toEqual(["op_retry"]);
    expect(dependencies.journal.sleeps).toEqual([]);
  });

  it("fails closed without a selected login", async () => {
    const target = operation({ context: undefined });
    const createExecutor = vi.fn();
    const dependencies = runnerDependencies({ createExecutor });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(createExecutor).not.toHaveBeenCalled();
    expect(target).toMatchObject({
      state: "failed_partial",
      failure: { code: "verification-retry-github-account-missing" }
    });
  });

  it("reports selected-account acquisition failure without ambient fallback", async () => {
    const target = operation();
    const dependencies = runnerDependencies({
      createExecutor: () => Promise.reject(new Error("credential unavailable"))
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      state: "failed_partial",
      failure: {
        code: "verification-retry-github-account-unavailable",
        evidence: "credential unavailable"
      },
      verification: { accountUnavailablePhase: "acquisition" }
    });
    expect(dependencies.journal.calls).toEqual([]);
  });

  it.each([
    {
      detail: "The selected GitHub account acquisition deadline elapsed.",
      message:
        "Radius could not start credential verification before the selected GitHub account acquisition deadline elapsed."
    },
    {
      detail: "secondary rate limit (HTTP 403); Retry-After: 60",
      message:
        "Radius could not start credential verification before the GitHub rate-limit acquisition window expired."
    }
  ])("reports the matching acquisition expiry cause", async (scenario) => {
    const target = operation({
      verification: {
        workflow: "radius-verify-credentials.yml",
        ref: "main",
        environment: "dev",
        acquisitionDeadline: NOW
      }
    });
    const dependencies =
      scenario.detail.startsWith("secondary") ?
        runnerDependencies({
          createExecutor: () => Promise.reject(new Error(scenario.detail)),
          now: vi
            .fn<() => number>()
            .mockReturnValueOnce(NOW - 1)
            .mockReturnValue(NOW)
        })
      : runnerDependencies();

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      failure: {
        code: "verification-tracking-expired",
        message: scenario.message,
        evidence: scenario.detail
      }
    });
    expect(dependencies.journal.registered).toEqual([]);
  });

  it("gives a resumed known run a fresh monitoring window", async () => {
    const target = operation({
      verification: {
        dispatchedAt: NOW - 60 * 60 * 1000,
        workflow: "radius-verify-credentials.yml",
        ref: "main",
        environment: "dev",
        runId: "41",
        accountUnavailablePhase: "monitor",
        acquisitionDeadline: NOW + 1000
      }
    });
    const dependencies = runnerDependencies();

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(dependencies.journal.calls).toEqual([]);
    expect(dependencies.journal.monitored).toEqual(["op_retry"]);
    expect(target.verification).toMatchObject({
      runId: "41",
      trackingDeadline: NOW + TRACKING_WINDOW_MS,
      acquisitionDeadline: NOW + TRACKING_WINDOW_MS,
      accountUnavailablePhase: null
    });
  });

  it("fails retryably when the resumed-run checkpoint cannot be saved", async () => {
    const target = operation({
      verification: {
        dispatchedAt: NOW - 60 * 60 * 1000,
        workflow: "radius-verify-credentials.yml",
        ref: "main",
        environment: "dev",
        runId: "41",
        accountUnavailablePhase: "monitor",
        acquisitionDeadline: NOW + 1000
      }
    });
    const monitor = vi.fn();
    const dependencies = runnerDependencies({
      persist: () => Promise.resolve(false),
      monitor
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(monitor).not.toHaveBeenCalled();
    expect(target).toMatchObject({
      failure: { code: "verification-retry-persist-failed" },
      verification: {
        runId: "41",
        acquisitionPending: true,
        accountUnavailablePhase: "monitor"
      }
    });
  });

  it("does not contact GitHub when the acquisition checkpoint cannot be saved", async () => {
    const target = operation({
      verification: {
        workflow: "radius-verify-credentials.yml",
        ref: "main",
        environment: "dev"
      }
    });
    const createExecutor = vi.fn();
    const dependencies = runnerDependencies({
      createExecutor,
      persist: () => Promise.resolve(false)
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(createExecutor).not.toHaveBeenCalled();
    expect(target).toMatchObject({
      failure: { code: "verification-retry-persist-failed" }
    });
  });

  it("fails without dispatching when the baseline is malformed", async () => {
    const target = operation();
    const dependencies = runnerDependencies({
      run: async (args) =>
        args[0] === "run" ?
          { code: 0, stdout: '{"databaseId":40}', stderr: "" }
        : { code: 0, stdout: "", stderr: "" }
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      failure: { code: "verify-dispatch-baseline-failed" },
      verification: { accountUnavailablePhase: "dispatch" }
    });
    expect(dependencies.journal.calls).toEqual([]);
  });

  it("maps baseline authorization failure to the selected account", async () => {
    const target = operation();
    const dependencies = runnerDependencies({
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "gh: Forbidden (HTTP 403)"
      })
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      failure: {
        code: "verification-retry-github-account-unavailable",
        evidence: expect.stringContaining("HTTP 403")
      },
      verification: { accountUnavailablePhase: "dispatch" }
    });
  });

  it("reports an ordinary baseline read failure without dispatching", async () => {
    const target = operation();
    const dependencies = runnerDependencies({
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "gh: Service Unavailable (HTTP 503)"
      })
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      failure: {
        code: "verify-dispatch-baseline-failed",
        evidence: expect.stringContaining("HTTP 503")
      }
    });
  });

  it("records a conclusive dispatch rejection as retryable", async () => {
    const target = operation();
    const dependencies = runnerDependencies({
      run: async (args) => {
        if (args[0] === "workflow") {
          return {
            code: 1,
            stdout: "",
            stderr: "gh: Validation Failed (HTTP 422)"
          };
        }
        return { code: 0, stdout: '[{"databaseId":40}]', stderr: "" };
      }
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      failure: {
        code: "verify-dispatch-failed",
        evidence: expect.stringContaining("HTTP 422")
      },
      verification: { accountUnavailablePhase: "dispatch" }
    });
  });

  it("maps a dispatch authorization refusal to the selected account", async () => {
    const target = operation();
    const dependencies = runnerDependencies({
      run: async (args) =>
        args[0] === "workflow" ?
          {
            code: 1,
            stdout: "",
            stderr: "gh: Forbidden (HTTP 403)"
          }
        : { code: 0, stdout: '[{"databaseId":40}]', stderr: "" }
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      failure: {
        code: "verification-retry-github-account-unavailable",
        evidence: expect.stringContaining("HTTP 403")
      },
      verification: { accountUnavailablePhase: "dispatch" }
    });
  });

  it("fails retryably when the dispatch journal cannot be saved", async () => {
    const target = operation();
    const dependencies = runnerDependencies({
      persistJournal: () => Promise.reject(new Error("disk unavailable"))
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      failure: {
        code: "verification-retry-persist-failed",
        evidence: expect.stringContaining("disk unavailable")
      },
      verification: { accountUnavailablePhase: "acquisition" }
    });
    expect(
      dependencies.journal.calls.filter((entry) => entry.args[0] === "workflow")
    ).toEqual([]);
  });

  it("resumes a confirmed run when its first acknowledgement cannot be saved", async () => {
    const target = operation();
    let persists = 0;
    const dependencies = runnerDependencies({
      persistJournal: async () => {
        persists += 1;
        if (persists === 2) throw new Error("disk unavailable after dispatch");
      }
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(
      dependencies.journal.calls.filter((entry) => entry.args[0] === "workflow")
    ).toHaveLength(1);
    expect(target).toMatchObject({
      failure: {
        code: "verification-retry-persist-failed",
        evidence: expect.stringContaining("disk unavailable after dispatch")
      },
      verification: {
        accountUnavailablePhase: "dispatch",
        runId: "41",
        runUrl: "https://github.com/contoso/store/actions/runs/41"
      }
    });

    target.state = "running";
    target.endedAt = null;
    target.failure = null;
    await runVerificationRetry(target, "cmd-2", dependencies);

    expect(
      dependencies.journal.calls.filter((entry) => entry.args[0] === "workflow")
    ).toHaveLength(1);
    expect(dependencies.journal.monitored).toEqual(["op_retry"]);
    expect(dependencies.journal.steps).toContainEqual({
      text: "✅ Resuming the previously identified verify workflow run.",
      stage: "verify"
    });
  });

  it("surfaces authorization failure during acknowledged-run discovery", async () => {
    const target = operation();
    const dependencies = runnerDependencies({
      run: async (args) => {
        if (args[0] === "workflow") {
          return { code: 0, stdout: "", stderr: "" };
        }
        const json = args[args.indexOf("--json") + 1];
        return json === "databaseId" ?
            { code: 0, stdout: '[{"databaseId":40}]', stderr: "" }
          : {
              code: 1,
              stdout: "",
              stderr: "gh: Forbidden (HTTP 403)"
            };
      }
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      failure: {
        code: "verification-retry-github-account-unavailable",
        evidence: expect.stringContaining("HTTP 403")
      },
      verification: { accountUnavailablePhase: "dispatch" }
    });
  });

  it.each([
    {
      name: "a transient run-list failure",
      result: {
        code: 1,
        stdout: "",
        stderr: "gh: Service Unavailable (HTTP 503)"
      },
      guidance: "could not read verification runs"
    },
    {
      name: "an unreadable run list",
      result: { code: 0, stdout: "not-json", stderr: "" },
      guidance: "unreadable verification run list"
    },
    {
      name: "a new run with the wrong marker",
      result: {
        code: 0,
        stdout: JSON.stringify([
          {
            databaseId: 41,
            createdAt: new Date(NOW).toISOString(),
            displayTitle: "Radius verify dev [another-operation]",
            event: "workflow_dispatch",
            headBranch: "main"
          }
        ]),
        stderr: ""
      },
      guidance: "could not identify exactly one verification run"
    },
    {
      name: "no visible post-dispatch run",
      result: { code: 0, stdout: "[]", stderr: "" },
      guidance: "No exact verification run appeared"
    }
  ])("hands off $name without adopting a run", async (scenario) => {
    const target = operation();
    const dependencies = runnerDependencies({
      run: async (args) => {
        if (args[0] === "workflow") {
          return { code: 0, stdout: "", stderr: "" };
        }
        const json = args[args.indexOf("--json") + 1];
        return json === "databaseId" ?
            { code: 0, stdout: '[{"databaseId":40}]', stderr: "" }
          : scenario.result;
      }
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      state: "failed_partial",
      failure: {
        code: "provider-reconciliation-manual-required",
        message: expect.stringContaining(scenario.guidance)
      }
    });
    expect(dependencies.journal.monitored).toEqual([]);
  });

  it("hands off ambiguous exact runs without monitoring either one", async () => {
    const target = operation();
    const ambiguous = JSON.stringify([
      JSON.parse(exactRun(41))[0],
      JSON.parse(exactRun(42))[0]
    ]);
    const dependencies = runnerDependencies({
      run: async (args) => {
        if (args[0] === "workflow") {
          return { code: 0, stdout: "", stderr: "" };
        }
        const json = args[args.indexOf("--json") + 1];
        return json === "databaseId" ?
            { code: 0, stdout: '[{"databaseId":40}]', stderr: "" }
          : { code: 0, stdout: ambiguous, stderr: "" };
      }
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      state: "failed_partial",
      failure: {
        code: "provider-reconciliation-manual-required",
        message: expect.stringContaining(
          "could not identify exactly one verification run"
        )
      }
    });
    expect(dependencies.journal.monitored).toEqual([]);
  });

  it("keeps a manual reconciliation disposition when its persistence fails", async () => {
    const target = operation();
    const ambiguous = JSON.stringify([
      JSON.parse(exactRun(41))[0],
      JSON.parse(exactRun(42))[0]
    ]);
    let persists = 0;
    const dependencies = runnerDependencies({
      run: async (args) => {
        if (args[0] === "workflow") {
          return { code: 0, stdout: "", stderr: "" };
        }
        const json = args[args.indexOf("--json") + 1];
        return json === "databaseId" ?
            { code: 0, stdout: '[{"databaseId":40}]', stderr: "" }
          : { code: 0, stdout: ambiguous, stderr: "" };
      },
      persistJournal: async () => {
        persists += 1;
        if (persists === 3) throw new Error("disk unavailable");
      }
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      failure: {
        code: "provider-mutation-manual-required",
        message: expect.stringContaining(
          "could not identify exactly one verification run"
        )
      },
      verification: { accountUnavailablePhase: "dispatch" }
    });
  });

  it("accepts the returned run identity without an operation marker", async () => {
    const target = operation({
      verification: {
        workflow: "radius-verify-credentials.yml",
        ref: "main",
        environment: "dev",
        operationMarker: ""
      }
    });
    const dependencies = runnerDependencies();

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      verification: {
        runId: "41",
        runUrl: "https://github.com/contoso/store/actions/runs/41"
      }
    });
    expect(dependencies.journal.sleeps).toEqual([]);
  });

  it("always releases the selected executor after monitoring fails", async () => {
    const target = operation({
      verification: {
        workflow: "radius-verify-credentials.yml",
        ref: "main",
        environment: "dev",
        runId: "41",
        accountUnavailablePhase: "monitor",
        acquisitionDeadline: NOW + 1000
      }
    });
    const dependencies = runnerDependencies({
      monitor: () => Promise.reject(new Error("monitor failed"))
    });

    await expect(
      runVerificationRetry(target, "cmd-1", dependencies)
    ).rejects.toThrow("monitor failed");
    expect(dependencies.journal.unregistered).toEqual(["op_retry"]);
  });

  it("ignores a retry task that already ended", async () => {
    const target = operation({ endedAt: "finished" });
    const createExecutor = vi.fn();
    const dependencies = runnerDependencies({ createExecutor });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(createExecutor).not.toHaveBeenCalled();
  });
});
