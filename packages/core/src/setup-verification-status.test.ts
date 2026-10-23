import { describe, expect, it, vi } from "vitest";
import {
  isAzureRbacVerificationFailure,
  readSetupVerificationStatus,
  type SetupVerificationReadRequest,
  type SetupVerificationStatusPorts
} from "./setup-verification-status.js";

const input = {
  repo: "fixture/app",
  environment: "dev",
  operationId: "setup-1"
};

function fixture(
  overrides: Partial<
    SetupVerificationStatusPorts<
      { login: string },
      SetupVerificationReadRequest
    >
  > = {}
) {
  const operation = {
    ...input,
    state: "running",
    currentStage: "verify",
    context: { githubLogin: "saved-account" },
    verification: {
      runId: "17",
      dispatchedAt: 100,
      dispatchMutationTarget: "fixture/app:verify:topic:dev",
      retryCommandId: "retry-1"
    }
  };
  const executor = { login: "saved-account" };
  const request: SetupVerificationReadRequest = {};
  const ports: SetupVerificationStatusPorts<
    typeof executor,
    SetupVerificationReadRequest
  > = {
    prepare: vi.fn(),
    getOperation: () => operation,
    resolveRunId: (op) => {
      const id = op?.verification?.runId;
      return typeof id === "string" || typeof id === "number" ? id : null;
    },
    getSelectedGitHubExecutor: () => executor,
    isSelectedGitHubAuthorizationError: () => false,
    hasCompleteVerificationIdentity: () => true,
    observe: () => request,
    observationStopped: () => false,
    readLimitReason: () => undefined,
    getRunDetail: vi.fn(async () => ({
      status: "completed",
      conclusion: "success"
    })),
    fetchRunLog: vi.fn(async () => ""),
    extractErrorLines: (log) => (log ? log.split("\n") : []),
    extractGitHubActionsStepLog: () => "",
    explainOidcEnterpriseClaim: () => "",
    explainNoSubscriptions: () => "",
    addLegacyStep: vi.fn(),
    isTerminalState: (state) => state === "succeeded" || state === "cancelled",
    finish: vi.fn(),
    finishSucceeded: vi.fn(() => {
      operation.state = "succeeded";
    }),
    persistBestEffort: async ({ persist }) => {
      await persist();
      return true;
    },
    persistOperations: vi.fn(async () => {}),
    reportOperationDiagnostic: vi.fn(),
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    stageVerify: "verify",
    redactDiagnostic: (value) => value,
    ...overrides
  };
  return { operation, executor, request, ports };
}

