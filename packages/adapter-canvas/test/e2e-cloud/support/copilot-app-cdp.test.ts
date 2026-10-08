import { describe, expect, it } from "vitest";

import {
  canvasCdpUrls,
  canvasPageUrl,
  cdpUrlForPort,
  findRadiusCanvasTarget,
  isLoopbackHttpUrl,
  isRadiusCanvasTitle,
  probeCdpEndpoint,
  selectMainPage,
  type CdpFetch
} from "./copilot-app-cdp.js";

function page(url: string): { url(): string } {
  return { url: () => url };
}

function target(
  url: string,
  title: string | Error
): { url(): string; title(): Promise<string> } {
  return {
    url: () => url,
    title: () =>
      title instanceof Error ? Promise.reject(title) : Promise.resolve(title)
  };
}

function respond(ok: boolean, status: number, body: unknown): CdpFetch {
  return () =>
    Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

describe("cdpUrlForPort", () => {
  it.each([1, 9222, 65_535])("builds an IPv4 loopback URL for %i", (port) => {
    expect(cdpUrlForPort(port)).toBe(`http://127.0.0.1:${port}`);
  });

  it.each([0, 65_536, 92.5, Number.NaN])("rejects port %s", (port) => {
    expect(() => cdpUrlForPort(port)).toThrow(/integer from 1 to 65535/);
  });
});

describe("canvasCdpUrls", () => {
  it("uses the IPv6 loopback when the app is on IPv4", () => {
    expect(canvasCdpUrls("http://127.0.0.1:9222")).toEqual([
      "http://[::1]:9222"
    ]);
  });

  it("uses the IPv4 loopback when the app is on IPv6", () => {
    expect(canvasCdpUrls("http://[::1]:9333")).toEqual([
      "http://127.0.0.1:9333"
    ]);
  });

  it("tries both families for a host name", () => {
    expect(canvasCdpUrls("http://localhost:9222")).toEqual([
      "http://127.0.0.1:9222",
      "http://[::1]:9222"
    ]);
  });
});

describe("probeCdpEndpoint", () => {
  it("reports the browser version of a CDP endpoint", async () => {
    await expect(
      probeCdpEndpoint(
        "http://127.0.0.1:9222",
        respond(true, 200, { Browser: "Edg/140.0" }),
        100
      )
    ).resolves.toEqual({ ok: true, browser: "Edg/140.0" });
  });

  it("reports an HTTP failure", async () => {
    await expect(
      probeCdpEndpoint("http://127.0.0.1:9222", respond(false, 404, {}), 100)
    ).resolves.toEqual({
      ok: false,
      reason: "http://127.0.0.1:9222/json/version returned HTTP 404"
    });
  });

  it.each([null, "text", {}, { Browser: 1 }])(
    "rejects a payload that is not a CDP version: %j",
    async (body) => {
      const result = await probeCdpEndpoint(
        "http://127.0.0.1:9222",
        respond(true, 200, body),
        100
      );
      expect(result).toEqual({
        ok: false,
        reason:
          "http://127.0.0.1:9222/json/version did not return a CDP version payload"
      });
    }
  );

  it.each([new Error("connect ECONNREFUSED"), "refused"])(
    "reports an unreachable endpoint: %s",
    async (failure) => {
      const result = await probeCdpEndpoint(
        "http://127.0.0.1:9222",
        () => Promise.reject(failure),
        100
      );
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.reason).toMatch(
        /is unreachable: .*refused/i
      );
    }
  );
});

describe("isLoopbackHttpUrl", () => {
  it.each([
    "http://127.0.0.1:4000/",
    "https://localhost/x",
    "http://[::1]:5000/?page=graph"
  ])("accepts %s", (url) => {
    expect(isLoopbackHttpUrl(url)).toBe(true);
  });

  it.each([
    "http://example.com/",
    "file:///C:/x",
    "tauri://localhost",
    "not a url",
    ""
  ])("rejects %s", (url) => {
    expect(isLoopbackHttpUrl(url)).toBe(false);
  });
});

describe("selectMainPage", () => {
  it("prefers the Tauri origin over other app pages", () => {
    const main = page("http://tauri.localhost/workspaces/1");
    expect(
      selectMainPage([page("https://github.com/login"), main, page("")])
    ).toBe(main);
  });

  it("accepts the tauri: scheme and a subdomain", () => {
    const scheme = page("tauri://localhost/");
    const subdomain = page("http://app.tauri.localhost/");
    expect(selectMainPage([scheme])).toBe(scheme);
    expect(selectMainPage([subdomain])).toBe(subdomain);
  });

  it("skips internal, blank, and canvas pages", () => {
    const main = page("https://app.example/");
    expect(
      selectMainPage([
        page("about:blank"),
        page("devtools://devtools/x"),
        page("http://127.0.0.1:4100/?page=graph"),
        main
      ])
    ).toBe(main);
  });

  it("lists the targets it saw when no app page exists", () => {
    expect(() => selectMainPage([page("about:blank"), page("")])).toThrow(
      "No Copilot app page found over CDP. Targets seen: about:blank, <empty>"
    );
    expect(() => selectMainPage([])).toThrow(/Targets seen: <none>/);
  });
});

describe("isRadiusCanvasTitle", () => {
  it.each(["Graph — Radius", "  Deploy — Radius  "])("accepts %j", (title) => {
    expect(isRadiusCanvasTitle(title)).toBe(true);
  });

  it.each(["Radius", "Graph - Radius", "Graph — Radius docs"])(
    "rejects %j",
    (title) => {
      expect(isRadiusCanvasTitle(title)).toBe(false);
    }
  );
});

describe("findRadiusCanvasTarget", () => {
  it("returns the first loopback target with a Radius title", async () => {
    const canvas = target("http://127.0.0.1:4100/", "Graph — Radius");
    await expect(
      findRadiusCanvasTarget([
        target("https://example.com/", "Graph — Radius"),
        target("http://127.0.0.1:4200/", new Error("detached")),
        target("http://127.0.0.1:4300/", "Other canvas"),
        canvas
      ])
    ).resolves.toBe(canvas);
  });

  it("returns undefined when no Radius canvas is open", async () => {
    await expect(findRadiusCanvasTarget([])).resolves.toBeUndefined();
  });
});

describe("canvasPageUrl", () => {
  it("sets the page and keeps the host's other query values", () => {
    expect(
      canvasPageUrl(
        "http://127.0.0.1:4100/?token=abc&page=graph#x",
        "deploying"
      )
    ).toBe("http://127.0.0.1:4100/?token=abc&page=deploying");
  });

  it("refuses a URL that is not on loopback", () => {
    expect(() => canvasPageUrl("https://example.com/", "graph")).toThrow(
      /not on a loopback URL/
    );
  });
});
