// Shared GitHub REST helpers for the opt-in workflow YAML and OIDC environment
// contract suites. They hit the real GitHub API for radius-project/ai-extensions
// (internal), so they are only imported by live tests gated on
// RUN_LIVE_WORKFLOW_TESTS. This is not production code and is excluded from
// coverage in vitest.config.ts.

const USER_AGENT = "radius-ai-extensions-live-tests";
const DEFAULT_RETRY_DELAYS_MS = [250, 1000] as const;

export interface LiveGithubFetchResult {
  readonly response: Response;
  readonly attempts: number;
}

export interface FetchGitHubWithRetryOptions {
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly retryDelaysMs?: readonly number[];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
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

// Retry one GitHub API request across the provided retry budget. Transient
// failures are HTTP 408, HTTP 429, and 5xx responses; fetch rejections are
// retried the same way and rethrown once the budget is exhausted. The number of
// extra attempts equals `retryDelaysMs.length`, so the default budget is three
// total attempts and an empty budget means one attempt with no retries.
export async function fetchGitHubWithRetry(
  url: string,
  init: RequestInit,
  options: FetchGitHubWithRetryOptions = {}
): Promise<LiveGithubFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelaysMs = [...(options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS)];
  const delay = options.sleep ?? sleep;

  for (const [attemptIndex, retryDelayMs] of retryDelaysMs.entries()) {
    try {
      const response = await fetchImpl(url, init);
      if (response.ok || !isTransientStatus(response.status)) {
        return { response, attempts: attemptIndex + 1 };
      }
    } catch {
      // Retry rejected fetches until the retry budget is exhausted.
    }

    await delay(retryDelayMs);
  }

  const response = await fetchImpl(url, init);
  return { response, attempts: retryDelaysMs.length + 1 };
}

// Fetch one file under a repo's `.github/extension/` tree as raw text through
// the authenticated contents API. ai-extensions is internal, so its templates
// are not reachable over anonymous raw.githubusercontent.com.
export async function fetchExtensionFile(
  repo: string,
  dir: string,
  file: string,
  ref: string,
  options?: FetchGitHubWithRetryOptions
): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/contents/${dir}/${file}?ref=${encodeURIComponent(ref)}`;
  const { response: res, attempts } = await fetchGitHubWithRetry(
    url,
    {
      headers: githubApiHeaders("application/vnd.github.raw")
    },
    options
  );
  if (!res.ok) {
    const attemptNoun = attempts === 1 ? "attempt" : "attempts";
    throw new Error(
      `failed to fetch ${url} after ${attempts} ${attemptNoun}: ${res.status} ${res.statusText}`
    );
  }
  return res.text();
}
