import type { CanvasRequestContext } from "../request-context.js";
import {
  templatePathParameters,
  type RouteHandlerRegistry
} from "../route-table.js";
import {
  acceptCommand,
  announceOperationTerminal,
  applySetupResumePoint,
  applyStopRequest,
  beginRetryAttempt,
  canContinueSetup,
  canExitSetup,
  canRetryCleanup,
  canRetrySetup,
  canRetryVerification,
  canStartRollback,
  enterStage,
  findActiveCommand,
  finish,
  markVerificationRetryAcquisition,
  rollbackRetryAttempt,
  setCommandState,
  setStageState,
  snapshotRetryState,
  toClientView,
  EXIT_COMMAND_KIND,
  EXIT_COMMAND_OUTCOME,
  STAGE_VERIFY,
  type OperationAttemptKind,
  type OperationCommandKind,
  type StopRequestOutcome
} from "../../operations.js";
import { errorMessage } from "../../runtime/util.js";
import type { OperationRecord } from "./operations-status.js";

// Cooperative controls for an environment operation: stop, the two forward
// commands (continue a deliberate stop, retry a failed continuation), rollback
// of what the attempt created, and the two remaining retries.
//
// The order is the safety property and does not vary by command: read the saved
// record, decide from the saved record alone, durably record the command before
// the caller is told it was accepted, and only then schedule work. It is written
// once in `runCommandRoute`, and `COMMANDS` below is the only place the five
// commands differ. Nothing here deploys the application — that stays a separate
// customer action. Stop and rollback are also deliberately different commands:
// stop means "create nothing more"; rollback means "remove what you created",
// is confirmed in the browser first, and fails closed on anything the ledger
// cannot prove.
//
// Eligibility, command identity, and the retry snapshot are pure state
// transitions in `operations.ts`, so they are imported rather than injected: a
// fake for them could only drift from the rules these routes exist to enforce.
// The dependencies are the genuine I/O the handlers cannot decide alone — the
// registry, the durable write, the merge proof, and the per-instance runner —
// and each is a single function so a test fake can throw on anything a given
// route must not reach.

// Declared alongside the handlers that read their path variables, mirroring the
// resume and abandon routes in `operations-status.ts`, so a template and the
// code that destructures it cannot drift apart.
export const STOP_OPERATION_ROUTE = "/api/operations/:operationId/stop";
export const CONTINUE_OPERATION_ROUTE = "/api/operations/:operationId/continue";
export const ROLLBACK_OPERATION_ROUTE = "/api/operations/:operationId/rollback";
export const EXIT_OPERATION_ROUTE = "/api/operations/:operationId/exit";
export const RETRY_OPERATION_ROUTE =
  "/api/operations/:operationId/retry/:retryKind";

// The three kinds a retry route may name: a retry repeats exactly one attempt,
// so they are the model's attempt kinds rather than a parallel list.
type OperationRetryKind = OperationAttemptKind;

// The command a request is asking for, independent of which route carried it.
// `continue` and `rollback` are first-choice commands after a stop; `retry/*`
// repeats one that already ran; `exit` ends the customer's involvement with the
// attempt altogether.
type OperationCommandName =
  OperationRetryKind | "continue" | "rollback" | "exit";

// Which server-owned runner the accepted command is handed to. The first
// rollback removes every proven-owned pre-commit artifact rather than the
// unresolved subset a cleanup retry repeats, so it names its own runner instead
// of passing a flag to the cleanup one. `exit_setup` runs the same deletion pass
// over the same proven-owned selection, and differs in what it reports and in
// the record it closes.
export type OperationScheduleKind =
  | "setup_continuation"
  | "verification_retry"
  | "cleanup_retry"
  | "rollback"
  | "exit_setup";

type RetryEligibility = {
  ok: boolean;
  code: string;
  detail?: string;
  resumeFrom?: string;
  target?: string;
  targets?: readonly unknown[];
  classification?: string;
  requiresMergedPullRequest?: boolean;
  pullRequestUrl?: string | null;
};

// Registering a command either accepts a new one or resolves to the saved one
// carrying the same derived id, so a record that exists — the only kind these
// routes hold — always gets a command back.
type AcceptedCommand = {
  ok: boolean;
  duplicate: boolean;
  command: { commandId: string };
};

