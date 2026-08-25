import { describe, expect, it, vi } from "vitest";
import type { SelectedGhExecutor } from "../../gh.js";
import {
  prepareProviderMutation,
  settleProviderMutation
} from "../../operations.js";
import {
  isGitHubRateLimitError,
  isSelectedGhAuthorizationError,
  SelectedGhAuthorizationError
} from "../../deploy.js";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import {
  parseVerificationBaselineRunId,
  resolveAcknowledgedVerificationRun,
  runVerificationRetry,
  type VerificationRetryRunnerDependencies
} from "./verification-retry-runner.js";
import type { VerificationRetryOperation } from "./verification-retry.js";

const NOW = Date.parse("2026-08-25T00:00:00Z");
const TRACKING_WINDOW_MS = 45 * 60 * 1000;

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
      return { code: 0, stdout: "", stderr: "" };
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
    sleeps: []
  };
  const executor = successfulSelectedGhExecutor({
    login: "alice",
    run: overrides.run || defaultRun(journal)
  });
  const base: VerificationRetryRunnerDependencies = {
    createExecutor: () => Promise.resolve(executor),
    registerExecutor: (operationId) => {
      journal.registered.push(operationId);
    },
    unregisterExecutor: (operationId) => {
      journal.unregistered.push(operationId);
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
      "workflow",
      "run"
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
    expect(dependencies.journal.sleeps).toEqual([5000]);
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

  it("reconciles an unresolved dispatch without sending it again", async () => {
    const target = operation();
    const mutationTarget =
      "contoso/store:radius-verify-credentials.yml:main:dev:cmd-1";
    const mutation = prepareProviderMutation(target, {
      kind: "github_workflow.dispatch_retry",
      target: mutationTarget,
      providerIdempotencyKey: "op_retry"
    });
    settleProviderMutation(
      target,
      mutation.mutationId,
      "outcome_unknown",
      "response lost"
    );
    target.verification = {
      ...(target.verification || {}),
      dispatchMutationTarget: mutationTarget,
      accountUnavailablePhase: "dispatch",
      baselineRunId: 40
    };
    const dependencies = runnerDependencies();

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(
      dependencies.journal.calls.filter((entry) => entry.args[0] === "workflow")
    ).toEqual([]);
    expect(target.verification).toMatchObject({ runId: "41" });
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

  it("preserves a possibly accepted dispatch when its acknowledgement cannot be saved", async () => {
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
      verification: { accountUnavailablePhase: "dispatch" }
    });
  });

  it("surfaces authorization failure while reconciling an unresolved dispatch", async () => {
    const target = operation();
    const mutationTarget =
      "contoso/store:radius-verify-credentials.yml:main:dev:cmd-1";
    const mutation = prepareProviderMutation(target, {
      kind: "github_workflow.dispatch_retry",
      target: mutationTarget,
      providerIdempotencyKey: "op_retry"
    });
    settleProviderMutation(
      target,
      mutation.mutationId,
      "outcome_unknown",
      "response lost"
    );
    target.verification = {
      ...(target.verification || {}),
      dispatchMutationTarget: mutationTarget,
      accountUnavailablePhase: "dispatch",
      baselineRunId: 40
    };
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
      guidance: "could not confirm the exact marked run"
    },
    {
      name: "an unreadable run list",
      result: { code: 0, stdout: "not-json", stderr: "" },
      guidance: "could not confirm the exact marked run"
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
      guidance: "none matches this operation's exact"
    },
    {
      name: "no visible post-dispatch run",
      result: { code: 0, stdout: "[]", stderr: "" },
      guidance: "could not confirm the exact marked run"
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
      state: "action_required",
      terminal: {
        reason: "verification-run-manual",
        userMessage: expect.stringContaining(scenario.guidance)
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
      state: "action_required",
      terminal: {
        reason: "verification-run-manual",
        userMessage: expect.stringContaining("Multiple verification retry runs")
      }
    });
    expect(dependencies.journal.monitored).toEqual([]);
  });

  it("keeps a manual reconciliation disposition when its persistence fails", async () => {
    const target = operation();
    const mutationTarget =
      "contoso/store:radius-verify-credentials.yml:main:dev:cmd-1";
    const mutation = prepareProviderMutation(target, {
      kind: "github_workflow.dispatch_retry",
      target: mutationTarget,
      providerIdempotencyKey: "op_retry"
    });
    settleProviderMutation(
      target,
      mutation.mutationId,
      "outcome_unknown",
      "response lost"
    );
    target.verification = {
      ...(target.verification || {}),
      dispatchMutationTarget: mutationTarget,
      accountUnavailablePhase: "dispatch",
      baselineRunId: 40
    };
    const ambiguous = JSON.stringify([
      JSON.parse(exactRun(41))[0],
      JSON.parse(exactRun(42))[0]
    ]);
    const dependencies = runnerDependencies({
      run: async () => ({ code: 0, stdout: ambiguous, stderr: "" }),
      persistJournal: () => Promise.reject(new Error("disk unavailable"))
    });

    await runVerificationRetry(target, "cmd-1", dependencies);

    expect(target).toMatchObject({
      failure: {
        code: "provider-mutation-manual-required",
        message: expect.stringContaining("Multiple verification retry runs")
      },
      verification: { accountUnavailablePhase: "dispatch" }
    });
  });

  it("propagates an unreadable unresolved dispatch for server-owned recovery", async () => {
    const target = operation();
    const mutationTarget =
      "contoso/store:radius-verify-credentials.yml:main:dev:cmd-1";
    const mutation = prepareProviderMutation(target, {
      kind: "github_workflow.dispatch_retry",
      target: mutationTarget,
      providerIdempotencyKey: "op_retry"
    });
    settleProviderMutation(
      target,
      mutation.mutationId,
      "outcome_unknown",
      "response lost"
    );
    target.verification = {
      ...(target.verification || {}),
      dispatchMutationTarget: mutationTarget,
      accountUnavailablePhase: "dispatch",
      baselineRunId: 40
    };
    const dependencies = runnerDependencies({
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "gh: Service Unavailable (HTTP 503)"
      })
    });

    await expect(
      runVerificationRetry(target, "cmd-1", dependencies)
    ).rejects.toMatchObject({
      code: "provider-mutation-outcome-unknown"
    });
    expect(dependencies.journal.unregistered).toEqual(["op_retry"]);
  });

  it("refuses to reconcile an unmarked unresolved dispatch", async () => {
    const target = operation();
    const mutationTarget =
      "contoso/store:radius-verify-credentials.yml:main:dev:cmd-1";
    const mutation = prepareProviderMutation(target, {
      kind: "github_workflow.dispatch_retry",
      target: mutationTarget
    });
    settleProviderMutation(
      target,
      mutation.mutationId,
      "outcome_unknown",
      "response lost"
    );
    target.verification = {
      ...(target.verification || {}),
      operationMarker: "",
      dispatchMutationTarget: mutationTarget,
      accountUnavailablePhase: "dispatch",
      baselineRunId: 40
    };
    const dependencies = runnerDependencies({
      run: async () => ({ code: 0, stdout: "[]", stderr: "" })
    });

    await expect(
      runVerificationRetry(target, "cmd-1", dependencies)
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required"
    });
    expect(dependencies.journal.unregistered).toEqual(["op_retry"]);
  });

  it("hands off an acknowledged legacy workflow instead of guessing a run", async () => {
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
      state: "action_required",
      terminal: { reason: "verification-run-manual" },
      verification: {
        runId: null,
        runUrl:
          "https://github.com/contoso/store/actions/workflows/radius-verify-credentials.yml"
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

describe("verification retry parsing and adoption", () => {
  it("reads the newest positive safe baseline id", () => {
    expect(
      parseVerificationBaselineRunId(
        '[{"databaseId":2},{"databaseId":7},{"databaseId":4}]'
      )
    ).toBe(7);
    expect(parseVerificationBaselineRunId("[]")).toBeNull();
  });

  it.each([
    "{}",
    '[{"databaseId":0}]',
    '[{"databaseId":1.5}]',
    '[{"databaseId":"2"}]',
    "[null]"
  ])("rejects malformed baseline JSON %s", (value) => {
    expect(() => parseVerificationBaselineRunId(value)).toThrow();
  });

  it("adopts one exact marked run after the acknowledgement delay", async () => {
    const pauses: number[] = [];
    await expect(
      resolveAcknowledgedVerificationRun({
        operationMarker: "op_retry",
        pause: async (milliseconds) => {
          pauses.push(milliseconds);
        },
        discover: async () => ({ state: "applied", value: "41" }),
        actionsUrl: "https://github.com/contoso/store/actions"
      })
    ).resolves.toEqual({ state: "applied", runId: "41" });
    expect(pauses).toEqual([5000]);
  });

  it("hands off discovery failures but rethrows authorization errors", async () => {
    const authorization = new SelectedGhAuthorizationError(
      "alice",
      403,
      "forbidden"
    );
    await expect(
      resolveAcknowledgedVerificationRun({
        operationMarker: "op_retry",
        pause: async () => {},
        discover: async () => {
          throw new Error("runs unavailable");
        },
        actionsUrl: "https://github.com/contoso/store/actions"
      })
    ).resolves.toMatchObject({ state: "manual_required" });
    await expect(
      resolveAcknowledgedVerificationRun({
        operationMarker: "op_retry",
        pause: async () => {},
        discover: async () => {
          throw authorization;
        },
        actionsUrl: "https://github.com/contoso/store/actions",
        isAuthorizationError: isSelectedGhAuthorizationError
      })
    ).rejects.toBe(authorization);
  });
});
