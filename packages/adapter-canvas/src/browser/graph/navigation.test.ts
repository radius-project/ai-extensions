import { describe, expect, it } from "vitest";
import {
  createGraphNavigation,
  graphPageUrl,
  GRAPH_CONTENT_ID,
  GRAPH_NAV_ID,
  GRAPH_PAGE_ATTRIBUTE,
  initializeGraphNavigation
} from "./navigation.js";
import {
  createDeferred,
  createFakeBrowser,
  createFakeDocument,
  createFakeElement,
  flushPromises,
  textResponse
} from "../../../test/support/browser/fakes.js";
import type { DomElement, HttpResponse } from "../ports.js";

function setup(options: { withContent?: boolean; withNav?: boolean } = {}) {
  const browser = createFakeBrowser();
  const content = createFakeElement(GRAPH_CONTENT_ID);
  const nav = createFakeElement(GRAPH_NAV_ID);
  if (options.withContent !== false) {
    browser.document.add(content);
    if (options.withNav !== false) browser.document.add(nav);
  }
  let pageTeardowns = 0;
  const claims: Array<"begin" | "end"> = [];
  const navigation = createGraphNavigation(browser.context, {
    teardownPage() {
      pageTeardowns++;
    },
    beginNavigation() {
      claims.push("begin");
    },
    endNavigation() {
      claims.push("end");
    }
  });
  return {
    browser,
    content,
    nav,
    navigation,
    claims,
    get pageTeardowns() {
      return pageTeardowns;
    }
  };
}

function parsedPage(
  contentHtml: string | null,
  navHtml: string | null,
  activePage?: string
): ReturnType<typeof createFakeDocument> {
  const document = createFakeDocument();
  if (contentHtml !== null) {
    const element = createFakeElement(GRAPH_CONTENT_ID);
    element.innerHTML = contentHtml;
    document.add(element);
  }
  if (navHtml !== null) {
    const element = createFakeElement(GRAPH_NAV_ID);
    element.innerHTML = navHtml;
    document.add(element);
  }
  if (activePage) {
    document.addSelector(
      `[${GRAPH_PAGE_ATTRIBUTE}="${activePage}"]`,
      createFakeElement("active-link", "a")
    );
  }
  return document;
}

describe("graphPageUrl", () => {
  it("replaces only the page query and preserves the remaining state", () => {
    expect(
      graphPageUrl("?repo=octo%2Fapp&page=graph&environment=dev", "planned")
    ).toBe("?page=planned&repo=octo%2Fapp&environment=dev");
  });

  it("handles an empty or malformed query without losing it", () => {
    expect(graphPageUrl("", "graph-diff")).toBe("?page=graph-diff");
    expect(graphPageUrl("?bad=%E0%A4%A", "deployed")).toBe(
      "?page=deployed&bad=%E0%A4%A"
    );
    expect(graphPageUrl("?%E0%A4%A=value", "graph")).toBe(
      "?page=graph&%E0%A4%A=value"
    );
  });
});

