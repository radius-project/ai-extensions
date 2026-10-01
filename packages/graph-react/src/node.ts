import {
  createContext,
  createElement as h,
  useContext,
  useLayoutEffect,
  useRef
} from "react";
import { Handle, Position } from "@xyflow/react";
import type { CSSProperties, ReactElement, ReactNode, MouseEvent } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { isLocalSourceNode } from "./build.js";
import { safeExternalUrl } from "./external-url.js";
import { browserCssMaskUrl } from "./html.js";
import { githubSourceReferenceUrl } from "./model.js";
import type { GraphNodeData, GraphSettings } from "./build.js";
import type { GraphCallbacks } from "./callbacks.js";

export interface NodeInteraction {
  appearance?: "default" | "custom";
  settings: GraphSettings;
  callbacks: GraphCallbacks;
  showDetails(node: GraphNodeData, card: HTMLElement, toggle: boolean): void;
}

export const NodeInteractionContext = createContext<NodeInteraction | null>(
  null
);

interface MeasuredElement {
  scrollWidth: number;
  clientWidth: number;
  style: { fontSize: string };
}

export function fitTypeLabel(element: MeasuredElement): number {
  let size = 13;
  element.style.fontSize = size + "px";
  while (element.scrollWidth > element.clientWidth && size > 7) {
    size -= 0.5;
    element.style.fontSize = size + "px";
  }
  return size;
}

export type ResourceFlowNode = Node<GraphNodeData, "rad">;

