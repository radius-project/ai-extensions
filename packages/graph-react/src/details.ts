// The node details panel's data model (BU-06).
//
// Clicking a node card opens a small panel of links beside it: the resource's
// source file, the app definition, a live portal resource, and the producer's
// status message when a deployment failed. This module decides *which* rows a
// node offers and where the panel is anchored. It is deliberately free of
// React, markup and the DOM: a row is a plain description, and `DetailsOverlay`
// in `details-panel.ts` is the single place that turns one into elements.
//
// Rows carry raw text, never markup. Escaping belongs to the renderer, so a
// resource name from a provider cannot become markup no matter how it is used.

import { safeExternalUrl } from "./external-url.js";
import { buildSourceUrl, githubSourceReferenceUrl } from "./model.js";
import { isLocalSourceNode } from "./build.js";
import type { GraphNodeData, GraphSettings } from "./build.js";

/** Which monochrome octicon a link row leads with. */
export type DetailIcon = "definition" | "link" | "source";

export type DetailRow =
  /** The resource's name and type, shown for a live graph. */
  | { readonly kind: "summary"; readonly name: string; readonly type: string }
  /** The live provisioning state reported by the control plane. */
  | { readonly kind: "status"; readonly state: string }
  /** The concrete resource type a recipe resolved to, as secondary detail. */
  | { readonly kind: "concrete"; readonly type: string }
  /** The producer's message for this resource, leading on a failure. */
  | {
      readonly kind: "message";
      readonly text: string;
      readonly failure: boolean;
    }
  /** A destination outside the app, opened through the host when it offers to. */
  | {
      readonly kind: "external";
      readonly icon: DetailIcon;
      readonly label: string;
      readonly href: string;
      readonly showUrl: boolean;
    }
  /** A destination that failed URL validation: shown, but not actionable. */
  | {
      readonly kind: "inert";
      readonly icon: DetailIcon;
      readonly label: string;
    }
  /** A file in the host's checkout, with a remote URL to fall back to. */
  | {
      readonly kind: "local";
      readonly icon: DetailIcon;
      readonly label: string;
      readonly path: string;
      readonly line: number;
      readonly fallbackUrl: string;
    }
  /** Stands in for an empty panel so it never opens blank. */
  | { readonly kind: "empty" };

// Re-exported so this panel's existing importers keep one import site while the
// deploy chip, which cannot pull in the graph modules this file depends on,
// shares the same definition.
export { safeExternalUrl };

// A destination is validated once, here. A row that survives validation is
// always safe to render as a link, and one that does not is rendered inert
// rather than dropped, so the panel still says what it could not offer.
function externalRow(
  icon: DetailIcon,
  label: string,
  href: string,
  showUrl: boolean
): DetailRow {
  const safeHref = safeExternalUrl(href);
  if (!safeHref) return { kind: "inert", icon, label };
  return { kind: "external", icon, label, href: safeHref, showUrl };
}

// A local row opens an on-disk file in the host instead of navigating. The
// fallback URL is validated the same way, because it is also the anchor's href
// and is used when the file is not on this checkout.
function localRow(
  icon: DetailIcon,
  label: string,
  path: string,
  line: number,
  fallbackUrl: string
): DetailRow {
  return {
    kind: "local",
    icon,
    label,
    path,
    line,
    fallbackUrl: safeExternalUrl(fallbackUrl)
  };
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

function cloudRows(data: GraphNodeData): DetailRow[] {
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
  const rows: DetailRow[] = [];
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
      externalRow(
        "link",
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
): DetailRow[] {
  const rows: DetailRow[] = [];
  if (settings.liveMode) {
    rows.push({
      kind: "summary",
      name: data.nodeName,
      type: data.resourceType
    });
    if (data.provisioningState !== undefined) {
      rows.push({ kind: "status", state: data.provisioningState });
    }
  }
  if (data.concreteType) {
    rows.push({ kind: "concrete", type: data.concreteType });
  }
  if (isLocalSourceNode(settings, data)) {
    if (data.srcPath) {
      rows.push(
        localRow(
          "source",
          "View source code",
          data.srcPath,
          data.srcLine,
          data.sourceUrl
        )
      );
    } else if (githubSourceReferenceUrl(data.codeRef) && data.sourceUrl) {
      rows.push(
        externalRow("source", "View source code", data.sourceUrl, true)
      );
    }
    if (data.defFile) {
      rows.push(
        localRow(
          "definition",
          "View app definition",
          data.defFile,
          data.defLine,
          definitionUrl(settings, data)
        )
      );
    }
  } else {
    if (data.sourceUrl) {
      rows.push(
        externalRow("source", "View source code", data.sourceUrl, true)
      );
    }
    if (settings.repoUrl && data.defFile) {
      rows.push(
        externalRow(
          "definition",
          "View app definition",
          definitionUrl(settings, data),
          true
        )
      );
    }
  }
  // The producer's status message for this resource leads when a deploy failed:
  // the reason is what the user opened the panel for.
  if (data.deployMessage) {
    rows.unshift({
      kind: "message",
      text: data.deployMessage,
      failure: data.deployStatus === "failed"
    });
  }
  if (safeExternalUrl(data.portalUrl)) {
    rows.push(externalRow("link", "View in portal", data.portalUrl, false));
  }
  if (data.cloudId) {
    rows.push(
      externalRow(
        "link",
        "View in Azure portal",
        azurePortalUrl(data.cloudId),
        false
      )
    );
  }
  rows.push(...cloudRows(data));
  if (rows.length === 0) rows.push({ kind: "empty" });
  return rows;
}

/** Anything the panel can hand focus back to when it closes. */
export interface FocusTarget {
  focus(): void;
}

// Duck-typed rather than checked against `HTMLElement` so this file stays free
// of DOM globals, and so a document that reports nothing focused — or reports
// something that cannot take focus — still closes the panel cleanly.
export function focusReturnTarget(active: unknown): FocusTarget | null {
  if (typeof active !== "object" || active === null) return null;
  const focus = (active as { focus?: unknown }).focus;
  return typeof focus === "function" ? (active as FocusTarget) : null;
}

/**
 * Whether a click on `target` inside the drawing area dismisses the panel.
 * Clicking the panel keeps it open, a card is that card's own business, and
 * anything else — empty canvas, controls, legend — closes it.
 */
export function closesDetails(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== "function") return false;
  if (closest.call(target, "[data-radius-details]")) return false;
  return !closest.call(target, ".rad-node[data-node-id]");
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

// Layout measurement is read through a guard rather than a DOM type, so a
// element that cannot be measured positions the panel at the container's origin
// instead of throwing.
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

// Where the panel sits for a card, in container coordinates. Anything that
// cannot be measured yet anchors at the container origin.
export function anchorPosition(
  container: unknown,
  card: unknown
): PanelPosition {
  const containerRect = rectOf(container);
  const cardRect = rectOf(card);
  return containerRect && cardRect ?
      panelPosition(containerRect, cardRect)
    : { left: 0, top: 0 };
}
