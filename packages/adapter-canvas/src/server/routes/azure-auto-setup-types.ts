import type { IncomingMessage } from "node:http";
import type {
  GitHubJsonResponse,
  RadiusAppProvenanceInput,
  ResolveOidcSubjectResult
} from "../../azure-oidc.js";

export interface AzureAutoSetupCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

export interface AzureAutoSetupOperation {
  operationId: string;
  repo: string;
  environment: string;
  provider: string;
  currentStage: string;
  state?: string;
  inputRequired?: unknown;
}

export interface AzureAutoSetupFailureResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface AzureAutoSetupFailureInput {
  status: number;
  error: string;
  code: string;
  stage?: string | null;
  classification?: string;
  evidence?: string | null;
  extra?: Record<string, unknown>;
  steps?: string[];
  runAz?:
    ((args: string[]) => Promise<Partial<AzureAutoSetupCommandResult>>) | null;
}

export interface AzureAutoSetupOperationPort {
  get(operationId: string): AzureAutoSetupOperation | undefined;
  isStale(operation: AzureAutoSetupOperation): boolean;
  create(input: Record<string, unknown>): AzureAutoSetupOperation;
  buildStages(): unknown[];
  start(
    operation: AzureAutoSetupOperation
  ): { ok: true } | { ok: false; conflict: { operationId: string } };
  persist(): Promise<void>;
  report(diagnostic: { code: string; message: string }): void;
  finish(
    operation: AzureAutoSetupOperation,
    state: string,
    options: Record<string, unknown>
  ): void;
  enterStage(operation: AzureAutoSetupOperation, stage: string): void;
  setStageState(
    operation: AzureAutoSetupOperation,
    stage: string,
    state: string
  ): void;
  hasWarnings(operation: AzureAutoSetupOperation): boolean;
  addLegacyStep(operation: AzureAutoSetupOperation, text: string): void;
  setContext(
    operation: AzureAutoSetupOperation,
    patch: Record<string, unknown>
  ): void;
  setCloudContext(
    operation: AzureAutoSetupOperation,
    provider: string,
    patch: Record<string, unknown>
  ): void;
  requireInput(
    operation: AzureAutoSetupOperation,
    input: Record<string, unknown>
  ): void;
  resumeAfterInput(operation: AzureAutoSetupOperation): void;
  recordAzureApp(
    operation: AzureAutoSetupOperation,
    patch: Record<string, unknown>
  ): void;
  recordServicePrincipal(
    operation: AzureAutoSetupOperation,
    patch: Record<string, unknown>
  ): void;
  recordCreatedFederatedCredential(
    operation: AzureAutoSetupOperation,
    entry: { name: string; subject: string }
  ): void;
  recordCreatedRoleAssignment(
    operation: AzureAutoSetupOperation,
    entry: {
      role: string;
      scope: string;
      principalObjectId: string;
    }
  ): void;
}

export interface AzureAutoSetupExternalPort {
  getGitHubIdentity(): Promise<{
    actingLogin?: string;
    displayLogin?: string;
    mismatch?: boolean;
  } | null>;
  preflightRepoAdmin(repo: string): Promise<string>;
  preflightGhcrPackageWriteAccess(): Promise<
    { ok: true } | { ok: false; status: number; error: string; code: string }
  >;
  runGitHubJson(apiPath: string): Promise<GitHubJsonResponse>;
  runAz(args: string[]): Promise<AzureAutoSetupCommandResult>;
}

export interface AzureAutoSetupTempFilePort {
  createPath(): string;
  write(path: string, contents: string): void;
  remove(path: string): void;
}

export interface AzureAutoSetupDependencies {
  isServerOwnedRequest(instanceId: string, request: IncomingMessage): boolean;
  operations: AzureAutoSetupOperationPort;
  external: AzureAutoSetupExternalPort;
  tempFile: AzureAutoSetupTempFilePort;
  ensureServicePrincipal(
    clientId: string,
    runAz: (args: string[]) => Promise<Partial<AzureAutoSetupCommandResult>>
  ): Promise<
    | { ok: true; state: "created" | "reused"; objectId: string | null }
    | { ok: false; stderr: string }
  >;
  finalizeSetupFailure(
    operation: AzureAutoSetupOperation | null,
    input: AzureAutoSetupFailureInput
  ): Promise<AzureAutoSetupFailureResponse>;
  persistMutationCheckpoint(input: {
    operation: AzureAutoSetupOperation | null;
    persist: () => Promise<void>;
    report: (diagnostic: { code: string; message: string }) => void;
    fail: (status: number, error: string, code: string) => Promise<void>;
  }): Promise<boolean>;
  sleep(milliseconds: number): Promise<void>;
  stageAuthorizeIdentity: string;
}

export interface AzureAutoSetupWorkflow {
  operation: AzureAutoSetupOperation;
  steps: string[];
  respond(status: number, payload: unknown): void;
  runAz(args: string[]): Promise<AzureAutoSetupCommandResult>;
  runGitHubJson(apiPath: string): Promise<GitHubJsonResponse>;
  fail(
    status: number,
    error: string,
    code: string,
    extra?: Record<string, unknown>
  ): Promise<void>;
  checkpoint(): Promise<boolean>;
}

export interface AzureAutoSetupApplicationInput {
  workflow: AzureAutoSetupWorkflow;
  dependencies: Pick<AzureAutoSetupDependencies, "operations">;
  oidc: ResolveOidcSubjectResult;
  environment: string;
  explicitAppId: string;
  createNewApp: boolean;
  appNameProvided: boolean;
  requestedAppName: string;
  requestedClientId: string;
  serviceManagementReference: string;
}

export interface AzureAutoSetupApplicationResult {
  clientId: string;
  appName: string;
}

export interface AzureAutoSetupCredentialInput {
  workflow: AzureAutoSetupWorkflow;
  dependencies: Pick<
    AzureAutoSetupDependencies,
    "ensureServicePrincipal" | "operations" | "sleep" | "tempFile"
  >;
  oidc: ResolveOidcSubjectResult;
  oidcSuffix: string;
  clientId: string;
  appName: string;
  subscriptionId: string;
  resourceGroup: string;
  clusterResourceGroup: string;
  clusterName: string;
}

export type { RadiusAppProvenanceInput };
