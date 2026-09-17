// Shared GitHub REST helpers for the opt-in workflow YAML and OIDC environment
// contract suites. They hit the real GitHub API for radius-project/ai-extensions
// (internal), so they are only imported by live tests gated on
// RUN_LIVE_WORKFLOW_TESTS. This is not production code and is excluded from
// coverage in vitest.config.ts.

const USER_AGENT = "radius-ai-extensions-live-tests";
export const DEFAULT_RETRY_DELAYS_MS = [250, 1000] as const;
// The whole call is bounded by one wall-clock deadline. The live suites give
// each test 30s, so everything the helper does — every attempt, every backoff,
// and every `Retry-After` wait — has to fit inside this budget, or Vitest kills
// the test before the final diagnostic is emitted. Per-attempt limits alone
// cannot guarantee that, because waits accumulate across retries.
export const DEFAULT_TOTAL_BUDGET_MS = 25_000;
// Each attempt is additionally capped so one stalled connection cannot spend
// the entire budget before any retry happens. The effective cap is the smaller
// of this and the time left in the budget.
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 8_000;
// Retrying with less than this left is pointless: the attempt would be aborted
// almost immediately and would replace a useful diagnostic with a timeout.
const MINIMUM_ATTEMPT_MS = 1_000;
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

// The wait is passed the deadline signal so an injected sleep can abort its own
// timer when the caller cancels, rather than leaving it pending.
export type LiveGitHubSleep = (
  milliseconds: number,
  signal?: AbortSignal
) => Promise<void>;

export interface FetchGitHubTextOptions {
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: LiveGitHubSleep;
  readonly retryDelaysMs?: readonly number[];
  readonly attemptTimeoutMs?: number;
  readonly totalBudgetMs?: number;
  readonly maxRetryAfterMs?: number;
  readonly random?: () => number;
  readonly now?: () => number;
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
  readonly sleep: LiveGitHubSleep;
  readonly retryDelaysMs: readonly number[];
  readonly attemptTimeoutMs: number;
  readonly totalBudgetMs: number;
  readonly maxRetryAfterMs: number;
  readonly random: () => number;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}

// Resolve on abort as well as on the timer, clearing the timer when the wait is
// cancelled so nothing is left pending. Callers guarantee the signal is not
// already aborted, since an abort listener added afterwards would never fire.
function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resolvePolicy(options: FetchGitHubTextOptions): ResolvedRetryPolicy {
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep ?? defaultSleep,
    retryDelaysMs: [...(options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS)],
    attemptTimeoutMs: options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
    totalBudgetMs: options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS,
    maxRetryAfterMs: options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
    random: options.random ?? Math.random,
    now: options.now ?? Date.now,
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

// GitHub reports secondary rate limits as 403 or 429. Only a usable
// `Retry-After` or an exhausted quota counts as evidence, so a plain 403 stays
// permanent while a malformed header leaves a 429 on the normal transient path.
function hasExhaustedQuota(response: Response): boolean {
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
  const retryAfterMs = parseRetryAfterMs(response);
  const rateLimitStatus = response.status === 403 || response.status === 429;
  const quotaExhausted = rateLimitStatus && hasExhaustedQuota(response);
  const rateLimited =
    rateLimitStatus && (retryAfterMs !== undefined || quotaExhausted);
  if (!isTransientStatus(response.status) && !rateLimited) {
    return { kind: "failure", reason: status, retryable: false };
  }

  if (retryAfterMs !== undefined) {
    if (retryAfterMs > maxRetryAfterMs) {
      return {
        kind: "failure",
        reason: `${status} (retry-after ${retryAfterMs}ms exceeds the ${maxRetryAfterMs}ms budget)`,
        retryable: false
      };
    }
    return { kind: "failure", reason: status, retryable: true, retryAfterMs };
  }

  // An exhausted quota resets far beyond any retry budget worth spending, so
  // report the reset instead of retrying. Everything else backs off normally.
  if (quotaExhausted) {
    return {
      kind: "failure",
      reason: `${status} (${describeRateLimitReset(response)})`,
      retryable: false
    };
  }
  return { kind: "failure", reason: status, retryable: true };
}

// Run one attempt under the smaller of its own cap and the time left in the
// overall budget, reading the body inside the same boundary so a connection
// that drops mid-stream is retried like any other transport failure. Caller
// cancellation is never retried.
async function runAttempt(
  url: string,
  init: RequestInit,
  policy: ResolvedRetryPolicy,
  attemptTimeoutMs: number
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
    controller.abort(new Error(`timed out after ${attemptTimeoutMs}ms`));
  }, attemptTimeoutMs);

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

