import { createHash } from "node:crypto";
import {
  prepareProviderMutation,
  providerMutationId,
  providerMutationRecord,
  requestStop,
  settleProviderMutation,
  shouldStop,
  unresolvedProviderMutations,
  type ProviderMutationRecord
} from "../../operations.js";

export interface ProviderMutationCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type ProviderMutationReconciliation<T> =
  | {
      state: "applied";
      value: T;
      evidence?: string;
      /**
       * The provider's own immutable id for what this mutation wrote, settled
       * in the same write as the status so no crash can separate them.
       */
      providerId?: string | null;
    }
  | { state: "not_applied"; evidence?: string }
  | { state: "manual_required"; guidance: string };

export type RecoverableMutationResult<T> =
  | { state: "applied"; value: T; recovered: boolean }
  | { state: "not_applied"; result?: ProviderMutationCommandResult }
  | { state: "cancelled" };

export class ProviderMutationRecoveryError extends Error {
  readonly code: string;

  constructor(message: string, code = "provider-mutation-recovery-failed") {
    super(message);
    this.name = "ProviderMutationRecoveryError";
    this.code = code;
  }
}

type RecoveringOperation = {
  recoveryState?: string | null;
  providerRecovery?: { state?: string; guidance?: string | null };
};

function requireRecoveryRollback(
  operation: RecoveringOperation,
  mutation: ProviderMutationRecord
): void {
  if (
    operation.recoveryState !== "provider_reconciliation_pending" ||
    mutation.kind.startsWith("github_workflow.dispatch") ||
    // A deletion the rollback itself issued settles inside a pass that is
    // already the rollback. Demanding another one, and stopping the executor to
    // get it, would halt that pass between two deletions.
    mutation.kind.endsWith(".cleanup_delete") ||
    unresolvedProviderMutations(operation).length > 0
  ) {
    return;
  }
  if (operation.providerRecovery) {
    operation.providerRecovery.state = "rollback_pending";
    operation.providerRecovery.guidance = null;
  }
  requestStop(operation);
}

/**
 * Whether the provider's answer leaves the mutation's outcome unknown.
 *
 * A nonzero exit is not by itself evidence that nothing happened. A CLI that was
 * killed, lost its socket, or died mid-write may have delivered the request
 * before it failed, and recording that as `not_applied` is what lets the next
 * attempt replay a mutation that already landed. Only an answer the provider
 * itself composed — a validation error, a permission refusal, a conflict — says
 * the request was seen and rejected.
 *
 * So the test is an allowlist rather than a denylist. A denylist has to
 * enumerate every way a request can fail inconclusively and gets the default
 * exactly backwards: the failure nobody anticipated becomes "nothing happened",
 * which is the one verdict that authorizes a blind replay. Here an
 * unrecognised diagnostic stays unknown, and only a recognised conclusive
 * rejection is allowed to say the provider refused the write.
 */
export function providerMutationOutcomeUnknown(
  result: ProviderMutationCommandResult,
  target?: string
): boolean {
  // A timeout, a kill, or a signal is never a success, whatever the exit code
  // says. Only an unambiguous zero is read as an answer.
  if (result.timedOut === true) return true;
  if (result.code === 0 || result.code === "0") return false;
  return classifyProviderMutationFailure(result, target) !== "not_applied";
}

export type ProviderMutationFailureVerdict = "not_applied" | "outcome_unknown";

/**
 * Read a failed provider command as either a conclusive rejection or silence.
 *
 * `not_applied` is the load-bearing verdict: it is the only one that lets a
 * later attempt reissue the same write. It is reached only when the diagnostic
 * carries a rejection the provider itself composed and carries nothing that
 * could equally describe a request the provider accepted and then failed to
 * acknowledge.
 */
/**
 * The diagnostic with the target's own name taken out of it.
 *
 * The allowlist below matches case-insensitively, and a provider's error text
 * usually quotes the resource it was about — often as a URL. A resource the
 * customer named `gone`, `conflict`, or `forbidden` would otherwise supply the
 * very token that means "the provider refused this", turning an inconclusive
 * network failure into the one verdict that authorizes reissuing the request.
 * The name is removed before the text is read as a status.
 */