export type RepositoryLockResult =
  { ok: true } | { ok: false; conflict: { operationId: string } };

export interface OperationsControlDependencies {
  get(operationId: string): OperationRecord | null;
  // Takes the repository lock back for a retry of a record that already owns
  // it. A different live attempt wins, which is what keeps a retry from running
  // beside a fresh setup for the same repository.
  acquireForRetry(operation: OperationRecord): RepositoryLockResult;
  persistOperations(): Promise<void>;
  checkPullRequestMerge(
    operation: OperationRecord,
    pullRequestUrl: string | null
  ): Promise<
    | { state: "merged" }
    | { state: "open" }
    | { state: "unavailable"; login: string; detail: string }
  >;
  // Returns whether a runner actually accepted the work. Scheduling is
  // per-instance closure state, so the instance that received the request is
  // passed through and the composition root resolves the right runner; a miss
  // must close the reopened record rather than leave it durably `running` with
  // nothing behind it.
  schedule(request: {
    kind: OperationScheduleKind;
    instanceId: string;
    operation: OperationRecord;
    commandId: string;
  }): boolean;
  // Drops the repository's cached environment listing. An exit that closes a
  // setup without deleting anything still has to make the picker read GitHub
  // again: the browser cannot invalidate a server cache, and a listing answered
  // from the cached payload would keep showing the environment this setup left
  // behind under the status its last attempt wrote.
  invalidateEnvironmentListing(repo: string): void;
}

// Typed views of the model's `any`-shaped exports, pinned once here so the
// handlers below stay strictly typed without a cast at each call site.
type EligibilityCheck = (operation: OperationRecord) => RetryEligibility;
const requestStopOn: (
  operation: OperationRecord,
  options: { announce: boolean }
) => { outcome: StopRequestOutcome; duplicate: boolean } = applyStopRequest;
const acceptOperationCommand: (
  operation: OperationRecord,
  input: { kind: OperationCommandKind; attempt: number; target: string }
) => AcceptedCommand = acceptCommand;
const findActiveOperationCommand: (
  operation: OperationRecord,
  kinds: readonly OperationCommandKind[]
) => { commandId: string } | null = findActiveCommand;
const clientView: (operation: OperationRecord) => unknown = toClientView;

// One resolved control request: the record the decision is taken from, the
// verdict that allowed it, and the seams it may use.
interface CommandRequest {
  context: CanvasRequestContext;
  dependencies: OperationsControlDependencies;
  operationId: string;
  operation: OperationRecord;
  eligibility: RetryEligibility;
}

// Everything that differs between the five commands. The handler order, the
// durable-write boundary, and the failure handling are identical by
// construction, which is the property that keeps a new command from quietly
// acquiring a different safety story.
interface CommandSpec {
  name: OperationCommandName;
  // Overrides the vocabulary a refusal and a scheduling miss are written in.
  // `continue` refuses as a setup, because setup is the work it continues.
  refusalKind?: string;
  workLabel?: string;
  commandKind: OperationCommandKind;
  // Which attempt counter the command advances. Rollback shares the cleanup
  // counter with the cleanup retry, so a retry selects the results of the
  // attempt before it rather than a parallel history.
  attemptKind: OperationRetryKind;
  eligibility: EligibilityCheck;
  // Kinds a repeated submission resolves to before eligibility is consulted.
  // The two first-choice commands answer with the command already in flight,
  // which is what keeps a double click from deleting through the ledger twice.
  activeKinds?: readonly OperationCommandKind[];
  // Where the record must be positioned for the work to resume.
  prepare?: (operation: OperationRecord, eligibility: RetryEligibility) => void;
  prepareAccepted?: (
    operation: OperationRecord,
    eligibility: RetryEligibility,
    commandId: string
  ) => void;
  // Checked after eligibility, for a command that needs proof from outside the
  // saved record. Resolves false when it has already answered the request.
  precondition?: (request: CommandRequest) => Promise<boolean>;
  // A command with no work to hand a runner finishes inside the request that
  // asked for it. Resolves true when it has already answered, so the reopen and
  // schedule below never run for it.
  settleWithoutWork?: (request: CommandRequest) => Promise<boolean>;
  scheduleKind: OperationScheduleKind;
  // A retry that no runner accepted is closed with a failure, preserving the
  // established contract. A first-choice command restores the terminal decision
  // the customer was looking at instead, because nothing ran at all.
  schedulerMiss: "close-operation" | "restore-terminal";
  persistFailureCode: string;
  persistFailureMessage: string;
}

