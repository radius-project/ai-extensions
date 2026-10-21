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
  | {
      state: "not_applied";
      result?: ProviderMutationCommandResult;
      // An inconclusive command's diagnostic must not become a retryable result.
      diagnostic?: string;
    }
  | { state: "cancelled" };

export type AzureMutationInput<T> = {
  kind: string;
  target: string;
  providerIdempotencyKey?: string | null;
  intent?: Record<string, string | number | boolean | null> | null;
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
export interface AzureMutationRecord {
  kind: string;
  status:
    | "prepared"
    | "outcome_unknown"
    | "confirmed"
    | "not_applied"
    | "manual_required";
  providerId?: string | null;
  evidence: string | null;
  createdByOperation?: boolean;
}
export interface AzureRecoveryPort {
  find(kind: string, target: string): AzureMutationRecord | null;
  willWrite(kind: string, target: string): boolean;
  unresolved(): readonly AzureMutationRecord[];
  execute<T>(
    input: AzureMutationInput<T>
  ): Promise<RecoverableMutationResult<T>>;
}