export function ResourceNode({
  data
}: NodeProps<ResourceFlowNode>): ReactElement {
  const interaction = useContext(NodeInteractionContext);
  if (!interaction)
    throw new Error("ResourceNode must be rendered inside RadiusGraph.");
  const { settings, callbacks, showDetails, appearance } = interaction;
  const cardRef = useRef<HTMLDivElement>(null);
  const typeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (typeRef.current) {
      if (appearance === "custom") typeRef.current.style.fontSize = "";
      else fitTypeLabel(typeRef.current);
    }
  }, [data.typeLabel, appearance]);

  const glyph = h("span", { className: "rad-node__source-glyph" }, "</>");
  const label = h("span", null, "View source code");
  const local = isLocalSourceNode(settings, data);
  const sourceUrl = safeExternalUrl(data.sourceUrl);
  let source: ReactNode = null;
  if (!settings.liveMode) {
    if (local && data.srcPath && callbacks.onOpenSource) {
      source = h(
        "a",
        {
          className: "rad-node__source nodrag nopan nokey",
          "data-radius-part": "source",
          href: sourceUrl || "#",
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            callbacks.onOpenSource?.({
              path: data.srcPath,
              line: data.srcLine,
              fallbackUrl: sourceUrl
            });
          }
        },
        glyph,
        label
      );
    } else if (
      sourceUrl &&
      (!local || data.srcPath || githubSourceReferenceUrl(data.codeRef))
    ) {
      source = h(
        "a",
        {
          className: "rad-node__source nodrag nopan nokey",
          "data-radius-part": "source",
          href: sourceUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          onClick: (event: MouseEvent) => {
            event.stopPropagation();
            if (callbacks.onOpenExternal) {
              event.preventDefault();
              callbacks.onOpenExternal(sourceUrl);
            }
          }
        },
        glyph,
        label
      );
    } else {
      source = h(
        "span",
        {
          className: "rad-node__source",
          "data-radius-part": "source",
          role: "button",
          "aria-disabled": "true",
          title: "No source reference found"
        },
        glyph,
        label
      );
    }
  }

  const badge =
    data.deployBadge ?
      h("img", {
        className: "rad-node__badge",
        "data-radius-part": "badge",
        src: data.deployBadge,
        alt:
          data.deployBadgeKind === "failed" ? "Failed"
          : data.deployBadgeKind === "success" ? "Deployed"
          : "In progress"
      })
    : null;
  const head = h(
    "div",
    {
      className:
        badge ? "rad-node__head rad-node__head--with-badge" : "rad-node__head"
    },
    data.icon ?
      // A monochrome icon draws itself in `currentColor`, but inside an <img>
      // the SVG is a separate document and would always paint black. Painting
      // it through a CSS mask fills its alpha channel with the theme token, so
      // it stays legible in light and dark. Multi-color artwork keeps the <img>.
      data.iconMonochrome ?
        h("span", {
          className: "rad-node__icon rad-node__icon--themed",
          "aria-hidden": "true",
          "data-radius-part": "icon",
          style: {
            WebkitMaskImage: browserCssMaskUrl(data.icon),
            maskImage: browserCssMaskUrl(data.icon)
          }
        })
      : h("img", {
          className: "rad-node__icon",
          src: data.icon,
          alt: "",
          "data-radius-part": "icon"
        })
    : null,
    h(
      "span",
      {
        className: "rad-node__title",
        title: data.nodeName,
        "data-radius-part": "node-title"
      },
      data.nodeName
    )
  );
  const type = h(
    "div",
    {
      className: "rad-node__type",
      ref: typeRef,
      title: data.concreteType || data.typeLabel,
      "data-radius-part": "node-type"
    },
    data.typeLabel
  );
  const portalUrl = settings.deployMode ? safeExternalUrl(data.portalUrl) : "";
  const content =
    portalUrl ?
      h(
        "a",
        {
          className: "rad-node__portal nodrag nopan nokey",
          href: portalUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          "aria-label": `Open ${data.nodeName} in Azure Portal`,
          onClick: (event: MouseEvent) => event.stopPropagation()
        },
        head,
        type
      )
    : h("div", { className: "rad-node__content" }, head, type);

  return h(
    "div",
    { className: "rad-node-shell" },
    h(Handle, {
      type: "target",
      position: Position.Top,
      isConnectable: false,
      className: "rad-handle"
    }),
    h(
      "div",
      {
        ref: cardRef,
        className: "rad-node",
        role: "group",
        "aria-label": data.nodeName,
        "data-node-id": data.id,
        "data-radius-part": "node",
        "data-radius-diff": data.diffStatus,
        "data-radius-deploy": data.deployStatus,
        "data-radius-provisioning": data.provisioningState,
        style: {
          "--rad-node-default-background": data.bgColor,
          "--rad-node-default-border-style": data.borderStyle || "solid",
          "--rad-node-default-border-width": data.borderWidth + "px",
          "--rad-node-default-border-color": data.borderColor
        } satisfies CSSProperties &
          Record<`--rad-node-default-${string}`, string>,
        // Clicking the card toggles its panel, so a second click on the same
        // node dismisses the menu it opened.
        onClick: (event: MouseEvent<HTMLDivElement>) =>
          showDetails(data, event.currentTarget, true)
      },
      settings.enablePopup ?
        h(
          "button",
          {
            type: "button",
            className: "rad-node__dots nodrag nopan nokey",
            "data-radius-part": "details-toggle",
            "aria-label": "Show details",
            onClick: (event: MouseEvent) => {
              event.preventDefault();
              event.stopPropagation();
              if (cardRef.current) showDetails(data, cardRef.current, true);
            }
          },
          "\u2022\u2022\u2022"
        )
      : null,
      badge,
      content,
      source,
      settings.liveMode && data.provisioningState ?
        h(
          "div",
          {
            className: "rad-node__status",
            "data-radius-part": "status",
            "aria-label": `Provisioning status: ${data.provisioningState}`
          },
          data.provisioningState
        )
      : null,
      callbacks.onNavigate ?
        h(
          "button",
          {
            type: "button",
            className: "rad-node__source nodrag nopan nokey",
            "data-radius-part": "navigate",
            onClick: (event: MouseEvent) => {
              event.stopPropagation();
              callbacks.onNavigate?.(data);
            }
          },
          `Open ${data.nodeName}`
        )
      : null
    ),
    h(Handle, {
      type: "source",
      position: Position.Bottom,
      isConnectable: false,
      className: "rad-handle"
    })
  );
}
