import type {
  CallerIdentity,
  GitHubJsonResponse,
  ResolveOidcSubjectResult
} from "./platforms/setup-azure-identity.js";
import type {
  AzureSetupFailure,
  AzureSetupProgress
} from "./setup-azure-events.js";
import type {
  AzureRecoveryPort,
  ProviderMutationCommandResult
} from "./setup-azure-recovery.js";
import type { ensureAzureServicePrincipal } from "./setup-azure-service-principal.js";

export interface AzureExecutionPorts {
  operationId: string;
  environment: string;
  runAz(args: string[]): Promise<ProviderMutationCommandResult>;
  sleep(milliseconds: number): Promise<void>;
  stopBoundary(boundary: string): Promise<boolean>;
  checkpoint(boundary: string): Promise<boolean>;
  haltKind(): "failed" | "stopped" | "input-required";
  progress(event: AzureSetupProgress): void;
  finalizeFailure(event: AzureSetupFailure): Promise<void>;
  recovery: AzureRecoveryPort;
}

export interface AzureApplicationPorts extends AzureExecutionPorts {
  runGitHubJson(path: string): Promise<GitHubJsonResponse>;
  persist(): Promise<void>;
  persistenceFailure(error: unknown): void;
  getApplicationArtifact():
    { origin?: string; appId?: string | null } | undefined;
  recordAzureApp(patch: {
    state: "created" | "reused";
    origin: "this_operation" | "pre_existing" | "radius_earlier_setup";
    appId: string;
    displayName: string | null;
    serviceManagementReference?: string | null;
  }): void;
}

export interface AzureApplicationInput {
  ports: AzureApplicationPorts;
  oidc: ResolveOidcSubjectResult;
  environment: string;
  explicitAppId: string;
  createNewApp: boolean;
  appNameProvided: boolean;
  requestedAppName: string;
  requestedClientId: string;
  serviceManagementReference: string;
  callerIdentity: CallerIdentity;
  resumeAtCreate?: { appName: string; callerObjectId: string };
}

export interface AzureApplication {
  clientId: string;
  appName: string;
  state: "created" | "reused";
}

export interface AzureCredentialPorts extends AzureExecutionPorts {
  isRollbackPending(): boolean;
  deterministicUuid(seed: string): string;
  ensureServicePrincipal(
    clientId: string,
    beforeCreate: () => Promise<boolean>
  ): ReturnType<typeof ensureAzureServicePrincipal>;
  tempFile: {
    createPath(): string;
    write(path: string, contents: string): void;
    remove(path: string): void;
  };
  withCredentialProvenanceLock<T>(work: () => Promise<T>): Promise<T>;
  recordServicePrincipal(patch: {
    state?: "created" | "reused" | "created_candidate";
    origin?: "unknown" | "pre_existing" | "this_operation";
    appId?: string;
    objectId?: string;
  }): void;
  recordCreatedFederatedCredential(entry: {
    name: string;
    subject: string;
    providerId?: string | null;
  }): void;
  recordFederatedCredentialProvenance(entry: {
    repo: string;
    repoId: number;
    environment: string;
    tenantId: string;
    clientId: string;
    applicationObjectId: string;
    credentialId: string;
    name: string;
    subject: string;
    issuer: string;
    audiences: string[];
    subjectConfig: ResolveOidcSubjectResult["subjectConfig"];
    origin: "created" | "reused";
  }): Promise<void>;
  recordCreatedRoleAssignment(entry: {
    assignmentId?: string;
    role: string;
    scope: string;
    principalObjectId: string;
  }): void;
}

export interface AzureCredentialInput {
  ports: AzureCredentialPorts;
  oidc: ResolveOidcSubjectResult;
  oidcSuffix: string;
  clientId: string;
  tenantId: string;
  appName: string;
  subscriptionId: string;
  resourceGroup: string;
  clusterResourceGroup: string;
  clusterName: string;
}
