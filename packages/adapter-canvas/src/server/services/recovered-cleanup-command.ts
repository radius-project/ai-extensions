import {
  acceptCommand,
  ambiguousProviderMutation,
  beginRetryAttempt,
  findActiveCommand,
  hasReachedSetupCommitPoint,
  provenOwnedCleanupTargets,
  rollbackArtifactIdentity,
  setCommandState,
  workflowProvenanceGap
} from "../../operations.js";
import {
  cleanupRunnerKind,
  type CleanupCommandKind
} from "./cleanup-commands.js";

// Deciding which deletion pass a recovered operation should run, if any.
//
// Two mistakes are possible here and both are quiet. Resuming the newest saved
// command of a deletion kind will happily pick a pass that already finished,
// re-running a completed deletion under an identity that says it is complete.
// And handing a persisted command kind straight to the executor selects no spec
// at all, so the pass dies on an undefined selector before it deletes or
// reports anything — leaving the record running, the repository locked, and no
// command the customer can clear.
//
// So the choice is made once, here: resume only a command that is genuinely
// still in flight, and otherwise open a new rollback with the derived identity
// every other rollback uses.

// The persisted command kinds that describe a deletion pass. A finished one is
// history, not work; only an accepted or running command still owes an answer.
const CLEANUP_COMMAND_KINDS = Object.freeze([
  "rollback",
  "retry_cleanup",
  "exit_setup"
]);

export interface RecoveredCleanupCommand {
  commandId: string;
  kind: CleanupCommandKind;
}

export type RecoveredCleanupPlan =
  | { state: "resume"; commandId: string; kind: CleanupCommandKind }
  | { state: "start"; commandId: string; kind: "rollback"; attempt: number }
  | { state: "blocked"; detail: string }
  | { state: "nothing_owned" };

/**
 * The deletion pass a recovery may resume, translated to its runner key.
 *
 * Returns nothing for a finished command however recent it is: an interrupted
 * pass is one that was accepted or running when the process went away, and
 * re-running a completed one would repeat deletions under an identity that
 * already reported them.
 */
export function activeCleanupCommand(
  operation: unknown
): RecoveredCleanupCommand | null {
  const command = findActiveCommand(operation, CLEANUP_COMMAND_KINDS);
  const commandId = command?.commandId;
  const kind = cleanupRunnerKind(command?.kind);
  return typeof commandId === "string" && commandId && kind ?
      { commandId, kind }
    : null;
}

/**
 * Decide what deletion a recovered operation runs, opening one if it has to.
 *
 * A recovery that reconciled its way to a rollback has to leave behind a
 * command the customer can see and a runner can execute. When no pass is still
 * in flight this opens a fresh rollback keyed on the exact artifact set it will
 * remove, so a repeat of this decision — another restart, a duplicate schedule
 * — resolves to the same command rather than deleting through the ledger twice.
 *
 * The new command is persisted before it is returned. A command a runner
 * executes but no reload can find is the one shape that lets the same deletion
 * be scheduled again after the next restart.
 */
export async function planRecoveredCleanup(input: {
  operation: object & { operationId: string };
  persist(): Promise<void>;
}): Promise<RecoveredCleanupPlan> {
  const active = activeCleanupCommand(input.operation);
  if (active) {
    return { state: "resume", commandId: active.commandId, kind: active.kind };
  }
  // The same refusal every destructive command answers to. Opening a rollback
  // against a record whose provider work is unaccounted for would delete around
  // the resource that is missing from the ledger.
  const blocker = ambiguousProviderMutation(input.operation);
  if (blocker) return { state: "blocked", detail: blocker };
  // Post-commit, the artifacts are in the customer's repository rather than in
  // Radius's own footprint, so a rollback that cannot prove every committed
  // workflow file is still the file it wrote removes nothing at all. The
  // executor already fails closed on that, but opening a pass that is certain
  // to stop leaves the customer watching work that will not happen.
  const provenanceGap =
    hasReachedSetupCommitPoint(input.operation) ?
      workflowProvenanceGap(input.operation)
    : null;
  if (provenanceGap) return { state: "blocked", detail: provenanceGap };
  const targets = provenOwnedCleanupTargets(input.operation);
  if (targets.length === 0) return { state: "nothing_owned" };
  const attempt = beginRetryAttempt(input.operation, "cleanup");
  // The attempt counter the identity derives from was just advanced, so this is
  // always a new command rather than a finished one resolved a second time.
  const { command } = acceptCommand(input.operation, {
    kind: "rollback",
    attempt,
    // Finding #6's artifact digest: the identity is the set this pass removes,
    // so a duplicate decision is the same command and a different set is not.
    target: rollbackArtifactIdentity(targets)
  });
  const commandId = String(command.commandId);
  setCommandState(input.operation, commandId, "running");
  await input.persist();
  return { state: "start", commandId, kind: "rollback", attempt };
}