// Wait out the backoff, but settle as soon as the caller cancels so the wait
// does not run to completion and start another request. The injected sleep is
// given a derived signal so it can drop its own timer, and the abort listener is
// removed either way. `signal.reason` is always set once a signal is aborted.
async function waitBeforeRetry(
  delayMs: number,
  policy: ResolvedRetryPolicy
): Promise<void> {
  const signal = policy.signal;
  if (!signal) {
    await policy.sleep(delayMs);
    return;
  }
  if (signal.aborted) {
    throw signal.reason;
  }

  const waitController = new AbortController();
  let rejectCancelled!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  const onAbort = (): void => {
    // Reject before aborting the derived signal: a sleep that resolves on abort
    // would otherwise win the race and let the retry proceed as if the wait had
    // simply elapsed.
    rejectCancelled(signal.reason);
    waitController.abort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    await Promise.race([
      cancelled,
      policy.sleep(delayMs, waitController.signal)
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
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

// Fetch one GitHub REST resource as text, retrying transient failures until the
// retry budget or the overall wall-clock deadline runs out. Transient means HTTP
// 408, HTTP 429, 5xx, a 403 or 429 carrying a usable `Retry-After`, a transport
// rejection, an attempt that exceeds its deadline, or a body read that fails
// mid-stream. Missing files, invalid refs, auth failures, a 403 with no
// rate-limit evidence, an exhausted rate-limit quota, a `Retry-After` beyond the
// wait budget, and caller cancellation fail immediately.
//
// Two limits apply together. `retryDelaysMs.length + 1` caps the attempt count,
// so an empty budget means a single attempt. `totalBudgetMs` caps the elapsed
// wall clock across every attempt and every wait, including a `Retry-After`
// override, so the call always leaves the caller's own timeout enough room to
// observe the diagnostic. A retry that cannot fit in the remaining budget is
// reported instead of started.
//
// Any `signal` in `init` is replaced by the per-attempt deadline; pass caller
// cancellation through `options.signal` instead, which also interrupts a wait.
export async function fetchGitHubText(
  url: string,
  init: RequestInit,
  options: FetchGitHubTextOptions = {}
): Promise<LiveGitHubTextResult> {
  const policy = resolvePolicy(options);
  const totalAttempts = policy.retryDelaysMs.length + 1;
  const deadline = policy.now() + policy.totalBudgetMs;
  const remainingMs = (): number => deadline - policy.now();

  for (let index = 0; ; index += 1) {
    const attempts = index + 1;
    const fail = (reason: string, cause?: unknown): Error =>
      new Error(
        `failed to fetch ${url} after ${formatAttemptCount(attempts)}: ${reason}`,
        { cause }
      );

    const outcome = await runAttempt(
      url,
      init,
      policy,
      Math.min(policy.attemptTimeoutMs, Math.max(remainingMs(), 0))
    );
    if (outcome.kind === "text") {
      return { text: outcome.text, attempts };
    }

    if (index === totalAttempts - 1 || !outcome.retryable) {
      throw fail(outcome.reason, outcome.cause);
    }

    // Decide against the clock rather than the attempt count: a `Retry-After`
    // wait can be long enough that another attempt would overrun the budget
    // even though retries remain. Report that instead of starting a request the
    // caller's timeout would kill first.
    const delayMs = nextDelayMs(
      policy.retryDelaysMs[index],
      outcome.retryAfterMs,
      policy.random
    );
    const remaining = remainingMs();
    if (delayMs + MINIMUM_ATTEMPT_MS > remaining) {
      throw fail(
        `${outcome.reason} (retrying in ${delayMs}ms would exceed the ${policy.totalBudgetMs}ms budget, ${Math.max(remaining, 0)}ms left)`,
        outcome.cause
      );
    }

    try {
      await waitBeforeRetry(delayMs, policy);
    } catch (error) {
      throw fail(`cancelled by caller: ${describeError(error)}`, error);
    }
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
