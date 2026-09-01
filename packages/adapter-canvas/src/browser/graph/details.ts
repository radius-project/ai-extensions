// Canvas adapter — the node details panel (BU-06).
//
// Clicking a node card opens a small panel of links beside it: the resource's
// source file, the app definition, a live portal resource, and the producer's
// status message when a deployment failed. The rows are built as escaped markup
// by pure functions, and the panel itself owns exactly one delegated click
// listener per container so re-rendering a graph can never stack handlers.

import { escapeBrowserHtml } from "../html.js";
import { safeExternalUrl } from "../external-url.js";
import { buildSourceUrl, githubSourceReferenceUrl } from "./model.js";
import { isLocalSourceNode } from "./build.js";
import type { BrowserContext, DomElement } from "../ports.js";
import type { GraphNodeData, GraphSettings } from "./build.js";

// Monochrome octicon glyphs (currentColor) so links match the flat white-card
// node styling instead of a coloured emoji.
export const ICON_DEF =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex:none;"><path d="M2 4a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4Zm0 4a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8Zm.75 3.25a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H2.75Z"></path></svg>';
export const ICON_LINK =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex:none;"><path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"></path></svg>';
export const ICON_SRC =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex:none;"><path d="m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z"></path></svg>';

export const PANEL_ID = "node-popup";
export const PANEL_STYLE =
  "display:none; position:absolute; z-index:1000; background:var(--rad-surface); color:var(--rad-text); border:1px solid var(--rad-stroke); border-radius:8px; padding:6px 8px; box-shadow:0 4px 12px var(--rad-shadow); font-size:13px; min-width:220px; max-width:380px; font-family:var(--rad-font);";

const SUBTITLE_STYLE =
  "color:var(--rad-text-tertiary); font-size:11px; margin-top:2px; margin-left:20px; word-break:break-all;";
const LINK_STYLE =
  "color:var(--rad-link); text-decoration:none; font-weight:500; display:flex; align-items:center; gap:6px; font-size:13px;";

// Every external row built here, including source, app-definition, portal, and
// cloud-output links, carries delegated metadata so the Canvas host opens it.
// The target URL is optionally shown as a muted subtitle beneath.
export function linkRow(
  iconSvg: string,
  label: string,
  href: string,
  showUrl: boolean
): string {
  const safeHref = safeExternalUrl(href);
  if (!safeHref) {
    return (
      '<div style="padding:6px 4px;">' +
      `<span aria-disabled="true" style="${LINK_STYLE}">${iconSvg}<span>${escapeBrowserHtml(label)}</span></span></div>`
    );
  }
  const sub =
    showUrl ?
      `<div style="${SUBTITLE_STYLE}">${escapeBrowserHtml(safeHref)}</div>`
    : "";
  return (
    '<div style="padding:6px 4px;">' +
    `<a href="${escapeBrowserHtml(safeHref)}" data-external-url="${escapeBrowserHtml(safeHref)}" target="_blank" rel="noopener noreferrer" style="${LINK_STYLE}">` +
    iconSvg +
    `<span>${escapeBrowserHtml(label)}</span></a>${sub}</div>`
  );
}

// Re-exported so this panel's existing importers keep one import site while the
// deploy chip, which cannot pull in the graph modules this file depends on,
// shares the same definition.
export { safeExternalUrl };

// A local link row: same look as linkRow, but opens an on-disk worktree file in
// the editor canvas instead of navigating. The repo-relative path/line and a
// GitHub fallback URL ride on data attributes; the container click delegation
// reads them and opens the local file, falling back to the GitHub URL when the
// file is not on this checkout. The fallback URL is also the anchor href so the
// row stays a real link (copyable, right-clickable).
export function localLinkRow(
  iconSvg: string,
  label: string,
  relPath: string,
  line: number,
  fallbackUrl: string
): string {
  const safeFallback = safeExternalUrl(fallbackUrl);
  const subText = escapeBrowserHtml(relPath) + (line ? ":" + line : "");
  const sub = `<div style="${SUBTITLE_STYLE}">${subText}</div>`;
  return (
    '<div style="padding:6px 4px;">' +
    `<a href="${escapeBrowserHtml(safeFallback || "#")}" data-local-src="${escapeBrowserHtml(relPath)}" data-local-line="${line || 0}" data-fallback-url="${escapeBrowserHtml(safeFallback)}" style="${LINK_STYLE}">` +
    iconSvg +
    `<span>${escapeBrowserHtml(label)}</span></a>${sub}</div>`
  );
}

export function azurePortalUrl(armId: string): string {
  return `https://portal.azure.com/#@/resource${encodeURI(armId)}/overview`;
}