/**
 * Explain a refused command in the customer's terms.
 *
 * Each string maps to one closed refusal code so the page never has to guess at
 * a reason, and an unrecognised code degrades to the honest general statement
 * rather than an invented cause. The map is module state because it is constant
 * data, and the sentences the two forward commands share are named once so the
 * pair cannot drift.
 */
const FORWARD_REQUEST_MISSING =
  "Radius no longer holds the environment details needed to continue this setup.";
const FORWARD_OWNERSHIP_AMBIGUOUS =
  "Radius cannot prove what it created during this attempt, so continuing could duplicate a resource. Review the listed resources first.";
const PROVENANCE_INCOMPLETE =
  "Radius did not save enough about the workflow files it committed to prove they are unchanged, so it will not remove them or anything they depend on.";

const REFUSAL_MESSAGES: Record<string, string> = {
  "unknown-operation": "Radius has no record of this operation.",
  "operation-active":
    "This setup is still running, so there is nothing to retry yet.",
  "verification-retry-not-retryable":
    "This result is not one Radius can fix by checking credentials again.",
  "verification-provenance-incomplete":
    "Radius did not save enough of the workflow, branch, and identity details to repeat verification safely.",
  "setup-retry-not-retryable":
    "Only a stopped or partially failed setup can be continued.",
  "setup-retry-request-missing": FORWARD_REQUEST_MISSING,
  "setup-retry-ownership-ambiguous": FORWARD_OWNERSHIP_AMBIGUOUS,
  "setup-continue-not-available":
    "This setup is not waiting at a stop that Radius can continue from.",
  "setup-continue-request-missing": FORWARD_REQUEST_MISSING,
  "setup-continue-ownership-ambiguous": FORWARD_OWNERSHIP_AMBIGUOUS,
  "setup-continue-rolled-back":
    "Radius rolled back what this attempt created, so there is nothing left to continue from. Start a new environment setup.",
  "rollback-not-available":
    "Only a stopped, partially failed, or unfinished setup can be rolled back.",
  "rollback-environment-verified":
    "Credential verification succeeded for this environment, so it is finished setup. Remove it with Delete Environment instead.",
  "rollback-provenance-incomplete": PROVENANCE_INCOMPLETE,
  "rollback-nothing-owned":
    "Radius did not create any resources it can prove it owns in this attempt.",
  "rollback-already-attempted":
    "Radius already ran a rollback for this attempt. Use the rollback retry for anything still present.",
  "cleanup-retry-not-retryable":
    "The last cleanup attempt did not leave anything Radius can safely retry.",
  "cleanup-retry-provenance-incomplete": PROVENANCE_INCOMPLETE,
  "cleanup-retry-nothing-unresolved":
    "Every resource Radius proved it created has already been removed.",
  "cleanup-retry-ledger-missing":
    "Radius has no record of resources it created for this setup.",
  "exit-environment-ready":
    "This environment finished setup, so there is nothing to exit. Remove it with Delete Environment instead.",
  "setup-already-exited": "Radius already closed this setup."
};

export function retryRefusalMessage(kind: string, code: string): string {
  return (
    REFUSAL_MESSAGES[code] ||
    `Radius cannot retry ${kind} for this operation (${code}).`
  );
}

/**
 * Percent-decode one path variable.
 *
 * A malformed escape such as `%` is a bad request, not a crash: `decodeURIComponent`
 * throws on it, and letting that throw escape the handler would leave the
 * request hanging with no response at all.
 */
function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function statusUrlFor(operationId: string): string {
  return `/api/operations/${encodeURIComponent(operationId)}`;
}

function sendJson(
  context: CanvasRequestContext,
  status: number,
  payload: Record<string, unknown>
): void {
  context.response.setHeader("Content-Type", "application/json");
  context.response.setHeader("Cache-Control", "no-store");
  context.response.writeHead(status);
  context.response.end(JSON.stringify(payload));
}

function unknownOperation(context: CanvasRequestContext): void {
  sendJson(context, 404, {
    error: "Unknown operation.",
    code: "unknown-operation"
  });
}

