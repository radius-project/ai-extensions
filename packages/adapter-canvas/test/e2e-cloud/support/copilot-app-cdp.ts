// Pure helpers for reaching the GitHub Copilot desktop app over the Chrome
// DevTools Protocol. The app is Tauri on WebView2, so Playwright cannot launch
// it; it attaches to the remote-debugging port the app opens when it is
// started with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const COPILOT_APP_DEFAULT_CDP_PORT = 9222;

/**
 * The app's endpoint for one port. The IPv4 literal is deliberate: a canvas
 * runs in a second WebView2 browser process that opens the same port on the
 * IPv6 loopback, and "localhost" could reach either process.
 */
export function cdpUrlForPort(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`The CDP port must be an integer from 1 to 65535: ${port}`);
  return `http://127.0.0.1:${port}`;
}

/**
 * The endpoints where a canvas browser process can listen: the same port on
 * the other loopback address family.
 */
export function canvasCdpUrls(appCdpUrl: string): string[] {
  const { hostname } = new URL(appCdpUrl);
  const hosts =
    hostname === "127.0.0.1" ? ["[::1]"]
    : hostname === "[::1]" ? ["127.0.0.1"]
    : ["127.0.0.1", "[::1]"];
  return hosts.map((host) => {
    const url = new URL(appCdpUrl);
    url.hostname = host;
    return url.origin;
  });
}

export type CdpProbeResult =
  | { readonly ok: true; readonly browser: string }
  | { readonly ok: false; readonly reason: string };

export type CdpFetch = (
  input: string,
  init: { signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Checks that `<cdpUrl>/json/version` answers like a Chromium CDP endpoint. */
export async function probeCdpEndpoint(
  cdpUrl: string,
  fetchImpl: CdpFetch,
  timeoutMs: number
): Promise<CdpProbeResult> {
  const versionUrl = `${cdpUrl}/json/version`;
  let body: unknown;
  try {
    const response = await fetchImpl(versionUrl, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok)
      return {
        ok: false,
        reason: `${versionUrl} returned HTTP ${response.status}`
      };
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
  )
    return {
      ok: false,
      reason: `${versionUrl} did not return a CDP version payload`
    };
  return { ok: true, browser: body.Browser };
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

/** True for http(s) URLs on a loopback host, where extensions serve canvases. */
export function isLoopbackHttpUrl(value: string): boolean {
  const url = parseUrl(value);
  return (
    url !== undefined &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    LOOPBACK_HOSTS.has(url.hostname)
  );
}

function isTauriAppUrl(value: string): boolean {
  const url = parseUrl(value);
  return (
    url !== undefined &&
    (url.protocol === "tauri:" ||
      url.hostname === "tauri.localhost" ||
      url.hostname.endsWith(".tauri.localhost"))
  );
}

/**
 * Picks the top-level Copilot app page from the CDP targets. DevTools, blank,
 * browser-internal, and loopback canvas pages are skipped. A Tauri origin is
 * preferred; otherwise the first remaining page is used.
 */
export function selectMainPage<T extends { url(): string }>(
  pages: readonly T[]
): T {
  const candidates = pages.filter((page) => {
    const url = page.url();
    return (
      url !== "" &&
      !NON_APP_URL_PREFIXES.some((prefix) => url.startsWith(prefix)) &&
      !isLoopbackHttpUrl(url)
    );
  });
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

/** Every Radius canvas page renders `<title>{page} — Radius</title>`. */
export function isRadiusCanvasTitle(title: string): boolean {
  return /\s—\sRadius$/.test(title.trim());
}

/**
 * Returns the first loopback frame or page whose title marks it as a Radius
 * canvas page, or `undefined` when no Radius canvas is open.
 */
export async function findRadiusCanvasTarget<
  T extends { url(): string; title(): Promise<string> }
>(targets: readonly T[]): Promise<T | undefined> {
  for (const target of targets) {
    if (!isLoopbackHttpUrl(target.url())) continue;
    let title: string;
    try {
      title = await target.title();
    } catch {
      // The frame detached or navigated while it was read.
      continue;
    }
    if (isRadiusCanvasTitle(title)) return target;
  }
  return undefined;
}

/**
 * Builds the canvas URL for one page. The host adds query values, such as an
 * instance token, that the canvas server needs, so every other value is kept.
 */
export function canvasPageUrl(current: string, page: string): string {
  const url = new URL(current);
  if (!isLoopbackHttpUrl(url.href))
    throw new Error(`The Radius canvas is not on a loopback URL: ${current}`);
  url.searchParams.set("page", page);
  url.hash = "";
  return url.toString();
}
