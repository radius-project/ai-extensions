// Shared GitHub REST helpers for the opt-in workflow YAML and OIDC environment
// contract suites. They hit the real GitHub API for radius-project/ai-extensions
// (internal), so they are only imported by live tests gated on
// RUN_LIVE_WORKFLOW_TESTS. This is not production code and is excluded from
// coverage in vitest.config.ts.

const USER_AGENT = "radius-ai-extensions-live-tests";

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

// Status codes worth a retry: GitHub-side/proxy hiccups (502/503/504) and
// secondary-rate-limit throttling (429), none of which reflect a real
// contract break in the fetched template.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch one file under a repo's `.github/extension/` tree as raw text through
// the authenticated contents API. ai-extensions is internal, so its templates
// are not reachable over anonymous raw.githubusercontent.com.
//
// GitHub's API occasionally returns a transient 502/503/504 (or a 429 under
// secondary rate limiting) that has nothing to do with the workflow contract
// under test; retry those a couple of times with a short backoff before
// failing the test.
export async function fetchExtensionFile(
  repo: string,
  dir: string,
  file: string,
  ref: string
): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/contents/${dir}/${file}?ref=${encodeURIComponent(ref)}`;
  let lastError: Error = new Error(`failed to fetch ${url}`);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: githubApiHeaders("application/vnd.github.raw")
      });
    } catch (err) {
      // Network-level failure (DNS, reset, timeout): always worth a retry.
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === MAX_ATTEMPTS) throw lastError;
      await delay(RETRY_DELAY_MS * attempt);
      continue;
    }
    if (res.ok) {
      return await res.text();
    }
    lastError = new Error(
      `failed to fetch ${url}: ${res.status} ${res.statusText}`
    );
    if (!RETRYABLE_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) {
      throw lastError;
    }
    await delay(RETRY_DELAY_MS * attempt);
  }
  throw lastError;
}