function withoutTargetText(diagnostic: string, target?: string): string {
  const raw = (target || "").trim();
  if (!raw) return diagnostic;
  const segments = new Set<string>([raw]);
  for (const segment of raw.split(/[\0:/\\]/)) {
    const trimmed = segment.trim();
    // Two characters cannot carry a status word, and removing them would chew
    // holes in text that has nothing to do with the target.
    if (trimmed.length >= 3) {
      segments.add(trimmed);
      try {
        segments.add(encodeURIComponent(trimmed));
      } catch {
        // A segment that cannot be encoded is matched in its raw form only.
      }
    }
  }
  let masked = diagnostic;
  for (const segment of [...segments].sort((a, b) => b.length - a.length)) {
    masked = masked.split(segment).join(" ");
    const lowered = segment.toLowerCase();
    const uppered = segment.toUpperCase();
    if (lowered !== segment) masked = masked.split(lowered).join(" ");
    if (uppered !== segment) masked = masked.split(uppered).join(" ");
  }
  return masked;
}

export function classifyProviderMutationFailure(
  result: ProviderMutationCommandResult,
  target?: string
): ProviderMutationFailureVerdict {
  if (result.timedOut === true) return "outcome_unknown";
  // A signal name or a negative/128+ status is the process dying, not an answer.
  if (typeof result.code === "string" && /^SIG[A-Z0-9]+$/.test(result.code)) {
    return "outcome_unknown";
  }
  const status = Number(result.code);
  if (Number.isFinite(status) && (status < 0 || status >= 128)) {
    return "outcome_unknown";
  }
  const diagnostic = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  // Nothing came back to read, so nothing says the provider rejected anything.
  if (!diagnostic) return "outcome_unknown";
  if (INCONCLUSIVE_FAILURE.test(diagnostic)) return "outcome_unknown";
  return CONCLUSIVE_REJECTION.test(withoutTargetText(diagnostic, target)) ?
      "not_applied"
    : "outcome_unknown";
}

// Answers that are compatible with the provider having accepted the write.
// Checked before the allowlist so a diagnostic carrying both — a 500 that also
// mentions "Not Found", a retry summary quoting an earlier 422 — stays unknown.
const INCONCLUSIVE_FAILURE =
  /\b(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|EPIPE|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EAI_AGAIN)\b|\bHTTP\s*5\d\d\b|\bstatus(?:\s*code)?[:=]?\s*5\d\d\b|connection (?:reset|closed|aborted)|broken pipe|socket hang up|network is unreachable|unexpected EOF|premature close|stream closed|terminated by signal|\bkilled\b|timed? ?out|\btimeout\b|context deadline exceeded|deadline exceeded|i\/o timeout|request canceled|operation was cancell?ed|TLS handshake|remote error|server closed the connection|internal server error|bad gateway|service unavailable|gateway time-?out|temporarily unavailable|try again later|\bEOF\b/i;

// Rejections the provider composed. Every entry names a request the provider
// saw, understood, and refused, so nothing was written and reissuing the same
// call is safe.
const CONCLUSIVE_REJECTION = new RegExp(
  [
    // GitHub REST/CLI: an explicit 4xx other than 408 Request Timeout.
    String.raw`\bHTTP\s*(?:400|401|403|404|405|409|410|415|422|429|451)\b`,
    String.raw`\b(?:Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Conflict|Gone|Unsupported Media Type|Unprocessable Entity|Validation Failed|API rate limit exceeded|Too Many Requests|TooManyRequests)\b`,
    String.raw`Resource not accessible by`,
    String.raw`Bad credentials`,
    String.raw`Resource protected by organization SAML enforcement`,
    String.raw`grant your OAuth token access`,
    String.raw`Must have admin rights`,
    String.raw`already exists`,
    String.raw`Reference (?:already exists|does not exist)`,
    String.raw`refusing to allow`,
    String.raw`protected branch|branch protection|required status check|approving review|review is required|through a pull request|push declined`,
    // Azure CLI argument parsing never reaches the service at all.
    String.raw`unrecognized arguments|the following arguments are required|argument [^:\n]+: (?:expected|invalid)|invalid choice`,
    // Microsoft Graph and ARM error identifiers.
    String.raw`\b(?:AuthorizationFailed|InvalidAuthenticationToken|Authorization_RequestDenied|Authentication_Unauthorized|Request_BadRequest|Request_ResourceNotFound|Directory_ObjectNotFound|BadRequest|InvalidRequest|InvalidRequestFormat|ValidationError|InvalidArgumentValue|InvalidParameterValue|MissingRequiredParameter|ResourceNotFound|ResourceGroupNotFound|SubscriptionNotFound|InvalidResourceType|MissingSubscription|RoleAssignmentExists|RoleDefinitionDoesNotExist|PrincipalNotFound|InvalidPrincipalId|LinkedAuthorizationFailed|InvalidTemplateDeployment)\b`,
    String.raw`Insufficient privileges to complete the operation`,
    String.raw`does not have authorization to perform action`,
    String.raw`is not authorized to perform action`,
    String.raw`does not exist or one of its queried reference-property objects are not present`,
    String.raw`does not exist in the directory`,
    String.raw`Cannot find (?:principal|user or service principal)`,
    String.raw`No matching principal`,
    String.raw`not found in the directory`,
    String.raw`added object references already exist|object reference already exists`,
    // Service Management Reference identifiers, matched as the tenant emits them.
    String.raw`serviceManagementReference|serviceTreeNullValueProvided|serviceTreeInvalid`,
    String.raw`Please run 'az login'|az login --|Please run 'az account set'`
  ].join("|"),
  "i"
);