describe("graph navigation", () => {
  it("tears down the outgoing page, swaps content, preserves keyboard focus, and pushes once", async () => {
    const harness = setup();
    harness.browser.net.handle("/?page=planned", () => {
      // The outgoing page is torn down before the request goes out, so its
      // timers cannot fire against a page the user has already left.
      expect(harness.pageTeardowns).toBe(1);
      return textResponse("<html>planned</html>");
    });
    const parsed = parsedPage(
      "<div>new content</div>",
      "<a>planned</a>",
      "planned"
    );
    const liveActive = createFakeElement("live-active", "a");
    harness.browser.document.addSelector(
      `#${GRAPH_NAV_ID} [${GRAPH_PAGE_ATTRIBUTE}="planned"]`,
      liveActive
    );
    harness.browser.nav.parsed = (html) => {
      expect(html).toBe("<html>planned</html>");
      return parsed;
    };
    let prevented = 0;

    harness.navigation.navigateTo(
      { detail: 0, preventDefault: () => prevented++ },
      "planned"
    );
    await flushPromises();

    expect(prevented).toBe(1);
    expect(harness.pageTeardowns).toBe(1);
    expect(harness.content.innerHTML).toBe("<div>new content</div>");
    expect(harness.nav.innerHTML).toBe("<a>planned</a>");
    expect(harness.browser.nav.pushed).toEqual(["?page=planned"]);
    expect(harness.browser.nav.assigned).toEqual([]);
    expect(liveActive.focusCount).toBe(1);
  });

  it("does not transfer focus after pointer navigation", async () => {
    const harness = setup();
    harness.browser.net.handle("/?page=planned", () =>
      textResponse("<html>planned</html>")
    );
    harness.browser.nav.parsed = () =>
      parsedPage("<div>new content</div>", "<a>planned</a>", "planned");
    const liveActive = createFakeElement("live-active", "a");
    harness.browser.document.addSelector(
      `#${GRAPH_NAV_ID} [${GRAPH_PAGE_ATTRIBUTE}="planned"]`,
      liveActive
    );

    harness.navigation.navigateTo(
      { detail: 1, preventDefault() {} },
      "planned"
    );
    await flushPromises();

    expect(liveActive.focusCount).toBe(0);
  });

  it("re-executes incoming inline scripts and leaves an absent nav alone", async () => {
    const harness = setup();
    harness.nav.innerHTML = "<a>current</a>";
    const stale = createFakeElement("", "script");
    stale.textContent = "installPage();";
    const withSrc = createFakeElement("", "script");
    withSrc.setAttribute("src", "/vendor.js");
    const detached = createFakeElement("", "script");
    const replaced: Array<[DomElement, DomElement]> = [];
    for (const script of [stale, withSrc]) {
      script.parentNode = {
        replaceChild(next, previous) {
          replaced.push([next, previous]);
        }
      };
    }
    harness.content.matches.set("script", [stale, withSrc, detached]);
    harness.browser.net.handle("/?page=graph-diff", () =>
      textResponse("<html/>")
    );
    harness.browser.nav.parsed = () => parsedPage("<div></div>", null);

    harness.navigation.navigateTo(null, "graph-diff");
    await flushPromises();

    expect(replaced).toHaveLength(2);
    expect(replaced[0][0].textContent).toBe("installPage();");
    expect(replaced[1][0].getAttribute("src")).toBe("/vendor.js");
    expect(harness.nav.innerHTML).toBe("<a>current</a>");
  });

  it("tolerates an incoming nav when the current document has no nav", async () => {
    const harness = setup({ withNav: false });
    harness.browser.net.handle("/?page=planned", () => textResponse("<html/>"));
    harness.browser.nav.parsed = () =>
      parsedPage("<div>planned</div>", "<a>planned</a>");
    harness.navigation.navigateTo(null, "planned");
    await flushPromises();
    expect(harness.content.innerHTML).toContain("planned");
  });

  it("falls back to a full navigation without a content region", () => {
    const harness = setup({ withContent: false });
    harness.navigation.navigateTo(null, "planned");
    expect(harness.browser.nav.assigned).toEqual(["?page=planned"]);
    expect(harness.browser.net.calls).toEqual([]);
    expect(harness.pageTeardowns).toBe(0);
  });

  it.each([
    [
      "a completed swap",
      async (harness: ReturnType<typeof setup>) => {
        harness.browser.net.handle("/?page=planned", () =>
          textResponse("<html>planned</html>")
        );
        harness.browser.nav.parsed = () =>
          parsedPage("<div>planned</div>", null);
        harness.navigation.navigateTo(null, "planned");
        await flushPromises();
      }
    ],
    [
      "a failed swap",
      async (harness: ReturnType<typeof setup>) => {
        harness.browser.net.handle("/?page=planned", () =>
          Promise.reject(new Error("offline"))
        );
        harness.navigation.navigateTo(null, "planned");
        await flushPromises();
      }
    ],
    [
      "cancellation",
      async (harness: ReturnType<typeof setup>) => {
        harness.browser.net.handle(
          "/?page=planned",
          () => createDeferred<HttpResponse>().promise
        );
        harness.navigation.navigateTo(null, "planned");
        harness.navigation.cancelPendingWork();
      }
    ]
  ])("releases its navigation claim after %s", async (_label, run) => {
    const harness = setup();

    await run(harness);

    expect(harness.claims.at(-1)).toBe("end");
  });

  it.each([
    ["network rejection", () => Promise.reject(new Error("offline"))],
    ["non-success response", () => textResponse("no", false, 503)]
  ])("falls back when the %s prevents a swap", async (_label, response) => {
    const harness = setup();
    harness.browser.net.handle("/?page=planned", response);

    harness.navigation.navigateTo(null, "planned");
    await flushPromises();

    expect(harness.browser.nav.assigned).toEqual(["?page=planned"]);
    expect(harness.browser.logger.errors).toHaveLength(1);
  });

  it("falls back when parsing or the content contract fails", async () => {
    const harness = setup();
    let parses = 0;
    harness.browser.net.handle("/?page=planned", () => textResponse("<html/>"));
    harness.browser.nav.parsed = () => {
      parses++;
      if (parses === 1) throw new Error("bad html");
      return parsedPage(null, null);
    };

    harness.navigation.navigateTo(null, "planned");
    await flushPromises();
    harness.navigation.navigateTo(null, "planned");
    await flushPromises();

    expect(harness.browser.nav.assigned).toEqual([
      "?page=planned",
      "?page=planned"
    ]);
  });

  it("aborts and ignores an older response after a newer navigation", async () => {
    const harness = setup();
    const first = createDeferred<HttpResponse>();
    harness.browser.net.handle("/?page=planned", () => first.promise);
    harness.browser.net.handle("/?page=deployed", () =>
      textResponse("<html>latest</html>")
    );
    harness.browser.nav.parsed = (html) =>
      parsedPage(`<div>${html}</div>`, null);

    harness.navigation.navigateTo(null, "planned");
    harness.navigation.navigateTo(null, "deployed");
    await flushPromises();
    first.resolve(textResponse("<html>stale</html>"));
    await flushPromises();

    expect(harness.browser.net.aborted).toBe(1);
    expect(harness.content.innerHTML).toContain("latest");
    expect(harness.content.innerHTML).not.toContain("stale");
    expect(harness.browser.nav.pushed).toEqual(["?page=deployed"]);
  });

  it("ignores an older response even when abort support is unavailable", async () => {
    const harness = setup();
    harness.browser.net.supportsAbort = false;
    const first = createDeferred<HttpResponse>();
    harness.browser.net.handle("/?page=planned", () => first.promise);
    harness.browser.net.handle("/?page=deployed", () =>
      textResponse("<html>latest</html>")
    );
    harness.browser.nav.parsed = (html) =>
      parsedPage(`<div>${html}</div>`, null);
    harness.navigation.navigateTo(null, "planned");
    harness.navigation.navigateTo(null, "deployed");
    await flushPromises();
    first.resolve(textResponse("<html>stale</html>"));
    await flushPromises();
    expect(harness.content.innerHTML).toContain("latest");
    expect(harness.content.innerHTML).not.toContain("stale");
  });

  it("ignores an older request failure after a newer navigation", async () => {
    const harness = setup();
    const first = createDeferred<HttpResponse>();
    harness.browser.net.handle("/?page=planned", () => first.promise);
    harness.browser.net.handle("/?page=deployed", () =>
      textResponse("<html>latest</html>")
    );
    harness.browser.nav.parsed = (html) =>
      parsedPage(`<div>${html}</div>`, null);
    harness.navigation.navigateTo(null, "planned");
    harness.navigation.navigateTo(null, "deployed");
    await flushPromises();

    first.reject(new Error("stale failure"));
    await flushPromises();

    expect(harness.browser.nav.assigned).toEqual([]);
    expect(harness.browser.logger.errors).toEqual([]);
  });

  it("navigates without a request signal when abort is unavailable", async () => {
    const harness = setup();
    harness.browser.net.supportsAbort = false;
    harness.browser.net.handle("/?page=planned", () => textResponse("<html/>"));
    harness.browser.nav.parsed = () => parsedPage("<div>planned</div>", null);

    harness.navigation.navigateTo(null, "planned");
    await flushPromises();

    expect(harness.browser.net.calls[0].init).toBeUndefined();
  });

  it("cancels an active request and outgoing page work explicitly", () => {
    const harness = setup();
    harness.browser.net.handle(
      "/?page=planned",
      () => createDeferred<HttpResponse>().promise
    );
    harness.navigation.navigateTo(null, "planned");

    harness.navigation.cancelPendingWork();

    expect(harness.browser.net.aborted).toBe(1);
    // Once for the navigation itself, once for the explicit cancel: tearing a
    // page down twice is a no-op rather than an error.
    expect(harness.pageTeardowns).toBe(2);
  });
});

