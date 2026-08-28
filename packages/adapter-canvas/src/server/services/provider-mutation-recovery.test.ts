import { describe, expect, it, vi } from "vitest";
import {
  createOperation,
  prepareProviderMutation,
  requestStop,
  settleProviderMutation
} from "../../operations.js";
import {
  classifyProviderMutationFailure,
  deterministicProviderUuid,
  executeRecoverableMutation,
  ProviderMutationRecoveryError,
  providerMutationOutcomeUnknown,
  providerMutationWillWrite
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

  it("does not start a mutation when Stop arrives while its journal is saved", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const events: string[] = [];
    const mutate = vi.fn(async () => command());

    const result = await executeRecoverableMutation({
      operation,
      kind: "github_environment.put",
      target: "octo/app:prod",
      persist: async () => {
        const mutation = operation.providerRecovery.mutations[0];
        events.push(`persist:${mutation?.status}`);
        if (mutation?.status === "prepared") requestStop(operation);
      },
      beforeMutation: async () => {
        events.push(
          `boundary:${operation.providerRecovery.mutations[0]?.status}`
        );
        return false;
      },
      mutate,
      accept: (value) => value,
      reconcile: async () => {
        throw new Error("a mutation that did not start is never reconciled");
      }
    });

    expect(result).toEqual({ state: "cancelled" });
    expect(mutate).not.toHaveBeenCalled();
    expect(events).toEqual([
      "persist:prepared",
      "persist:not_applied",
      "boundary:not_applied"
    ]);
  });

  it("defers Stop while an older provider mutation still needs reconciliation", async () => {
    const operation = createOperation({ operationId: "op_test" });
    prepareProviderMutation(operation, {
      kind: "provider_registration.create",
      target: "provider-a",
      intent: {
        provider: "azure"
      }
    });
    requestStop(operation);
    const mutation = vi.fn(async () => command());
    const beforeMutation = vi.fn(async () => true);

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "github_environment.put",
        target: "octo/app:dev",
        persist: async () => undefined,
        beforeMutation,
        mutate: mutation,
        accept: (result) => result,
        reconcile: async () => ({ state: "not_applied" })
      })
    ).rejects.toMatchObject({
      code: "provider-mutation-outcome-unknown"
    });

    expect(mutation).not.toHaveBeenCalled();
    expect(beforeMutation).toHaveBeenCalledOnce();
    expect(operation.providerRecovery?.mutations).toEqual([
      expect.objectContaining({
        kind: "provider_registration.create",
        status: "prepared"
      }),
      expect.objectContaining({
        kind: "github_environment.put",
        status: "not_applied"
      })
    ]);
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
        "an organization SAML refusal without an HTTP status",
        "Resource protected by organization SAML enforcement. You must grant your OAuth token access."
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

  it("propagates caller-classified reconciliation failures unchanged", async () => {
    const operation = createOperation({ operationId: "op_test" });
    const authorizationError = new Error("selected account forbidden");

    await expect(
      executeRecoverableMutation({
        operation,
        kind: "github_workflow.dispatch_retry",
        target: "octo/app:verify",
        persist: async () => {},
        mutate: async () => command({ code: 1, timedOut: true }),
        accept: () => null,
        reconcile: async () => {
          throw authorizationError;
        },
        rethrowReconciliationError: (error) => error === authorizationError
      })
    ).rejects.toBe(authorizationError);
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

// A runner can report a clean exit for a command it gave up waiting on. Reading
// that as an acknowledgement records a mutation nobody saw the provider answer,
// and the next pass treats it as settled fact.
describe("a success code on a request that was cut short", () => {
  async function attempt(
    response: Partial<{
      code: string | number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>,
    reconcile = async () =>
      ({ state: "not_applied", evidence: "nothing was created" }) as const
  ) {
    const operation = createOperation({ operationId: "op_ambiguous" });
    const states: string[] = [];
    const mutate = vi.fn(async () => command(response));
    const outcome = await executeRecoverableMutation({
      operation,
      kind: "github_environment.put",
      target: "octo/app:prod",
      persist: async () => {
        states.push(operation.providerRecovery.mutations[0]?.status);
      },
      mutate,
      accept: () => "accepted",
      providerIdOf: () => "should-not-be-recorded",
      reconcile
    }).catch((error: unknown) => error);
    return { operation, states, mutate, outcome };
  }

  it("reconciles a timed-out exit 0 instead of confirming it", async () => {
    const { operation, states, mutate } = await attempt({
      code: 0,
      timedOut: true
    });

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["prepared", "outcome_unknown", "not_applied"]);
    // No id is settled from an answer nobody can vouch for.
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "not_applied",
      providerId: null
    });
  });

  it.each([
    // Each of these reports a shape a runner can produce for a request that
    // never got an answer, including ones that carry a success exit code.
    ["a timed-out string zero", { code: "0", timedOut: true }],
    ["a timed-out request that also failed", { code: 1, timedOut: true }],
    ["a process killed by a signal", { code: "SIGKILL" }],
    ["a status that means the shell died", { code: 137 }]
  ])("reconciles %s rather than confirming it", async (_label, response) => {
    const { operation, states } = await attempt(response);

    // The whole sequence, so a change that confirmed first and reconciled
    // afterwards could not satisfy it.
    expect(states).toEqual(["prepared", "outcome_unknown", "not_applied"]);
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "not_applied",
      providerId: null
    });
  });

  it("still confirms an unambiguous success", async () => {
    const { operation, states } = await attempt({ code: 0, stdout: "{}" });

    expect(states).toEqual(["prepared", "confirmed"]);
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "confirmed",
      providerId: "should-not-be-recorded"
    });
  });

  it("hands a cut-short request that cannot be read to the customer", async () => {
    const { operation, outcome } = await attempt(
      { code: 0, timedOut: true },
      async () => {
        throw new Error("the provider cannot be read");
      }
    );

    expect(outcome).toBeInstanceOf(ProviderMutationRecoveryError);
    expect(operation.providerRecovery.mutations[0].status).toBe(
      "outcome_unknown"
    );
  });
});