export function deterministicProviderUuid(seed: string): string {
  const bytes = Buffer.from(
    createHash("sha256").update(seed).digest().subarray(0, 16)
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

async function persistOrThrow(
  persist: () => Promise<void>,
  phase: string
): Promise<void> {
  try {
    await persist();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProviderMutationRecoveryError(
      `Could not persist the provider mutation recovery record ${phase}: ${detail}`,
      "provider-mutation-recovery-persistence-failed"
    );
  }
}

/**
 * How many times a mutation's provider state may fail to be readable before
 * the uncertainty is handed to the customer.
 *
 * Reconciliation is rescheduled on a fixed interval, so a read that can never
 * succeed — a directory that will never list the object, a repository the token
 * lost access to — otherwise retries for as long as the extension runs. The
 * record stays nonterminal, the repository stays reserved, and no command is
 * ever offered to clear it. Bounding the attempts turns that silent livelock
 * into a named refusal that the destructive gates and the panel can both act
 * on. The mutation is still never replayed.
 */
const MAX_RECONCILE_ATTEMPTS = 12;

async function confirmProviderMutation<T>({
  operation,
  mutation,
  value,
  recovered,
  evidence,
  providerId = null,
  createdByOperation,
  persist,
  onConfirmed
}: {
  operation: object;
  mutation: ProviderMutationRecord;
  value: T;
  recovered: boolean;
  evidence: string | null;
  providerId?: string | null;
  createdByOperation?: boolean;
  persist: () => Promise<void>;
  onConfirmed?: (value: T, recovered: boolean) => void;
}): Promise<void> {
  try {
    onConfirmed?.(value, recovered);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const guidance = `The provider mutation succeeded, but Radius could not record the deletion provenance: ${detail}`;
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "manual_required",
      guidance
    );
    await persistOrThrow(persist, "after deletion provenance recording failed");
    throw new ProviderMutationRecoveryError(
      guidance,
      "provider-mutation-manual-required"
    );
  }
  settleProviderMutation(
    operation,
    mutation.mutationId,
    "confirmed",
    evidence,
    providerId,
    createdByOperation
  );
  if (recovered) requireRecoveryRollback(operation, mutation);
  await persistOrThrow(
    persist,
    recovered ? "after reconciliation" : "after the provider acknowledged it"
  );
}

async function reconcileMutation<T>(
  operation: object,
  mutation: ProviderMutationRecord,
  reconcile: () => Promise<ProviderMutationReconciliation<T>>,
  persist: () => Promise<void>,
  onConfirmed?: (value: T, recovered: boolean) => void,
  rethrowReconciliationError?: (error: unknown) => boolean
): Promise<RecoverableMutationResult<T>> {
  // `settleProviderMutation` normalizes the whole recovery record, so the entry
  // it leaves behind is a different object from the one passed in here. The
  // attempt counter has to be written to that live entry or it is discarded.
  const recordAttempts = (attempts: number): void => {
    const live = (
      operation as {
        providerRecovery?: { mutations?: ProviderMutationRecord[] };
      }
    ).providerRecovery?.mutations?.find(
      (entry) => entry.mutationId === mutation.mutationId
    );
    if (live) live.reconcileAttempts = attempts;
  };
  let outcome: ProviderMutationReconciliation<T>;
  try {
    outcome = await reconcile();
  } catch (error) {
    if (rethrowReconciliationError?.(error)) throw error;
    return recordProviderReconciliationFailure(
      operation,
      mutation,
      persist,
      error,
      recordAttempts
    );
  }
  if (outcome.state === "manual_required") {
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "manual_required",
      outcome.guidance
    );
    await persistOrThrow(persist, "after manual reconciliation was required");
    throw new ProviderMutationRecoveryError(
      outcome.guidance,
      "provider-mutation-manual-required"
    );
  }
  if (outcome.state === "applied") {
    await confirmProviderMutation({
      operation,
      mutation,
      value: outcome.value,
      recovered: true,
      evidence: outcome.evidence || null,
      providerId: outcome.providerId ?? null,
      persist,
      onConfirmed
    });
    return { state: "applied", value: outcome.value, recovered: true };
  }
  settleProviderMutation(
    operation,
    mutation.mutationId,
    "not_applied",
    outcome.evidence || null
  );
  requireRecoveryRollback(operation, mutation);
  await persistOrThrow(persist, "after reconciliation");
  return { state: "not_applied" };
}

