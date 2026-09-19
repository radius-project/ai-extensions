export interface DeploymentResource {
  [metadata: string]: unknown;
  id?: string;
  name?: string;
  type?: string;
  displayType?: string;
  connections?: {
    id?: string;
    name?: string;
    direction?: string;
    diffStatus?: string;
  }[];
  diffStatus?: string;
  codeReference?: string;
  outputResources?: DeploymentResource[];
  deployStatus?: "pending" | "in_progress" | "success" | "failed";
  deployMessage?: string;
  portalUrl?: string;
}

export interface DeploymentTarget {
  repo: string;
  environment: string;
  provider: string;
  application?: string;
}

export interface DeploymentSource {
  repo: string;
  branch: string;
  appFile: string;
}

export interface DeployParams {
  targetRepo?: string;
  environment?: string;
  provider?: string;
  branch?: string;
  appFile?: string;
}

export interface DeployAttempt extends DeployParams {
  id: string;
}

export type DeployErrorKind =
  | "branch-not-pushed"
  | "run-unconfirmed"
  | "oidc-subject-missing"
  | "oidc-subject-case-mismatch"
  | "cloud-auth-drift";

export interface DeploymentReservation {
  repo: string;
  environment: string;
  kind: "deploy" | "delete" | "abandon";
  expiresAt: number;
  attemptId?: string;
}

// Field names retain the existing serialized attempt contract. This record has
// no panel identity or presentation lifecycle and can be owned by any caller.
export interface DeploymentState {
  [extension: string]: unknown;
  deployParams?: DeployParams;
  deployAttempt?: DeployAttempt;
  deploymentMutation?: DeploymentReservation;
  envName?: string;
  appFile?: string;
  workspaceBranch?: string;
  deployProvider?: string;
  deployingRepo?: string;
  deployingBranch?: string;
  deployingProvider?: string;
  deployingResources?: DeploymentResource[] | null;
  plannedResources?: DeploymentResource[] | null;
  plannedRepo?: string;
  contextRepo?: string;
  deployStartedAt?: number;
  deployFinishedAt?: number;
  deployGeneration?: number;
  deployLogs?: string[];
  deployLogBase?: number;
  deployStatus?: string;
  deployError?: string | null;
  deployErrorKind?: DeployErrorKind | null;
  deployErrorBranch?: string | null;
  deployErrorPaths?: string | null;
  deployRunId?: string | number | null;
  deployRunUrl?: string | null;
  deployAppName?: string;
  deployEnvName?: string;
  deployedGraph?: DeploymentResource[] | null;
  deployedGraphRepo?: string;
  deployRepairing?: boolean;
  deployHandoffState?: string;
  deployHandoffAttempts?: number;
  deployNoticeState?: string;
  deployNoticeAttempts?: number;
  deployRepairAttempts?: number;
}
