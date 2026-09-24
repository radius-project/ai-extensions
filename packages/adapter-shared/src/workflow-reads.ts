import type { WorkflowRunRead } from "@radius-project/core";

export interface WorkflowCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

export interface WorkflowReadOptions {
  timeout: number;
  maxBuffer?: number;
}

export type WorkflowRunner = (
  args: string[],
  options: WorkflowReadOptions
) => Promise<WorkflowCommandResult>;

export interface SelectedWorkflowExecutor {
  readonly login: string;
  run: WorkflowRunner;
  errorMessage(error: unknown): string;
}

export type WorkflowExecution =
  | { mode: "ambient"; run: WorkflowRunner }
  | { mode: "selected"; executor: SelectedWorkflowExecutor };

export class SelectedGhAuthorizationError extends Error {
  readonly login: string;
  readonly status: 401 | 403 | 404;

  constructor(login: string, status: 401 | 403 | 404, detail: string) {
    super(
      `GitHub rejected @${login} while reading workflow state (HTTP ${status})${
        detail ? `: ${detail}` : "."
      }`
    );
    this.name = "SelectedGhAuthorizationError";
    this.login = login;
    this.status = status;
  }
}

export function isSelectedGhAuthorizationError(
  error: unknown
): error is SelectedGhAuthorizationError {
  return error instanceof SelectedGhAuthorizationError;
}

function selectedAuthorizationStatus(
  stdout: string,
  stderr: string
): 401 | 403 | null {
  const detail = `${stderr}\n${stdout}`;
  const match = /\bHTTP\s+(401|403)\b/i.exec(detail);
  if (!match) return isSamlAuthorizationFailure(detail) ? 403 : null;
  return match[1] === "401" ? 401 : 403;
}

function isSamlAuthorizationFailure(detail: string): boolean {
  return /Resource protected by organization SAML enforcement|grant your OAuth token access/i.test(
    detail
  );
}

function selectedFailureStatus(
  stdout: string,
  stderr: string
): 401 | 403 | 404 | 429 | null {
  const detail = `${stderr}\n${stdout}`;
  const match = /\bHTTP\s+(401|403|404|429)\b/i.exec(detail);
  if (!match) return isSamlAuthorizationFailure(detail) ? 403 : null;
  return (
    match[1] === "401" ? 401
    : match[1] === "403" ? 403
    : match[1] === "404" ? 404
    : 429
  );
}

function isRateLimitFailure(stdout: string, stderr: string): boolean {
  const detail = `${stderr}\n${stdout}`;
  return (
    /\bHTTP\s+429\b/i.test(detail) ||
    /\bRetry-After\s*:/i.test(detail) ||
    /\bX-RateLimit-Remaining\s*:\s*0\b/i.test(detail) ||
    /\bsecondary rate limit\b/i.test(detail) ||
    /\b(?:API|primary) rate limit (?:exceeded|reached)\b/i.test(detail) ||
    /\brate limit\b[\s\S]*\b(?:reset|resets|retry|try again)\b/i.test(detail)
  );
}

export function isGitHubRateLimitError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return isRateLimitFailure("", detail);
}

function selectedAuthorizationError(
  executor: SelectedWorkflowExecutor,
  stdout: string,
  stderr: string
): SelectedGhAuthorizationError | null {
  const status = selectedAuthorizationStatus(stdout, stderr);
  if (status === 403 && isRateLimitFailure(stdout, stderr)) return null;
  return status === null ? null : (
      new SelectedGhAuthorizationError(
        executor.login,
        status,
        (stderr || stdout).trim()
      )
    );
}

function rejectedSelectedAuthorizationError(
  executor: SelectedWorkflowExecutor,
  error: unknown
): SelectedGhAuthorizationError | null {
  const detail = executor.errorMessage(error);
  const status = selectedAuthorizationStatus("", detail);
  if (status === 403 && isRateLimitFailure("", detail)) return null;
  return status === null ? null : (
      new SelectedGhAuthorizationError(executor.login, status, detail)
    );
}

async function selectedRepositoryAccessError(
  executor: SelectedWorkflowExecutor,
  repo: string
): Promise<SelectedGhAuthorizationError | null> {
  try {
    const result = await executor.run(
      ["api", `repos/${repo}`, "--jq", ".full_name"],
      { timeout: 15000 }
    );
    if (Number(result.code) === 0) return null;
    if (isRateLimitFailure(result.stdout, result.stderr)) return null;
    const status = selectedFailureStatus(result.stdout, result.stderr);
    if (status === 401 || status === 403 || status === 404) {
      return new SelectedGhAuthorizationError(
        executor.login,
        status,
        (result.stderr || result.stdout).trim()
      );
    }
    return null;
  } catch (error) {
    if (isSelectedGhAuthorizationError(error)) return error;
    const detail = executor.errorMessage(error);
    if (isRateLimitFailure("", detail)) return null;
    const status = selectedFailureStatus("", detail);
    return status === 401 || status === 403 || status === 404 ?
        new SelectedGhAuthorizationError(executor.login, status, detail)
      : null;
  }
}