export async function recordProviderReconciliationFailure(
  operation: object,
  mutation: ProviderMutationRecord,
  persist: () => Promise<void>,
  error: unknown,
  recordAttempts?: (attempts: number) => void
): Promise<never> {
  const detail = error instanceof Error ? error.message : String(error);
  const attempts = (Number(mutation.reconcileAttempts) || 0) + 1;
  const saveAttempts =
    recordAttempts ??
    ((value: number) => {
      const live = (
        operation as {
          providerRecovery?: { mutations?: ProviderMutationRecord[] };
        }
      ).providerRecovery?.mutations?.find(
        (entry) => entry.mutationId === mutation.mutationId
      );
      if (live) live.reconcileAttempts = value;
    });
  if (attempts >= MAX_RECONCILE_ATTEMPTS) {
    const guidance =
      `Radius could not read provider state for ${mutation.kind} on ${mutation.target} after ${attempts} attempts, most recently: ${detail}. ` +
      "It will not repeat that request or delete anything on a guess. Review that resource yourself, remove it if it is unwanted, then start a new setup.";
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "manual_required",
      guidance
    );
    saveAttempts(attempts);
    await persistOrThrow(persist, "after reconciliation was abandoned");
    throw new ProviderMutationRecoveryError(
      guidance,
      "provider-mutation-manual-required"
    );
  }
  settleProviderMutation(
    operation,
    mutation.mutationId,
    "outcome_unknown",
    `Provider state could not be read: ${detail}`
  );
  saveAttempts(attempts);
  await persistOrThrow(persist, "after reconciliation failed");
  throw new ProviderMutationRecoveryError(
    `Radius could not confirm the outcome of ${mutation.kind} for ${mutation.target}. It will not retry that mutation until provider state can be read safely.`,
    "provider-mutation-outcome-unknown"
  );
}

/**
 * Whether the next `executeRecoverableMutation` for this entry would issue a
 * forward provider write rather than reread state it already journaled.
 *
 * A Stop boundary belongs before a write and never before a reconciliation: the
 * read is what settles the provenance of a request nobody saw answered, and
 * skipping it would strand that entry unresolved on an operation the Stop is
 * about to make terminal. Callers gate on this so the same journal decides both
 * whether to write and whether a Stop may intervene.
 */
export function providerMutationWillWrite(
  operation: object & { operationId: string },
  kind: string,
  target: string
): boolean {
  const journaled = providerMutationRecord(operation, kind, target);
  return !journaled || journaled.status === "not_applied";
}

