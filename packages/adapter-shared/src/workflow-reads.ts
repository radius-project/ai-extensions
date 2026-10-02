import type {
  WorkflowReadEvidence,
  WorkflowResponseMetadata,
  WorkflowRunRead
} from "@radius-project/core";
import { readWorkflowApi } from "./workflow-read-response.js";
import {
  createWorkflowReadBudget,
  isWorkflowReadLimitError
} from "./workflow-read-budget.js";

export interface WorkflowCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

export interface WorkflowReadOptions {
  timeout: number;
  maxBuffer?: number;
  signal?: AbortSignal;
}

/** The host runner enforces command bounds and redacts credentials in diagnostics. */
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
  // Ambient runners resolve ordinary command failures (including timeouts) with
  // a nonzero code. Unexpected rejections propagate unchanged to the caller.
  | { mode: "ambient"; run: WorkflowRunner }
  // Selected readers classify rejected authorization evidence through
  // executor.errorMessage; unexpected workflow-read rejections propagate.
  | {
      mode: "selected";
      executor: SelectedWorkflowExecutor;
      prepare?: () => Promise<void>;
    };

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

export type SelectedWorkflowJsonRead =
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

export interface WorkflowRunResponse {
  value: WorkflowRunRead | null;
  completeness: "complete" | "status-only" | "unavailable";
  reason?:
    "read-failed" | "invalid-data" | "pagination" | "timeout" | "output-limit";
  evidence: WorkflowReadEvidence[];
}

function nextJobsPage(
  link: string | null,
  endpoint: string,
  repositoryId: unknown,
  current: number
): number | null {
  if (link === null) return null;
  const links = link.split(/,\s*(?=<)/);
  const next = links.filter((part) => /;\s*rel="next"\s*$/.test(part));
  if (next.length === 0) return null;
  if (next.length !== 1) return -1;
  const match = /^<([^>]+)>;\s*rel="next"\s*$/.exec(next[0]);
  if (!match) return -1;
  let url: URL;
  try {
    url = new URL(match[1]);
  } catch {
    return -1;
  }
  const pathname = url.pathname.replace(/^\/api\/v3/, "");
  const numericPath =
    typeof repositoryId === "number" && Number.isSafeInteger(repositoryId) ?
      `/${endpoint.replace(/^repos\/[^/]+\/[^/]+/, `repositories/${repositoryId}`)}`
    : "";
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (pathname !== `/${endpoint}` && pathname !== numericPath) ||
    [...url.searchParams.keys()].some(
      (key) => key !== "page" && key !== "per_page"
    ) ||
    url.searchParams.getAll("page").length !== 1 ||
    url.searchParams.getAll("per_page").length !== 1 ||
    url.searchParams.get("per_page") !== "100"
  )
    return -1;
  const page = Number(url.searchParams.get("page"));
  return Number.isSafeInteger(page) && page === current + 1 ? page : -1;
}

