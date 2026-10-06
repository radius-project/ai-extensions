import { expect, test } from "@playwright/test";
import {
  DEFAULT_CDP_URL,
  countTestAttributes,
  probeCdpEndpoint,
  resolveCdpUrl,
  selectMainPage,
  type FetchLike
} from "../fixtures/cdp.ts";

// These checks need no running app; they cover the helpers the CDP fixture
// and the a11y dump script depend on.

const page = (url: string) => ({ url: () => url });

test.describe("resolveCdpUrl", () => {
  test("uses the default endpoint when the variable is unset or blank", () => {
    expect(resolveCdpUrl(undefined)).toBe(DEFAULT_CDP_URL);
    expect(resolveCdpUrl("   ")).toBe(DEFAULT_CDP_URL);
  });

  test("accepts loopback endpoints and drops trailing slashes", () => {
    expect(resolveCdpUrl("http://127.0.0.1:9333/")).toBe(
      "http://127.0.0.1:9333"
    );
    expect(resolveCdpUrl("http://[::1]:9222")).toBe("http://[::1]:9222");
  });

  for (const [value, message] of [
    ["not a url", /not a valid URL/],
    ["ws://localhost:9222", /must use http or https/],
    ["http://example.com:9222", /loopback host/]
  ] as const) {
    test(`rejects ${value}`, () => {
      expect(() => resolveCdpUrl(value)).toThrow(message);
    });
  }
});

test.describe("probeCdpEndpoint", () => {
  const respond =
    (status: number, body: unknown): FetchLike =>
    async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    });

  test("reports the browser version for a CDP payload", async () => {
    const result = await probeCdpEndpoint(
      DEFAULT_CDP_URL,
      respond(200, { Browser: "Edg/140.0" }),
      1000
    );
    expect(result).toEqual({ ok: true, browser: "Edg/140.0" });
  });

  test("fails on a non-success status", async () => {
    const result = await probeCdpEndpoint(
      DEFAULT_CDP_URL,
      respond(404, {}),
      1000
    );
    expect(result).toEqual({
      ok: false,
      reason: `${DEFAULT_CDP_URL}/json/version returned HTTP 404`
    });
  });

  for (const body of [null, "text", {}, { Browser: 1 }]) {
    test(`fails on a malformed payload ${JSON.stringify(body)}`, async () => {
      const result = await probeCdpEndpoint(
        DEFAULT_CDP_URL,
        respond(200, body),
        1000
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(/did not return a CDP/);
    });
  }

  test("fails when the endpoint is unreachable", async () => {
    const refuse: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const result = await probeCdpEndpoint(DEFAULT_CDP_URL, refuse, 1000);
    expect(!result.ok && result.reason).toMatch(/unreachable.*ECONNREFUSED/);
  });

  test("fails when the request exceeds the timeout", async () => {
    const hang: FetchLike = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    const result = await probeCdpEndpoint(DEFAULT_CDP_URL, hang, 10);
    expect(!result.ok && result.reason).toMatch(/unreachable/);
  });
});

test.describe("selectMainPage", () => {
  test("prefers the Tauri app origin over other pages", () => {
    const app = page("http://tauri.localhost/sessions");
    const selected = selectMainPage([
      page("about:blank"),
      page("devtools://devtools/bundled/inspector.html"),
      page("https://github.com/login"),
      app
    ]);
    expect(selected).toBe(app);
  });

  test("skips loopback canvas pages and falls back to the first page", () => {
    const other = page("https://example.test/app");
    const selected = selectMainPage([
      page("http://127.0.0.1:51234/canvas"),
      page("http://localhost:4000/"),
      page(""),
      other
    ]);
    expect(selected).toBe(other);
  });

  test("throws with the seen targets when no app page exists", () => {
    expect(() => selectMainPage([page("about:blank"), page("")])).toThrow(
      "Targets seen: about:blank, <empty>"
    );
    expect(() => selectMainPage([])).toThrow("Targets seen: <none>");
  });
});

test.describe("countTestAttributes", () => {
  test("counts data-test* values and ignores other attributes", () => {
    expect(
      countTestAttributes([
        ["data-testid", "send"],
        ["data-testid", "send"],
        ["data-testid", "sidebar"],
        ["data-test-id", "x"],
        ["aria-label", "Send"],
        ["data-tracking", "y"]
      ])
    ).toEqual({
      "data-testid": { send: 2, sidebar: 1 },
      "data-test-id": { x: 1 }
    });
  });

  test("returns an empty object when nothing matches", () => {
    expect(countTestAttributes([])).toEqual({});
  });
});