// The declared body policy is `json`, and the client sends `{}`, but no control
// decision is taken from the body: every input is the saved record plus the
// path. The body is still drained so the request is fully consumed before the
// response ends.
async function resolveOperation(
  context: CanvasRequestContext,
  template: string,
  dependencies: Pick<OperationsControlDependencies, "get">
): Promise<{
  operationId: string;
  operation: OperationRecord;
  params: Readonly<Record<string, string>>;
} | null> {
  await context.readTextBody();
  const params = templatePathParameters(template, context.pathname);
  const operationId = params ? decodeSegment(params.operationId) : null;
  const operation = operationId ? dependencies.get(operationId) : null;
  if (!params || !operationId || !operation) {
    unknownOperation(context);
    return null;
  }
  return { operationId, operation, params };
}

/**
 * Record a customer stop request.
 *
 * An operation parked on a prompt has nothing in flight, so it cancels at once;
 * anything else records the request and lets the executor stop at its next safe
 * boundary. Either way the request is durable before the caller hears that it
 * was accepted, so a canvas reload or an extension restart cannot lose it.
 *
 * Stop is the one control that is not a scheduled command, so it keeps its own
 * handler rather than a row in the table below.
 */
export async function handleStopOperation(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies
): Promise<void> {
  const resolved = await resolveOperation(
    context,
    STOP_OPERATION_ROUTE,
    dependencies
  );
  if (!resolved) return;
  const { operationId, operation } = resolved;

  const activeCommand = findActiveCommand(operation);
  if (
    activeCommand &&
    (activeCommand.kind === "rollback" ||
      activeCommand.kind === "retry_cleanup" ||
      activeCommand.kind === EXIT_COMMAND_KIND)
  ) {
    sendJson(context, 409, {
      error:
        "Cleanup is already running and cannot be stopped. Wait for it to finish.",
      code: "operation-cleanup-not-stoppable",
      operationId,
      operation: clientView(operation)
    });
    return;
  }

  const snapshot: unknown = snapshotRetryState(operation);
  // Announcing is deferred until the write lands: a cancellation that a failed
  // write rolls back must never be reported as an ended setup.
  const result = requestStopOn(operation, { announce: false });
  if (result.outcome === "terminal") {
    sendJson(context, 409, {
      error:
        "This operation already finished, so there is nothing left to stop.",
      code: "operation-already-terminal",
      operationId,
      operation: clientView(operation)
    });
    return;
  }
  if (result.outcome === "already_stopped") {
    sendJson(context, 200, {
      operationId,
      code: "operation-stopped",
      statusUrl: statusUrlFor(operationId),
      operation: clientView(operation)
    });
    return;
  }
  try {
    await dependencies.persistOperations();
  } catch (error) {
    // The stop was never durable, so the in-memory record goes back exactly as
    // it was rather than reporting a command Radius would forget on restart.
    rollbackRetryAttempt(operation, snapshot);
    sendJson(context, 500, {
      error:
        "Radius could not save the stop request, so nothing was stopped. Try again.",
      code: "operation-stop-persist-failed",
      operationId,
      detail: errorMessage(error)
    });
    return;
  }
  if (result.outcome === "cancelled") {
    announceOperationTerminal(operation);
  }
  sendJson(context, result.outcome === "cancelled" ? 200 : 202, {
    operationId,
    code:
      result.outcome === "cancelled" ?
        "operation-stopped"
      : "operation-stop-pending",
    statusUrl: statusUrlFor(operationId),
    operation: clientView(operation)
  });
}

/**
 * Prove the setup pull request merged before verification is repeated.
 *
 * The workflow only exists on the target branch once the pull request lands, so
 * repeating verification before then would burn the retry on a run that cannot
 * pass.
 */
