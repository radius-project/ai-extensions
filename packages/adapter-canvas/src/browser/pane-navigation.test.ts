import { describe, expect, it, vi } from "vitest";
import {
  createPaneNavigation,
  initializePaneNavigation,
  PANE_ACTIVE_CLASS,
  PANE_CONTENT_ID,
  PANE_NAVIGATION_LINK_SELECTOR,
  PANE_NAVIGATION_TRIGGER_SELECTOR,
  PANE_TOP_NAV_ID
} from "./pane-navigation.js";
import {
  createDeferred,
  createFakeBrowser,
  createFakeDocument,
  createFakeElement,
  flushPromises,
  textResponse
} from "../../test/support/browser/fakes.js";
import type { DomEvent, HttpResponse } from "./ports.js";

function parsedPane(
  contentHtml: string | null,
  activeHref: string | null
): ReturnType<typeof createFakeDocument> {
  const document = createFakeDocument();
  if (contentHtml !== null) {
    const content = createFakeElement(PANE_CONTENT_ID);
    content.innerHTML = contentHtml;
    document.add(content);
  }
  const nav = createFakeElement(PANE_TOP_NAV_ID);
  if (activeHref !== null) {
    const active = createFakeElement("incoming-active", "a");
    active.setAttribute("href", activeHref);
    nav.matches.set(`.${PANE_ACTIVE_CLASS}`, [active]);
  }
  document.add(nav);
  return document;
}

function setup(options: { content?: boolean; nav?: boolean } = {}) {
  const browser = createFakeBrowser();
  const content = createFakeElement(PANE_CONTENT_ID);
  const topNav = createFakeElement(PANE_TOP_NAV_ID);
  const applications = createFakeElement("applications", "a");
  applications.className = `${PANE_NAVIGATION_LINK_SELECTOR.slice(1)} ${PANE_ACTIVE_CLASS}`;
  applications.setAttribute("href", "/?page=graph");
  const environments = createFakeElement("environments", "a");
  environments.className = PANE_NAVIGATION_LINK_SELECTOR.slice(1);
  environments.setAttribute("href", "/?page=environment");
  const deployments = createFakeElement("deployments", "a");
  deployments.className = PANE_NAVIGATION_LINK_SELECTOR.slice(1);
  deployments.setAttribute("href", "/?page=deploying");
  for (const link of [applications, environments, deployments]) {
    link.ancestors.set(PANE_NAVIGATION_TRIGGER_SELECTOR, link);
  }
  topNav.matches.set(PANE_NAVIGATION_LINK_SELECTOR, [
    applications,
    environments,
    deployments
  ]);
  if (options.content !== false) browser.document.add(content);
  if (options.nav !== false) browser.document.add(topNav);
  let pageTeardowns = 0;
  const navigation = createPaneNavigation(browser.context, {
    teardownPage() {
      pageTeardowns += 1;
    }
  });
  return {
    ...browser,
    content,
    topNav,
    applications,
    environments,
    deployments,
    navigation,
    get pageTeardowns() {
      return pageTeardowns;
    }
  };
}

function clickEvent(target: unknown, overrides: Partial<DomEvent> = {}) {
  return {
    target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides
  };
}

