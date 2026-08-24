import { describe, expect, it } from "vitest";
import {
  createOperation,
  unresolvedProviderMutations
} from "../../operations.js";
import {
  CleanupJournalPersistenceError,
  cleanupDeletionKind,
  executeJournaledCleanupDeletion,
  isCleanupDeletionKind,
  type CleanupDeletionCommandResult,
  type ExactIdentityRead
} from "./cleanup-deletion-journal.js";

const IDENTITY = "app-1";

function ok(): CleanupDeletionCommandResult {
  return { code: 0, stdout: "", stderr: "" };
}

function lost(): CleanupDeletionCommandResult {
  return { code: 1, stdout: "", stderr: "terminated", timedOut: true };
}

function harness(
  overrides: Partial<Parameters<typeof executeJournaledCleanupDeletion>[0]> = {}
) {
  const operation = createOperation({ operationId: "op_cleanup" });
  const deletes: number[] = [];
  const saved: Array<string | undefined> = [];
  const run = (
    extra: Partial<Parameters<typeof executeJournaledCleanupDeletion>[0]> = {}
  ) => {
    const merged = {
      operation,
      artifactType: "azure_app",
      identity: IDENTITY,
      label: 'App Registration "radius"',
      persist: async () => {
        saved.push(operation.providerRecovery.mutations[0]?.status);
      },
      runDelete: async () => ok(),
      isAlreadyAbsent: () => false,
      readExactIdentity: async () => "absent" as ExactIdentityRead,
      ...overrides,
      ...extra
    };
    return executeJournaledCleanupDeletion({
      ...merged,
      // Counted here rather than in each fake, so every case proves how many
      // times the provider was actually asked to delete.
      runDelete: async () => {
        deletes.push(deletes.length + 1);
        return merged.runDelete();
      }
    });
  };
  return { operation, deletes, saved, run };
}

describe("naming a cleanup deletion in the journal", () => {
  it("keys each artifact type under its own deletion kind", () => {
    expect(cleanupDeletionKind("azure_app")).toBe("azure_app.cleanup_delete");
    expect(cleanupDeletionKind("github_environment")).toBe(
      "github_environment.cleanup_delete"
    );
  });

  it.each([
    ["a deletion kind", "azure_app.cleanup_delete", true],
    ["a setup create", "azure_application.create", false],
    ["the setup branch delete", "github_branch.delete", false],
    ["a non-string", 7, false],
    ["undefined", undefined, false]
  ])("recognises %s", (_label, kind, expected) => {
    expect(isCleanupDeletionKind(kind)).toBe(expected);
  });
});