async function requireMergedSetupPullRequest({
  context,
  dependencies,
  operationId,
  operation,
  eligibility
}: CommandRequest): Promise<boolean> {
  if (!eligibility.requiresMergedPullRequest) return true;
  const pullRequestUrl = eligibility.pullRequestUrl ?? null;
  const merge = await dependencies.checkPullRequestMerge(
    operation,
    pullRequestUrl
  );
  if (merge.state === "unavailable") {
    const account = merge.login ? `@${merge.login}` : "the selected account";
    sendJson(context, 409, {
      error: `Radius could not verify the setup pull request with ${account}. Re-check that GitHub account and try again.`,
      code: "verification-retry-github-account-unavailable",
      operationId,
      pullRequestUrl,
      detail: merge.detail,
      operation: clientView(operation)
    });
    return false;
  }
  if (merge.state === "open") {
    sendJson(context, 409, {
      error:
        "The setup pull request has not merged yet, so the verification workflow is not installed on the target branch.",
      code: "verification-retry-pull-request-open",
      operationId,
      pullRequestUrl,
      operation: clientView(operation)
    });
    return false;
  }
  // The merge check is the one await between deciding and acting, so the
  // verdict is re-read rather than assumed to have survived it.
  if (!canRetryVerification(operation).ok) {
    sendJson(context, 409, {
      error:
        "This operation changed while Radius checked the setup pull request. Refresh the operation before retrying.",
      code: "operation-active",
      operationId,
      operation: clientView(operation)
    });
    return false;
  }
  return true;
}

function enterVerifyStage(operation: OperationRecord): void {
  setStageState(operation, STAGE_VERIFY, "pending");
  enterStage(operation, STAGE_VERIFY);
}

const applyResumePoint: CommandSpec["prepare"] = (operation, eligibility) =>
  applySetupResumePoint(operation, eligibility.resumeFrom);

const RETRY_PERSIST_FAILURE = {
  persistFailureCode: "operation-retry-persist-failed",
  persistFailureMessage:
    "Radius could not save the retry request, so no work was started. Try again."
} as const;

/**
 * Close a setup that has nothing left to delete.
 *
 * Reached only when the ledger proves this attempt owns no removable artifact —
 * a reused App Registration and Service Principal, or a set a previous rollback
 * already removed. There is no deletion to schedule, so the exit is recorded as
 * a finished command and the record is durable before the caller hears it was
 * accepted. The record keeps its own terminal verdict: the customer left the
 * setup, which is a different fact from how the setup ended.
 */
async function closeExitedSetup({
  context,
  dependencies,
  operationId,
  operation,
  eligibility
}: CommandRequest): Promise<boolean> {
  if ((eligibility.targets?.length ?? 0) > 0) return false;
  const snapshot: unknown = snapshotRetryState(operation);
  const accepted = acceptOperationCommand(operation, {
    kind: EXIT_COMMAND_KIND,
    attempt: 0,
    target: eligibility.target ?? "exit"
  });
  const commandId = accepted.command.commandId;
  setCommandState(operation, commandId, "finished", EXIT_COMMAND_OUTCOME);
  try {
    await dependencies.persistOperations();
  } catch (error) {
    // Nothing was removed and nothing was saved, so the record goes back to the
    // decision the customer is still looking at.
    rollbackRetryAttempt(operation, snapshot);
    sendJson(context, 500, {
      error:
        "Radius could not save the request to exit setup, so the setup is still open. Try again.",
      code: "operation-exit-persist-failed",
      operationId,
      detail: errorMessage(error)
    });
    return true;
  }
  // The listing the picker reads is repo-scoped and cached, so the refresh the
  // browser performs next has to reach GitHub rather than the payload written
  // while this setup was still running.
  dependencies.invalidateEnvironmentListing(String(operation.repo ?? ""));
  sendJson(context, 200, {
    operationId,
    code: "setup-exited",
    statusUrl: statusUrlFor(operationId),
    commandId,
    removed: false,
    operation: clientView(operation)
  });
  return true;
}

