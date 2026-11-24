import type { DeletionOperation } from "./environment-deletion.js";

// Persisted IDs: changing them would change retry behavior for existing records.
export const STAGE_DELETE_RADIUS_ENV = "delete_radius_environment";
export const STAGE_DELETE_CREDENTIAL = "delete_federated_credential";
export const STAGE_DELETE_GITHUB_ENV = "delete_github_environment";
export const STAGE_DELETE_STATE_PACKAGE = "delete_state_package";
export const STAGE_REVIEW_APP_REGISTRATION = "review_app_registration";
export const STAGE_DELETE_AWS_ROLE_ACCESS = "delete_aws_role_access";
export const STAGE_REVIEW_IAM_ROLE = "review_iam_role";

export interface EnvironmentDeletionProgress {
  enterStage(op: DeletionOperation, stage: string): void;
  setStageState(op: DeletionOperation, stage: string, state: string): void;
  addStep(
    op: DeletionOperation,
    step: {
      stage: string;
      kind: "mutation" | "observation" | "warning";
      label: string;
      state?: "running" | "succeeded" | "failed";
      warning?: { code: string; message: string; impact?: string };
    }
  ): void;
  finish(
    op: DeletionOperation,
    state: "failed" | "failed_partial" | "action_required",
    outcome: {
      terminal?: { code: string; userMessage: string };
      failure?: {
        code: string;
        stage: string;
        stepSeq: null;
        message: string;
        classification: "user-fixable";
        evidence: null;
      };
    }
  ): void;
  finishSucceeded(
    op: DeletionOperation,
    terminal: "succeeded" | "succeeded_with_warnings"
  ): void;
  hasWarnings(op: DeletionOperation): boolean;
  touchOperation(op: DeletionOperation): void;
  setContext(op: DeletionOperation, patch: Record<string, unknown>): void;
}
