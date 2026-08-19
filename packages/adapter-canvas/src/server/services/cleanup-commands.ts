import {
  provenOwnedCleanupTargets,
  unresolvedCleanupTargets,
  EXIT_COMMAND_OUTCOME
} from "../../operations.js";

// What the one deletion pass does differently for each command that reaches it.
//
// The confirmed first rollback, the cleanup retry, and an exit are the same pass
// over a different selection, so the executor is shared and the difference lives
// here as data: which resources are selected, what the finished command records
// as its outcome, and what the customer is told. Selection is the safety
// property — every selector is a model function that fails closed on anything
// the ledger cannot prove this attempt created — so it is named here rather than
// passed in as a flag the executor interprets.

export interface CleanupCommandSpec {
  /** The resources this command may delete, re-derived from the saved ledger. */
  selectTargets: (operation: unknown) => Array<{
    artifactType: string;
    key: string;
    [field: string]: unknown;
  }>;
  /**
   * The outcome recorded on the finished command when the pass removed
   * everything it selected. `exit_setup` records the model's exit outcome, which
   * is the durable fact that closes the setup; any other value leaves it open.
   */
  cleanedOutcome: string;
  terminalReason: string;
  cleanedMessage: string;
  incompleteMessage: string;
}

export const CLEANUP_COMMANDS: Readonly<Record<string, CleanupCommandSpec>> = {
  rollback: {
    selectTargets: provenOwnedCleanupTargets,
    cleanedOutcome: "rolled-back",
    terminalReason: "rollback-complete",
    cleanedMessage:
      "Radius removed the resources it created during this attempt.",
    incompleteMessage:
      "Radius removed what it could, but some resources it created are still present."
  },
  cleanup_retry: {
    selectTargets: unresolvedCleanupTargets,
    cleanedOutcome: "cleaned",
    terminalReason: "cleanup-complete",
    cleanedMessage:
      "Radius removed the resources it created during this attempt.",
    incompleteMessage:
      "Radius removed what it could, but some resources it created still need attention."
  },
  // Exit removes the same proven-owned set a rollback would: the customer asked
  // to be done with the setup, and the artifacts this attempt created — chiefly
  // the GitHub environment that would otherwise stay in the environment list —
  // are what it leaves behind. A pass that ends with warnings records a
  // different outcome, so a setup that still owns resources stays open and keeps
  // reporting them.
  exit_setup: {
    selectTargets: provenOwnedCleanupTargets,
    cleanedOutcome: EXIT_COMMAND_OUTCOME,
    terminalReason: "setup-exited",
    cleanedMessage:
      "Radius closed this setup and removed the resources it created during this attempt.",
    incompleteMessage:
      "Radius removed what it could while closing this setup, but some resources it created are still present."
  }
} as const;

export type CleanupCommandKind = keyof typeof CLEANUP_COMMANDS;

export function isCleanupCommandKind(
  value: string
): value is CleanupCommandKind {
  return Object.hasOwn(CLEANUP_COMMANDS, value);
}

/**
 * Whether a finished deletion pass changed what the environment picker shows.
 *
 * The picker reads a repo-scoped cached listing that a different request
 * assembles, so a pass that removed the GitHub environment — or found it
 * already gone — has to drop that cache before the browser reloads the table on
 * the terminal record. A pass that could not remove it invalidates nothing: the
 * environment is still there, so the listing that still reports it, pending
 * verification or otherwise, is the truthful one.
 */
export function cleanupRemovedGitHubEnvironment(
  results: readonly { artifactType: string; outcome: string }[]
): boolean {
  return results.some(
    (entry) =>
      entry.artifactType === "github_environment" &&
      (entry.outcome === "deleted" || entry.outcome === "not_found")
  );
}
