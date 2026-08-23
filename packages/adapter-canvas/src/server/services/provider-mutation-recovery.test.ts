import { describe, expect, it, vi } from "vitest";
import {
  createOperation,
  prepareProviderMutation,
  settleProviderMutation
} from "../../operations.js";
import {
  classifyProviderMutationFailure,
  deterministicProviderUuid,
  executeRecoverableMutation,
  ProviderMutationRecoveryError,
  providerMutationOutcomeUnknown
} from "./provider-mutation-recovery.js";

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

describe("provider mutation recovery", () => {
  it("persists intent before mutation and confirmation afterwards", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const events: string[] = [];

    const result = await executeRecoverableMutation({
      operation,
      kind: "github_environment.put",
      target: "octo/app:prod",
      persist: async () => {
        events.push(
          `persist:${operation.providerRecovery.mutations[0]?.status}`
        );
      },
      mutate: async () => {
        events.push("mutate");
        return command({ stdout: '{"name":"prod"}' });
      },
      accept: (value) => JSON.parse(value.stdout) as { name: string },
      reconcile: async () => {
        throw new Error("successful mutations do not need reconciliation");
      }
    });

    expect(result).toEqual({
      state: "applied",
      value: { name: "prod" },
      recovered: false
    });
    expect(events).toEqual(["persist:prepared", "mutate", "persist:confirmed"]);
  });

  it("does not repeat a prepared mutation after restart and adopts provider state", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const mutate = vi.fn(async () => command());
    await executeRecoverableMutation({
      operation,
      kind: "workflow.put",
      target: "octo/app:main:.github/workflows/verify.yml",
      persist: async () => {},
      mutate,
      accept: () => ({ sha: "first" }),
      reconcile: async () => ({ state: "not_applied" })
    });
    operation.providerRecovery.mutations[0].status = "prepared";

    const recovered = await executeRecoverableMutation({
      operation,
      kind: "workflow.put",
      target: "octo/app:main:.github/workflows/verify.yml",
      persist: async () => {},
      mutate,
      accept: () => ({ sha: "unexpected" }),
      reconcile: async () => ({
        state: "applied",
        value: { sha: "adopted" },
        evidence: "Exact content digest matched."
      })
    });

    expect(recovered).toEqual({
      state: "applied",
      value: { sha: "adopted" },
      recovered: true
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("requests automatic rollback after every restarted setup mutation is reconciled", async () => {
    const operation = createOperation({ operationId: "op_test" });
    operation.recoveryState = "provider_reconciliation_pending";
    const mutate = vi.fn(async () => command());
    await executeRecoverableMutation({
      operation,
      kind: "workflow.put",
      target: "octo/app:main:.github/workflows/verify.yml",
      persist: async () => {},
      mutate,
      accept: () => ({ sha: "first" }),
      reconcile: async () => ({ state: "not_applied" })
    });
    operation.providerRecovery.mutations[0].status = "prepared";

    await executeRecoverableMutation({
      operation,
      kind: "workflow.put",
      target: "octo/app:main:.github/workflows/verify.yml",
      persist: async () => {},
      mutate,
      accept: () => ({ sha: "unexpected" }),
      reconcile: async () => ({
        state: "applied",
        value: { sha: "adopted" }
      })
    });

    expect(operation.providerRecovery.state).toBe("rollback_pending");
    expect(operation.stopRequested).toBe(true);
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("adopts a restarted verification dispatch without rolling back", async () => {
    const operation = createOperation({ operationId: "op_test" });
    operation.recoveryState = "provider_reconciliation_pending";
    const mutate = vi.fn(async () => command());
    await executeRecoverableMutation({
      operation,
      kind: "github_workflow.dispatch",
      target: "octo/app:verify.yml:main:prod",
      persist: async () => {},
      mutate,
      accept: () => "41",
      reconcile: async () => ({ state: "not_applied" })
    });
    operation.providerRecovery.mutations[0].status = "prepared";

    await executeRecoverableMutation({
      operation,
      kind: "github_workflow.dispatch",
      target: "octo/app:verify.yml:main:prod",
      persist: async () => {},
      mutate,
      accept: () => "unexpected",
      reconcile: async () => ({ state: "applied", value: "42" })
    });

    expect(operation.providerRecovery.state).toBe("complete");
    expect(operation.stopRequested).toBe(false);
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("reconciles a timed-out mutation instead of retrying it", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const mutate = vi.fn(async () =>
      command({ code: 1, timedOut: true, stderr: "terminated" })
    );

    const result = await executeRecoverableMutation({
      operation,
      kind: "verification.dispatch",
      target: "octo/app:main:prod",
      persist: async () => {},
      mutate,
      accept: () => 0,
      reconcile: async () => ({
        state: "applied",
        value: 42,
        evidence: "Run 42 appeared after the saved baseline."
      })
    });

    expect(result).toEqual({ state: "applied", value: 42, recovered: true });
    expect(mutate).toHaveBeenCalledOnce();
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "confirmed",
      evidence: "Run 42 appeared after the saved baseline."
    });
  });

  it("durably fails closed when reconciliation cannot prove identity", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const guidance =
      "The workflow path contains different content. Review that exact path before continuing.";

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "workflow.put",
        target: "octo/app:main:.github/workflows/verify.yml",
        persist: async () => {},
        mutate: async () => command({ code: 1, timedOut: true }),
        accept: () => null,
        reconcile: async () => ({ state: "manual_required", guidance })
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProviderMutationRecoveryError>>({
        code: "provider-mutation-manual-required",
        message: guidance
      })
    );
    expect(operation.providerRecovery).toMatchObject({
      state: "manual_required",
      guidance
    });
  });

  it("fails before mutation when journaling intent cannot be persisted", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const mutate = vi.fn(async () => command());

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "workflow.put",
        target: "octo/app:main:.github/workflows/verify.yml",
        persist: async () => {
          throw "disk unavailable";
        },
        mutate,
        accept: () => null,
        reconcile: async () => ({ state: "not_applied" })
      })
    ).rejects.toMatchObject({
      code: "provider-mutation-recovery-persistence-failed",
      message: expect.stringContaining("disk unavailable")
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("keeps manual-required conclusions durable", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const mutate = vi.fn(async () => command());
    const input = {
      operation,
      kind: "workflow.put",
      target: "octo/app:main:.github/workflows/verify.yml",
      persist: async () => {},
      mutate,
      accept: () => null,
      reconcile: async () => ({ state: "not_applied" as const })
    };

    await executeRecoverableMutation(input);
    operation.providerRecovery.mutations[0].status = "manual_required";
    operation.providerRecovery.mutations[0].evidence =
      "Inspect the exact path.";
    await expect(executeRecoverableMutation(input)).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message: "Inspect the exact path."
    });

    expect(mutate).toHaveBeenCalledOnce();
  });

  it("keeps rollback pending sticky and starts no later provider write", async () => {
    const operation = createOperation({ operationId: "op_test" });
    operation.providerRecovery.state = "rollback_pending";
    const mutate = vi.fn(async () => command());

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "azure_app_owner.add",
        target: "app:user",
        persist: async () => {},
        mutate,
        accept: () => null,
        reconcile: async () => ({ state: "not_applied" })
      })
    ).rejects.toMatchObject({
      code: "provider-mutation-rollback-pending"
    });

    expect(operation.providerRecovery.state).toBe("rollback_pending");
    expect(operation.providerRecovery.mutations).toEqual([]);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("allows rollback to reconcile an existing setup mutation without replaying it", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const prepared = prepareProviderMutation(operation, {
      kind: "azure_federated_credential.create",
      target: "app:dev"
    });
    settleProviderMutation(operation, prepared.mutationId, "outcome_unknown");
    operation.providerRecovery.state = "rollback_pending";
    const mutate = vi.fn(async () => command());

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "azure_federated_credential.create",
        target: "app:dev",
        persist: async () => {},
        mutate,
        accept: () => null,
        reconcile: async () => ({
          state: "applied" as const,
          value: null,
          evidence: "Exact operation provenance matched."
        })
      })
    ).resolves.toEqual({ state: "applied", value: null, recovered: true });
    expect(mutate).not.toHaveBeenCalled();
    expect(operation.providerRecovery.state).toBe("rollback_pending");
  });

  it.each([
    [
      "an explicit validation rejection",
      { code: 1, stderr: "BadRequest: environment name is invalid" }
    ],
    [
      "a permission refusal",
      { code: 1, stderr: "HTTP 403: Resource not accessible by integration" }
    ],
    [
      "a conflict the provider composed",
      { code: 1, stderr: "RoleAssignmentExists: already exists" }
    ],
    [
      "an argument the CLI never sent",
      { code: 2, stdout: "ERROR: unrecognized arguments: --subject" }
    ]
  ])("treats %s as a definite non-application", (_label, result) => {
    expect(providerMutationOutcomeUnknown(command(result))).toBe(false);
  });

  it.each([
    ["a timed-out command", { code: 1, timedOut: true }],
    ["a reset connection", { code: 1, stderr: "read ECONNRESET" }],
    ["a broken pipe", { code: 1, stderr: "write EPIPE: broken pipe" }],
    ["a hung-up socket", { code: 1, stderr: "socket hang up" }],
    ["a killed process", { code: "SIGKILL", stderr: "" }],
    ["a signal-derived status", { code: 137, stderr: "" }],
    ["a negative status", { code: -1, stderr: "" }],
    ["no diagnostic at all", { code: 1, stderr: "", stdout: "" }],
    ["whitespace instead of a diagnostic", { code: 1, stderr: "   \n" }],
    // The inversion this classification exists for: an unrecognised sentence
    // is not evidence that the provider refused anything.
    [
      "an unrecognised diagnostic",
      { code: 2, stdout: "ERROR: subject mismatch" }
    ],
    ["a server-side failure", { code: 1, stderr: "HTTP 502: Bad Gateway" }],
    [
      "a context deadline",
      {
        code: 1,
        stderr: 'Post "https://api.github.com": context deadline exceeded'
      }
    ],
    [
      "a rejection quoted beside a transport failure",
      { code: 1, stderr: "HTTP 422: Validation Failed\nread ECONNRESET" }
    ]
  ])("leaves %s unresolved rather than replaying it", (_label, result) => {
    expect(providerMutationOutcomeUnknown(command(result))).toBe(true);
  });

  it("treats a successful command as settled", () => {
    expect(providerMutationOutcomeUnknown(command({ code: 0 }))).toBe(false);
    expect(providerMutationOutcomeUnknown(command({ code: "0" }))).toBe(false);
  });

  it("reconciles a transport failure instead of recording it as not applied", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const mutate = vi.fn(async () =>
      command({ code: 1, stderr: "write EPIPE: broken pipe" })
    );
    const reconcile = vi.fn(async () => ({
      state: "applied" as const,
      value: "adopted",
      evidence: "The exact resource identity matched."
    }));

    const result = await executeRecoverableMutation({
      operation,
      kind: "azure_role_assignment.create",
      target: "assignment",
      persist: async () => {},
      mutate,
      accept: () => null,
      reconcile
    });

    expect(result).toEqual({
      state: "applied",
      value: "adopted",
      recovered: true
    });
    expect(mutate).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "confirmed"
    });
  });

  it("records an explicit rejection as not applied without reconciling", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const reconcile = vi.fn(async () => ({ state: "not_applied" as const }));

    const result = await executeRecoverableMutation({
      operation,
      kind: "azure_role_assignment.create",
      target: "assignment",
      persist: async () => {},
      mutate: async () =>
        command({ code: 1, stderr: "BadRequest: scope is invalid" }),
      accept: () => null,
      reconcile
    });

    expect(result.state).toBe("not_applied");
    expect(reconcile).not.toHaveBeenCalled();
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "not_applied",
      evidence: "BadRequest: scope is invalid"
    });
  });

  it("builds stable provider UUIDs with UUID v5 bits", () => {
    const first = deterministicProviderUuid("op_test:role:scope");
    expect(first).toBe(deterministicProviderUuid("op_test:role:scope"));
    expect(first).not.toBe(deterministicProviderUuid("op_test:role:other"));
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  describe("classifying a failed provider command", () => {
    it.each([
      [
        "an Entra permission refusal",
        "ERROR: (Authorization_RequestDenied) Insufficient privileges to complete the operation."
      ],
      ["a GitHub validation failure", "gh: Validation Failed (HTTP 422)"],
      [
        "a protected branch refusal",
        "HTTP 409: refusing to allow an OAuth App to create or update workflow"
      ],
      [
        "an argument the CLI rejected",
        "ERROR: unrecognized arguments: --subject"
      ],
      ["a Service Management Reference refusal", "ERROR: serviceTreeInvalid"],
      ["a stale directory object", "ERROR: Request_ResourceNotFound"],
      [
        "a replication lag refusal",
        "ERROR: PrincipalNotFound: does not exist in the directory"
      ]
    ])("reads %s as a definite non-application", (_label, stderr) => {
      expect(
        classifyProviderMutationFailure(command({ code: 1, stderr }))
      ).toBe("not_applied");
    });

    it.each([
      ["a gateway failure", "HTTP 502: Bad Gateway"],
      ["a service outage", "ERROR: Service Unavailable, try again later"],
      ["a context deadline", "context deadline exceeded"],
      ["an i/o timeout", "dial tcp: i/o timeout"],
      ["a sentence nobody classified", "ERROR: something went wrong"],
      ["a bare failure line", "failed"]
    ])("leaves %s unknown rather than replaying it", (_label, stderr) => {
      expect(
        classifyProviderMutationFailure(command({ code: 1, stderr }))
      ).toBe("outcome_unknown");
    });

    it("treats a success as applied rather than classifying its silence", () => {
      expect(providerMutationOutcomeUnknown(command({ code: 0 }))).toBe(false);
      expect(providerMutationOutcomeUnknown(command({ code: "0" }))).toBe(
        false
      );
    });

    it("keeps a timed-out command unknown even when it exited zero", () => {
      expect(
        providerMutationOutcomeUnknown(command({ code: 0, timedOut: true }))
      ).toBe(true);
    });
  });

  describe("a destructive request the provider refused", () => {
    it("records the refusal as the blocker itself, in one settle", async () => {
      const operation = createOperation({ operationId: "op_test" });
      const persisted: Array<string | undefined> = [];
      const reconcile = vi.fn(async () => ({
        state: "applied" as const,
        value: true,
        evidence: "unreachable"
      }));

      await expect(
        executeRecoverableMutation({
          operation,
          kind: "github_branch.delete",
          target: "octo/app\u0000radius/setup-dev\u0000base",
          persist: async () => {
            persisted.push(operation.providerRecovery.mutations[0]?.status);
          },
          mutate: async () =>
            command({ code: 1, stderr: "HTTP 403: Forbidden" }),
          rejectionGuidance: (result) =>
            `GitHub refused the delete: ${result.stderr}. Remove the branch yourself.`,
          accept: () => true,
          reconcile
        })
      ).rejects.toMatchObject({
        code: "provider-mutation-manual-required",
        message: expect.stringContaining("Remove the branch yourself")
      });

      // Never `not_applied` on disk: a crash after that status would reload a
      // record that looks settled while the branch is still in the repository.
      expect(persisted).toEqual(["prepared", "manual_required"]);
      expect(operation.providerRecovery.mutations[0]).toMatchObject({
        status: "manual_required",
        evidence: expect.stringContaining("HTTP 403: Forbidden")
      });
      expect(operation.providerRecovery.state).toBe("manual_required");
      expect(reconcile).not.toHaveBeenCalled();
    });

    it("still reconciles rather than settling when the refusal is inconclusive", async () => {
      const operation = createOperation({ operationId: "op_test" });
      const rejectionGuidance = vi.fn(() => "unreachable");

      await expect(
        executeRecoverableMutation({
          operation,
          kind: "github_branch.delete",
          target: "octo/app\u0000radius/setup-dev\u0000base",
          persist: async () => {},
          mutate: async () => command({ code: 1, stderr: "HTTP 500" }),
          rejectionGuidance,
          accept: () => true,
          reconcile: async () => ({
            state: "applied" as const,
            value: true,
            evidence: "GitHub confirmed the branch is absent."
          })
        })
      ).resolves.toMatchObject({ state: "applied", recovered: true });

      expect(rejectionGuidance).not.toHaveBeenCalled();
    });

    it("leaves an ordinary rejection as not applied when no guidance is supplied", async () => {
      const operation = createOperation({ operationId: "op_test" });

      const result = await executeRecoverableMutation({
        operation,
        kind: "github_environment.put",
        target: "octo/app:prod",
        persist: async () => {},
        mutate: async () => command({ code: 1, stderr: "HTTP 422" }),
        accept: () => null,
        reconcile: async () => ({ state: "not_applied" as const })
      });

      expect(result.state).toBe("not_applied");
      expect(operation.providerRecovery.mutations[0].status).toBe(
        "not_applied"
      );
    });
  });

  describe("retrying a mutation the provider refused", () => {
    it("journals the intent the retry actually read, not the refused one", async () => {
      const operation = createOperation({ operationId: "op_test" });
      const shared = {
        operation,
        kind: "github_workflow.put",
        target: "octo/app:main:.github/workflows/verify.yml",
        persist: async () => {},
        accept: (result: ReturnType<typeof command>) => result,
        reconcile: async () => ({ state: "not_applied" as const })
      };

      await executeRecoverableMutation({
        ...shared,
        intent: { previousBlobSha: "blob-before", previousBlobKnown: true },
        mutate: async () => command({ code: 1, stderr: "HTTP 409: Conflict" })
      });
      expect(operation.providerRecovery.mutations[0]).toMatchObject({
        status: "not_applied",
        intent: { previousBlobSha: "blob-before" }
      });

      await executeRecoverableMutation({
        ...shared,
        intent: { previousBlobSha: "blob-after", previousBlobKnown: true },
        mutate: async () => command({ code: 0 })
      });

      expect(operation.providerRecovery.mutations).toHaveLength(1);
      expect(operation.providerRecovery.mutations[0]).toMatchObject({
        status: "confirmed",
        intent: { previousBlobSha: "blob-after", previousBlobKnown: true }
      });
    });

    it("drops a stale intent entirely when the retry has none", async () => {
      const operation = createOperation({ operationId: "op_test" });
      const shared = {
        operation,
        kind: "github_workflow.put",
        target: "octo/app:main:.github/workflows/verify.yml",
        persist: async () => {},
        accept: (result: ReturnType<typeof command>) => result,
        reconcile: async () => ({ state: "not_applied" as const })
      };

      await executeRecoverableMutation({
        ...shared,
        intent: { previousBlobSha: "blob-before" },
        mutate: async () => command({ code: 1, stderr: "HTTP 409: Conflict" })
      });
      await executeRecoverableMutation({
        ...shared,
        mutate: async () => command({ code: 0 })
      });

      expect(operation.providerRecovery.mutations[0].intent).toBeUndefined();
    });

    it("keeps the intent of a mutation still awaiting an answer", async () => {
      const operation = createOperation({ operationId: "op_test" });
      const mutation = prepareProviderMutation(operation, {
        kind: "github_workflow.put",
        target: "octo/app:main:.github/workflows/verify.yml",
        intent: { previousBlobSha: "blob-before" }
      });
      settleProviderMutation(
        operation,
        mutation.mutationId,
        "outcome_unknown",
        "The write response was lost."
      );

      await executeRecoverableMutation({
        operation,
        kind: "github_workflow.put",
        target: "octo/app:main:.github/workflows/verify.yml",
        intent: { previousBlobSha: "blob-after" },
        persist: async () => {},
        mutate: async () => {
          throw new Error("a reconciling mutation must not be reissued");
        },
        accept: (result: ReturnType<typeof command>) => result,
        reconcile: async () => ({
          state: "applied" as const,
          value: command({ code: 0 }),
          evidence: "The exact content digest matched."
        })
      });

      expect(operation.providerRecovery.mutations[0].intent).toEqual({
        previousBlobSha: "blob-before"
      });
    });
  });

  describe("provider state that can never be read", () => {
    async function reconcileUnreadable(operation: object, attempts: number) {
      const failures: string[] = [];
      for (let attempt = 0; attempt < attempts; attempt++) {
        await executeRecoverableMutation({
          operation: operation as { operationId: string },
          kind: "azure_application.create",
          target: "octo/app:prod:radius-deploy",
          persist: async () => {},
          mutate: async () => command({ code: 1, timedOut: true }),
          accept: () => null,
          reconcile: async () => {
            throw new Error("the directory did not answer");
          }
        }).catch((error: Error & { code?: string }) => {
          failures.push(String(error.code));
        });
      }
      return failures;
    }

    it("hands an unreadable mutation to the customer instead of rereading forever", async () => {
      const operation = createOperation({ operationId: "op_test" });

      const failures = await reconcileUnreadable(operation, 12);

      expect(failures.at(0)).toBe("provider-mutation-outcome-unknown");
      expect(failures.at(-1)).toBe("provider-mutation-manual-required");
      expect(operation.providerRecovery.mutations[0]).toMatchObject({
        status: "manual_required",
        evidence: expect.stringContaining("after 12 attempts")
      });
      // The hand-off is what lets the destructive gate and the panel say
      // something; an endlessly rescheduled read says nothing at all.
      expect(operation.providerRecovery.state).toBe("manual_required");
    });

    it("keeps rereading while the bound has not been reached", async () => {
      const operation = createOperation({ operationId: "op_test" });

      const failures = await reconcileUnreadable(operation, 5);

      expect(new Set(failures)).toEqual(
        new Set(["provider-mutation-outcome-unknown"])
      );
      expect(operation.providerRecovery.mutations[0]).toMatchObject({
        status: "outcome_unknown",
        reconcileAttempts: 5
      });
    });

    it("never reissues the mutation while it is being reread", async () => {
      const operation = createOperation({ operationId: "op_test" });
      const mutate = vi.fn(async () => command({ code: 1, timedOut: true }));

      await executeRecoverableMutation({
        operation,
        kind: "azure_application.create",
        target: "octo/app:prod:radius-deploy",
        persist: async () => {},
        mutate,
        accept: () => null,
        reconcile: async () => {
          throw new Error("the directory did not answer");
        }
      }).catch(() => {});
      await executeRecoverableMutation({
        operation,
        kind: "azure_application.create",
        target: "octo/app:prod:radius-deploy",
        persist: async () => {},
        mutate,
        accept: () => null,
        reconcile: async () => {
          throw new Error("the directory did not answer");
        }
      }).catch(() => {});

      expect(mutate).toHaveBeenCalledOnce();
    });
  });
});

