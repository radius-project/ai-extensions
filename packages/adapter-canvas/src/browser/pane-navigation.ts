import { isDomElement } from "./context.js";
import { activateInlineScripts } from "./dom.js";
import { beginEntry, NOOP_TEARDOWN } from "./lifecycle.js";
import type { BrowserTeardown } from "./lifecycle.js";
import type {
  AbortHandle,
  BrowserContext,
  DomElement,
  DomEvent
} from "./ports.js";
import type { PageRegistry } from "./registry.js";

export const PANE_NAVIGATION_ENTRY_KEY = "pane-navigation";
export const PANE_NAVIGATION_LINK_SELECTOR = ".rad-topnav__tab";
export const PANE_NAVIGATION_TRIGGER_SELECTOR = `${PANE_NAVIGATION_LINK_SELECTOR}, .rad-opchip`;
export const PANE_CONTENT_ID = "radius-main-content";
export const PANE_TOP_NAV_ID = "radius-topnav";
export const PANE_ACTIVE_CLASS = "rad-topnav__tab--active";

export type PaneNavigationHistory = "push" | "none";

function isModifiedActivation(event: DomEvent): boolean {
  return (
    (event.button !== undefined && event.button !== 0) ||
    event.shiftKey === true ||
    event.altKey === true ||
    event.ctrlKey === true ||
    event.metaKey === true
  );
}

function paneLinkFromEvent(event: DomEvent): DomElement | null {
  if (!isDomElement(event.target) || isModifiedActivation(event)) return null;
  const link = event.target.closest(PANE_NAVIGATION_TRIGGER_SELECTOR);
  if (link === null) return null;
  const target = link.getAttribute("target");
  return target === null || target === "" || target === "_self" ? link : null;
}

function currentPaneUrl(search: string): string {
  if (search === "") return "/?page=graph";
  return search.startsWith("?") ? `/${search}` : `/?${search}`;
}

function updateActivePane(
  context: BrowserContext,
  currentNav: DomElement,
  incomingNav: DomElement
): DomElement | null {
  const incomingActive = incomingNav.querySelector(`.${PANE_ACTIVE_CLASS}`);
  const activeHref =
    incomingActive === null ? null : incomingActive.getAttribute("href");
  let active: DomElement | null = null;
  for (const link of context.dom.all(
    currentNav,
    PANE_NAVIGATION_LINK_SELECTOR
  )) {
    const selected =
      activeHref !== null && link.getAttribute("href") === activeHref;
    link.classList.toggle(PANE_ACTIVE_CLASS, selected);
    if (selected) active = link;
  }
  return active;
}

export interface PaneNavigation {
  navigateTo(
    event: DomEvent | null,
    url: string,
    history?: PaneNavigationHistory
  ): void;
  cancelPendingWork(): void;
  teardown(): void;
}

export function createPaneNavigation(
  context: BrowserContext,
  registry: Pick<PageRegistry, "teardownPage" | "beginNavigation">
): PaneNavigation {
  let generation = 0;
  let request: AbortHandle | null = null;

  function cancelRequest(): void {
    generation += 1;
    request?.abort();
    request = null;
    context.dom.byId(PANE_CONTENT_ID)?.removeAttribute("aria-busy");
  }

  function cancelPendingWork(): void {
    cancelRequest();
    registry.teardownPage();
  }

  function navigateTo(
    event: DomEvent | null,
    url: string,
    history: PaneNavigationHistory = "push"
  ): void {
    event?.preventDefault();
    event?.stopPropagation();
    const content = context.dom.byId(PANE_CONTENT_ID);
    const topNav = context.dom.byId(PANE_TOP_NAV_ID);
    if (content === null || topNav === null) {
      context.nav.assign(url);
      return;
    }

    cancelPendingWork();
    registry.beginNavigation(cancelRequest);
    content.setAttribute("aria-busy", "true");
    const requestGeneration = generation;
    request = context.net.createAbort();
    void context.net
      .fetch(url, request === null ? undefined : { signal: request.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Pane request failed with ${response.status}.`);
        }
        return response.text();
      })
      .then((html) => {
        if (requestGeneration !== generation) return;
        const parsed = context.nav.parseDocument(html);
        const incomingContent = parsed.getElementById(PANE_CONTENT_ID);
        const incomingNav = parsed.getElementById(PANE_TOP_NAV_ID);
        if (!isDomElement(incomingContent) || !isDomElement(incomingNav)) {
          throw new Error("Pane response had no shell regions.");
        }
        content.innerHTML = incomingContent.innerHTML;
        activateInlineScripts(context, content);
        const active = updateActivePane(context, topNav, incomingNav);
        content.removeAttribute("aria-busy");
        if (history === "push") context.nav.pushState(url);
        context.focus.focus(active);
        request = null;
      })
      .catch((error: unknown) => {
        if (requestGeneration !== generation) return;
        request = null;
        content.removeAttribute("aria-busy");
        context.logger.error("Radius pane navigation failed.", error);
        context.nav.assign(url);
      });
  }

  return {
    navigateTo,
    cancelPendingWork,
    teardown: cancelRequest
  };
}

export function initializePaneNavigation(
  context: BrowserContext,
  navigation: PaneNavigation
): BrowserTeardown {
  const scope = beginEntry(context, PANE_NAVIGATION_ENTRY_KEY);
  if (scope === null) return NOOP_TEARDOWN;
  scope.on(context.dom.document, "click", (event) => {
    const link = paneLinkFromEvent(event);
    const href = link?.getAttribute("href");
    if (href === null || href === undefined || href === "") return;
    navigation.navigateTo(event, href);
  });
  scope.on(context.page, "popstate", () => {
    navigation.navigateTo(null, currentPaneUrl(context.nav.search), "none");
  });
  scope.onTeardown(navigation.teardown);
  return () => scope.teardown();
}