// The whole difference between the six commands. The two first-choice ones a
// stopped operation offers come first; the three retries repeat a command that
// already ran, and differ only in what they may repeat: a setup continues from
// the first step its artifact ledger does not already prove finished, a
// verification repeats the exact workflow identity Radius saved, and a cleanup
// removes only the resources Radius proved it created and could not delete.
// Exit ends the attempt: it disposes of the same proven-owned set a rollback
// would, and closes the record whether or not there was anything to remove.
const COMMANDS: Readonly<Record<OperationCommandName, CommandSpec>> = {
  continue: {
    name: "continue",
    refusalKind: "setup",
    workLabel: "setup continuation",
    commandKind: "continue_setup",
    attemptKind: "setup",
    eligibility: canContinueSetup,
    activeKinds: ["continue_setup", "retry_setup"],
    prepare: applyResumePoint,
    scheduleKind: "setup_continuation",
    schedulerMiss: "restore-terminal",
    persistFailureCode: "operation-continue-persist-failed",
    persistFailureMessage:
      "Radius could not save the request to continue setup, so no work was started. Try again."
  },
  rollback: {
    name: "rollback",
    commandKind: "rollback",
    attemptKind: "cleanup",
    eligibility: canStartRollback,
    activeKinds: ["rollback", "retry_cleanup"],
    scheduleKind: "rollback",
    schedulerMiss: "restore-terminal",
    persistFailureCode: "operation-rollback-persist-failed",
    persistFailureMessage:
      "Radius could not save the rollback request, so no cleanup began. Try again."
  },
  setup: {
    name: "setup",
    commandKind: "retry_setup",
    attemptKind: "setup",
    eligibility: canRetrySetup,
    prepare: applyResumePoint,
    scheduleKind: "setup_continuation",
    schedulerMiss: "close-operation",
    ...RETRY_PERSIST_FAILURE
  },
  verification: {
    name: "verification",
    commandKind: "retry_verification",
    attemptKind: "verification",
    eligibility: canRetryVerification,
    prepare: enterVerifyStage,
    prepareAccepted: (operation, _eligibility, commandId) => {
      markVerificationRetryAcquisition(operation, commandId);
    },
    precondition: requireMergedSetupPullRequest,
    scheduleKind: "verification_retry",
    schedulerMiss: "close-operation",
    ...RETRY_PERSIST_FAILURE
  },
  cleanup: {
    name: "cleanup",
    commandKind: "retry_cleanup",
    attemptKind: "cleanup",
    eligibility: canRetryCleanup,
    scheduleKind: "cleanup_retry",
    schedulerMiss: "close-operation",
    ...RETRY_PERSIST_FAILURE
  },
  exit: {
    name: "exit",
    workLabel: "exit",
    commandKind: EXIT_COMMAND_KIND,
    // Exit deletes through the cleanup ledger, so it advances the same attempt
    // counter a rollback does and its results select against the same attempt.
    attemptKind: "cleanup",
    eligibility: canExitSetup,
    // A second submission while the disposal is in flight resolves to the
    // command already running rather than deleting through the ledger twice.
    activeKinds: [EXIT_COMMAND_KIND],
    settleWithoutWork: closeExitedSetup,
    scheduleKind: "exit_setup",
    // Nothing ran, so the customer is put back in front of the terminal
    // decision they were looking at instead of a record closed by a miss.
    schedulerMiss: "restore-terminal",
    persistFailureCode: "operation-exit-persist-failed",
    persistFailureMessage:
      "Radius could not save the request to exit setup, so nothing was removed and the setup is still open. Try again."
  }
};

function isRetryKind(value: string): value is OperationRetryKind {
  return value === "setup" || value === "verification" || value === "cleanup";
}

/**
 * Reopen a closed operation for exactly one saved command.
 *
 * The order is the safety property and does not vary by command: take the
 * repository lock, snapshot what a failure must restore, record the command
 * with its derived identity, position the record where the work resumes, make
 * it durable, and only then hand the work to a runner.
 */
