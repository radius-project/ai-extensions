import type { CanvasState } from "../../shared.js";
import type { SelectedGhExecutor } from "../../gh.js";

// Type surface for the `environments` route module (see `environments.ts`).
// These are declarations only — erased at compile time — extracted so the
// handler module stays under the decomposition-review line budget. Nothing here
// carries behavior: no handler, no I/O, no module-level state.

// The instance entry as these routes see it. Only `state` is declared, and it is
// optional because the legacy branches read it through `entry?.state?.` and must
// keep distinguishing a missing entry from an entry with empty state — the
// request context's `{}` snapshot cannot express that, and `verify-status`
// mutates the live `state.verifyRunId` in place.
export interface EnvironmentsInstanceEntry {
  state?: CanvasState;
}

// A workflow run's status/conclusion as `list-environments` reads it. The values
// are the raw GitHub API strings, so both are plain strings (the empty string is
// a real, distinct value the jq default `// ""` produces).
export interface EnvironmentVerifyRun {
  status: string;
  conclusion: string;
}

// The active-deployment guard's return shape. Declared with every field
// `resolveEnvDeployment` produces so a fake cannot be narrower than production:
// the handler only reads `app` and `status`, but pinning the full contract keeps
// a real `DeploymentRow` representable in tests.
export interface EnvironmentActiveDeployment {
  app: string;
  environment: string;
  provider: string;
  status: string;
  deploymentId: string;
  runUrl: string;
}

// A single completed-run step as `verify-status` reads it, shaped exactly like
// `getRunDetail`'s `WorkflowStep`: `conclusion` is nullable because the GitHub
// API returns null for a step that has not concluded.
export interface EnvironmentRunStep {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

// The run detail `verify-status` consumes, shaped exactly like `getRunDetail`'s
// return: `status`/`conclusion` are the raw run strings and `steps` may be
// absent when the jobs sub-resource degraded.
export interface EnvironmentRunDetail {
  status?: string;
  conclusion?: string | null;
  steps?: EnvironmentRunStep[];
}

// The narrow bicep param shape `app-params` echoes back. `appParams` returns
// richer objects, but the route serializes whatever it returns verbatim, so the
// seam is declared as an opaque array to avoid re-describing (and thereby
// constraining) that shape.
export type EnvironmentBicepParam = unknown;

export interface EnvironmentsCliExec {
  (
    command: string,
    args: string[],
    options: { timeout: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): void;
}

export interface EnvironmentsDependencies {
  // --- shared ---
  errorMessage(error: unknown): string;
  repoMatchesWorkspace(state: CanvasState, repo: string): boolean;
  // Returns undefined when the instance has no entry, matching the legacy
  // `servers.get(instanceId)` miss. `verify-status` mutates the returned
  // `state` in place, so this must hand back the live entry, not a snapshot.
  readInstanceEntry(instanceId: string): EnvironmentsInstanceEntry | undefined;

  // --- app-params ---
  runCommand(
    command: string,
    args: string[],
    options?: { timeout?: number }
  ): Promise<string>;
  fetchFileFromRepo(
    repo: string,
    path: string,
    branch?: string
  ): Promise<string | null>;
  appParams(source: unknown): EnvironmentBicepParam[];

  // --- delete-environment ---
  resolveRepoAppName(repo: string, branch: string): Promise<string>;
  resolveEnvDeployment(
    repo: string,
    environment: string,
    appName: string
  ): Promise<EnvironmentActiveDeployment | null>;
  logError(message: string): void;

  // --- list-environments ---
  cliExec: EnvironmentsCliExec;
  envListCacheGet(repo: string): { at: number; payload: unknown } | undefined;
  envListCacheSet(repo: string, entry: { at: number; payload: unknown }): void;
  envListCacheDelete(repo: string): void;
  envListTtlMs: number;
  kickoffWorkflowSync(
    repo: string,
    managedEnvironments: { name: string; provider?: string }[],
    workingBranch: string
  ): void;
  now(): number;

  // --- verify-status ---
  getOperation(operationId: string): unknown;
  getSelectedGitHubExecutor(
    operationId: string
  ): SelectedGhExecutor | null | undefined;
  hasCompleteVerificationIdentity(operation: unknown): boolean;
  findWorkflowRun(
    repo: string,
    workflowFile: string,
    sinceMs: number,
    knownId?: number | string | null,
    executor?: SelectedGhExecutor
  ): Promise<number | string | null>;
  getRunDetail(
    repo: string,
    runId: number | string,
    executor?: SelectedGhExecutor
  ): Promise<EnvironmentRunDetail | null>;
  fetchRunLog(
    repo: string,
    runId: number | string,
    executor?: SelectedGhExecutor
  ): Promise<string | null>;
  extractErrorLines(logText?: string | null, max?: number): string[];
  extractGitHubActionsStepLog(
    logText: string | null | undefined,
    stepName: string
  ): string;
  explainOidcEnterpriseClaim(logText?: string | null): string;
  explainNoSubscriptions(logText?: string | null): string;
  addLegacyStep(operation: unknown, text: string): unknown;
  isTerminalState(state: unknown): boolean;
  finish(operation: unknown, state: unknown, options?: unknown): unknown;
  finishSucceeded(operation: unknown, terminal?: unknown): unknown;
  persistBestEffort(input: {
    operation: unknown;
    persist: () => Promise<void>;
    report?: (diagnostic: { code: string; message: string }) => void;
  }): Promise<boolean>;
  persistOperations(): Promise<void>;
  reportOperationDiagnostic(diagnostic: {
    code: string;
    message: string;
  }): void;
  verifyWorkflowFile: string;
  stageVerify: string;
}