describe("navigation bindings", () => {
  it("delegates graph-link clicks and ignores unrelated targets", async () => {
    const harness = setup();
    initializeGraphNavigation(harness.browser.context, harness.navigation);
    harness.browser.net.handle("/?page=deployed", () =>
      textResponse("<html/>")
    );
    harness.browser.nav.parsed = () => parsedPage("<div>deployed</div>", null);
    const link = createFakeElement("deployed-link", "a");
    link.setAttribute(GRAPH_PAGE_ATTRIBUTE, "deployed");
    const child = createFakeElement("label", "strong");
    child.ancestors.set(`[${GRAPH_PAGE_ATTRIBUTE}]`, link);
    let prevented = 0;

    harness.browser.document.dispatch("click", {
      target: child,
      preventDefault: () => prevented++
    });
    harness.browser.document.dispatch("click", {
      target: createFakeElement("other")
    });
    harness.browser.document.dispatch("click", { target: "text" });
    const noPage = createFakeElement("no-page", "a");
    noPage.ancestors.set(`[${GRAPH_PAGE_ATTRIBUTE}]`, noPage);
    harness.browser.document.dispatch("click", { target: noPage });
    const invalid = createFakeElement("invalid", "a");
    invalid.setAttribute(GRAPH_PAGE_ATTRIBUTE, "environment");
    invalid.ancestors.set(`[${GRAPH_PAGE_ATTRIBUTE}]`, invalid);
    harness.browser.document.dispatch("click", { target: invalid });
    await flushPromises();

    expect(prevented).toBe(1);
    expect(harness.content.innerHTML).toContain("deployed");
    expect(harness.browser.net.calls).toHaveLength(1);
  });

  it("binds once and tears down the document listener", () => {
    const harness = setup();
    const teardown = initializeGraphNavigation(
      harness.browser.context,
      harness.navigation
    );
    initializeGraphNavigation(harness.browser.context, harness.navigation);

    expect(harness.browser.document.listenerCount("click")).toBe(1);
    expect(harness.browser.page.listenerCount()).toBe(0);

    teardown();
    expect(harness.browser.document.listenerCount()).toBe(0);
  });
});