describe("direct core verification observation", () => {
  it.each(["success", "failure", "authorization"] as const)(
    "reports checkpoint failure without losing %s observation evidence",
    async (outcome) => {
      const diagnostic = {
        code: "checkpoint-failed",
        message: "Disk unavailable"
      };
      const { ports } = fixture({
        getRunDetail: async () => {
          if (outcome === "authorization") throw new Error("account denied");
          return { status: "completed", conclusion: outcome };
        },
        isSelectedGitHubAuthorizationError: () => outcome === "authorization",
        persistOperations: vi.fn(async () => {
          throw new Error(diagnostic.message);
        }),
        persistBestEffort: async ({ persist, report }) => {
          try {
            await persist();
            return true;
          } catch {
            report?.(diagnostic);
            return false;
          }
        }
      });
      expect(await readSetupVerificationStatus(input, ports)).toMatchObject({
        state: outcome === "success" ? "success" : "failed",
        runId: "17"
      });
      expect(ports.persistOperations).toHaveBeenCalledOnce();
      expect(ports.reportOperationDiagnostic).toHaveBeenCalledExactlyOnceWith(
        diagnostic
      );
    }
  );

  it.each(["removed", "cleared-run", "account-changed"] as const)(
    "does not publish an observation after its operation was %s",
    async (change) => {
      const { ports, operation } = fixture();
      ports.getRunDetail = async () => {
        if (change === "removed") ports.getOperation = () => undefined;
        else if (change === "cleared-run")
          ports.getOperation = () => ({ ...operation, verification: null });
        else operation.context.githubLogin = "replacement-account";
        return { status: "completed", conclusion: "success" };
      };
      expect(await readSetupVerificationStatus(input, ports)).toEqual({
        state: "pending",
        runId: change === "account-changed" ? "17" : null
      });
      expect(ports.finishSucceeded).not.toHaveBeenCalled();
      expect(ports.persistOperations).not.toHaveBeenCalled();
    }
  );

  it("keeps missing executor and run acquisition pending without a provider read", async () => {
    const { ports, operation } = fixture({
      getSelectedGitHubExecutor: () => undefined
    });
    operation.verification.runId = "";
    expect(await readSetupVerificationStatus(input, ports)).toEqual({
      state: "pending",
      runId: null
    });
    expect(ports.getRunDetail).not.toHaveBeenCalled();
  });

  it("leaves unreadable run evidence pending without inventing activity", async () => {
    const { ports } = fixture({ getRunDetail: async () => null });
    expect(await readSetupVerificationStatus(input, ports)).toEqual({
      state: "pending",
      runId: "17",
      runUrl: "https://github.com/fixture/app/actions/runs/17"
    });
    expect(ports.persistOperations).not.toHaveBeenCalled();
  });

  it("includes the affected component in a confirmed reachability failure", async () => {
    const { ports } = fixture({
      getRunDetail: async () => ({
        status: "completed",
        conclusion: "failure",
        steps: [{ name: "Verify AKS Access", conclusion: "failure" }]
      }),
      fetchRunLog: async () => "connection refused"
    });
    expect(await readSetupVerificationStatus(input, ports)).toMatchObject({
      state: "failed",
      category: "cluster-unreachable",
      component: "Kubernetes cluster"
    });
  });

  it("does not replace Stop with an authorization error arriving after cancellation", async () => {
    const { ports, operation } = fixture({
      isSelectedGitHubAuthorizationError: () => true
    });
    ports.getRunDetail = async () => {
      operation.state = "cancelled";
      throw new Error("late account error");
    };
    expect(await readSetupVerificationStatus(input, ports)).toEqual({
      state: "unknown",
      error: "late account error"
    });
    expect(ports.finish).not.toHaveBeenCalled();
    expect(ports.persistOperations).not.toHaveBeenCalled();
  });

  it("uses saved execution identity and persists verification success without deployment", async () => {
    const { ports, operation, executor, request } = fixture();
    expect(await readSetupVerificationStatus(input, ports)).toEqual({
      state: "success",
      runId: "17",
      runUrl: "https://github.com/fixture/app/actions/runs/17"
    });
    expect(ports.getRunDetail).toHaveBeenCalledExactlyOnceWith(
      input.repo,
      "17",
      executor,
      request
    );
    expect(ports.finishSucceeded).toHaveBeenCalledExactlyOnceWith(operation);
    expect(ports.persistOperations).toHaveBeenCalledOnce();
    expect(ports.fetchRunLog).not.toHaveBeenCalled();
    expect(ports.addLegacyStep).toHaveBeenCalledWith(
      operation,
      expect.stringContaining("Deploy your application")
    );
  });

  it.each([
    null,
    [],
    4,
    { context: [] },
    { verification: "invalid" },
    { repo: "wrong/repo" },
    { repo: input.repo, environment: "wrong" }
  ])("refuses a missing, malformed or mismatched operation: %j", async (op) => {
    const { ports } = fixture({ getOperation: () => op });
    expect(await readSetupVerificationStatus(input, ports)).toMatchObject({
      state: "expired",
      terminal: true
    });
    expect(ports.getRunDetail).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
  });

  it("reports missing repository before acquiring any observation", async () => {
    const { ports } = fixture();
    expect(
      await readSetupVerificationStatus({ ...input, repo: "" }, ports)
    ).toEqual({ state: "unknown", error: "No repository specified." });
    expect(ports.prepare).not.toHaveBeenCalled();
  });

  it("persists an explicit refusal when the saved account is missing", async () => {
    const { ports, operation } = fixture();
    operation.context.githubLogin = " ";
    expect(await readSetupVerificationStatus(input, ports)).toMatchObject({
      state: "failed",
      terminal: true,
      code: "verification-retry-github-account-missing"
    });
    expect(ports.finish).toHaveBeenCalledWith(
      operation,
      "failed_partial",
      expect.any(Object)
    );
    expect(ports.persistOperations).toHaveBeenCalledOnce();
    expect(ports.getRunDetail).not.toHaveBeenCalled();
  });

  it("does not acquire a run when saved dispatch identity is incomplete", async () => {
    const { ports } = fixture({ hasCompleteVerificationIdentity: () => false });
    expect(await readSetupVerificationStatus(input, ports)).toMatchObject({
      state: "expired",
      terminal: true,
      error: "The verification operation has incomplete dispatch identity."
    });
    expect(ports.getRunDetail).not.toHaveBeenCalled();
  });

  it.each(["executor", "run"] as const)(
    "keeps %s acquisition pending without an ambient read",
    async (missing) => {
      const { ports } = fixture(
        missing === "executor" ?
          { getSelectedGitHubExecutor: () => undefined }
        : { resolveRunId: () => null }
      );
      expect(await readSetupVerificationStatus(input, ports)).toMatchObject({
        state: "pending",
        runId: missing === "executor" ? "17" : null
      });
      expect(ports.getRunDetail).not.toHaveBeenCalled();
    }
  );

  it.each(["future-conclusion", "", null, undefined])(
    "preserves uncertainty for unsupported completed conclusion %j",
    async (conclusion) => {
      const { ports } = fixture({
        getRunDetail: async () => ({ status: "completed", conclusion })
      });
      expect(await readSetupVerificationStatus(input, ports)).toMatchObject({
        state: "unknown",
        runId: "17",
        error:
          "The verification workflow completed without a supported conclusion."
      });
      expect(ports.finish).not.toHaveBeenCalled();
      expect(ports.finishSucceeded).not.toHaveBeenCalled();
      expect(ports.fetchRunLog).not.toHaveBeenCalled();
    }
  );

  it.each(["pending", "in_progress"] as const)(
    "keeps bounded read evidence on %s observations",
    async (state) => {
      const { ports } = fixture({
        getRunDetail: async (_repo, _runId, _executor, request) => {
          request?.onDecision?.({
            state: "deferred",
            reason: "missing-deadline"
          });
          return state === "pending" ? null : { status: "in_progress" };
        }
      });
      expect(await readSetupVerificationStatus(input, ports)).toMatchObject({
        state,
        activity: "Workflow evidence deferred: missing-deadline."
      });
      expect(ports.persistOperations).not.toHaveBeenCalled();
    }
  );

  it("reports the active step while retaining the same known run", async () => {
    const { ports } = fixture({
      getRunDetail: async () => ({
        status: "in_progress",
        steps: [{ name: "Verify AKS Access", status: "in_progress" }]
      })
    });
    expect(await readSetupVerificationStatus(input, ports)).toMatchObject({
      state: "in_progress",
      activity: "Verify AKS Access",
      runId: "17"
    });
  });

  it.each([
    "runId",
    "dispatchedAt",
    "dispatchMutationTarget",
    "retryCommandId"
  ] as const)(
    "rejects stale %s evidence after an asynchronous read",
    async (field) => {
      const { ports, operation } = fixture();
      ports.getRunDetail = async () => {
        if (field === "dispatchedAt") operation.verification[field] += 1;
        else operation.verification[field] = "replacement";
        return { status: "completed", conclusion: "success" };
      };
      expect(await readSetupVerificationStatus(input, ports)).toEqual({
        state: "pending",
        runId: operation.verification.runId
      });
      expect(ports.finishSucceeded).not.toHaveBeenCalled();
      expect(ports.persistOperations).not.toHaveBeenCalled();
    }
  );

  it.each(["success", "failure"] as const)(
    "does not overwrite a stopped operation with a late %s",
    async (conclusion) => {
      const { ports, operation } = fixture();
      ports.getRunDetail = async () => {
        operation.state = "cancelled";
        return { status: "completed", conclusion };
      };
      await readSetupVerificationStatus(input, ports);
      expect(operation.state).toBe("cancelled");
      expect(ports.finishSucceeded).not.toHaveBeenCalled();
      expect(ports.finish).not.toHaveBeenCalled();
      expect(ports.persistOperations).not.toHaveBeenCalled();
    }
  );

  it.each(["detail", "log"] as const)(
    "does not publish a result after the %s observation is stopped",
    async (stage) => {
      let stopped = false;
      const { ports } = fixture({
        observationStopped: () => stopped,
        getRunDetail: async () => {
          if (stage === "detail") stopped = true;
          return { status: "completed", conclusion: "failure" };
        },
        fetchRunLog: async () => {
          stopped = true;
          return "late diagnostic";
        }
      });
      expect(await readSetupVerificationStatus(input, ports)).toEqual({
        state: "pending",
        error: "Workflow observation stopped.",
        observationStopped: true
      });
      expect(ports.finish).not.toHaveBeenCalled();
    }
  );

  it.each(["timeout", "output-limit"] as const)(
    "retains confirmed remote failure when diagnostic reading hits %s",
    async (reason) => {
      const { ports } = fixture({
        getRunDetail: async () => ({
          status: "completed",
          conclusion: "failure"
        }),
        fetchRunLog: async () => {
          throw new Error(reason);
        },
        readLimitReason: () => reason
      });
      expect(await readSetupVerificationStatus(input, ports)).toMatchObject({
        state: "failed",
        error: expect.stringContaining("The verification log could not be read")
      });
      expect(ports.finish).toHaveBeenCalledOnce();
      expect(ports.persistOperations).toHaveBeenCalledOnce();
    }
  );

  it("classifies and persists positive Azure RBAC evidence", async () => {
    const { ports, operation } = fixture({
      getRunDetail: async () => ({
        status: "completed",
        conclusion: "failure",
        steps: [{ name: "Verify AKS Access", conclusion: "failure" }]
      }),
      fetchRunLog: async () => "AuthorizationFailed: missing role assignment"
    });
    expect(await readSetupVerificationStatus(input, ports)).toMatchObject({
      state: "failed",
      category: "permissions"
    });
    expect(ports.finish).toHaveBeenCalledWith(operation, "failed_partial", {
      failure: expect.objectContaining({
        code: "verify-run-rbac-failed",
        evidence: expect.stringContaining("AuthorizationFailed")
      })
    });
  });

  it.each(["prepare", "getRunDetail", "persistOperations"] as const)(
    "surfaces %s rejection rather than claiming an observed success",
    async (stage) => {
      const { ports } = fixture({
        getRunDetail: async () => ({
          status: "completed",
          conclusion: "failure"
        })
      });
      ports[stage] = vi.fn(() => {
        throw new Error("observation failed");
      });
      expect(await readSetupVerificationStatus(input, ports)).toEqual({
        state: "unknown",
        error: "observation failed"
      });
    }
  );

  it("pins account refusal to the saved operation without switching identities", async () => {
    const { ports, operation } = fixture({
      getRunDetail: async () => {
        throw new Error("account unavailable");
      },
      isSelectedGitHubAuthorizationError: () => true
    });
    expect(await readSetupVerificationStatus(input, ports)).toMatchObject({
      state: "failed",
      terminal: true,
      code: "verification-retry-github-account-unavailable",
      error: expect.stringContaining("@saved-account")
    });
    expect(operation.verification).toMatchObject({
      accountUnavailablePhase: "monitor"
    });
    expect(ports.persistOperations).toHaveBeenCalledOnce();
  });
});

