// Shared GitHub REST helpers for the opt-in `*.live.test.ts` suites
// (workflow-yaml, oidc-environment-contract, extension-parity). They hit the
// real GitHub API for radius-project/ai-extensions (internal) and
// radius-project/radius, so they are only imported by live tests gated on
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

// Fetch one file under a repo's `.github/extension/` tree as raw text through
// the authenticated contents API. ai-extensions is internal, so its templates
// are not reachable over anonymous raw.githubusercontent.com.
export async function fetchExtensionFile(
  repo: string,
  dir: string,
  file: string,
  ref: string
): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/contents/${dir}/${file}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: githubApiHeaders("application/vnd.github.raw")
  });
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}
