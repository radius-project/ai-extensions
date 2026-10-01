// The node details panel's renderer (BU-06).
//
// `buildDetailRows` decides which rows a node offers; this module is the single
// place that turns them into elements. It is an ordinary controlled component:
// React owns the panel element, its rows and its handlers, so an open panel
// survives a host re-render and a row's destination lives in a closure rather
// than in a data attribute that page script could rewrite.
//
import { createElement as h } from "react";
import type { MouseEvent, ReactElement, ReactNode } from "react";
import type { DetailIcon, DetailRow } from "./details.js";

// Monochrome octicon glyphs (currentColor) so links match the flat white-card
// node styling instead of a coloured emoji.
const ICON_PATHS: Readonly<Record<DetailIcon, string>> = {
  definition:
    "M2 4a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4Zm0 4a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8Zm.75 3.25a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H2.75Z",
  link: "M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z",
  source:
    "m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z"
};

function icon(name: DetailIcon): ReactElement {
  return h(
    "svg",
    {
      width: 14,
      height: 14,
      viewBox: "0 0 16 16",
      fill: "currentColor",
      "aria-hidden": true,
      "data-radius-part": "details-icon"
    },
    h("path", { d: ICON_PATHS[name] })
  );
}

function subtitle(text: string): ReactElement {
  return h("div", { "data-radius-part": "details-subtitle" }, text);
}

export interface DetailsOverlayProps {
  /** Unique per graph instance so two graphs on one page never collide. */
  id: string;
  rows: readonly DetailRow[];
  open: boolean;
  left: number;
  top: number;
  /** Opens a validated destination through the host rather than navigating. */
  onOpenExternal?(url: string): void;
  /** Opens a file in the host's checkout, with a remote URL to fall back to. */
  onOpenLocalSource?(path: string, line: number, fallbackUrl: string): void;
}

function renderRow(
  row: DetailRow,
  key: number,
  props: DetailsOverlayProps
): ReactNode {
  switch (row.kind) {
    case "summary":
      return h(
        "dl",
        { key, "data-radius-part": "details-summary" },
        h("dt", null, "Resource"),
        h("dd", null, row.name),
        h("dt", null, "Type"),
        h("dd", null, row.type)
      );
    case "status":
      return h(
        "div",
        { key, "data-radius-part": "details-status" },
        `Provisioning status: ${row.state}`
      );
    case "concrete":
      return h(
        "div",
        { key, "data-radius-part": "details-concrete" },
        h("div", { "data-radius-part": "details-label" }, "Concrete type"),
        h("div", { "data-radius-part": "details-value" }, row.type)
      );
    case "message":
      return h(
        "div",
        {
          key,
          "data-radius-part": "details-message",
          "data-radius-failure": row.failure
        },
        row.text
      );
    case "inert":
      return h(
        "div",
        { key, "data-radius-part": "details-row" },
        h(
          "span",
          { "aria-disabled": "true", "data-radius-part": "details-link" },
          icon(row.icon),
          h("span", null, row.label)
        )
      );
    case "external":
      return h(
        "div",
        { key, "data-radius-part": "details-row" },
        h(
          "a",
          {
            href: row.href,
            target: "_blank",
            rel: "noopener noreferrer",
            "data-radius-part": "details-link",
            onClick: (event: MouseEvent) => {
              // Without a host capability the anchor stays a real link, which
              // is what a plain web host wants.
              if (!props.onOpenExternal) return;
              event.preventDefault();
              props.onOpenExternal(row.href);
            }
          },
          icon(row.icon),
          h("span", null, row.label)
        ),
        row.showUrl ? subtitle(row.href) : null
      );
    case "local":
      return h(
        "div",
        { key, "data-radius-part": "details-row" },
        h(
          "a",
          {
            // The remote fallback is also the href so the row stays a real
            // link: copyable, and usable when the host cannot open files.
            href: row.fallbackUrl || "#",
            "data-radius-part": "details-link",
            onClick: (event: MouseEvent) => {
              if (!props.onOpenLocalSource) return;
              event.preventDefault();
              props.onOpenLocalSource(row.path, row.line, row.fallbackUrl);
            }
          },
          icon(row.icon),
          h("span", null, row.label)
        ),
        subtitle(row.path + (row.line ? ":" + row.line : ""))
      );
    default:
      return h(
        "div",
        { key, "data-radius-part": "details-empty" },
        "No links available."
      );
  }
}

/**
 * The details panel for the node a user opened, anchored inside the graph's
 * drawing area. It stays mounted while closed so a host can style or query it,
 * and so reopening it does not replace the element.
 */
export function DetailsOverlay(props: DetailsOverlayProps): ReactElement {
  return h(
    "div",
    {
      id: props.id,
      "data-radius-details": "",
      "data-radius-part": "details",
      style: {
        left: props.left,
        top: props.top,
        display: props.open ? undefined : "none"
      }
    },
    props.open ?
      props.rows.map((row, index) => renderRow(row, index, props))
    : null
  );
}