async function runAcceptedCommand(
  {
    context,
    dependencies,
    operationId,
    operation,
    eligibility
  }: CommandRequest,
  spec: CommandSpec
): Promise<void> {
  const lock = dependencies.acquireForRetry(operation);
  if (!lock.ok) {
    sendJson(context, 409, {
      error: `Another setup is already running for ${String(operation.repo ?? "")}.`,
      code: "operation-in-progress",
      operationId: lock.conflict.operationId
    });
    return;
  }

  const snapshot: unknown = snapshotRetryState(operation);
  const attempt = beginRetryAttempt(operation, spec.attemptKind);
  const accepted = acceptOperationCommand(operation, {
    kind: spec.commandKind,
    attempt,
    // Rollback keys on the exact artifact set it will remove, so a repeat of
    // the same request is the same command and a different set is not.
    target: eligibility.target ?? spec.name
  });
  const commandId = accepted.command.commandId;
  if (!accepted.ok) {
    // The identity is derived from saved facts, so a double click, a lost
    // response, or a reload all resolve to the command already in flight.
    rollbackRetryAttempt(operation, snapshot);
    sendJson(context, 202, {
      operationId,
      statusUrl: statusUrlFor(operationId),
      commandId,
      duplicate: true
    });
    return;
  }
  spec.prepare?.(operation, eligibility);
  spec.prepareAccepted?.(operation, eligibility, commandId);
  try {
    await dependencies.persistOperations();
  } catch (error) {
    rollbackRetryAttempt(operation, snapshot);
    sendJson(context, 500, {
      error: spec.persistFailureMessage,
      code: spec.persistFailureCode,
      operationId,
      detail: errorMessage(error)
    });
    return;
  }
  setCommandState(operation, commandId, "running");

  const start = (): boolean =>
    dependencies.schedule({
      kind: spec.scheduleKind,
      instanceId: context.instanceId,
      operation,
      commandId
    });
  const accept = (): void => {
    sendJson(context, 202, {
      operationId,
      statusUrl: statusUrlFor(operationId),
      commandId,
      attempt,
      operation: clientView(operation)
    });
  };
  // Best effort: the in-memory record is already correct after either recovery
  // below, so polling reports the truth even if this durable write does not
  // land.
  const persistRecovery = async (): Promise<void> => {
    try {
      await dependencies.persistOperations();
    } catch {
      // Intentionally swallowed; the record the customer polls is already right.
    }
  };

  if (spec.schedulerMiss === "restore-terminal") {
    // Scheduling first keeps the promise the response makes: the customer is
    // told work started only once a runner has it. There is no await between
    // the two, so the record cannot advance before the response is written.
    if (!start()) {
      // Undoing the reopened attempt removes the command with it, so the record
      // goes back to exactly the terminal decision the customer is looking at.
      rollbackRetryAttempt(operation, snapshot);
      sendJson(context, 503, {
        error: `Radius could not start the ${spec.workLabel ?? spec.name}, so no work was started and nothing changed. Try again.`,
        code: "operation-command-unscheduled",
        operationId,
        operation: clientView(operation)
      });
      await persistRecovery();
      return;
    }
    accept();
    return;
  }

  accept();
  if (start()) return;
  // No runner accepted the work, so nothing will advance the record this
  // request just reopened. The 202 is already on the wire and cannot be
  // recalled, but leaving the operation `running` would hold the repository
  // lock and keep the panel spinning until the record went stale.
  setCommandState(operation, commandId, "finished", "unscheduled");
  finish(operation, "failed", {
    failure: {
      code: "operation-scheduling-failed",
      stage: operation.currentStage,
      stepSeq: null,
      message: `Radius accepted the ${spec.workLabel ?? spec.name} retry but could not start any work for it.`,
      classification: "unknown",
      evidence: `No server-owned task runner was available for instance ${context.instanceId}.`
    }
  });
  await persistRecovery();
}

/**
 * Run one control command end to end for the route that carried it.
 *
 * `selectSpec` resolves the row the request asked for and answers the request
 * itself when the path names no command this family implements.
 */
async function runCommandRoute(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies,
  route: string,
  selectSpec: (
    params: Readonly<Record<string, string>>,
    operationId: string
  ) => CommandSpec | null
): Promise<void> {
  const resolved = await resolveOperation(context, route, dependencies);
  if (!resolved) return;
  const { operationId, operation, params } = resolved;
  const spec = selectSpec(params, operationId);
  if (!spec) return;

  if (spec.activeKinds) {
    const active = findActiveOperationCommand(operation, spec.activeKinds);
    if (active) {
      sendJson(context, 202, {
        operationId,
        statusUrl: statusUrlFor(operationId),
        commandId: active.commandId,
        duplicate: true,
        operation: clientView(operation)
      });
      return;
    }
  }

  const eligibility = spec.eligibility(operation);
  if (!eligibility.ok) {
    sendJson(context, 409, {
      error: retryRefusalMessage(
        spec.refusalKind ?? spec.name,
        eligibility.code
      ),
      code: eligibility.code,
      operationId,
      ...(eligibility.detail ? { detail: eligibility.detail } : {}),
      operation: clientView(operation)
    });
    return;
  }
  const request: CommandRequest = {
    context,
    dependencies,
    operationId,
    operation,
    eligibility
  };
  if (spec.precondition && !(await spec.precondition(request))) return;
  if (spec.settleWithoutWork && (await spec.settleWithoutWork(request))) return;
  await runAcceptedCommand(request, spec);
}

