import {
  executeRecoverableMutation,
  ProviderMutationRecoveryError,
  type ProviderMutationCommandResult
} from "./provider-mutation-recovery.js";

// Journaling the deletions a rollback issues, so a lost answer never becomes a
// second delete.
//
// Creating a resource and destroying one fail the same way — the request lands,
// the process dies, the answer never arrives — but they fail with opposite
// consequences. An unjournaled create that is replayed leaves a duplicate the
// customer can find and remove. An unjournaled delete that is replayed removes
// whatever now answers to that name, which after a customer rebuilt their
// environment is their replacement rather than Radius's leftover.
//
// So every cleanup delete is written down before it is issued, against the exact
// immutable identity it targets, and settled strictly afterwards. A delete whose
// answer was lost stays `outcome_unknown` until a read of that exact identity
// says it is gone; a resource still present after Radius's one delete is handed
// to the customer rather than deleted again.

export interface CleanupDeletionCommandResult extends ProviderMutationCommandResult {}

/** What a read of the exact immutable identity found. */
export type ExactIdentityRead = "absent" | "present" | "unreadable";

export type CleanupDeletionOutcome =
  | { outcome: "deleted"; detail: null }
  | { outcome: "not_found"; detail: null }
  | { outcome: "warning"; detail: string }
  | { outcome: "skipped"; detail: string };

export class CleanupJournalPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupJournalPersistenceError";
  }
}

/** The journal kind a cleanup delete of one artifact type is recorded under. */
export function cleanupDeletionKind(artifactType: string): string {
  return `${artifactType}.cleanup_delete`;
}

/** Whether a mutation kind is a cleanup deletion rather than forward setup work. */
export function isCleanupDeletionKind(kind: unknown): boolean {
  return typeof kind === "string" && kind.endsWith(".cleanup_delete");
}

const UNKNOWN_OUTCOME =
  "Outcome unknown after provider timeout; Radius will not repeat this delete blindly.";

/**
 * Issue one cleanup delete through the mutation journal.
 *
 * `identity` is the exact immutable provider identity — a role assignment's
 * resource id, an application's client id, a credential's app-scoped name — and
 * it is what the journal entry is keyed on. A caller that cannot supply one must
 * not call this at all: a delete addressed by display name alone is the one that
 * removes a replacement, and the refusal belongs upstream where the label is
 * still available to explain it.
 */
export async function executeJournaledCleanupDeletion(input: {
  operation: object & { operationId: string };
  artifactType: string;
  identity: string;
  label: string;
  persist(): Promise<void>;
  runDelete(): Promise<CleanupDeletionCommandResult>;
  /**
   * How to read the provider's own answer that the resource was already gone.
   *
   * `true` settles it as a completed removal. `"unproven"` says the provider's
   * "not found" is not evidence on its own — GitHub returns it for a resource
   * this token may not see — so the question is handed to reconciliation, which
   * owns the read that can actually tell absence from invisibility.
   */
  isAlreadyAbsent(result: CleanupDeletionCommandResult): boolean | "unproven";
  /** Read back the exact immutable identity this delete targeted. */
  readExactIdentity(): Promise<ExactIdentityRead>;
}): Promise<CleanupDeletionOutcome> {
  let alreadyAbsent = false;
  try {
    const removal = await executeRecoverableMutation<"deleted" | "not_found">({
      operation: input.operation,
      kind: cleanupDeletionKind(input.artifactType),
      target: input.identity,
      providerIdempotencyKey: input.identity,
      persist: input.persist,
      mutate: async () => {
        const result = await input.runDelete();
        if (result.code === 0 || result.code === "0") return result;
        if (result.timedOut) return result;
        // "It was already gone" is a completed deletion, not a refusal, and it
        // is the answer a replayed delete would produce if the first one had
        // landed. Normalizing it here keeps both on the same settled path —
        // but only for a provider whose "not found" is an answer rather than a
        // permission decision. Where it is not, the delete is marked
        // inconclusive so reconciliation proves absence before anything is
        // recorded as removed.
        const absent = input.isAlreadyAbsent(result);
        if (absent === "unproven") return { ...result, timedOut: true };
        if (absent) {
          alreadyAbsent = true;
          return { ...result, code: 0 };
        }
        return result;
      },
      accept: () => (alreadyAbsent ? "not_found" : "deleted"),
      reconcile: async () => {
        const found = await input.readExactIdentity();
        if (found === "absent") {
          return {
            state: "applied" as const,
            value: "not_found" as const,
            evidence: `The exact identity ${input.identity} is absent after the interrupted delete.`
          };
        }
        if (found === "present") {
          return {
            state: "manual_required" as const,
            guidance:
              `${UNKNOWN_OUTCOME} ${input.label} is still present at the exact identity Radius targeted, ` +
              "so deleting it again could remove a resource created since. Remove it yourself if it is unwanted."
          };
        }
        throw new Error(
          `${input.label} state could not be read at its exact identity.`
        );
      }
    });
    if (removal.state === "not_applied") {
      const detail =
        (removal.result?.stderr || removal.result?.stdout || "").trim() ||
        "The provider rejected the delete.";
      return { outcome: "warning", detail };
    }
    return removal.value === "not_found" ?
        { outcome: "not_found", detail: null }
      : { outcome: "deleted", detail: null };
  } catch (error) {
    if (!(error instanceof ProviderMutationRecoveryError)) throw error;
    if (error.code === "provider-mutation-recovery-persistence-failed") {
      // The record of what Radius is about to do, or has just done, did not
      // reach disk. Continuing would delete more resources with no durable
      // account of any of them, so this is never folded into a warning row.
      throw new CleanupJournalPersistenceError(error.message);
    }
    if (error.code === "provider-mutation-manual-required") {
      return { outcome: "skipped", detail: error.message };
    }
    return {
      outcome: "warning",
      detail: `${UNKNOWN_OUTCOME} ${error.message}`
    };
  }
}