describe("edges the recovery record must still describe honestly", () => {
  it("names a non-Error persistence failure rather than dropping it", async () => {
    const operation = createOperation({ operationId: "op_test" });

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "github_environment.put",
        target: "octo/app:prod",
        persist: async () => {
          throw "the store is read-only";
        },
        mutate: async () => command({ code: 0 }),
        accept: () => null,
        reconcile: async () => ({ state: "not_applied" as const })
      })
    ).rejects.toMatchObject({
      code: "provider-mutation-recovery-persistence-failed",
      message: expect.stringContaining("the store is read-only")
    });
  });

  it("refuses a step whose journal entry was already handed to the customer", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const mutation = prepareProviderMutation(operation, {
      kind: "azure_application.create",
      target: "octo/app:prod:radius-deploy"
    });
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "manual_required",
      "Two applications carry this operation's name."
    );

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "azure_application.create",
        target: "octo/app:prod:radius-deploy",
        persist: async () => {},
        mutate: async () => {
          throw new Error("a quarantined mutation must not be reissued");
        },
        accept: () => null,
        reconcile: async () => {
          throw new Error("a quarantined mutation must not be reread");
        }
      })
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message: "Two applications carry this operation's name."
    });
  });

  it("keeps a rejection detail that arrived on stdout", async () => {
    const operation = createOperation({ operationId: "op_test" });

    const result = await executeRecoverableMutation({
      operation,
      kind: "azure_role_assignment.create",
      target: "assignment",
      persist: async () => {},
      mutate: async () =>
        command({ code: 2, stdout: "ERROR: RoleAssignmentExists", stderr: "" }),
      accept: () => null,
      reconcile: async () => ({ state: "not_applied" as const })
    });

    expect(result.state).toBe("not_applied");
    expect(operation.providerRecovery.mutations[0].evidence).toBe(
      "ERROR: RoleAssignmentExists"
    );
  });

  it("does not demand a rollback for a record with no recovery block at all", async () => {
    const operation = {
      operationId: "op_bare",
      recoveryState: "provider_reconciliation_pending"
    } as { operationId: string; recoveryState: string };

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "azure_application.create",
        target: "octo/app:prod:radius-deploy",
        persist: async () => {},
        mutate: async () => command({ code: 0 }),
        accept: () => "created",
        reconcile: async () => ({ state: "not_applied" as const })
      })
    ).resolves.toMatchObject({ state: "applied", value: "created" });
  });

  it("names an Error persistence failure with the phase it failed in", async () => {
    const operation = createOperation({ operationId: "op_test" });

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "github_environment.put",
        target: "octo/app:prod",
        persist: async () => {
          throw new Error("disk full");
        },
        mutate: async () => command({ code: 0 }),
        accept: () => null,
        reconcile: async () => ({ state: "not_applied" as const })
      })
    ).rejects.toMatchObject({
      code: "provider-mutation-recovery-persistence-failed",
      message: expect.stringContaining("before the provider request: disk full")
    });
  });

  it("names a non-Error reconciliation failure rather than dropping it", async () => {
    const operation = createOperation({ operationId: "op_test" });

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "azure_application.create",
        target: "octo/app:prod:radius-deploy",
        persist: async () => {},
        mutate: async () => command({ code: 1, timedOut: true }),
        accept: () => null,
        reconcile: async () => {
          throw "the directory closed the connection";
        }
      })
    ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });

    expect(operation.providerRecovery.mutations[0].evidence).toContain(
      "the directory closed the connection"
    );
  });

  it("still refuses a quarantined step whose guidance was not recorded", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const mutation = prepareProviderMutation(operation, {
      kind: "azure_application.create",
      target: "octo/app:prod:radius-deploy"
    });
    settleProviderMutation(operation, mutation.mutationId, "manual_required");

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "azure_application.create",
        target: "octo/app:prod:radius-deploy",
        persist: async () => {},
        mutate: async () => {
          throw new Error("a quarantined mutation must not be reissued");
        },
        accept: () => null,
        reconcile: async () => {
          throw new Error("a quarantined mutation must not be reread");
        }
      })
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message:
        "Radius could not prove the outcome of azure_application.create for octo/app:prod:radius-deploy."
    });
  });
});