describe("verification diagnostic publication", () => {
  it("requires the host credential sanitizer before reading evidence", async () => {
    const { ports } = fixture();
    Reflect.deleteProperty(ports, "redactDiagnostic");
    await expect(readSetupVerificationStatus(input, ports)).rejects.toThrow(
      "Verification diagnostics require a credential redactor."
    );
    expect(ports.prepare).not.toHaveBeenCalled();
  });

  it.each([
    'Error: client_secret="fixture first line\nError: fixture continuation"',
    'Error: password="fixture unterminated value\nError: fixture continuation',
    'Error: {"access_token":"fixture structured value"}',
    "Error: fixture-host-credential-value"
  ])(
    "sanitizes complete log text before excerpting and persisting: %s",
    async (log) => {
      const { ports } = fixture({
        getRunDetail: async () => ({
          status: "completed",
          conclusion: "failure",
          steps: [
            {
              name: 'Verify AKS Access password="fixture step value"',
              conclusion: "failure"
            }
          ]
        }),
        fetchRunLog: async () => log,
        redactDiagnostic: (value) =>
          value.replaceAll("fixture-host-credential-value", "[REDACTED]")
      });
      const result = await readSetupVerificationStatus(input, ports);
      expect(result).toMatchObject({
        state: "failed",
        error: expect.stringContaining("Credential verification failed")
      });
      const published = JSON.stringify(result);
      const retained = JSON.stringify(vi.mocked(ports.finish).mock.calls);
      for (const value of [published, retained]) {
        expect(value).toContain("[REDACTED]");
        expect(value).not.toMatch(
          /fixture (?:first|continuation|unterminated|structured|step)/
        );
        expect(value).not.toContain("fixture-host-credential-value");
      }
      expect(ports.persistOperations).toHaveBeenCalledOnce();
    }
  );

  it("bounds diagnostic fields and permission lists without losing the primary verdict", async () => {
    const { ports } = fixture({
      getRunDetail: async () => ({
        status: "completed",
        conclusion: "failure",
        steps: [
          {
            name: `Verify Azure Credentials ${"x".repeat(6000)}`,
            conclusion: "failure"
          }
        ]
      }),
      fetchRunLog: async () =>
        "AuthorizationFailed " +
        Array.from({ length: 20 }, (_, index) => `fixture:Action${index}`).join(
          " "
        ),
      explainNoSubscriptions: () => "Authorization guidance ".repeat(1000)
    });
    const result = await readSetupVerificationStatus(input, ports);
    expect(result.state).toBe("failed");
    expect(result.error).toHaveLength(4000);
    expect(result.error).toContain("Credential verification failed (failure).");
    expect(result.detail).toHaveLength(4000);
    expect(result.missingPermissions).toHaveLength(8);
    expect(ports.finish).toHaveBeenCalledWith(
      expect.any(Object),
      "failed_partial",
      {
        failure: expect.objectContaining({
          message: expect.stringMatching(/^Credential verification failed/),
          evidence: result.error
        })
      }
    );
    const options = vi.mocked(ports.finish).mock.calls[0][2];
    expect(JSON.stringify(options).length).toBeLessThan(8500);
  });

  it.each(["active", "malformed"] as const)(
    "sanitizes %s step metadata without confirming the workflow",
    async (kind) => {
      const step = {
        name: 'Waiting password="fixture activity"',
        status: "in_progress"
      };
      if (kind === "malformed")
        Reflect.set(step, "name", { password: "fixture activity" });
      const { ports } = fixture({
        getRunDetail: async () => ({ status: "in_progress", steps: [step] })
      });
      const result = await readSetupVerificationStatus(input, ports);
      expect(result.state).toBe("in_progress");
      expect(JSON.stringify(result)).not.toContain("fixture activity");
      expect(result.activity).toBe(
        kind === "active" ? 'Waiting password="[REDACTED]"' : undefined
      );
      expect(ports.finish).not.toHaveBeenCalled();
    }
  );

  it.each(["primary", "authorization", "secondary"] as const)(
    "redacts %s read errors while preserving observed versus unavailable evidence",
    async (phase) => {
      const { ports } = fixture({
        getRunDetail: async () => {
          if (phase !== "secondary")
            throw new Error("Denied client_secret=fixture-error-value");
          return { status: "completed", conclusion: "failure" };
        },
        fetchRunLog: async () => {
          throw new Error("Unavailable password=fixture-error-value");
        },
        isSelectedGitHubAuthorizationError: () => phase === "authorization"
      });
      const result = await readSetupVerificationStatus(input, ports);
      expect(result.state).toBe(phase === "primary" ? "unknown" : "failed");
      expect(JSON.stringify(result)).not.toContain("fixture-error-value");
      expect(JSON.stringify(vi.mocked(ports.finish).mock.calls)).not.toContain(
        "fixture-error-value"
      );
      if (phase === "secondary") {
        expect(result.error).toContain(
          "Credential verification failed (failure)."
        );
        expect(result.error).toContain(
          "The verification log could not be read"
        );
      }
      if (phase === "primary")
        expect(ports.persistOperations).not.toHaveBeenCalled();
      else expect(ports.persistOperations).toHaveBeenCalledOnce();
    }
  );

  it("fails explicitly if the host sanitizer fails instead of publishing raw evidence", async () => {
    const failure = new Error("Sanitizer unavailable");
    const { ports } = fixture({
      getRunDetail: async () => ({
        status: "completed",
        conclusion: "failure",
        steps: [{ name: "fixture untrusted text", conclusion: "failure" }]
      }),
      redactDiagnostic: () => {
        throw failure;
      }
    });
    await expect(readSetupVerificationStatus(input, ports)).rejects.toBe(
      failure
    );
    expect(ports.finish).not.toHaveBeenCalled();
    expect(ports.persistOperations).not.toHaveBeenCalled();
  });
});

describe("positive Azure RBAC evidence", () => {
  it.each([
    [[], "", "No subscription", true],
    [[{ name: "Verify AKS Access" }], "Forbidden", "", true],
    [[{ name: "Verify Azure Access" }], "not authorized", "", true],
    [[{ name: "Verify AKS Access" }], "network timeout", "", false],
    [[{}], "Forbidden", "", false],
    [[{ name: "Azure Login" }], "Forbidden", "", false]
  ] as const)(
    "classifies only positively identified access failures",
    (steps, log, help, expected) => {
      expect(isAzureRbacVerificationFailure(steps, log, help)).toBe(expected);
    }
  );
});
