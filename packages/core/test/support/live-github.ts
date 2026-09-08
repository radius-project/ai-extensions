// Shared GitHub REST helpers for the opt-in workflow YAML and OIDC environment
// contract suites. They hit the real GitHub API for radius-project/ai-extensions
// (internal), so they are only imported by live tests gated on
// RUN_LIVE_WORKFLOW_TESTS. This is not production code and is excluded from
// coverage in vitest.config.ts.

const USER_AGENT = "radius-ai-extensions-live-tests";
const DEFAULT_RETRY_DELAYS_MS = [250, 1000] as const;
// Each attempt is aborted on its own deadline so a stalled connection cannot
// hang a live suite for the runner's default socket timeout.
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;
// Waiting longer than this for a rate limit to lift is worse for CI than
// failing with a diagnostic, so a longer `Retry-After` is treated as terminal.
const DEFAULT_MAX_RETRY_AFTER_MS = 15_000;
// Live suites fetch several templates concurrently. Spreading the backoff keeps
// their retries from re-hitting the API in lockstep after a shared failure.
const JITTER_RATIO = 0.5;

export interface LiveGitHubTextResult {
  readonly text: string;
  readonly attempts: number;
}

export interface FetchGitHubTextOptions {
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly retryDelaysMs?: readonly number[];
  readonly attemptTimeoutMs?: number;
  readonly maxRetryAfterMs?: number;
  readonly random?: () => number;
  readonly signal?: AbortSignal;
}

// A single attempt either produced the whole body or failed in a way the retry
// loop must classify. `retryable` is decided at the point of failure because
// only there do we know whether it was a status, a rate limit, or a transport
// error.
type AttemptOutcome =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "failure";
      readonly reason: string;
      readonly cause?: unknown;
      readonly retryable: boolean;
      readonly retryAfterMs?: number;
    };

interface ResolvedRetryPolicy {
  readonly fetchImpl: typeof fetch;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly retryDelaysMs: readonly number[];
  readonly attemptTimeoutMs: number;
  readonly maxRetryAfterMs: number;
  readonly random: () => number;
  readonly signal?: AbortSignal;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolvePolicy(options: FetchGitHubTextOptions): ResolvedRetryPolicy {
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep ?? defaultSleep,
    retryDelaysMs: [...(options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS)],
    attemptTimeoutMs: options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
    maxRetryAfterMs: options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
    random: options.random ?? Math.random,
    signal: options.signal
  };
}