type RecoverableMutationInput<T> = {
  operation: object & { operationId: string };
  kind: string;
  target: string;
  providerIdempotencyKey?: string | null;
  intent?: Record<string, string | number | boolean | null> | null;
  persist(): Promise<void>;
  beforeMutation?(): Promise<boolean>;
  /**
   * Revalidate provider identity after intent is durable but before the request
   * is sent. A rejection proves the provider mutation was not attempted.
   */
  validateBeforeMutation?(): Promise<void>;
  mutate(): Promise<ProviderMutationCommandResult>;
  accept(result: ProviderMutationCommandResult): T;
  /**
   * Read the provider's own immutable id out of the response it acknowledged
   * with, so it is settled together with the confirmed status. A resource whose
   * name can be reused is otherwise indistinguishable from its replacement
   * after a restart.
   */
  providerIdOf?(result: ProviderMutationCommandResult, value: T): string | null;
  /**
   * Record whether an acknowledged create actually made its target. Some
   * providers return success for "already exists"; recovery must preserve that
   * distinction so rollback never takes ownership of a reused resource.
   */
  createdByOperation?(
    result: ProviderMutationCommandResult,
    value: T
  ): boolean | undefined;
  /**
   * What the journal should record for a write that ended well.
   *
   * A caller that treats a provider's "this already holds" as success must say
   * so here: recording "the provider acknowledged the mutation" for a write it
   * refused makes the audit trail describe something that never happened.
   */
  acceptedEvidence?(result: ProviderMutationCommandResult): string | null;
  reconcile(): Promise<ProviderMutationReconciliation<T>>;
  /**
   * Add provider-specific artifact provenance before the confirmed journal entry
   * is persisted, so a crash cannot save one without the other.
   */
  onConfirmed?(value: T, recovered: boolean): void;
  /**
   * Turn a conclusive provider rejection into a manual blocker in the same
   * settle. A destructive request Radius issued once and the provider refused
   * leaves the resource in place, and `not_applied` is a resolved status: a
   * crash between recording it and writing a separate blocker would reload a
   * record that looks fully reconciled with the resource still there.
   */
  rejectionGuidance?(result: ProviderMutationCommandResult): string;
  rethrowReconciliationError?(error: unknown): boolean;
};

type NonCancelledMutationResult<T> = Exclude<
  RecoverableMutationResult<T>,
  { state: "cancelled" }
>;