describe("top-level pane navigation", () => {
  it("swaps the main region, updates active navigation, and pushes history", async () => {
    const harness = setup();
    harness.net.handle("/?page=environment", () =>
      textResponse("<html>environment</html>")
    );
    harness.nav.parsed = () =>
      parsedPane("<section>environment</section>", "/?page=environment");
    const event = clickEvent(harness.environments);

    harness.navigation.navigateTo(event, "/?page=environment");
    expect(harness.content.getAttribute("aria-busy")).toBe("true");
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(harness.pageTeardowns).toBe(1);
    expect(harness.content.innerHTML).toBe("<section>environment</section>");
    expect(harness.content.getAttribute("aria-busy")).toBeNull();
    expect(harness.applications.classList.contains(PANE_ACTIVE_CLASS)).toBe(
      false
    );
    expect(harness.environments.classList.contains(PANE_ACTIVE_CLASS)).toBe(
      true
    );
    expect(harness.environments.focusCount).toBe(1);
    expect(harness.nav.pushed).toEqual(["/?page=environment"]);
    expect(harness.nav.assigned).toEqual([]);
  });

  it("keeps the current document and applies only the latest rapid navigation", async () => {
    const harness = setup();
    const first = createDeferred<HttpResponse>();
    harness.net.handle("/?page=environment", () => first.promise);
    harness.net.handle("/?page=deploying", () =>
      textResponse("<html>deploying</html>")
    );
    harness.nav.parsed = (html) =>
      parsedPane(
        `<section>${html}</section>`,
        html.includes("deploying") ? "/?page=deploying" : "/?page=environment"
      );

    harness.navigation.navigateTo(null, "/?page=environment");
    harness.navigation.navigateTo(null, "/?page=deploying");
    await flushPromises();
    first.resolve(textResponse("<html>environment</html>"));
    await flushPromises();

    expect(harness.net.aborted).toBe(1);
    expect(harness.content.innerHTML).toContain("deploying");
    expect(harness.content.innerHTML).not.toContain("environment");
    expect(harness.nav.pushed).toEqual(["/?page=deploying"]);
    expect(harness.nav.assigned).toEqual([]);
  });

  it("does not push history while restoring a pane from browser history", async () => {
    const harness = setup();
    harness.net.handle("/?page=environment", () =>
      textResponse("<html>environment</html>")
    );
    harness.nav.parsed = () =>
      parsedPane("<section>environment</section>", "/?page=environment");

    harness.navigation.navigateTo(null, "/?page=environment", "none");
    await flushPromises();

    expect(harness.content.innerHTML).toContain("environment");
    expect(harness.nav.pushed).toEqual([]);
  });

  it("fences stale responses when abort support is unavailable", async () => {
    const harness = setup();
    harness.net.supportsAbort = false;
    const first = createDeferred<HttpResponse>();
    harness.net.handle("/?page=environment", () => first.promise);
    harness.net.handle("/?page=deploying", () =>
      textResponse("<html>deploying</html>")
    );
    harness.nav.parsed = (html) =>
      parsedPane(`<section>${html}</section>`, null);

    harness.navigation.navigateTo(null, "/?page=environment");
    harness.navigation.navigateTo(null, "/?page=deploying");
    await flushPromises();
    first.resolve(textResponse("<html>environment</html>"));
    await flushPromises();

    expect(harness.content.innerHTML).toContain("deploying");
    expect(harness.content.innerHTML).not.toContain("environment");
  });

  it.each([
    ["network rejection", () => Promise.reject(new Error("offline"))],
    ["non-success response", () => textResponse("no", false, 503)]
  ])("falls back to full navigation on %s", async (_label, response) => {
    const harness = setup();
    harness.net.handle("/?page=environment", response);

    harness.navigation.navigateTo(null, "/?page=environment");
    await flushPromises();

    expect(harness.content.getAttribute("aria-busy")).toBeNull();
    expect(harness.logger.errors).toHaveLength(1);
    expect(harness.nav.assigned).toEqual(["/?page=environment"]);
  });

  it("falls back when parsing or the shell-region contract fails", async () => {
    const harness = setup();
    let parses = 0;
    harness.net.handle("/?page=environment", () => textResponse("<html/>"));
    harness.nav.parsed = () => {
      parses += 1;
      if (parses === 1) throw new Error("bad html");
      return parsedPane(null, null);
    };

    harness.navigation.navigateTo(null, "/?page=environment");
    await flushPromises();
    harness.navigation.navigateTo(null, "/?page=environment");
    await flushPromises();

    expect(harness.nav.assigned).toEqual([
      "/?page=environment",
      "/?page=environment"
    ]);
  });

  it.each([
    [{ content: false }, "missing content"],
    [{ nav: false }, "missing navigation"]
  ])("falls back before fetching with $1", (options, _label) => {
    const harness = setup(options);

    harness.navigation.navigateTo(null, "/?page=environment");

    expect(harness.nav.assigned).toEqual(["/?page=environment"]);
    expect(harness.net.calls).toEqual([]);
    expect(harness.pageTeardowns).toBe(0);
  });

  it("cancels pending work and ignores a stale failure", async () => {
    const harness = setup();
    const first = createDeferred<HttpResponse>();
    harness.net.handle("/?page=environment", () => first.promise);
    harness.navigation.navigateTo(null, "/?page=environment");

    harness.navigation.cancelPendingWork();
    first.reject(new Error("stale"));
    await flushPromises();

    expect(harness.net.aborted).toBe(1);
    expect(harness.logger.errors).toEqual([]);
    expect(harness.nav.assigned).toEqual([]);
    expect(harness.pageTeardowns).toBe(2);
  });

  it("handles top-nav clicks without unloading and preserves modified clicks", () => {
    const harness = setup();
    const icon = createFakeElement("environment-icon", "span");
    icon.ancestors.set(PANE_NAVIGATION_TRIGGER_SELECTOR, harness.environments);
    const operationChip = createFakeElement("operation-chip", "a");
    operationChip.setAttribute("href", "/?page=environment");
    operationChip.ancestors.set(
      PANE_NAVIGATION_TRIGGER_SELECTOR,
      operationChip
    );
    const events = [
      clickEvent(icon),
      clickEvent(operationChip),
      clickEvent(icon, { button: 1 }),
      clickEvent(icon, { shiftKey: true }),
      clickEvent(icon, { altKey: true }),
      clickEvent(icon, { ctrlKey: true }),
      clickEvent(icon, { metaKey: true }),
      clickEvent(createFakeElement("orphan", "span")),
      clickEvent({})
    ];
    const navigateTo = vi.spyOn(harness.navigation, "navigateTo");
    initializePaneNavigation(harness.context, harness.navigation);

    for (const event of events) harness.document.dispatch("click", event);

    expect(navigateTo).toHaveBeenCalledTimes(2);
    expect(navigateTo).toHaveBeenNthCalledWith(
      1,
      events[0],
      "/?page=environment"
    );
    expect(navigateTo).toHaveBeenNthCalledWith(
      2,
      events[1],
      "/?page=environment"
    );
  });

  it.each([
    [null, null],
    ["", null],
    ["/?page=environment", "_blank"]
  ])("ignores unusable link href=%s target=%s", (href, target) => {
    const harness = setup();
    if (href === null) harness.environments.removeAttribute("href");
    else harness.environments.setAttribute("href", href);
    if (target !== null) harness.environments.setAttribute("target", target);
    const navigateTo = vi.spyOn(harness.navigation, "navigateTo");
    initializePaneNavigation(harness.context, harness.navigation);

    harness.document.dispatch("click", clickEvent(harness.environments));

    expect(navigateTo).not.toHaveBeenCalled();
  });

  it.each(["", "_self"])("accepts the same-context target %s", (target) => {
    const harness = setup();
    harness.environments.setAttribute("target", target);
    const navigateTo = vi.spyOn(harness.navigation, "navigateTo");
    initializePaneNavigation(harness.context, harness.navigation);

    harness.document.dispatch("click", clickEvent(harness.environments));

    expect(navigateTo).toHaveBeenCalledOnce();
  });

  it("handles history without pushing another entry", () => {
    const harness = setup();
    const navigateTo = vi.spyOn(harness.navigation, "navigateTo");
    initializePaneNavigation(harness.context, harness.navigation);

    for (const search of ["", "?page=deploying", "page=environment"]) {
      harness.nav.search = search;
      harness.page.dispatch("popstate");
    }

    expect(navigateTo.mock.calls).toEqual([
      [null, "/?page=graph", "none"],
      [null, "/?page=deploying", "none"],
      [null, "/?page=environment", "none"]
    ]);
  });

  it("binds once, tears down cleanly, and permits a rebind", () => {
    const harness = setup();
    const navigationTeardown = vi.spyOn(harness.navigation, "teardown");
    const teardown = initializePaneNavigation(
      harness.context,
      harness.navigation
    );
    const duplicate = initializePaneNavigation(
      harness.context,
      harness.navigation
    );

    expect(harness.document.listenerCount("click")).toBe(1);
    expect(harness.page.listenerCount("popstate")).toBe(1);
    duplicate();
    teardown();
    teardown();

    expect(navigationTeardown).toHaveBeenCalledOnce();
    expect(harness.document.listenerCount()).toBe(0);
    expect(harness.page.listenerCount()).toBe(0);

    initializePaneNavigation(harness.context, harness.navigation);
    expect(harness.document.listenerCount("click")).toBe(1);
  });
});
