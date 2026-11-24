import {
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_ENV_GUARD_STEP_NAME
} from "@radius-project/core";
import type { GhCommandResult } from "./gh-command-result.js";

type DispatchContext = {
  operationAttempt: number;
  dispatchedAt: number;
  correlationId: string;
  branch: string;
  head: string;
};
type SettledDispatch = DispatchContext & {
  state: "guarded" | "deleted";
  runId: number;
  runAttempt: number;
  updatedAt: string;
};

export type EnvironmentDispatchAttempt = DispatchContext &
  (
    | { state: "unresolved" }
    | { state: "refused" }
    | { state: "correlated"; runId: number }
    | SettledDispatch
  );

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function readEnvironmentDispatchAttempts(
  value: unknown
): EnvironmentDispatchAttempt[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const attempts: EnvironmentDispatchAttempt[] = [];
  for (const entry of value) {
    if (
      !record(entry) ||
      typeof entry.operationAttempt !== "number" ||
      !Number.isSafeInteger(entry.operationAttempt) ||
      entry.operationAttempt < 0 ||
      !positiveInt(entry.dispatchedAt) ||
      entry.dispatchedAt > 8_640_000_000_000_000 ||
      typeof entry.correlationId !== "string" ||
      !/^del-[a-z0-9]+-[a-z0-9]{1,8}$/.test(entry.correlationId) ||
      typeof entry.branch !== "string" ||
      !entry.branch.trim() ||
      typeof entry.head !== "string" ||
      !/^[a-f0-9]{40}$/i.test(entry.head) ||
      attempts.some((attempt) => attempt.correlationId === entry.correlationId)
    )
      return null;
    const context = {
      operationAttempt: entry.operationAttempt,
      dispatchedAt: entry.dispatchedAt,
      correlationId: entry.correlationId,
      branch: entry.branch,
      head: entry.head
    };
    if (entry.state === "unresolved" || entry.state === "refused") {
      attempts.push({ ...context, state: entry.state });
    } else if (entry.state === "correlated" && positiveInt(entry.runId)) {
      attempts.push({ ...context, state: entry.state, runId: entry.runId });
    } else if (
      (entry.state === "guarded" || entry.state === "deleted") &&
      positiveInt(entry.runId) &&
      positiveInt(entry.runAttempt) &&
      timestamp(entry.updatedAt)
    ) {
      attempts.push({
        ...context,
        state: entry.state,
        runId: entry.runId,
        runAttempt: entry.runAttempt,
        updatedAt: entry.updatedAt
      });
    } else return null;
  }
  for (let index = 1; index < attempts.length; index++) {
    const previous = attempts[index - 1];
    if (
      !isRetryableEnvironmentDispatch(previous) ||
      attempts[index].operationAttempt <= previous.operationAttempt
    )
      return null;
  }
  return attempts;
}

export function isRetryableEnvironmentDispatch(
  attempt: EnvironmentDispatchAttempt
) {
  return attempt.state === "refused" || attempt.state === "guarded";
}

export function selectedEnvironmentDispatchAllowsRetry(
  request: Record<string, unknown> | undefined
): boolean {
  if (!request) return true;
  if (Object.hasOwn(request, "selectedDispatchAttempts")) {
    const attempt = readEnvironmentDispatchAttempts(
      request.selectedDispatchAttempts
    )?.at(-1);
    return attempt !== undefined && isRetryableEnvironmentDispatch(attempt);
  }
  return (
    (!Object.hasOwn(request, "selectedDispatchStarted") ||
      request.selectedDispatchStarted === false) &&
    !Object.hasOwn(request, "selectedDispatchTime") &&
    !Object.hasOwn(request, "selectedDispatchCorrelation")
  );
}

type Execute = (args: string[]) => Promise<GhCommandResult>;

export async function dispatchSelectedEnvironmentWorkflow(
  run: Execute,
  repo: string,
  environment: string,
  attempt: DispatchContext
): Promise<EnvironmentDispatchAttempt> {
  const result = await run([
    "api",
    "--method",
    "POST",
    "--include",
    `/repos/${repo}/actions/workflows/${DELETE_ENV_DISPATCHER_FILE}/dispatches`,
    "-f",
    `ref=${attempt.branch}`,
    "-f",
    `inputs[environment]=${environment}`,
    "-f",
    `inputs[correlation_id]=${attempt.correlationId}`
  ]);
  // Only a complete, explicit GitHub response can prove it rejected the POST.
  const [headers] = result.stdout.split(/\r?\n\r?\n/, 1);
  const status =
    /^HTTP\/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?) (401|403|404|422)(?: [^\r\n]*)?\r?\n/i.exec(
      headers
    );
  const complete =
    /\r?\n\r?\n/.test(result.stdout) &&
    /^x-github-request-id: [a-z0-9:-]+\r?$/im.test(headers);
  return {
    ...attempt,
    state:
      Number(result.code) > 0 && !result.timedOut && status && complete ?
        "refused"
      : "unresolved"
  };
}

