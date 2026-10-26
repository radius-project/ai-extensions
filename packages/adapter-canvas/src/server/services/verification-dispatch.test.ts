import { describe, expect, it, vi } from "vitest";
import { assertSetupExecutionActive } from "@radius-project/core";
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
const MUTATION_TARGET = `octo/app:${WORKFLOW}:main:dev`;

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
        dispatchMutationTarget: MUTATION_TARGET,
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
      target: MUTATION_TARGET,
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
  it.each(["baseline", "send-boundary"] as const)(
    "fences shutdown queued between the %s observer and its caller continuation",
    async (boundary) => {
      const test = harness({ dispatches: [] });
      let stopped = false;
      test.ports.isStopped = () => stopped;
      const shutdownAfterObservation = () => {
        queueMicrotask(() =>
          queueMicrotask(() => {
            stopped = true;
          })
        );
      };
      if (boundary === "baseline") {
        test.ports.runGh = async () => {
          shutdownAfterObservation();
          return command({ stdout: "[]" });
        };
      } else {
        test.ports.stopBoundary = async () => {
          shutdownAfterObservation();
          return true;
        };
      }
      await expect(test.run()).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      expect(test.sendDispatch).not.toHaveBeenCalled();
      expect(test.op.endedAt).toBeNull();
      if (boundary === "baseline") {
        expect(test.op.verification).toBeUndefined();
        expect(test.persisted).toEqual([]);
      } else {
        expect(test.persisted.at(-1)?.status).toBe("not_applied");
      }
    }
  );
  it("does not create an intent or observe GitHub when already shut down", async () => {
    const test = harness({ dispatches: [] });
    test.ports.isStopped = () => true;
    await expect(test.run()).rejects.toMatchObject({
      code: "setup-execution-interrupted"
    });
    expect(test.runGh).not.toHaveBeenCalled();
    expect(test.persisted).toEqual([]);
    expect(test.op.providerRecovery.mutations).toEqual([]);
  });

  it.each(["valid", "empty", "malformed", "denied", "error"] as const)(
    "discards a late %s baseline without preparing an intent",
    async (result) => {
      const test = harness({ dispatches: [] });
      const gate = deferred();
      const entered = deferred();
      let stopped = false;
      test.ports.isStopped = () => stopped;
      test.runGh.mockImplementation(async () => {
        entered.resolve();
        await gate.promise;
        if (result === "error") throw new Error("read failed");
        return command({
          code: result === "denied" ? 1 : 0,
          stdout:
            result === "valid" ? '[{"databaseId":1}]'
            : result === "empty" ? "[]"
            : "invalid"
        });
      });
      const pending = test.run();
      const assertion = expect(pending).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      await entered.promise;
      stopped = true;
      gate.resolve();
      await assertion;
      expect(test.sendDispatch).not.toHaveBeenCalled();
      expect(test.persisted).toEqual([]);
      expect(test.op.verification).toBeUndefined();
    }
  );

  it.each(["intent", "boundary", "boundary-error"] as const)(
    "settles the unsent intent when shutdown interrupts %s",
    async (boundary) => {
      const test = harness({ dispatches: [] });
      let stopped = false;
      test.ports.isStopped = () => stopped;
      const persist = test.ports.persist;
      test.ports.persist = async () => {
        await persist();
        if (boundary === "intent") stopped = true;
      };
      test.ports.stopBoundary = async () => {
        stopped = true;
        if (boundary === "boundary-error") throw new Error("late Stop read");
        return true;
      };
      await expect(test.run()).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      expect(test.sendDispatch).not.toHaveBeenCalled();
      expect(test.persisted.map((entry) => entry.status)).toEqual([
        "prepared",
        "not_applied"
      ]);
      expect(test.op.endedAt).toBeNull();
    }
  );

  it.each(["success", "timeout", "throw", "malformed", "rejected"] as const)(
    "persists the actual %s acknowledgement before interrupting",
    async (outcome) => {
      const test = harness({ dispatches: [] });
      let stopped = false;
      test.ports.isStopped = () => stopped;
      test.sendDispatch.mockImplementation(async () => {
        stopped = true;
        if (outcome === "throw") throw new Error("connection reset");
        return command({
          code: outcome === "timeout" || outcome === "rejected" ? 1 : 0,
          timedOut: outcome === "timeout",
          stdout:
            outcome === "success" ?
              "https://github.com/octo/app/actions/runs/42"
            : "unreadable",
          stderr: outcome === "rejected" ? "HTTP 403" : ""
        });
      });
      await expect(test.run()).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      expect(test.runGh).toHaveBeenCalledOnce();
      expect(test.sendDispatch).toHaveBeenCalledOnce();
      expect(test.persisted.at(-1)?.status).toBe(
        outcome === "success" ? "confirmed"
        : outcome === "rejected" ? "not_applied"
        : "outcome_unknown"
      );
      expect(test.op.endedAt).toBeNull();
      expect(test.op.failure).toBeNull();
    }
  );

  it.each([
    "success",
    "empty",
    "malformed",
    "denied",
    "error",
    "wait",
    "registration-wait"
  ] as const)(
    "does not publish or read again after shutdown at reconciliation %s",
    async (boundary) => {
      const test = harness({
        dispatches: [
          command({
            code: 1,
            timedOut: boundary !== "registration-wait",
            stderr:
              boundary === "registration-wait" ?
                "HTTP 404: workflow not found on branch main"
              : "timeout"
          })
        ]
      });
      const entered = deferred();
      const gate = deferred();
      let stopped = false;
      test.ports.isStopped = () => stopped;
      const originalRead = test.ports.runGh;
      test.ports.runGh = async (args) => {
        if (args.includes("databaseId")) return originalRead(args);
        if (boundary === "wait") return command({ stdout: "[]" });
        entered.resolve();
        await gate.promise;
        if (boundary === "error") throw new Error("listing failed");
        return command({
          code: boundary === "denied" ? 1 : 0,
          stdout:
            boundary === "success" ? JSON.stringify([exactRun()])
            : boundary === "empty" ? "[]"
            : "invalid"
        });
      };
      test.ports.sleep = async () => {
        entered.resolve();
        await gate.promise;
      };
      const identity = vi.spyOn(test.ports, "applyIdentity");
      const pending = expect(test.run()).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      await entered.promise;
      stopped = true;
      gate.resolve();
      await pending;
      expect(test.sendDispatch).toHaveBeenCalledOnce();
      expect(identity).toHaveBeenCalledOnce();
      expect(test.persisted.at(-1)?.status).toBe(
        boundary === "registration-wait" ? "not_applied" : "outcome_unknown"
      );
      expect(test.op.endedAt).toBeNull();
    }
  );

  it.each(["intent", "unsent", "acknowledgement"] as const)(
    "does not hide %s persistence rejection behind shutdown",
    async (phase) => {
      const test = harness({
        dispatches: [command({ code: 1, timedOut: true })]
      });
      let stopped = false;
      test.ports.isStopped = () => stopped;
      let writes = 0;
      test.ports.persist = async () => {
        writes++;
        if (phase === "unsent" && writes === 1) {
          stopped = true;
          return;
        }
        if (phase === "intent" || writes === 2) {
          stopped = true;
          throw new Error("journal offline");
        }
      };
      await expect(test.run()).rejects.toMatchObject({
        code: "provider-mutation-recovery-persistence-failed"
      });
      expect(test.sendDispatch).toHaveBeenCalledTimes(
        phase === "acknowledgement" ? 1 : 0
      );
    }
  );

  it("preserves typed interruption from a persistence boundary", async () => {
    const test = harness({ dispatches: [] });
    const persist = test.ports.persist;
    let interrupted = false;
    test.ports.persist = async () => {
      if (!interrupted) {
        interrupted = true;
        assertSetupExecutionActive(() => true);
      }
      await persist();
    };
    await expect(test.run()).rejects.toMatchObject({
      code: "setup-execution-interrupted"
    });
    expect(test.sendDispatch).not.toHaveBeenCalled();
    expect(test.persisted.at(-1)?.status).toBe("not_applied");
  });

  it("refuses a new command target while a previous dispatch is unresolved", async () => {
    const test = harness({ dispatches: [] });
    const prior = prepareProviderMutation(test.op, {
      kind: "github_workflow.dispatch_retry",
      target: "previous-command",
      intent: {}
    });
    settleProviderMutation(
      test.op,
      prior.mutationId,
      "outcome_unknown",
      "timeout"
    );
    await expect(test.run()).resolves.toMatchObject({
      state: "manual_required"
    });
    expect(test.runGh).not.toHaveBeenCalled();
    expect(test.sendDispatch).not.toHaveBeenCalled();
    expect(test.op.providerRecovery.mutations).toHaveLength(1);
  });

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

  it("reuses a confirmed run identity without provider I/O", async () => {
    const test = harness({
      dispatches: [
        command({
          stdout: "https://github.com/octo/app/actions/runs/123\n"
        })
      ]
    });
    await test.run();
    test.runGh.mockClear();
    test.sendDispatch.mockClear();
    const persistCount = test.persisted.length;

    await expect(test.run()).resolves.toEqual({
      state: "accepted",
      runId: "123",
      runUrl: "https://github.com/octo/app/actions/runs/123",
      recovered: true
    });

    expect(test.runGh).not.toHaveBeenCalled();
    expect(test.sendDispatch).not.toHaveBeenCalled();
    expect(test.persisted).toHaveLength(persistCount);
  });

  it("fails closed when a confirmed run identity does not match its mutation", async () => {
    const test = harness({
      dispatches: [
        command({
          stdout: "https://github.com/octo/app/actions/runs/123\n"
        })
      ]
    });
    await test.run();
    test.op.verification.runUrl =
      "https://github.com/octo/app/actions/runs/124";
    test.runGh.mockClear();
    test.sendDispatch.mockClear();

    await expect(test.run()).resolves.toMatchObject({
      state: "manual_required"
    });

    expect(test.runGh).not.toHaveBeenCalled();
    expect(test.sendDispatch).not.toHaveBeenCalled();
    expect(test.op.state).toBe("failed_partial");
  });

  it.each(["", "not-a-run-url"])(
    "fails closed when a confirmed run identity has an invalid URL (%j)",
    async (runUrl) => {
      const test = harness({
        dispatches: [
          command({
            stdout: "https://github.com/octo/app/actions/runs/123\n"
          })
        ]
      });
      await test.run();
      test.op.verification.runUrl = runUrl;
      test.runGh.mockClear();
      test.sendDispatch.mockClear();

      await expect(test.run()).resolves.toMatchObject({
        state: "manual_required"
      });

      expect(test.runGh).not.toHaveBeenCalled();
      expect(test.sendDispatch).not.toHaveBeenCalled();
    }
  );

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

  it("treats a SAML authorization refusal as conclusively not applied", async () => {
    const rejected = command({
      code: 1,
      stderr:
        "Resource protected by organization SAML enforcement. You must grant your OAuth token access."
    });
    const test = harness({ dispatches: [rejected] });

    await expect(test.run()).resolves.toMatchObject({
      state: "rejected",
      result: rejected
    });

    expect(test.sendDispatch).toHaveBeenCalledOnce();
    expect(test.runGh).toHaveBeenCalledOnce();
    expect(test.op.providerRecovery.mutations[0]).toMatchObject({
      status: "not_applied",
      initialDiagnostic: expect.stringContaining("SAML enforcement"),
      finalDiagnostic: expect.stringContaining("SAML enforcement")
    });
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
      target: MUTATION_TARGET
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