export async function selectedCommandAuthorizationError(
  executor: SelectedWorkflowExecutor,
  repo: string,
  result: { code: string | number; stdout: string; stderr: string }
): Promise<SelectedGhAuthorizationError | null> {
  if (Number(result.code) === 0) return null;
  if (isRateLimitFailure(result.stdout, result.stderr)) return null;
  const status = selectedFailureStatus(result.stdout, result.stderr);
  if (status === 404) {
    return selectedRepositoryAccessError(executor, repo);
  }
  return status === 401 || status === 403 ?
      new SelectedGhAuthorizationError(
        executor.login,
        status,
        (result.stderr || result.stdout).trim()
      )
    : null;
}

type SelectedWorkflowJsonRead =
  | { state: "value"; value: unknown }
  | { state: "missing" }
  | { state: "fallback" };

export async function selectedWorkflowJson(
  executor: SelectedWorkflowExecutor,
  repo: string,
  args: string[],
  timeout = 15000
): Promise<SelectedWorkflowJsonRead> {
  try {
    const result = await executor.run(args, { timeout });
    if (Number(result.code) !== 0) {
      const status = selectedFailureStatus(result.stdout, result.stderr);
      if (status === 404) {
        const repositoryError = await selectedRepositoryAccessError(
          executor,
          repo
        );
        if (repositoryError) throw repositoryError;
        return { state: "missing" };
      }
      const authorizationError = selectedAuthorizationError(
        executor,
        result.stdout,
        result.stderr
      );
      if (authorizationError) throw authorizationError;
      return { state: "fallback" };
    }
    try {
      return { state: "value", value: JSON.parse(result.stdout.trim()) };
    } catch {
      return { state: "fallback" };
    }
  } catch (error) {
    if (isSelectedGhAuthorizationError(error)) throw error;
    const detail = executor.errorMessage(error);
    if (selectedFailureStatus("", detail) === 404) {
      const repositoryError = await selectedRepositoryAccessError(
        executor,
        repo
      );
      if (repositoryError) throw repositoryError;
      return { state: "missing" };
    }
    const authorizationError = rejectedSelectedAuthorizationError(
      executor,
      error
    );
    if (authorizationError) throw authorizationError;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function workflowJson(
  execution: WorkflowExecution,
  repo: string,
  args: string[]
): Promise<SelectedWorkflowJsonRead> {
  if (execution.mode === "selected") {
    return selectedWorkflowJson(execution.executor, repo, args);
  }
  const result = await execution.run(args, { timeout: 15000 });
  if (Number(result.code) !== 0) return { state: "fallback" };
  try {
    return { state: "value", value: JSON.parse(result.stdout.trim()) };
  } catch {
    return { state: "fallback" };
  }
}

export async function readWorkflowRun(
  execution: WorkflowExecution,
  repo: string,
  runId: number | string
): Promise<WorkflowRunRead | null> {
  const args = [
    "run",
    "view",
    String(runId),
    "--json",
    "status,conclusion,jobs",
    "--repo",
    repo
  ];
  const detail = await workflowJson(execution, repo, args);
  if (detail.state === "missing") return null;
  if (detail.state === "value" && isRecord(detail.value)) {
    return { data: detail.value, includeJobs: true };
  }
  const status = await workflowJson(execution, repo, [
    "run",
    "view",
    String(runId),
    "--json",
    "status,conclusion",
    "--repo",
    repo
  ]);
  if (status.state !== "value" || !isRecord(status.value)) return null;
  return { data: status.value, includeJobs: false };
}

export async function readWorkflowLog(
  execution: WorkflowExecution,
  repo: string,
  runId: number | string
): Promise<string | null> {
  if (execution.mode === "selected") {
    const executor = execution.executor;
    try {
      const result = await executor.run(
        ["run", "view", String(runId), "--log", "--repo", repo],
        {
          timeout: 30000,
          maxBuffer: 1024 * 1024 * 20
        }
      );
      if (Number(result.code) !== 0) {
        if (selectedFailureStatus("", result.stderr) === 404) {
          const repositoryError = await selectedRepositoryAccessError(
            executor,
            repo
          );
          if (repositoryError) throw repositoryError;
          return null;
        }
        const authorizationError = selectedAuthorizationError(
          executor,
          "",
          result.stderr
        );
        if (authorizationError) throw authorizationError;
        return null;
      }
      return result.stdout || null;
    } catch (error) {
      if (isSelectedGhAuthorizationError(error)) throw error;
      const detail = executor.errorMessage(error);
      if (selectedFailureStatus("", detail) === 404) {
        const repositoryError = await selectedRepositoryAccessError(
          executor,
          repo
        );
        if (repositoryError) throw repositoryError;
        return null;
      }
      const authorizationError = rejectedSelectedAuthorizationError(
        executor,
        error
      );
      if (authorizationError) throw authorizationError;
      throw error;
    }
  }
  const result = await execution.run(
    ["run", "view", String(runId), "--log", "--repo", repo],
    { timeout: 30000, maxBuffer: 1024 * 1024 * 20 }
  );
  return Number(result.code) !== 0 || !result.stdout ? null : result.stdout;
}