export function executeRecoverableMutation<T>(
  input: RecoverableMutationInput<T> & { beforeMutation?: undefined }
): Promise<NonCancelledMutationResult<T>>;
export function executeRecoverableMutation<T>(
  input: RecoverableMutationInput<T>
): Promise<RecoverableMutationResult<T>>;
export async function executeRecoverableMutation<T>(
  input: RecoverableMutationInput<T>
): Promise<RecoverableMutationResult<T>> {
  const mutationId = providerMutationId(
    input.operation.operationId,
    input.kind,
    input.target
  );
  const existingBefore = (
    input.operation as {
      providerRecovery?: { mutations?: ProviderMutationRecord[] };
    }
  ).providerRecovery?.mutations?.find(
    (entry) => entry.mutationId === mutationId
  );
  // Read before `prepareProviderMutation` journals this attempt, so the answer
  // describes the world the caller's Stop gate was asked about.
  const shouldMutate = providerMutationWillWrite(
    input.operation,
    input.kind,
    input.target
  );
  // Rollback may reread an already-journaled setup mutation to settle its exact
  // outcome, but it may never start or replay a forward provider write. A
  // deletion issued by the cleanup itself is not forward work — it is the
  // rollback — so it is exempt along with the setup-branch delete that unblocks
  // it.
  if (
    (input.operation as RecoveringOperation).providerRecovery?.state ===
      "rollback_pending" &&
    input.kind !== "github_branch.delete" &&
    !input.kind.endsWith(".cleanup_delete") &&
    (!existingBefore ||
      existingBefore.status === "not_applied" ||
      existingBefore.status === "manual_required")
  ) {
    throw new ProviderMutationRecoveryError(
      "Radius has finished reconciling the interrupted provider request and must delete the setup resources before any further provider changes.",
      "provider-mutation-rollback-pending"
    );
  }
  const mutation = prepareProviderMutation(input.operation, {
    kind: input.kind,
    target: input.target,
    providerIdempotencyKey: input.providerIdempotencyKey,
    intent: input.intent
  });

  if (shouldMutate) {
    if (existingBefore?.status === "not_applied") {
      mutation.status = "prepared";
      mutation.preparedAt = new Date().toISOString();
      mutation.updatedAt = mutation.preparedAt;
      mutation.evidence = null;
      // The refused attempt made nothing, so any id it once carried belongs to
      // an earlier world and must not be matched against what this one writes.
      mutation.providerId = null;
      delete mutation.createdByOperation;
      // The refused attempt's intent described the world it was about to write
      // into. That world has moved on, so a fresh attempt journals the state it
      // actually read rather than inheriting a predecessor that is no longer
      // the one a revert would restore.
      if (input.intent) mutation.intent = structuredClone(input.intent);
      else delete mutation.intent;
    }
    await persistOrThrow(input.persist, "before the provider request");
    if (input.beforeMutation && shouldStop(input.operation)) {
      settleProviderMutation(
        input.operation,
        mutation.mutationId,
        "not_applied",
        "Radius stopped before sending the provider request."
      );
      await persistOrThrow(
        input.persist,
        "after Stop prevented the provider request"
      );
      const stopCompleted = !(await input.beforeMutation());
      if (!stopCompleted) {
        throw new ProviderMutationRecoveryError(
          "Radius must reconcile the existing provider request before it can honor Stop or start another provider mutation.",
          "provider-mutation-outcome-unknown"
        );
      }
      return { state: "cancelled" };
    }
    if (input.validateBeforeMutation) {
      try {
        await input.validateBeforeMutation();
      } catch (error) {
        settleProviderMutation(
          input.operation,
          mutation.mutationId,
          "not_applied",
          error instanceof Error ? error.message : String(error)
        );
        await persistOrThrow(
          input.persist,
          "after provider identity validation prevented the request"
        );
        throw error;
      }
    }
    let result: ProviderMutationCommandResult;
    try {
      result = await input.mutate();
    } catch {
      settleProviderMutation(
        input.operation,
        mutation.mutationId,
        "outcome_unknown",
        "The provider request ended without a response."
      );
      await persistOrThrow(
        input.persist,
        "after the provider response was lost"
      );
      return reconcileMutation(
        input.operation,
        mutation,
        input.reconcile,
        input.persist,
        input.onConfirmed,
        input.rethrowReconciliationError
      );
    }
    // Ambiguity is read before success. A command that timed out, was killed,
    // or died on a signal can still exit 0 on some runners, and accepting that
    // as an acknowledgement records a mutation nobody saw the provider answer.
    if (providerMutationOutcomeUnknown(result, input.target)) {
      settleProviderMutation(
        input.operation,
        mutation.mutationId,
        "outcome_unknown",
        "The provider request ended without an answer Radius could trust."
      );
      await persistOrThrow(
        input.persist,
        "after the provider response was inconclusive"
      );
      return reconcileMutation(
        input.operation,
        mutation,
        input.reconcile,
        input.persist,
        input.onConfirmed,
        input.rethrowReconciliationError
      );
    }
    if (result.code === 0 || result.code === "0") {
      const value = input.accept(result);
      await confirmProviderMutation({
        operation: input.operation,
        mutation,
        value,
        recovered: false,
        evidence:
          input.acceptedEvidence?.(result) ||
          "The provider acknowledged the mutation.",
        providerId: input.providerIdOf?.(result, value) ?? null,
        createdByOperation: input.createdByOperation?.(result, value),
        persist: input.persist,
        onConfirmed: input.onConfirmed
      });
      return { state: "applied", value, recovered: false };
    }
    // Everything ambiguous was settled above, so what is left is an answer the
    // provider composed: a rejection that leaves the resource untouched.
    const manualGuidance = input.rejectionGuidance?.(result);
    if (manualGuidance) {
      settleProviderMutation(
        input.operation,
        mutation.mutationId,
        "manual_required",
        manualGuidance
      );
      await persistOrThrow(
        input.persist,
        "after the provider refused a destructive request"
      );
      throw new ProviderMutationRecoveryError(
        manualGuidance,
        "provider-mutation-manual-required"
      );
    }
    settleProviderMutation(
      input.operation,
      mutation.mutationId,
      "not_applied",
      (
        result.stderr ||
        result.stdout ||
        "The provider rejected the request."
      ).trim()
    );
    await persistOrThrow(input.persist, "after the provider rejected it");
    return { state: "not_applied", result };
  }

  if (
    mutation.status === "prepared" ||
    mutation.status === "outcome_unknown" ||
    mutation.status === "confirmed"
  ) {
    return reconcileMutation(
      input.operation,
      mutation,
      input.reconcile,
      input.persist,
      input.onConfirmed,
      input.rethrowReconciliationError
    );
  }
  if (mutation.status === "manual_required") {
    throw new ProviderMutationRecoveryError(
      mutation.evidence ||
        `Radius could not prove the outcome of ${input.kind} for ${input.target}.`,
      "provider-mutation-manual-required"
    );
  }

  return { state: "not_applied" };
}