function formatAttemptCount(attempts: number): string {
  return `${attempts} ${attempts === 1 ? "attempt" : "attempts"}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Body cleanup is best-effort and must not hide the request failure.
  }
}

// GitHub reports secondary rate limits as 403 or 429 and only then carries
// rate-limit evidence, so a plain 403 stays permanent.
function isRateLimited(response: Response): boolean {
  if (response.headers.get("retry-after") !== null) {
    return true;
  }
  return response.headers.get("x-ratelimit-remaining") === "0";
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

// `Retry-After` is seconds for GitHub's secondary rate limits. Anything that is
// not a usable non-negative number is ignored so a malformed header falls back
// to the configured backoff.
function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return seconds * 1000;
}

// The primary rate limit resets on `x-ratelimit-reset` (epoch seconds), which is
// far beyond any retry budget worth spending in CI. Echo it so a live failure
// says when the token recovers instead of looking like a flaky 403.
function describeRateLimitReset(response: Response): string {
  const header = response.headers.get("x-ratelimit-reset")?.trim();
  if (!header) {
    return "rate limit exhausted";
  }
  const reset = Number(header);
  if (!Number.isFinite(reset)) {
    return "rate limit exhausted";
  }
  const resetAt = new Date(reset * 1000);
  if (Number.isNaN(resetAt.getTime())) {
    return "rate limit exhausted";
  }
  return `rate limit exhausted until ${resetAt.toISOString()}`;
}

function classifyResponse(
  response: Response,
  maxRetryAfterMs: number
): Extract<AttemptOutcome, { kind: "failure" }> {
  const status = `${response.status} ${response.statusText}`;
  const rateLimited =
    (response.status === 403 || response.status === 429) &&
    isRateLimited(response);
  if (!isTransientStatus(response.status) && !rateLimited) {
    return { kind: "failure", reason: status, retryable: false };
  }

  const retryAfterMs = parseRetryAfterMs(response);
  if (retryAfterMs === undefined) {
    if (rateLimited) {
      return {
        kind: "failure",
        reason: `${status} (${describeRateLimitReset(response)})`,
        retryable: false
      };
    }
    return { kind: "failure", reason: status, retryable: true };
  }
  if (retryAfterMs > maxRetryAfterMs) {
    return {
      kind: "failure",
      reason: `${status} (retry-after ${retryAfterMs}ms exceeds the ${maxRetryAfterMs}ms budget)`,
      retryable: false
    };
  }
  return { kind: "failure", reason: status, retryable: true, retryAfterMs };
}

// Run one attempt under its own deadline, reading the body inside the same
// boundary so a connection that drops mid-stream is retried like any other
// transport failure. Caller cancellation is never retried.
async function runAttempt(
  url: string,
  init: RequestInit,
  policy: ResolvedRetryPolicy
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  const abortForCaller = (): void => {
    controller.abort(policy.signal?.reason);
  };
  if (policy.signal?.aborted) {
    abortForCaller();
  } else {
    policy.signal?.addEventListener("abort", abortForCaller, { once: true });
  }
  const timeout = setTimeout(() => {
    controller.abort(new Error(`timed out after ${policy.attemptTimeoutMs}ms`));
  }, policy.attemptTimeoutMs);

  try {
    const response = await policy.fetchImpl(url, {
      ...init,
      signal: controller.signal
    });
    if (!response.ok) {
      await cancelResponseBody(response);
      return classifyResponse(response, policy.maxRetryAfterMs);
    }
    return { kind: "text", text: await response.text() };
  } catch (error) {
    if (policy.signal?.aborted) {
      return {
        kind: "failure",
        reason: `cancelled by caller: ${describeError(error)}`,
        cause: error,
        retryable: false
      };
    }
    return {
      kind: "failure",
      reason: describeError(error),
      cause: error,
      retryable: true
    };
  } finally {
    clearTimeout(timeout);
    policy.signal?.removeEventListener("abort", abortForCaller);
  }
}

function nextDelayMs(
  baseMs: number,
  retryAfterMs: number | undefined,
  random: () => number
): number {
  const jittered = baseMs + Math.round(random() * baseMs * JITTER_RATIO);
  return Math.max(jittered, retryAfterMs ?? 0);
}

// Build the standard GitHub REST headers, adding `Authorization` when a
// GITHUB_TOKEN is present. A token is required for the internal ai-extensions
// repo and, for the public radius repo, avoids the low anonymous rate limit.
// `accept` selects the media type: `application/vnd.github.raw` returns a file
// body verbatim; `application/vnd.github+json` is used for the JSON git/trees
// and git/blobs endpoints.
export function githubApiHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) {
    headers.Authorization = "Bearer " + token;
  }
  return headers;
}

// Fetch one GitHub REST resource as text, retrying transient failures across the
// configured budget. Transient means HTTP 408, HTTP 429, 5xx, a rate-limited 403
// or 429 carrying `Retry-After`, a transport rejection, or a body read that
// fails mid-stream. Missing files, invalid refs, auth failures, an exhausted
// primary rate limit, and caller cancellation fail immediately. Total attempts
// are `retryDelaysMs.length + 1`, so an empty budget means a single attempt.
// Any `signal` in `init` is replaced by the per-attempt deadline; pass caller
// cancellation through `options.signal` instead.
export async function fetchGitHubText(
  url: string,
  init: RequestInit,
  options: FetchGitHubTextOptions = {}
): Promise<LiveGitHubTextResult> {
  const policy = resolvePolicy(options);
  const totalAttempts = policy.retryDelaysMs.length + 1;

  for (let index = 0; ; index += 1) {
    const outcome = await runAttempt(url, init, policy);
    if (outcome.kind === "text") {
      return { text: outcome.text, attempts: index + 1 };
    }

    const isFinalAttempt = index === totalAttempts - 1;
    if (isFinalAttempt || !outcome.retryable) {
      throw new Error(
        `failed to fetch ${url} after ${formatAttemptCount(index + 1)}: ${outcome.reason}`,
        { cause: outcome.cause }
      );
    }

    await policy.sleep(
      nextDelayMs(
        policy.retryDelaysMs[index],
        outcome.retryAfterMs,
        policy.random
      )
    );
  }
}

// Fetch one file under a repo's `.github/extension/` tree as raw text through
// the authenticated contents API. ai-extensions is internal, so its templates
// are not reachable over anonymous raw.githubusercontent.com.
export async function fetchExtensionFile(
  repo: string,
  dir: string,
  file: string,
  ref: string,
  options?: FetchGitHubTextOptions
): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/contents/${dir}/${file}?ref=${encodeURIComponent(ref)}`;
  const { text } = await fetchGitHubText(
    url,
    {
      headers: githubApiHeaders("application/vnd.github.raw")
    },
    options
  );
  return text;
}