async function readJson(run: Execute, endpoint: string): Promise<unknown> {
  const result = await run(["api", "--method", "GET", endpoint]);
  if (result.code !== 0 || result.timedOut) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function findSelectedEnvironmentDispatch(
  run: Execute,
  target: { repo: string; environment: string; owner: string },
  attempt:
    | EnvironmentDispatchAttempt
    | Pick<DispatchContext, "dispatchedAt" | "correlationId">
) {
  const repo = `/repos/${target.repo}`;
  const title = `Radius - Delete Environment ${target.environment} ${attempt.correlationId}`;
  const entry =
    "runId" in attempt ?
      await readJson(run, `${repo}/actions/runs/${attempt.runId}`)
    : await discoverDispatchRun(run, repo, title, attempt.dispatchedAt);
  if (
    !record(entry) ||
    entry.display_title !== title ||
    !positiveInt(entry.id) ||
    ("runId" in attempt && entry.id !== attempt.runId) ||
    entry.event !== "workflow_dispatch" ||
    entry.path !== `.github/workflows/${DELETE_ENV_DISPATCHER_FILE}` ||
    ("branch" in attempt && entry.head_branch !== attempt.branch) ||
    ("head" in attempt && entry.head_sha !== attempt.head) ||
    !record(entry.actor) ||
    typeof entry.actor.login !== "string" ||
    entry.actor.login.toLowerCase() !== target.owner.toLowerCase() ||
    !timestamp(entry.created_at) ||
    Date.parse(entry.created_at) <
      Math.floor(attempt.dispatchedAt / 1000) * 1000 ||
    !positiveInt(entry.run_attempt) ||
    !timestamp(entry.updated_at)
  )
    return null;
  return {
    runId: entry.id,
    runAttempt: entry.run_attempt,
    updatedAt: entry.updated_at,
    status: entry.status,
    conclusion: entry.conclusion
  };
}

async function discoverDispatchRun(
  run: Execute,
  repo: string,
  title: string,
  dispatchedAt: number
) {
  const pageSize = 100;
  const maxPages = 10;
  const created = new Date(Math.floor(dispatchedAt / 1000) * 1000);
  const query = `${repo}/actions/workflows/${DELETE_ENV_DISPATCHER_FILE}/runs?event=workflow_dispatch&per_page=${pageSize}&created=${encodeURIComponent(`>=${created.toISOString()}`)}`;
  let total: number | undefined;
  const seen = new Set<number>();
  let exact: Record<string, unknown> | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const data = await readJson(run, `${query}&page=${page}`);
    if (
      !record(data) ||
      typeof data.total_count !== "number" ||
      !Number.isSafeInteger(data.total_count) ||
      data.total_count < 0 ||
      data.total_count >= maxPages * pageSize ||
      (total !== undefined && data.total_count !== total) ||
      !Array.isArray(data.workflow_runs) ||
      data.workflow_runs.length !==
        Math.min(pageSize, data.total_count - (page - 1) * pageSize)
    )
      return null;
    total = data.total_count;
    for (const entry of data.workflow_runs) {
      if (
        !record(entry) ||
        !positiveInt(entry.id) ||
        seen.has(entry.id) ||
        typeof entry.display_title !== "string"
      )
        return null;
      seen.add(entry.id);
      if (entry.display_title === title) {
        if (exact) return null;
        exact = entry;
      }
    }
    if (seen.size === total) return exact;
  }
  return null;
}

export async function proveSelectedEnvironmentGuard(
  run: Execute,
  target: { repo: string; environment: string; owner: string },
  attempt: EnvironmentDispatchAttempt
) {
  const result = await proveSelectedEnvironmentOutcome(run, target, attempt);
  return result?.state === "guarded" ? result : null;
}

export async function proveSelectedEnvironmentOutcome(
  run: Execute,
  target: { repo: string; environment: string; owner: string },
  attempt: EnvironmentDispatchAttempt
): Promise<SettledDispatch | null> {
  const observed = await findSelectedEnvironmentDispatch(run, target, attempt);
  if (
    observed?.status !== "completed" ||
    (observed.conclusion !== "success" && observed.conclusion !== "failure")
  )
    return null;
  const conclusion = observed.conclusion;
  const state = conclusion === "failure" ? "guarded" : "deleted";
  const endpoint = `/repos/${target.repo}/actions/runs/${observed.runId}`;
  const jobs = await readJson(
    run,
    `${endpoint}/attempts/${observed.runAttempt}/jobs?per_page=100`
  );
  if (
    !record(jobs) ||
    !Array.isArray(jobs.jobs) ||
    jobs.total_count !== jobs.jobs.length ||
    !jobs.jobs.every(record)
  )
    return null;
  const azure = jobs.jobs.filter(
    (job) => job.name === "Azure / Delete with Radius"
  );
  if (azure.length !== 1) return null;
  const job = azure[0];
  if (
    job.run_id !== observed.runId ||
    job.run_attempt !== observed.runAttempt ||
    job.status !== "completed" ||
    job.conclusion !== conclusion ||
    !Array.isArray(job.steps) ||
    !job.steps.every(record)
  )
    return null;
  for (const [name, expected] of [
    [DELETE_ENV_GUARD_STEP_NAME, conclusion],
    ["Delete Radius resource", state === "guarded" ? "skipped" : "success"],
    ["Teardown", "success"]
  ]) {
    const steps = job.steps.filter((step) => step.name === name);
    if (
      steps.length !== 1 ||
      steps[0].status !== "completed" ||
      steps[0].conclusion !== expected
    )
      return null;
  }
  const latest = await findSelectedEnvironmentDispatch(run, target, {
    ...attempt,
    state: "correlated",
    runId: observed.runId
  });
  if (
    !latest ||
    latest.runAttempt !== observed.runAttempt ||
    latest.updatedAt !== observed.updatedAt ||
    latest.status !== "completed" ||
    latest.conclusion !== conclusion
  )
    return null;
  return {
    operationAttempt: attempt.operationAttempt,
    dispatchedAt: attempt.dispatchedAt,
    correlationId: attempt.correlationId,
    branch: attempt.branch,
    head: attempt.head,
    state,
    runId: observed.runId,
    runAttempt: observed.runAttempt,
    updatedAt: observed.updatedAt
  };
}