describe("a target whose name collides with a rejection token", () => {
  // The allowlist matches case-insensitively over text that usually quotes the
  // resource. A resource the customer named `gone` must not supply the token
  // that means "the provider refused this", because `not_applied` is the one
  // verdict that authorizes reissuing the request.
  const dnsFailure = (name: string) => ({
    code: 1,
    stdout: "",
    stderr: `lookup api.github.com: no such host (https://api.github.com/repos/octo/app/environments/${name})`
  });

  it.each([["gone"], ["conflict"], ["forbidden"], ["not-found"]])(
    "keeps an inconclusive failure unknown for a resource named %s",
    (name) => {
      expect(
        classifyProviderMutationFailure(dnsFailure(name), `octo/app:${name}`)
      ).toBe("outcome_unknown");
    }
  );

  it("still reads a genuine provider refusal as conclusive", () => {
    expect(
      classifyProviderMutationFailure(
        { code: 1, stdout: "", stderr: "HTTP 409: Conflict" },
        "octo/app:dev"
      )
    ).toBe("not_applied");
  });

  it("without a target, the collision is what it always was", () => {
    // Guards the fix itself: drop the masking and this returns not_applied.
    expect(classifyProviderMutationFailure(dnsFailure("gone"))).toBe(
      "not_applied"
    );
  });
});

describe("the second attempt, across every settled status", () => {
  // The defects this journal exists to prevent all live on the second attempt:
  // retry after a rejection, restart after an interruption, delete then
  // recreate. This drives one mutation twice from each settled status and
  // asserts the only two that may reissue actually do, and no other does.
  const secondAttempt = async (
    status: "prepared" | "confirmed" | "not_applied" | "outcome_unknown"
  ) => {
    const operation = createOperation({ operationId: "op_second" });
    const prepared = prepareProviderMutation(operation, {
      kind: "azure_application.create",
      target: "octo/app:dev"
    });
    settleProviderMutation(
      operation,
      prepared.mutationId,
      status,
      "seeded by the first attempt"
    );
    let mutated = 0;
    let reconciled = 0;
    const run = () =>
      executeRecoverableMutation<string>({
        operation,
        kind: "azure_application.create",
        target: "octo/app:dev",
        persist: async () => {},
        mutate: async () => {
          mutated += 1;
          return { code: 0, stdout: "app-1", stderr: "" };
        },
        accept: (result) => result.stdout,
        reconcile: async () => {
          reconciled += 1;
          return {
            state: "applied" as const,
            value: "app-1",
            evidence: "read back"
          };
        }
      });
    try {
      await run();
    } catch {
      // A terminal status refuses, which is itself the assertion below.
    }
    return { mutated, reconciled };
  };

  it.each([
    ["prepared", 0, 1],
    ["outcome_unknown", 0, 1],
    ["confirmed", 0, 1],
    ["not_applied", 1, 0]
  ] as const)(
    "from %s, reissues %i time(s) and reconciles %i time(s)",
    async (status, mutated, reconciled) => {
      await expect(secondAttempt(status)).resolves.toEqual({
        mutated,
        reconciled
      });
    }
  );

  it("refuses outright once a mutation is manual_required", async () => {
    const { mutated, reconciled } = await secondAttempt(
      "prepared" as const
    ).then(async () => {
      const operation = createOperation({ operationId: "op_manual" });
      const prepared = prepareProviderMutation(operation, {
        kind: "azure_application.create",
        target: "octo/app:dev"
      });
      settleProviderMutation(
        operation,
        prepared.mutationId,
        "manual_required",
        "a human has to look"
      );
      let mutated = 0;
      let reconciled = 0;
      await expect(
        executeRecoverableMutation<string>({
          operation,
          kind: "azure_application.create",
          target: "octo/app:dev",
          persist: async () => {},
          mutate: async () => {
            mutated += 1;
            return { code: 0, stdout: "app-1", stderr: "" };
          },
          accept: (result) => result.stdout,
          reconcile: async () => {
            reconciled += 1;
            return { state: "not_applied" as const };
          }
        })
      ).rejects.toThrow(/a human has to look/u);
      return { mutated, reconciled };
    });

    expect({ mutated, reconciled }).toEqual({ mutated: 0, reconciled: 0 });
  });
});

// A Stop belongs before a forward write and never before a reconciling read, so
// the same predicate the journal uses to decide whether to write is the one
// callers gate their Stop boundary on.
describe("providerMutationWillWrite", () => {
  function journaled(status: string) {
    const operation = createOperation({ operationId: "op_test" });
    const mutation = prepareProviderMutation(operation, {
      kind: "github_environment.put",
      target: "octo/app:dev"
    });
    if (status !== "prepared") {
      settleProviderMutation(
        operation,
        mutation.mutationId,
        status as "confirmed",
        null
      );
    }
    return operation;
  }

  it("writes when the journal has never seen this mutation", () => {
    expect(
      providerMutationWillWrite(
        createOperation({ operationId: "op_test" }),
        "github_environment.put",
        "octo/app:dev"
      )
    ).toBe(true);
  });

  it.each([
    ["not_applied", true],
    ["prepared", false],
    ["outcome_unknown", false],
    ["confirmed", false],
    ["manual_required", false]
  ])("reports %s as willWrite=%s", (status, expected) => {
    expect(
      providerMutationWillWrite(
        journaled(status),
        "github_environment.put",
        "octo/app:dev"
      )
    ).toBe(expected);
  });
});
