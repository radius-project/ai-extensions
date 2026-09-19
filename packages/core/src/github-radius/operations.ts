/** The persisted journal shape is shared; execution and model ownership are ports. */
export interface ProviderMutationRecord {
  mutationId: string;
  kind: string;
  target: string;
  status:
    | "prepared"
    | "confirmed"
    | "not_applied"
    | "outcome_unknown"
    | "manual_required";
  preparedAt: string;
  updatedAt: string;
  providerIdempotencyKey: string | null;
  providerId?: string | null;
  intent?: Record<string, string | number | boolean | null>;
  reconcileAttempts?: number;
  createdByOperation?: boolean;
  initialDiagnostic?: string | null;
  finalDiagnostic?: string | null;
  evidence: string | null;
}

/**
 * The operation owner supplies these state transitions. In particular, journal
 * normalization retains its credential redactor, digest implementation, clock,
 * persisted-version compatibility, and terminal notification behavior.
 *
 * Records are mutable working objects shared with the coordinator. Direct field
 * writes do not persist or notify; the caller owns the explicit checkpoints.
 * Unknown mutation IDs and invalid statuses return false without mutation.
 * Diagnostics for unknown IDs are a no-op. Preparing a mutation preserves
 * unrecoverable_legacy quarantine and its guidance. Repeated preparation uses
 * the same operation/kind/target identity, never a new journal entry.
 * Use createEnvironmentOperationDomain for the canonical transition policy.
 */
export interface OperationDomain {
  providerMutationId(operationId: string, kind: string, target: string): string;
  prepareProviderMutation(
    operation: unknown,
    input: {
      kind: string;
      target: string;
      providerIdempotencyKey?: string | null;
      intent?: Record<string, string | number | boolean | null> | null;
    }
  ): ProviderMutationRecord;
  settleProviderMutation(
    operation: unknown,
    mutationId: string,
    status: ProviderMutationRecord["status"],
    evidence?: string | null,
    providerId?: string | null,
    createdByOperation?: boolean
  ): boolean;
  providerMutationRecord(
    operation: unknown,
    kind: string,
    target: string
  ): ProviderMutationRecord | null;
  providerMutationsByKind(
    operation: unknown,
    kind: string
  ): ProviderMutationRecord[];
  unresolvedProviderMutations(
    operation: unknown,
    kinds?: readonly string[]
  ): ProviderMutationRecord[];
  recordProviderMutationDiagnostics(
    operation: unknown,
    mutationId: string,
    diagnostics: {
      initial?: string | null;
      final?: string | null;
    }
  ): boolean;
  requestStop(operation: unknown): boolean;
  shouldStop(operation: unknown): boolean;
  terminalizeProviderManualRequired(operation: unknown, guidance: string): void;
  enterStage(operation: unknown, stage: string): unknown;
  setStageState(operation: unknown, stage: string, state: string): unknown;
  addStep(
    operation: unknown,
    input: {
      stage?: string;
      kind?: string;
      label?: string;
      state?: string;
      warning?: {
        code?: string;
        message?: string;
        impact?: string;
        remediationCommand?: string;
        blocksFutureStep?: string;
      } | null;
    }
  ): unknown;
  finish(
    operation: unknown,
    state: string,
    options?: {
      terminal?: unknown;
      failure?: Record<string, unknown> | null;
      announce?: boolean;
    }
  ): unknown;
  finishSucceeded(operation: unknown, terminal?: unknown): unknown;
  hasWarnings(operation: unknown): boolean;
  touchOperation(operation: unknown, now?: string): unknown;
}

export const STAGE_DELETE_RADIUS_ENV = "delete_radius_environment";
export const STAGE_DELETE_CREDENTIAL = "delete_federated_credential";
export const STAGE_DELETE_GITHUB_ENV = "delete_github_environment";
export const STAGE_DELETE_STATE_PACKAGE = "delete_state_package";
export const STAGE_REVIEW_APP_REGISTRATION = "review_app_registration";