export async function readWorkflowRunWithMetadata(
  execution: WorkflowExecution,
  repo: string,
  runId: number | string
): Promise<WorkflowRunResponse> {
  if (
    !/^[\w-]+\/[\w.-]+$/.test(repo) ||
    repo.split("/").some((part) => part === "." || part === "..") ||
    !/^[1-9]\d*$/.test(String(runId)) ||
    !Number.isSafeInteger(Number(runId))
  ) {
    throw new Error("A repository and positive workflow run ID are required.");
  }
  const evidence: WorkflowReadEvidence[] = [];
  let value: WorkflowRunRead | null = null;
  const incomplete = (
    reason: NonNullable<WorkflowRunResponse["reason"]>
  ): WorkflowRunResponse => ({
    value,
    completeness: value ? "status-only" : "unavailable",
    reason,
    evidence
  });
  const run =
    execution.mode === "ambient" ? execution.run : execution.executor.run;
  let repositoryProbe: Promise<void> | undefined;
  const probe = (executor: SelectedWorkflowExecutor): Promise<void> => {
    repositoryProbe ??= (async () => {
      try {
        const result = await readWorkflowApi(
          createWorkflowReadBudget(run),
          `repos/${repo}`,
          { timeout: 15000 }
        );
        evidence.push({ phase: "repository", response: result.metadata });
        const status =
          result.metadata.source === "gh-api-include" ?
            (
              result.metadata.classification === "authorization" ||
              result.metadata.status === 404
            ) ?
              result.metadata.status
            : null
          : result.commandMissing ? 404
          : result.commandAuthorizationStatus;
        if (status === 401 || status === 403 || status === 404)
          throw new SelectedGhAuthorizationError(
            executor.login,
            status,
            result.diagnostic ?
              executor.errorMessage(new Error(result.diagnostic))
            : "Repository access could not be confirmed."
          );
      } catch (error) {
        if (isSelectedGhAuthorizationError(error)) throw error;
        const detail = executor.errorMessage(error);
        const status = selectedFailureStatus("", detail);
        if (
          !isRateLimitFailure("", detail) &&
          (status === 401 || status === 403 || status === 404)
        )
          throw new SelectedGhAuthorizationError(
            executor.login,
            status,
            detail
          );
        evidence.push({
          phase: "repository",
          response: {
            source: "unavailable",
            reason:
              isWorkflowReadLimitError(error) ?
                error.reason
              : "invalid-response"
          }
        });
      }
    })();
    return repositoryProbe;
  };
  try {
    if (execution.mode === "selected") await execution.prepare?.();
    const bounded = createWorkflowReadBudget(run);
    const read = async (endpoint: string, phase: "run" | "jobs") => {
      const response = await readWorkflowApi(bounded, endpoint, {
        timeout: 15000
      });
      evidence.push({ phase, response: response.metadata });
      if (execution.mode === "selected") {
        const metadata = response.metadata;
        if (
          metadata.source === "gh-api-include" &&
          metadata.classification === "authorization"
        )
          throw new SelectedGhAuthorizationError(
            execution.executor.login,
            metadata.status === 401 ? 401 : 403,
            response.diagnostic ?
              execution.executor.errorMessage(new Error(response.diagnostic))
            : "Workflow state could not be read."
          );
        if (
          metadata.source === "unavailable" &&
          response.commandAuthorizationStatus !== null
        )
          throw new SelectedGhAuthorizationError(
            execution.executor.login,
            response.commandAuthorizationStatus,
            execution.executor.errorMessage(new Error(response.diagnostic))
          );
        if (
          (metadata.source === "gh-api-include" && metadata.status === 404) ||
          (metadata.source === "unavailable" && response.commandMissing)
        )
          await probe(execution.executor);
      }
      return response;
    };
    const endpoint = `repos/${repo}/actions/runs/${runId}`;
    const detail = await read(endpoint, "run");
    if (!detail.ok) return incomplete("read-failed");
    if (!isRecord(detail.value)) return incomplete("invalid-data");
    const data = detail.value;
    // gh's JSON exporter decodes nullable conclusions into Go strings.
    value = {
      data: {
        status: data.status,
        conclusion: data.conclusion === null ? "" : data.conclusion
      },
      includeJobs: false
    };
    const jobs: Record<string, unknown>[] = [];
    let page = 1;
    for (;;) {
      const response = await read(
        `${endpoint}/jobs?per_page=100&page=${page}`,
        "jobs"
      );
      if (!response.ok) return incomplete("read-failed");
      if (
        !isRecord(response.value) ||
        !Array.isArray(response.value.jobs) ||
        response.value.jobs.length > 100 ||
        typeof response.value.total_count !== "number" ||
        !Number.isSafeInteger(response.value.total_count) ||
        response.value.total_count < 0
      )
        return incomplete("invalid-data");
      for (const job of response.value.jobs) {
        if (!isRecord(job) || (job.steps != null && !Array.isArray(job.steps)))
          return incomplete("invalid-data");
        const steps: Record<string, unknown>[] = [];
        for (const step of job.steps ?? []) {
          if (!isRecord(step)) return incomplete("invalid-data");
          steps.push({
            name: step.name,
            status: step.status,
            conclusion: step.conclusion === null ? "" : step.conclusion
          });
        }
        jobs.push({ name: job.name, steps });
      }
      const next = nextJobsPage(
        response.nextLink,
        `${endpoint}/jobs`,
        isRecord(data.repository) ? data.repository.id : undefined,
        page
      );
      if (next === null) {
        if (jobs.length !== response.value.total_count)
          return incomplete("pagination");
        return {
          value: { data: { ...value.data, jobs }, includeJobs: true },
          completeness: "complete",
          evidence
        };
      }
      if (
        next === -1 ||
        page >= 100 ||
        jobs.length >= response.value.total_count
      )
        return incomplete("pagination");
      page = next;
    }
  } catch (error) {
    if (isWorkflowReadLimitError(error)) {
      evidence.push({
        phase: value ? "jobs" : "run",
        response: { source: "unavailable", reason: error.reason }
      });
      return incomplete(error.reason);
    }
    if (execution.mode === "selected") {
      if (isSelectedGhAuthorizationError(error)) throw error;
      if (
        selectedFailureStatus("", execution.executor.errorMessage(error)) ===
        404
      ) {
        await probe(execution.executor);
        return incomplete("read-failed");
      }
      const authorization = rejectedSelectedAuthorizationError(
        execution.executor,
        error
      );
      if (authorization) throw authorization;
    }
    throw error;
  }
}

export async function readWorkflowRun(
  execution: WorkflowExecution,
  repo: string,
  runId: number | string
): Promise<WorkflowRunRead | null> {
  return (await readWorkflowRunWithMetadata(execution, repo, runId)).value;
}

async function readWorkflowLogValue(
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

export async function readWorkflowLogWithMetadata(
  execution: WorkflowExecution,
  repo: string,
  runId: number | string
): Promise<{ value: string | null; metadata: WorkflowResponseMetadata }> {
  return {
    value: await readWorkflowLogValue(execution, repo, runId),
    metadata: { source: "unavailable", reason: "opaque-command" }
  };
}

export async function readWorkflowLog(
  execution: WorkflowExecution,
  repo: string,
  runId: number | string
): Promise<string | null> {
  return (await readWorkflowLogWithMetadata(execution, repo, runId)).value;
}
