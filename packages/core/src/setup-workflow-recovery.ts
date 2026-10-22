import type {
  AzureMutationInput,
  AzureMutationRecord,
  RecoverableMutationResult
} from "./setup-azure-recovery.js";

export interface SetupWorkflowMutation extends AzureMutationRecord {
  mutationId: string;
  target: string;
  intent?: Record<string, string | number | boolean | null> | null;
}

export interface SetupWorkflowRecoveryPort {
  readonly operationId: string;
  find(kind: string, target: string): SetupWorkflowMutation | null;
  byKind(kind: string): readonly SetupWorkflowMutation[];
  unresolved(): readonly SetupWorkflowMutation[];
  willWrite(kind: string, target: string): boolean;
  execute<T>(
    input: AzureMutationInput<T>
  ): Promise<RecoverableMutationResult<T>>;
  rollbackPending(): boolean;
  markRollbackPending(): void;
  settleManual(kind: string, target: string, guidance: string): void;
  persist(): Promise<void>;
}