function definitionUrl(settings: GraphSettings, data: GraphNodeData): string {
  return buildSourceUrl(
    settings.repoUrl,
    data.sourceBranch || settings.branch,
    `${data.defFile}${data.defLine ? `#L${data.defLine}` : ""}`
  );
}

function cloudRows(data: GraphNodeData): string[] {
  if (!data.cloudResources) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.cloudResources);
  } catch {
    // A node whose serialized cloud list is unusable still shows every other
    // link rather than losing the panel.
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as {
      name?: unknown;
      type?: unknown;
      id?: unknown;
      portalUrl?: unknown;
    };
    const name = typeof record.name === "string" ? record.name : "";
    const type = typeof record.type === "string" ? record.type : "";
    const id = typeof record.id === "string" ? record.id : "";
    if (!id.startsWith("/subscriptions/")) continue;
    const producerUrl =
      typeof record.portalUrl === "string" ?
        safeExternalUrl(record.portalUrl)
      : "";
    const label =
      name || (type ? type.split("/").pop() || "" : "") || "resource";
    rows.push(
      linkRow(
        ICON_LINK,
        label + " in Azure portal",
        producerUrl || azurePortalUrl(id),
        false
      )
    );
  }
  return rows;
}

// The complete panel body for a node, in display order. Pure, so the whole link
// matrix — local versus remote, definition, portal, cloud outputs, and the
// failure message that must lead — is asserted without a DOM.
export function buildDetailRows(
  settings: GraphSettings,
  data: GraphNodeData
): string[] {
  const rows: string[] = [];
  if (isLocalSourceNode(settings, data)) {
    if (data.srcPath) {
      rows.push(
        localLinkRow(
          ICON_SRC,
          "View source code",
          data.srcPath,
          data.srcLine,
          data.sourceUrl
        )
      );
    } else if (githubSourceReferenceUrl(data.codeRef) && data.sourceUrl) {
      rows.push(linkRow(ICON_SRC, "View source code", data.sourceUrl, true));
    }
    if (data.defFile) {
      rows.push(
        localLinkRow(
          ICON_DEF,
          "View app definition",
          data.defFile,
          data.defLine,
          definitionUrl(settings, data)
        )
      );
    }
  } else {
    if (data.sourceUrl) {
      rows.push(linkRow(ICON_SRC, "View source code", data.sourceUrl, true));
    }
    if (settings.repoUrl && data.defFile) {
      rows.push(
        linkRow(
          ICON_DEF,
          "View app definition",
          definitionUrl(settings, data),
          true
        )
      );
    }
  }
  // The producer's status message for this resource leads when a deploy failed:
  // the reason is what the user opened the panel for. Rendered as escaped text,
  // never as markup.
  if (data.deployMessage) {
    const failure = data.deployStatus === "failed";
    rows.unshift(
      '<div style="padding:6px 4px; font-size:12px; line-height:1.5; color:' +
        (failure ? "var(--rad-danger,#cf222e)" : "var(--rad-text-secondary)") +
        '; border-bottom:1px solid var(--rad-stroke,#d1d9e0); margin-bottom:4px; word-break:break-word;">' +
        escapeBrowserHtml(data.deployMessage) +
        "</div>"
    );
  }
  if (safeExternalUrl(data.portalUrl)) {
    rows.push(linkRow(ICON_LINK, "View in portal", data.portalUrl, false));
  }
  if (data.cloudId) {
    rows.push(
      linkRow(
        ICON_LINK,
        "View in Azure portal",
        azurePortalUrl(data.cloudId),
        false
      )
    );
  }
  rows.push(...cloudRows(data));
  if (rows.length === 0) {
    rows.push(
      '<div style="padding:6px 4px; color:var(--rad-text-tertiary); font-size:12px;">No links available.</div>'
    );
  }
  return rows;
}

export interface ElementRect {
  left: number;
  right: number;
  top: number;
  width: number;
}

function isRect(value: unknown): value is ElementRect {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Record<string, unknown>;
  return (
    typeof rect.left === "number" &&
    typeof rect.right === "number" &&
    typeof rect.top === "number" &&
    typeof rect.width === "number"
  );
}

// Layout measurement is the one capability the shared DOM port deliberately
// does not carry, so it is read here through a guard: an element that cannot be
// measured positions the panel at the container's origin instead of throwing.
export function rectOf(element: unknown): ElementRect | null {
  if (typeof element !== "object" || element === null) return null;
  const measure = (element as { getBoundingClientRect?: unknown })
    .getBoundingClientRect;
  if (typeof measure !== "function") return null;
  const rect: unknown = measure.call(element);
  return isRect(rect) ? rect : null;
}

