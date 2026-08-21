import { isDomElement } from "./context.js";
import { activateInlineScripts } from "./dom.js";
import { GRAPH_PAGE_ATTRIBUTE } from "./graph/navigation.js";
import { beginEntry, NOOP_TEARDOWN } from "./lifecycle.js";
import type { BrowserTeardown } from "./lifecycle.js";
import type {
  AbortHandle,
  BrowserContext,
  DomDocument,
  DomElement,
  DomEvent
} from "./ports.js";
import type { PageRegistry } from "./registry.js";

export const PANE_NAVIGATION_ENTRY_KEY = "pane-navigation";
export const PANE_NAVIGATION_LINK_SELECTOR = ".rad-topnav__tab";
export const PANE_SUBTAB_SELECTOR = ".rad-subtab";
// Sub-tabs inside the swapped region are panes too, so they navigate the same
// way. Graph sub-tabs keep their own navigator, which swaps a smaller region,
// so they are excluded here rather than handled twice.
export const PANE_OWNED_SUBTAB_SELECTOR = `${PANE_SUBTAB_SELECTOR}:not([${GRAPH_PAGE_ATTRIBUTE}])`;
export const PANE_NAVIGATION_TRIGGER_SELECTOR = `${PANE_NAVIGATION_LINK_SELECTOR}, ${PANE_OWNED_SUBTAB_SELECTOR}, .rad-opchip`;
export const PANE_CONTENT_ID = "radius-main-content";
export const PANE_TOP_NAV_ID = "radius-topnav";
export const PANE_ACTIVE_CLASS = "rad-topnav__tab--active";
export const PANE_DEFAULT_PAGE = "graph";

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
  if (search === "") return `/?page=${PANE_DEFAULT_PAGE}`;
  return search.startsWith("?") ? `/${search}` : `/?${search}`;
}

// Pane identity is the `page` query parameter. Both sides of every comparison
// are ids this extension rendered or pushed itself, so they are matched as the
// literal tokens they were emitted as.
export function paneIdFromUrl(url: string): string {
  const start = url.indexOf("?");
  if (start === -1) return PANE_DEFAULT_PAGE;
  for (const part of url.slice(start + 1).split("&")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator) !== "page") continue;
    return part.slice(separator + 1);
  }
  return PANE_DEFAULT_PAGE;
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

function applyPaneTitle(context: BrowserContext, parsed: DomDocument): void {
  const incoming = parsed.querySelector("title");
  const current = context.dom.document.querySelector("title");
  if (!isDomElement(incoming) || !isDomElement(current)) return;
  current.textContent = incoming.textContent;
}

// Focus follows what the user activated. A trigger outside the swapped region
// survives the swap and keeps focus; one inside it is replaced, so the
// equivalent sub-tab in the incoming markup takes over. A history entry has no
// activated element, so the sub-tab matching the destination wins when the pane
// has one, which is what keeps Back out of a graph sub-tab from throwing focus
// up to the top navigation.
function paneFocusTarget(
  context: BrowserContext,
  content: DomElement,
  retained: DomElement | null,
  url: string,
  active: DomElement | null
): DomElement | null {
  if (retained !== null) return retained;
  const pane = paneIdFromUrl(url);
  for (const subtab of context.dom.all(content, PANE_SUBTAB_SELECTOR)) {
    const href = subtab.getAttribute("href");
    if (href !== null && paneIdFromUrl(href) === pane) return subtab;
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
  registry: Pick<
    PageRegistry,
    "teardownPage" | "beginNavigation" | "endNavigation"
  >
): PaneNavigation {
  let generation = 0;
  let request: AbortHandle | null = null;

  function settle(): void {
    const content = context.dom.byId(PANE_CONTENT_ID);
    content?.removeAttribute("aria-busy");
    content?.removeAttribute("inert");
    registry.endNavigation(cancelRequest);
  }

  function cancelRequest(): void {
    generation += 1;
    request?.abort();
    request = null;
    settle();
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

    // Resolved before the swap, while the activated element still knows where
    // it lives: only a trigger outside the replaced region survives it.
    const activated = event === null ? null : paneLinkFromEvent(event);
    const retained =
      activated !== null && activated.closest(`#${PANE_CONTENT_ID}`) === null ?
        activated
      : null;

    cancelPendingWork();
    registry.beginNavigation(cancelRequest);
    // The outgoing pane stays on screen for the whole fetch but its page-scoped
    // handlers are already gone, so it is made inert and visibly busy instead
    // of silently ignoring input.
    content.setAttribute("aria-busy", "true");
    content.setAttribute("inert", "");
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
        applyPaneTitle(context, parsed);
        settle();
        if (history === "push") context.nav.pushState(url);
        context.focus.focus(
          paneFocusTarget(context, content, retained, url, active)
        );
        request = null;
      })
      .catch((error: unknown) => {
        if (requestGeneration !== generation) return;
        request = null;
        settle();
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
    // Re-entering the pane already on screen would refetch it, discard its
    // in-page state, and push a history entry that appears to do nothing.
    if (
      paneIdFromUrl(href) === paneIdFromUrl(currentPaneUrl(context.nav.search))
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    navigation.navigateTo(event, href);
  });
  scope.on(context.page, "popstate", () => {
    navigation.navigateTo(null, currentPaneUrl(context.nav.search), "none");
  });
  scope.onTeardown(navigation.teardown);
  return () => scope.teardown();
}
