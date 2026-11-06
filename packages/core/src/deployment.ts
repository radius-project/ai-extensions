/** Deployment data shared by runtime owners and frontend projections. */
export type DeploymentErrorKind =
  | "branch-not-pushed"
  | "run-unconfirmed"
  | "oidc-subject-missing"
  | "oidc-subject-case-mismatch"
  | "cloud-auth-drift";

export type DeploymentResource = {
  id?: string;
  name?: string;
  type?: string;
  displayType?: string;
  outputResources?: DeploymentResource[];
  deployStatus?: "pending" | "in_progress" | "success" | "failed";
  deployMessage?: string;
  portalUrl?: string;
};

export interface DeploymentParameters {
  targetRepo?: string;
  environment?: string;
  provider?: string;
  branch?: string;
  appFile?: string;
}

export interface DeploymentAttempt extends DeploymentParameters {
  id: string;
}

export interface DeploymentExecutionReference {
  workflowFile: string;
  dispatchedAt: number;
  environment: string;
  baselineRunId: number | string | null;
}

export type DeploymentState = {
  envName?: string;
  workspaceBranch?: string;
  deployParams?: DeploymentParameters;
  deployAttempt?: DeploymentAttempt;
  deployGeneration?: number;
  deployingRepo?: string;
  deployingBranch?: string;
  deployingProvider?: string;
  deployingResources?: DeploymentResource[] | null;
  deployStatus?: string;
  deployError?: string | null;
  deployErrorKind?: DeploymentErrorKind | null;
  deployErrorBranch?: string | null;
  deployErrorPaths?: string | null;
  deployEnvName?: string;
  deployAppName?: string;
  deployDispatchedAt?: number;
  deployRunId?: string | number | null;
  deployRunUrl?: string | null;
  deployStartedAt?: number;
  deployFinishedAt?: number;
  deployLogs?: string[];
  deployLogBase?: number;
  deployedGraph?: DeploymentResource[] | null;
  deployedGraphRepo?: string;
  deployRepairing?: boolean;
  deployHandoffState?: string;
  deployHandoffAttempts?: number;
  deployNoticeState?: string;
  deployNoticeAttempts?: number;
  deployRepairAttempts?: number;
};

export interface DeploymentBicepParameter {
  name: string;
  type: string;
  secure: boolean;
  hasDefault: boolean;
  default: string | null;
  description: string;
}
