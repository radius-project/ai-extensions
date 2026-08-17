import { isDomElement } from "../context.js";
import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import type { BrowserTeardown } from "../lifecycle.js";
import type {
  AbortHandle,
  BrowserContext,
  DomElement,
  DomEvent
} from "../ports.js";
import type { PageRegistry } from "../registry.js";

export const GRAPH_CONTENT_ID = "graph-page-content";
export const GRAPH_NAV_ID = "graph-nav";
export const GRAPH_PAGE_ATTRIBUTE = "data-radius-graph-page";
export const GRAPH_PAGES = [
  "graph",
  "planned",
  "graph-diff",
  "deployed"
] as const;

export type GraphPageId = (typeof GRAPH_PAGES)[number];
export type NavigationHistory = "push" | "none";

const NAVIGATION_ENTRY_KEY = "graph-navigation";

export interface NavigationEvent {
  preventDefault(): void;
}

function isGraphPage(value: string): value is GraphPageId {
  return GRAPH_PAGES.some((page) => page === value);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

export function graphPageUrl(search: string, pageId: GraphPageId): string {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const retained = query
    .split("&")
    .filter(Boolean)
    .filter((part) => decode(part.split("=", 1)[0]) !== "page");
  return `?page=${encodeURIComponent(pageId)}${
    retained.length > 0 ? `&${retained.join("&")}` : ""
  }`;
}

function currentPage(search: string): GraphPageId | null {
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const part of query.split("&")) {
    if (!part) continue;
    const separator = part.indexOf("=");
    const key = decode(separator < 0 ? part : part.slice(0, separator));
    if (key !== "page") continue;
    const value = decode(separator < 0 ? "" : part.slice(separator + 1));
    return isGraphPage(value) ? value : null;
  }
  return "graph";
}

function runInlineScripts(context: BrowserContext, root: DomElement): void {
  for (const stale of context.dom.all(root, "script")) {
    const parent = stale.parentNode;
    if (!parent) continue;
    const next = context.dom.createElement("script");
    const src = stale.getAttribute("src");
    if (src) next.setAttribute("src", src);
    else next.textContent = stale.textContent;
    parent.replaceChild(next, stale);
  }
}

export interface GraphNavigation {
  navigateTo(
    event: NavigationEvent | null,
    pageId: GraphPageId,
    history?: NavigationHistory
  ): void;
  cancelPendingWork(): void;
  teardown(): void;
}

export function createGraphNavigation(
  context: BrowserContext,
  registry: Pick<PageRegistry, "teardownPage">
): GraphNavigation {
  let generation = 0;
  let request: AbortHandle | null = null;

  function cancelRequest(): void {
    generation++;
    request?.abort();
    request = null;
  }

  function cancelPendingWork(): void {
    cancelRequest();
    registry.teardownPage();
  }

  function navigateTo(
    event: NavigationEvent | null,
    pageId: GraphPageId,
    history: NavigationHistory = "push"
  ): void {
    event?.preventDefault();
    const url = graphPageUrl(context.nav.search, pageId);
    const content = context.dom.byId(GRAPH_CONTENT_ID);
    if (!content) {
      context.nav.assign(url);
      return;
    }

    cancelRequest();
    const requestGeneration = generation;
    request = context.net.createAbort();
    void context.net
      .fetch(`/${url}`, request ? { signal: request.signal } : undefined)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Graph page request failed with ${response.status}.`);
        }
        return response.text();
      })
      .then((html) => {
        if (requestGeneration !== generation) return;
        const parsed = context.nav.parseDocument(html);
        const newContentValue = parsed.getElementById(GRAPH_CONTENT_ID);
        if (!isDomElement(newContentValue)) {
          throw new Error("Graph page response had no content region.");
        }
        const newNavValue = parsed.getElementById(GRAPH_NAV_ID);
        registry.teardownPage();
        content.innerHTML = newContentValue.innerHTML;
        runInlineScripts(context, content);
        if (isDomElement(newNavValue)) {
          const nav = context.dom.byId(GRAPH_NAV_ID);
          if (nav) nav.innerHTML = newNavValue.innerHTML;
        }
        if (history === "push") context.nav.pushState(url);
        const active = context.dom.document.querySelector(
          `#${GRAPH_NAV_ID} [${GRAPH_PAGE_ATTRIBUTE}="${pageId}"]`
        );
        context.focus.focus(isDomElement(active) ? active : null);
        request = null;
      })
      .catch((error: unknown) => {
        if (requestGeneration !== generation) return;
        request = null;
        context.logger.error("Radius graph navigation failed.", error);
        context.nav.assign(url);
      });
  }

  return {
    navigateTo,
    cancelPendingWork,
    teardown: cancelRequest
  };
}

function graphLinkFromEvent(event: DomEvent): {
  link: DomElement;
  page: GraphPageId;
} | null {
  if (!isDomElement(event.target)) return null;
  const link = event.target.closest(`[${GRAPH_PAGE_ATTRIBUTE}]`);
  if (!link) return null;
  const page = link.getAttribute(GRAPH_PAGE_ATTRIBUTE) ?? "";
  return isGraphPage(page) ? { link, page } : null;
}

export function initializeGraphNavigation(
  context: BrowserContext,
  navigation: GraphNavigation
): BrowserTeardown {
  const scope = beginEntry(context, NAVIGATION_ENTRY_KEY);
  if (!scope) return NOOP_TEARDOWN;
  scope.on(context.dom.document, "click", (event) => {
    const target = graphLinkFromEvent(event);
    if (!target) return;
    navigation.navigateTo(event, target.page, "push");
  });
  scope.on(context.page, "popstate", () => {
    const page = currentPage(context.nav.search);
    if (page) navigation.navigateTo(null, page, "none");
  });
  scope.onTeardown(navigation.teardown);
  return () => scope.teardown();
}