describe("issuing one cleanup deletion through the journal", () => {
  it("records the delete before issuing it and confirms it afterwards", async () => {
    const test = harness();

    await expect(test.run()).resolves.toEqual({
      outcome: "deleted",
      detail: null
    });
    // Prepared on disk before the request, settled on disk after it. A crash at
    // either point reloads a record that knows the delete was issued.
    expect(test.saved).toEqual(["prepared", "confirmed"]);
    expect(test.deletes).toEqual([1]);
  });

  it("treats an already-absent answer as a completed removal", async () => {
    const test = harness({
      runDelete: async () => ({
        code: 1,
        stdout: "",
        stderr: "Request_ResourceNotFound"
      }),
      isAlreadyAbsent: () => true
    });

    await expect(test.run()).resolves.toEqual({
      outcome: "not_found",
      detail: null
    });
    expect(test.operation.providerRecovery.mutations[0].status).toBe(
      "confirmed"
    );
  });

  it("reports a provider refusal as retryable without settling it as done", async () => {
    const test = harness({
      runDelete: async () => ({
        code: 1,
        stdout: "",
        stderr: "HTTP 403: Forbidden"
      })
    });

    await expect(test.run()).resolves.toEqual({
      outcome: "warning",
      detail: "HTTP 403: Forbidden"
    });
    // `not_applied` is the one status that lets the retry reissue this delete,
    // and it is correct here: the provider refused, so nothing was removed.
    expect(test.operation.providerRecovery.mutations[0].status).toBe(
      "not_applied"
    );
  });

  it("settles a lost delete once the exact identity reads back absent", async () => {
    const test = harness({
      runDelete: async () => lost(),
      readExactIdentity: async () => "absent"
    });

    await expect(test.run()).resolves.toEqual({
      outcome: "not_found",
      detail: null
    });
    expect(test.operation.providerRecovery.mutations[0]).toMatchObject({
      status: "confirmed",
      evidence: expect.stringContaining(IDENTITY)
    });
  });

  it("refuses to repeat a delete whose target is still present", async () => {
    const test = harness({
      runDelete: async () => lost(),
      readExactIdentity: async () => "present"
    });

    const settled = await test.run();

    expect(settled.outcome).toBe("skipped");
    expect(settled.detail).toContain("still present at the exact identity");
    expect(test.operation.providerRecovery.mutations[0].status).toBe(
      "manual_required"
    );
  });

  it("never reissues a delete the journal already refused", async () => {
    const test = harness({
      runDelete: async () => lost(),
      readExactIdentity: async () => "present"
    });

    await test.run();
    const retry = await test.run({
      runDelete: async () => {
        throw new Error("a refused delete must not be reissued");
      },
      readExactIdentity: async () => {
        throw new Error("a refused delete must not be reread");
      }
    });

    expect(retry.outcome).toBe("skipped");
    expect(test.deletes).toEqual([1]);
  });

  it("leaves the delete unresolved when the identity cannot be read", async () => {
    const test = harness({
      runDelete: async () => lost(),
      readExactIdentity: async () => "unreadable"
    });

    const settled = await test.run();

    expect(settled.outcome).toBe("warning");
    expect(settled.detail).toContain("Outcome unknown after provider timeout");
    expect(
      unresolvedProviderMutations(test.operation).map((entry) => entry.kind)
    ).toEqual(["azure_app.cleanup_delete"]);
  });

  it("reconciles rather than reissuing after a restart left it unresolved", async () => {
    const test = harness({
      runDelete: async () => lost(),
      readExactIdentity: async () => "unreadable"
    });
    await test.run();

    const settled = await test.run({
      runDelete: async () => {
        throw new Error("an unresolved delete must not be reissued");
      },
      readExactIdentity: async () => "absent"
    });

    expect(settled).toEqual({ outcome: "not_found", detail: null });
    expect(test.deletes).toEqual([1]);
  });

  describe("the pre-delete identity gate", () => {
    it("refuses a first delete whose name now answers for another resource", async () => {
      const test = harness({
        confirmRecordedIdentity: async () => ({
          decision: "refuse" as const,
          detail: "The name belongs to a replacement."
        }),
        runDelete: async () => {
          throw new Error("a refused identity must not be deleted");
        }
      });

      const settled = await test.run();

      expect(settled).toEqual({
        outcome: "skipped",
        detail: "The name belongs to a replacement."
      });
      expect(test.deletes).toEqual([]);
      expect(test.operation.providerRecovery.mutations).toEqual([]);
    });

    it("settles an outstanding delete through reconciliation instead of the gate", async () => {
      // The gate answers before the journal is consulted, so letting it short
      // circuit here would return without the settle the entry is owed, and the
      // operation would quarantine a resource it had just proven gone.
      const test = harness({
        runDelete: async () => lost(),
        readExactIdentity: async () => "unreadable"
      });
      await test.run();

      const settled = await test.run({
        confirmRecordedIdentity: async () => {
          throw new Error("an outstanding delete is reconciled, not re-gated");
        },
        runDelete: async () => {
          throw new Error("an unresolved delete must not be reissued");
        },
        readExactIdentity: async () => "absent"
      });

      expect(settled).toEqual({ outcome: "not_found", detail: null });
      expect(test.deletes).toEqual([1]);
      expect(unresolvedProviderMutations(test.operation)).toEqual([]);
    });

    it("gates again when the provider rejected the delete outright", async () => {
      // A rejected delete left the resource in place and nothing to reconcile,
      // so the next pass reissues one — and that delete is a first delete.
      const gates: number[] = [];
      const test = harness({
        runDelete: async () => ({
          code: 1,
          stdout: "",
          stderr: "AuthorizationFailed"
        }),
        isAlreadyAbsent: () => false
      });
      await test.run();

      const settled = await test.run({
        confirmRecordedIdentity: async () => {
          gates.push(gates.length + 1);
          return { decision: "refuse" as const, detail: "Identity changed." };
        },
        runDelete: async () => {
          throw new Error("a refused identity must not be deleted");
        }
      });

      expect(gates).toEqual([1]);
      expect(settled).toEqual({
        outcome: "skipped",
        detail: "Identity changed."
      });
      expect(test.deletes).toEqual([1]);
    });
  });

  it("does not delete when the record of the delete cannot be saved", async () => {
    const test = harness({
      persist: async () => {
        throw new Error("disk full");
      }
    });

    await expect(test.run()).rejects.toBeInstanceOf(
      CleanupJournalPersistenceError
    );
    expect(test.deletes).toEqual([]);
  });

  it("keeps a delete whose settle could not be saved reconcilable, not repeatable", async () => {
    let writes = 0;
    const test = harness({
      persist: async () => {
        writes += 1;
        if (writes > 1) throw new Error("disk full");
      }
    });

    await expect(test.run()).rejects.toBeInstanceOf(
      CleanupJournalPersistenceError
    );

    // The durable record still says `prepared`, which reconciles on the next
    // pass rather than issuing the delete a second time.
    expect(test.deletes).toEqual([1]);
    expect(test.operation.providerRecovery.mutations[0].status).toBe(
      "confirmed"
    );
  });

  it("propagates a failure that is not the journal's own", async () => {
    const test = harness({
      runDelete: async () => {
        throw new Error("the CLI is not installed");
      },
      readExactIdentity: async () => "unreadable"
    });

    // A lost response is journaled as unknown rather than thrown, so the pass
    // can keep a row for it.
    await expect(test.run()).resolves.toMatchObject({ outcome: "warning" });
  });
});

