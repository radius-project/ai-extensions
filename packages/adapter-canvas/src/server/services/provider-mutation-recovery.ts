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

export function providerMutationOutcomeUnknown(
  result: ProviderMutationCommandResult
): boolean {
  return result.timedOut === true;
}

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

async function reconcileMutation<T>(
  operation: object,
  mutation: ProviderMutationRecord,
  reconcile: () => Promise<ProviderMutationReconciliation<T>>,
  persist: () => Promise<void>
): Promise<RecoverableMutationResult<T>> {
  let outcome: ProviderMutationReconciliation<T>;
  try {
    outcome = await reconcile();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "outcome_unknown",
      `Provider state could not be read: ${detail}`
    );
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
  persist(): Promise<void>;
  mutate(): Promise<ProviderMutationCommandResult>;
  accept(result: ProviderMutationCommandResult): T;
  reconcile(): Promise<ProviderMutationReconciliation<T>>;
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
  const mutation = prepareProviderMutation(input.operation, {
    kind: input.kind,
    target: input.target,
    providerIdempotencyKey: input.providerIdempotencyKey
  });

  const shouldMutate =
    !existingBefore || existingBefore.status === "not_applied";
  if (shouldMutate) {
    if (existingBefore?.status === "not_applied") {
      mutation.status = "prepared";
      mutation.preparedAt = new Date().toISOString();
      mutation.updatedAt = mutation.preparedAt;
      mutation.evidence = null;
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