/**
 * Continue a deliberately stopped setup.
 *
 * This is the first forward action after Stop, so it is a command of its own
 * rather than the setup retry wearing a different label: the customer has not
 * retried anything yet, and the record should say which decision they made.
 */
export function handleContinueOperation(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies
): Promise<void> {
  return runCommandRoute(
    context,
    dependencies,
    CONTINUE_OPERATION_ROUTE,
    () => COMMANDS.continue
  );
}

/**
 * Remove the resources this attempt created.
 *
 * The browser confirms first, but confirmation is not authorisation: the
 * deletion set is re-derived from the saved ledger here, so a stale panel
 * cannot ask Radius to remove a resource it no longer proves it created.
 */
export function handleRollbackOperation(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies
): Promise<void> {
  return runCommandRoute(
    context,
    dependencies,
    ROLLBACK_OPERATION_ROUTE,
    () => COMMANDS.rollback
  );
}

/**
 * Leave a setup the customer no longer wants to finish.
 *
 * Exit is the panel's way out, and it is a server-owned command rather than a
 * dismissal: it closes the saved record so the panel stops reporting the
 * attempt, and it removes the disposable artifacts this attempt created —
 * chiefly the GitHub environment that would otherwise sit in the environment
 * list forever. The deletion set is the rollback's proven-owned selection,
 * re-derived here, so a reused App Registration, a reused Service Principal,
 * and an environment Radius cannot prove it created are never touched.
 */
export function handleExitOperation(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies
): Promise<void> {
  return runCommandRoute(
    context,
    dependencies,
    EXIT_OPERATION_ROUTE,
    () => COMMANDS.exit
  );
}

/** Reopen a closed operation for one allowed retry. */
export function handleRetryOperation(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies
): Promise<void> {
  return runCommandRoute(
    context,
    dependencies,
    RETRY_OPERATION_ROUTE,
    (params, operationId) => {
      const requestedKind = decodeSegment(params.retryKind) ?? "";
      if (!isRetryKind(requestedKind)) {
        sendJson(context, 400, {
          error: `Radius does not support a "${requestedKind}" retry.`,
          code: "unsupported-retry",
          operationId
        });
        return null;
      }
      return COMMANDS[requestedKind];
    }
  );
}

export function createOperationsControlRoutes(
  dependencies: OperationsControlDependencies
): RouteHandlerRegistry {
  const operationMutations = new Map<string, Promise<void>>();
  const runSerialized = (
    context: CanvasRequestContext,
    route: string,
    handler: (
      context: CanvasRequestContext,
      dependencies: OperationsControlDependencies
    ) => Promise<void>
  ): Promise<void> => {
    const rawOperationId =
      templatePathParameters(route, context.url.pathname)?.operationId ?? "";
    const operationId = decodeSegment(rawOperationId) ?? rawOperationId;
    const previous = operationMutations.get(operationId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => handler(context, dependencies));
    operationMutations.set(operationId, current);
    return current.finally(() => {
      if (operationMutations.get(operationId) === current) {
        operationMutations.delete(operationId);
      }
    });
  };
  return {
    [`POST ${STOP_OPERATION_ROUTE}`]: (context) =>
      runSerialized(context, STOP_OPERATION_ROUTE, handleStopOperation),
    [`POST ${CONTINUE_OPERATION_ROUTE}`]: (context) =>
      runSerialized(context, CONTINUE_OPERATION_ROUTE, handleContinueOperation),
    [`POST ${ROLLBACK_OPERATION_ROUTE}`]: (context) =>
      runSerialized(context, ROLLBACK_OPERATION_ROUTE, handleRollbackOperation),
    [`POST ${EXIT_OPERATION_ROUTE}`]: (context) =>
      runSerialized(context, EXIT_OPERATION_ROUTE, handleExitOperation),
    [`POST ${RETRY_OPERATION_ROUTE}`]: (context) =>
      runSerialized(context, RETRY_OPERATION_ROUTE, handleRetryOperation)
  };
}