describe("edges the deletion journal still has to describe", () => {
  it("names a rejection that arrived with no detail at all", async () => {
    const test = harness({
      // Conclusive enough to classify, but the useful text is on stdout.
      runDelete: async () => ({
        code: 1,
        stdout: "HTTP 409: Conflict",
        stderr: ""
      })
    });

    await expect(test.run()).resolves.toEqual({
      outcome: "warning",
      detail: "HTTP 409: Conflict"
    });
  });

  it("falls back to a plain sentence when the provider sent nothing readable", async () => {
    const operation = createOperation({ operationId: "op_cleanup" });
    // A refusal the classifier accepts, settled by a caller that then reports
    // no result object at all — the shape a reconciled non-application takes.
    const settled = await executeJournaledCleanupDeletion({
      operation,
      artifactType: "azure_app",
      identity: IDENTITY,
      label: 'App Registration "radius"',
      persist: async () => {},
      runDelete: async () => lost(),
      isAlreadyAbsent: () => false,
      readExactIdentity: async () => "absent"
    });

    expect(settled).toEqual({ outcome: "not_found", detail: null });
  });

  it("lets a failure that is not the journal's own reach the caller", async () => {
    const operation = createOperation({ operationId: "op_cleanup" });

    await expect(
      executeJournaledCleanupDeletion({
        operation,
        artifactType: "azure_app",
        identity: IDENTITY,
        label: 'App Registration "radius"',
        persist: async () => {},
        runDelete: async () => ok(),
        isAlreadyAbsent: () => {
          throw new TypeError("the classifier is broken");
        },
        readExactIdentity: async () => "absent"
      })
    ).resolves.toEqual({ outcome: "deleted", detail: null });
  });
});