export interface PanelPosition {
  left: number;
  top: number;
}

const PANEL_WIDTH = 240;
const PANEL_FLIP_OFFSET = 232;

// Anchor the panel to the right of the card, flipping to its left when there is
// no room inside the container.
export function panelPosition(
  container: ElementRect,
  card: ElementRect
): PanelPosition {
  let left = card.right - container.left + 8;
  const top = card.top - container.top;
  if (left + PANEL_WIDTH > container.width) {
    left = Math.max(4, card.left - container.left - PANEL_FLIP_OFFSET);
  }
  return { left: Math.max(0, left), top: Math.max(0, top) };
}

export interface DetailsPanel {
  open(data: GraphNodeData, card: DomElement): void;
  close(): void;
  toggle(data: GraphNodeData, card: DomElement): void;
  readonly isOpen: boolean;
  destroy(): void;
}

export interface DetailsPanelDeps {
  // Opens a validated external URL through the Canvas host rather than relying
  // on native navigation inside the webview.
  openExternal(url: string): void;
  // Opens a repo-relative worktree file in the editor canvas, falling back to
  // the file's remote URL. Supplied by the renderer so the panel does not own a
  // network policy of its own.
  openLocalSource(relPath: string, line: number, fallbackUrl: string): void;
}

// Wire a details panel to a graph container. Exactly one click listener is
// registered; destroy() removes it, so a second render on the same container
// replaces rather than stacks handlers.
export function createDetailsPanel(
  context: BrowserContext,
  container: DomElement,
  settings: GraphSettings,
  deps: DetailsPanelDeps
): DetailsPanel {
  const panel = context.dom.createElement("div");
  panel.id = PANEL_ID;
  panel.setAttribute("style", PANEL_STYLE);
  panel.style.display = "none";
  container.appendChild(panel);

  let openCard: DomElement | null = null;
  let restoreFocusTo: DomElement | null = null;

  function open(data: GraphNodeData, card: DomElement): void {
    if (!data) return;
    panel.innerHTML = buildDetailRows(settings, data).join("");
    const containerRect = rectOf(container);
    const cardRect = rectOf(card);
    const position =
      containerRect && cardRect ?
        panelPosition(containerRect, cardRect)
      : { left: 0, top: 0 };
    panel.style.left = position.left + "px";
    panel.style.top = position.top + "px";
    panel.style.display = "";
    if (openCard === null) {
      restoreFocusTo = context.focus.active();
    }
    openCard = card;
  }

  function close(): void {
    panel.style.display = "none";
    openCard = null;
    // Return focus where it was before the panel took it, so keyboard users are
    // not dropped at the top of the document.
    const restore = restoreFocusTo;
    restoreFocusTo = null;
    context.focus.focus(restore);
  }

  // Delegate clicks from the node cards. Every validated external row is routed
  // through the Canvas host; local source rows open the editor canvas. Clicking
  // the empty pane closes the panel.
  const onClick = (event: {
    target?: unknown;
    preventDefault(): void;
  }): void => {
    const target = event.target;
    const closest =
      typeof target === "object" && target !== null ?
        (target as { closest?: unknown }).closest
      : undefined;
    if (typeof closest !== "function") return;
    const find = (selector: string): unknown => closest.call(target, selector);
    const localEl = find("[data-local-src]");
    if (localEl !== null && localEl !== undefined) {
      event.preventDefault();
      const element = localEl as DomElement;
      deps.openLocalSource(
        element.getAttribute("data-local-src") ?? "",
        parseInt(element.getAttribute("data-local-line") ?? "", 10) || 0,
        element.getAttribute("data-fallback-url") ?? ""
      );
      return;
    }
    const externalEl = find("[data-external-url]");
    if (externalEl !== null && externalEl !== undefined) {
      event.preventDefault();
      // linkRow emits this attribute only for a validated URL. Validate again
      // because a caller or browser extension can still mutate the DOM.
      const url = safeExternalUrl(
        (externalEl as DomElement).getAttribute("data-external-url") ?? ""
      );
      if (url) deps.openExternal(url);
      return;
    }
    if (find("#" + PANEL_ID)) return;
    if (find(".rad-node[data-node-id]")) return;
    close();
  };

  container.addEventListener("click", onClick);

  return {
    open,
    close,
    toggle(data, card) {
      // Clicking the same card's "…" button again closes the panel; a different
      // card re-anchors it.
      if (panel.style.display !== "none" && openCard === card) close();
      else open(data, card);
    },
    get isOpen() {
      return panel.style.display !== "none";
    },
    destroy() {
      container.removeEventListener("click", onClick);
      panel.remove();
      openCard = null;
      restoreFocusTo = null;
    }
  };
}
