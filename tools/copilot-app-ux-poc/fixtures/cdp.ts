// Use the IPv4 literal, not "localhost". A canvas runs in a second WebView2
// browser process that also opens the CDP port, on the IPv6 loopback. With
// "localhost", a client can reach either process.
export const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Resolves a CDP endpoint from the environment. Only loopback http(s)
 * endpoints are accepted, because a CDP connection gives full control of the
 * app and the signed-in account.
 */
export function resolveCdpUrl(
  raw: string | undefined,
  variableName = "COPILOT_APP_CDP_URL"
): string {
  const value = raw?.trim() || DEFAULT_CDP_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} is not a valid URL: "${value}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `${variableName} must use http or https, got "${url.protocol}"`
    );
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `${variableName} must point to a loopback host, got "${url.hostname}"`
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Returns the CDP endpoints where a canvas browser process can listen. An
 * explicit override wins. Otherwise the same port on the other loopback
 * address family is used, because the canvas process reuses the app's port.
 */
export function canvasCdpUrls(
  appCdpUrl: string,
  override: string | undefined
): string[] {
  if (override?.trim()) {
    return [resolveCdpUrl(override, "COPILOT_APP_CANVAS_CDP_URL")];
  }
  const { hostname } = new URL(appCdpUrl);
  const hosts =
    hostname === "127.0.0.1" ? ["[::1]"]
    : hostname === "[::1]" ? ["127.0.0.1"]
    : ["127.0.0.1", "[::1]"];
  return hosts.map((host) => {
    const url = new URL(appCdpUrl);
    url.hostname = host;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  });
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

/** True for http(s) URLs on a loopback host, where extensions serve canvases. */
export function isLoopbackHttpUrl(value: string): boolean {
  const url = parseUrl(value);
  return (
    url !== undefined &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    LOOPBACK_HOSTS.has(url.hostname)
  );
}

function isCandidateUrl(value: string): boolean {
  if (!value || NON_APP_URL_PREFIXES.some((p) => value.startsWith(p))) {
    return false;
  }
  return !isLoopbackHttpUrl(value);
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

/** Every Radius canvas page renders `<title>{page} — Radius</title>`. */
export function isRadiusCanvasTitle(title: string): boolean {
  return /\s—\sRadius$/.test(title.trim());
}

export interface CanvasTargetLike {
  url(): string;
  title(): Promise<string>;
}

/**
 * Returns the first loopback frame or page whose title marks it as a Radius
 * canvas page, or `undefined` when no Radius canvas is open.
 */
export async function findRadiusCanvasTarget<T extends CanvasTargetLike>(
  targets: readonly T[]
): Promise<T | undefined> {
  for (const target of targets) {
    if (!isLoopbackHttpUrl(target.url())) {
      continue;
    }
    let title: string;
    try {
      title = await target.title();
    } catch {
      // The frame detached or navigated while we read it.
      continue;
    }
    if (isRadiusCanvasTitle(title)) {
      return target;
    }
  }
  return undefined;
}
