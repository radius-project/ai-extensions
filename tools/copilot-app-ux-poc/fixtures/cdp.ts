export const DEFAULT_CDP_URL = "http://localhost:9222";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Resolves the CDP endpoint from the environment. Only loopback http(s)
 * endpoints are accepted, because a CDP connection gives full control of the
 * app and the signed-in account.
 */
export function resolveCdpUrl(raw: string | undefined): string {
  const value = raw?.trim() || DEFAULT_CDP_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`COPILOT_APP_CDP_URL is not a valid URL: "${value}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `COPILOT_APP_CDP_URL must use http or https, got "${url.protocol}"`
    );
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `COPILOT_APP_CDP_URL must point to a loopback host, got "${url.hostname}"`
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export type CdpProbeResult =
  { ok: true; browser: string } | { ok: false; reason: string };

export type FetchLike = (
  input: string,
  init: { signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Checks that `<cdpUrl>/json/version` answers like a Chromium CDP endpoint. */
export async function probeCdpEndpoint(
  cdpUrl: string,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<CdpProbeResult> {
  const versionUrl = `${cdpUrl}/json/version`;
  let body: unknown;
  try {
    const response = await fetchImpl(versionUrl, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: `${versionUrl} returned HTTP ${response.status}`
      };
    }
    body = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `${versionUrl} is unreachable: ${message}` };
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("Browser" in body) ||
    typeof body.Browser !== "string"
  ) {
    return {
      ok: false,
      reason: `${versionUrl} did not return a CDP version payload`
    };
  }
  return { ok: true, browser: body.Browser };
}

export interface PageLike {
  url(): string;
}

const NON_APP_URL_PREFIXES = [
  "about:",
  "devtools://",
  "chrome-devtools://",
  "chrome://",
  "chrome-error://",
  "chrome-extension://",
  "edge://"
];

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isTauriAppUrl(value: string): boolean {
  const url = parseUrl(value);
  if (!url) {
    return false;
  }
  return (
    url.protocol === "tauri:" ||
    url.hostname === "tauri.localhost" ||
    url.hostname.endsWith(".tauri.localhost")
  );
}

function isCandidateUrl(value: string): boolean {
  if (!value || NON_APP_URL_PREFIXES.some((p) => value.startsWith(p))) {
    return false;
  }
  // Canvas panels are served by extensions from loopback HTTP servers.
  const url = parseUrl(value);
  return !url || !LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Picks the top-level Copilot app page from the CDP targets. DevTools, blank,
 * browser-internal, and loopback canvas pages are skipped. A Tauri origin is
 * preferred; otherwise the first remaining page is used.
 */
export function selectMainPage<T extends PageLike>(pages: readonly T[]): T {
  const candidates = pages.filter((page) => isCandidateUrl(page.url()));
  const page =
    candidates.find((candidate) => isTauriAppUrl(candidate.url())) ??
    candidates[0];
  if (!page) {
    const seen = pages.map((p) => p.url() || "<empty>").join(", ");
    throw new Error(
      `No Copilot app page found over CDP. Targets seen: ${seen || "<none>"}`
    );
  }
  return page;
}

export type TestAttributeCounts = Record<string, Record<string, number>>;

/** Counts `data-test*` attribute values, grouped by attribute name. */
export function countTestAttributes(
  attributes: Iterable<readonly [name: string, value: string]>
): TestAttributeCounts {
  const counts: TestAttributeCounts = {};
  for (const [name, value] of attributes) {
    if (!name.startsWith("data-test")) {
      continue;
    }
    const byValue = (counts[name] ??= {});
    byValue[value] = (byValue[value] ?? 0) + 1;
  }
  return counts;
}
