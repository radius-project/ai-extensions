import { createHash } from "node:crypto";
import {
  prepareProviderMutation,
  providerMutationId,
  requestStop,
  settleProviderMutation,
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
  | { state: "applied"; value: T; evidence?: string }
  | { state: "not_applied"; evidence?: string }
  | { state: "manual_required"; guidance: string };

export type RecoverableMutationResult<T> =
  | { state: "applied"; value: T; recovered: boolean }
  | { state: "not_applied"; result?: ProviderMutationCommandResult };

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
  result: ProviderMutationCommandResult
): boolean {
  if (result.timedOut !== true && (result.code === 0 || result.code === "0")) {
    return false;
  }
  return classifyProviderMutationFailure(result) !== "not_applied";
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
export function classifyProviderMutationFailure(
  result: ProviderMutationCommandResult
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
  return CONCLUSIVE_REJECTION.test(diagnostic) ? "not_applied" : (
      "outcome_unknown"
    );
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
    String.raw`\b(?:Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Conflict|Gone|Unsupported Media Type|Unprocessable Entity|Validation Failed|API rate limit exceeded)\b`,
    String.raw`Resource not accessible by`,
    String.raw`Bad credentials`,
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

async function reconcileMutation<T>(
  operation: object,
  mutation: ProviderMutationRecord,
  reconcile: () => Promise<ProviderMutationReconciliation<T>>,
  persist: () => Promise<void>
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
    const detail = error instanceof Error ? error.message : String(error);
    const attempts = (Number(mutation.reconcileAttempts) || 0) + 1;
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
      recordAttempts(attempts);
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
    recordAttempts(attempts);
    await persistOrThrow(persist, "after reconciliation failed");
    throw new ProviderMutationRecoveryError(
      `Radius could not confirm the outcome of ${mutation.kind} for ${mutation.target}. It will not retry that mutation until provider state can be read safely.`,
      "provider-mutation-outcome-unknown"
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
  settleProviderMutation(
    operation,
    mutation.mutationId,
    outcome.state === "applied" ? "confirmed" : "not_applied",
    outcome.evidence || null
  );
  requireRecoveryRollback(operation, mutation);
  await persistOrThrow(persist, "after reconciliation");
  return outcome.state === "applied" ?
      { state: "applied", value: outcome.value, recovered: true }
    : { state: "not_applied" };
}

export async function executeRecoverableMutation<T>(input: {
  operation: object & { operationId: string };
  kind: string;
  target: string;
  providerIdempotencyKey?: string | null;
  intent?: Record<string, string | number | boolean | null> | null;
  persist(): Promise<void>;
  mutate(): Promise<ProviderMutationCommandResult>;
  accept(result: ProviderMutationCommandResult): T;
  reconcile(): Promise<ProviderMutationReconciliation<T>>;
  /**
   * Turn a conclusive provider rejection into a manual blocker in the same
   * settle. A destructive request Radius issued once and the provider refused
   * leaves the resource in place, and `not_applied` is a resolved status: a
   * crash between recording it and writing a separate blocker would reload a
   * record that looks fully reconciled with the resource still there.
   */
  rejectionGuidance?(result: ProviderMutationCommandResult): string;
}): Promise<RecoverableMutationResult<T>> {
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
  // Rollback may reread an already-journaled setup mutation to settle its exact
  // outcome, but it may never start or replay a forward provider write.
  if (
    (input.operation as RecoveringOperation).providerRecovery?.state ===
      "rollback_pending" &&
    input.kind !== "github_branch.delete" &&
    (!existingBefore ||
      existingBefore.status === "not_applied" ||
      existingBefore.status === "manual_required")
  ) {
    throw new ProviderMutationRecoveryError(
      "Radius has finished reconciling the interrupted provider request and must roll back before any further provider changes.",
      "provider-mutation-rollback-pending"
    );
  }
  const mutation = prepareProviderMutation(input.operation, {
    kind: input.kind,
    target: input.target,
    providerIdempotencyKey: input.providerIdempotencyKey,
    intent: input.intent
  });

  const shouldMutate =
    !existingBefore || existingBefore.status === "not_applied";
  if (shouldMutate) {
    if (existingBefore?.status === "not_applied") {
      mutation.status = "prepared";
      mutation.preparedAt = new Date().toISOString();
      mutation.updatedAt = mutation.preparedAt;
      mutation.evidence = null;
      // The refused attempt's intent described the world it was about to write
      // into. That world has moved on, so a fresh attempt journals the state it
      // actually read rather than inheriting a predecessor that is no longer
      // the one a revert would restore.
      if (input.intent) mutation.intent = structuredClone(input.intent);
      else delete mutation.intent;
    }
    await persistOrThrow(input.persist, "before the provider request");
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
        input.persist
      );
    }
    if (result.code === 0 || result.code === "0") {
      const value = input.accept(result);
      settleProviderMutation(
        input.operation,
        mutation.mutationId,
        "confirmed",
        "The provider acknowledged the mutation."
      );
      await persistOrThrow(input.persist, "after the provider acknowledged it");
      return { state: "applied", value, recovered: false };
    }
    if (!providerMutationOutcomeUnknown(result)) {
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
    settleProviderMutation(
      input.operation,
      mutation.mutationId,
      "outcome_unknown",
      "The provider request timed out before Radius received a response."
    );
    await persistOrThrow(
      input.persist,
      "after the provider response timed out"
    );
    return reconcileMutation(
      input.operation,
      mutation,
      input.reconcile,
      input.persist
    );
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
      input.persist
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
