import { describe, expect, it, vi } from "vitest";
import {
  createOperation,
  prepareProviderMutation,
  recordCommittedWorkflowFile,
  settleProviderMutation,
  terminalizeProviderManualRequired
} from "../../operations.js";
import {
  hasFreshWorkflowWriteProvenance,
  isWorkflowRegistrationRejection,
  parseVerificationBaselineRunId,
  runVerificationDispatch,
  type VerificationDispatchPorts
} from "./verification-dispatch.js";

const WORKFLOW = "radius-verify-credentials.yml";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW}`;

function command(
  overrides: Partial<{
    code: string | number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }> = {}
) {
  return { code: 0, stdout: "", stderr: "", ...overrides };
}

function operation(withProvenance = true) {
  const value = createOperation({
    operationId: "op_test",
    provider: "azure",
    repo: "octo/app",
    environment: "dev"
  });
  if (withProvenance) {
    recordCommittedWorkflowFile(value, {
      path: WORKFLOW_PATH,
      branch: "main",
      mode: "default_branch",
      commitSha: "c".repeat(40),
      blobSha: "b".repeat(40),
      contentSha256: "a".repeat(64),
      previousBlobSha: null,
      previousBlobKnown: true
    });
  }
  return value;
}

function exactRun(id = 42) {
  return {
    databaseId: id,
    createdAt: new Date(100_000).toISOString(),
    displayTitle: "Radius verify dev [op_test]",
    event: "workflow_dispatch",
    headBranch: "main"
  };
}

function harness(input: {
  dispatches: ReturnType<typeof command>[];
  lists?: unknown[];
  withProvenance?: boolean;
  allowRegistrationRetry?: boolean;
  operationMarker?: string;
}) {
  const op = operation(input.withProvenance);
  const sleeps: number[] = [];
  const persisted: Array<{
    status: string | undefined;
    runId: unknown;
    state: unknown;
  }> = [];
  let listIndex = 0;
  const sendDispatch = vi.fn(async () => input.dispatches.shift()!);
  const runGh = vi.fn(async (args: string[]) => {
    if (args.includes("--limit") && args[args.indexOf("--limit") + 1] === "1") {
      return command({ stdout: "[]" });
    }
    const listed = input.lists?.[listIndex++] ?? [];
    return (
      (
        listed &&
        typeof listed === "object" &&
        "code" in listed &&
        "stdout" in listed
      ) ?
        listed
      : command({ stdout: JSON.stringify(listed) })) as ReturnType<
      typeof command
    >;
  });
  const ports: VerificationDispatchPorts = {
    runGh,
    sendDispatch,
    persist: async () => {
      persisted.push({
        status: op.providerRecovery?.mutations?.[0]?.status,
        runId: op.verification?.runId,
        state: op.state
      });
    },
    stopBoundary: async () => true,
    applyIdentity: (identity, run) => {
      op.verification = {
        ...identity,
        workflow: WORKFLOW,
        runId: run?.runId ?? null,
        runUrl: run?.runUrl ?? null
      };
    },
    terminalizeManualRequired: (guidance) =>
      terminalizeProviderManualRequired(op, guidance),
    now: () => 100_000,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    }
  };
  const run = () =>
    runVerificationDispatch({
      operation: op,
      kind: "github_workflow.dispatch",
      target: `octo/app:${WORKFLOW}:main:dev`,
      repo: "octo/app",
      workflowPath: WORKFLOW_PATH,
      workflowFile: WORKFLOW,
      environment: "dev",
      ref: "main",
      operationMarker: input.operationMarker ?? "op_test",
      allowRegistrationRetry: input.allowRegistrationRetry ?? true,
      ports
    });
  return { op, persisted, ports, run, runGh, sendDispatch, sleeps };
}

describe("verification dispatch", () => {
  it("persists the returned run identity with mutation confirmation", async () => {
    const test = harness({
      dispatches: [
        command({
          stdout: "https://github.com/octo/app/actions/runs/123\n"
        })
      ]
    });

    await expect(test.run()).resolves.toEqual({
      state: "accepted",
      runId: "123",
      runUrl: "https://github.com/octo/app/actions/runs/123",
      recovered: false
    });
    expect(test.sendDispatch).toHaveBeenCalledOnce();
    expect(test.runGh).toHaveBeenCalledOnce();
    expect(test.persisted.at(-1)).toEqual({
      status: "confirmed",
      runId: "123",
      state: "running"
    });
  });

  it("refuses to dispatch when the baseline fails or is unreadable", async () => {
    const failed = harness({ dispatches: [command()] });
    failed.runGh.mockResolvedValueOnce(
      command({ code: 1, stderr: "Actions unavailable" })
    );
    const unreadable = harness({ dispatches: [command()] });
    unreadable.runGh.mockResolvedValueOnce(command({ stdout: "<html>" }));

    await expect(failed.run()).resolves.toMatchObject({
      state: "baseline_failed",
      unreadable: false
    });
    await expect(unreadable.run()).resolves.toMatchObject({
      state: "baseline_failed",
      unreadable: true
    });
    expect(failed.sendDispatch).not.toHaveBeenCalled();
    expect(unreadable.sendDispatch).not.toHaveBeenCalled();
  });

  it("settles a stopped attempt without dispatching", async () => {
    const test = harness({ dispatches: [command()] });
    test.ports.stopBoundary = async () => false;

    await expect(test.run()).resolves.toEqual({ state: "cancelled" });

    expect(test.sendDispatch).not.toHaveBeenCalled();
    expect(test.op.providerRecovery.mutations[0].status).toBe("not_applied");
  });

  it("reconciles a thrown transport failure without redispatch", async () => {
    const test = harness({
      dispatches: [command()],
      lists: [[exactRun(126)]]
    });
    test.sendDispatch.mockRejectedValueOnce(new Error("connection reset"));

    await expect(test.run()).resolves.toMatchObject({
      state: "accepted",
      runId: "126",
      recovered: true
    });

    expect(test.sendDispatch).toHaveBeenCalledOnce();
    expect(test.op.providerRecovery.mutations[0]).toMatchObject({
      initialDiagnostic: expect.stringContaining("connection reset"),
      finalDiagnostic: expect.stringContaining("exact operation-marked")
    });
  });

  it("requires manual action when an ambiguous legacy dispatch has no marker", async () => {
    const test = harness({
      dispatches: [
        command({ code: 1, stderr: "request timed out", timedOut: true })
      ],
      lists: [[]],
      operationMarker: ""
    });

    await expect(test.run()).resolves.toMatchObject({
      state: "manual_required",
      guidance: expect.stringContaining("does not expose")
    });

    expect(test.sendDispatch).toHaveBeenCalledOnce();
    expect(test.op.state).toBe("failed_partial");
  });

  it("retries qualified registration rejections with bounded backoff", async () => {
    const test = harness({
      dispatches: [
        command({
          code: 1,
          stderr:
            "HTTP 404: workflow radius-verify-credentials.yml not found on branch main"
        }),
        command({
          code: 1,
          stderr: 'HTTP 422: Unexpected inputs provided: ["radius_operation"]'
        }),
        command({
          stdout: "https://github.com/octo/app/actions/runs/124"
        })
      ]
    });

    await expect(test.run()).resolves.toMatchObject({
      state: "accepted",
      runId: "124"
    });
    expect(test.sendDispatch).toHaveBeenCalledTimes(3);
    expect(test.sleeps).toEqual([2000, 5000]);
    expect(test.runGh).toHaveBeenCalledOnce();
  });

  it("adopts an exact run after an ambiguous timeout without redispatch", async () => {
    const test = harness({
      dispatches: [
        command({ code: 1, stderr: "request timed out", timedOut: true })
      ],
      lists: [[exactRun(125)]]
    });

    await expect(test.run()).resolves.toEqual({
      state: "accepted",
      runId: "125",
      runUrl: "https://github.com/octo/app/actions/runs/125",
      recovered: true
    });
    expect(test.sendDispatch).toHaveBeenCalledOnce();
    expect(test.op.providerRecovery.mutations[0]).toMatchObject({
      status: "confirmed",
      providerId: "125",
      initialDiagnostic: expect.stringContaining("timing out"),
      finalDiagnostic: expect.stringContaining("exact operation-marked")
    });
  });

  it("terminalizes when no exact run appears after an ambiguous timeout", async () => {
    const test = harness({
      dispatches: [
        command({ code: 1, stderr: "request timed out", timedOut: true })
      ],
      lists: [[], [], []]
    });

    await expect(test.run()).resolves.toMatchObject({
      state: "manual_required"
    });
    expect(test.sendDispatch).toHaveBeenCalledOnce();
    expect(test.sleeps).toEqual([2000, 5000]);
    expect(test.op).toMatchObject({
      state: "failed_partial",
      endedAt: expect.any(String),
      recoveryState: "manual_required",
      failure: {
        code: "provider-reconciliation-manual-required"
      },
      providerRecovery: {
        state: "manual_required",
        mutations: [
          expect.objectContaining({
            status: "manual_required",
            initialDiagnostic: expect.stringContaining("timing out"),
            finalDiagnostic: expect.stringContaining("No verification run")
          })
        ]
      }
    });
    expect(test.persisted.at(-1)?.state).toBe("failed_partial");
  });

  it("treats malformed successful output as ambiguous", async () => {
    const test = harness({
      dispatches: [command({ stdout: "" })],
      lists: [[], [], []]
    });

    await expect(test.run()).resolves.toMatchObject({
      state: "manual_required"
    });
    expect(test.sendDispatch).toHaveBeenCalledOnce();
    expect(test.op.providerRecovery.mutations[0].initialDiagnostic).toContain(
      "exited with 0"
    );
  });

  it("does not retry generic validation failures", async () => {
    const rejected = command({
      code: 1,
      stderr: "HTTP 422: Validation Failed: invalid ref"
    });
    const test = harness({ dispatches: [rejected] });

    await expect(test.run()).resolves.toMatchObject({
      state: "rejected",
      result: rejected
    });
    expect(test.sendDispatch).toHaveBeenCalledOnce();
  });

  it("does not retry without fresh workflow provenance or retry permission", async () => {
    const rejection = command({
      code: 1,
      stderr:
        "HTTP 404: workflow radius-verify-credentials.yml not found on branch main"
    });
    const withoutProof = harness({
      dispatches: [rejection],
      withProvenance: false
    });
    const retryRunner = harness({
      dispatches: [rejection],
      allowRegistrationRetry: false
    });

    await expect(withoutProof.run()).resolves.toMatchObject({
      state: "rejected"
    });
    await expect(retryRunner.run()).resolves.toMatchObject({
      state: "rejected"
    });
    expect(withoutProof.sendDispatch).toHaveBeenCalledOnce();
    expect(retryRunner.sendDispatch).toHaveBeenCalledOnce();
  });

  it("terminalizes a restored unresolved dispatch without provider reads or writes", async () => {
    const test = harness({
      dispatches: [
        command({
          stdout: "https://github.com/octo/app/actions/runs/999"
        })
      ]
    });
    const mutation = prepareProviderMutation(test.op, {
      kind: "github_workflow.dispatch",
      target: `octo/app:${WORKFLOW}:main:dev`
    });
    settleProviderMutation(
      test.op,
      mutation.mutationId,
      "outcome_unknown",
      "response lost"
    );

    await expect(test.run()).resolves.toMatchObject({
      state: "manual_required"
    });
    expect(test.runGh).not.toHaveBeenCalled();
    expect(test.sendDispatch).not.toHaveBeenCalled();
    expect(test.op.state).toBe("failed_partial");
  });
});

describe("verification dispatch guards", () => {
  it("requires exact workflow provenance", () => {
    const op = operation();
    expect(hasFreshWorkflowWriteProvenance(op, WORKFLOW_PATH, "main")).toBe(
      true
    );
    expect(hasFreshWorkflowWriteProvenance(op, WORKFLOW_PATH, "other")).toBe(
      false
    );
  });

  it.each([
    ["HTTP 404: workflow verify.yml not found on branch main", true],
    ['HTTP 422: Unexpected inputs provided: ["radius_operation"]', true],
    ["HTTP 422: Validation Failed: invalid ref", false],
    ["HTTP 404: repository not found", false],
    ["HTTP 500: workflow not found on branch main", false],
    ["request timed out; HTTP 404: workflow not found on branch main", false]
  ])("classifies %s", (stderr, expected) => {
    expect(
      isWorkflowRegistrationRejection(command({ code: 1, stderr }), true)
    ).toBe(expected);
  });

  it("parses a strict baseline", () => {
    expect(parseVerificationBaselineRunId("[]")).toBeNull();
    expect(
      parseVerificationBaselineRunId('[{"databaseId":2},{"databaseId":4}]')
    ).toBe(4);
    expect(() => parseVerificationBaselineRunId("{}")).toThrow("non-array");
    expect(() =>
      parseVerificationBaselineRunId('[{"databaseId":"4"}]')
    ).toThrow("valid databaseId");
  });
});
