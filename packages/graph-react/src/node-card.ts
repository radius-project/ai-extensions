import {
  createContext,
  createElement as h,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import type { CSSProperties, ReactElement, ReactNode, MouseEvent } from "react";
import { consoleNameForUrl } from "@radius-project/core/domain";
import { isLocalSourceNode } from "./build.js";
import { safeExternalUrl } from "./external-url.js";
import { browserCssMaskUrl } from "./html.js";
import { githubSourceReferenceUrl, radiusGetIconSvg } from "./model.js";
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

/**
 * The accessible name of a deployed card's console link, named from where the
 * link goes. Anything other than the AWS console keeps the Azure Portal copy.
 */
export function portalLinkLabel(name: string, url: string): string {
  return consoleNameForUrl(url) === "AWS console" ?
      `Open ${name} in AWS console`
    : `Open ${name} in Azure Portal`;
}

export function ResourceNodeCard({
  data,
  interaction,
  targetHandle,
  sourceHandle
}: {
  data: GraphNodeData;
  interaction: NodeInteraction;
  targetHandle: ReactNode;
  sourceHandle: ReactNode;
}): ReactElement {
  const { settings, callbacks, showDetails, appearance } = interaction;
  const cardRef = useRef<HTMLDivElement>(null);
  const typeRef = useRef<HTMLDivElement>(null);
  const [failedIcon, setFailedIcon] = useState("");
  const icon =
    failedIcon && failedIcon === data.icon ?
      radiusGetIconSvg(data.resourceType)
    : data.icon;
  const monochrome = data.iconMonochrome && failedIcon !== data.icon;
  useEffect(() => {
    if (!data.iconMonochrome || !data.icon) return;
    // CSS masks have no error event. Probe the same isolated image for fallback.
    const probe = new Image();
    probe.onerror = () => setFailedIcon(data.icon);
    probe.src = data.icon;
    return () => {
      probe.onerror = null;
    };
  }, [data.icon, data.iconMonochrome]);
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
  // SVG images and masks are isolated image documents; never insert API SVG into the DOM.
  const artwork =
    icon ?
      monochrome ?
        h("span", {
          className: "rad-node__icon rad-node__icon--themed",
          "aria-hidden": "true",
          "data-radius-part": "icon",
          style: {
            WebkitMaskImage: browserCssMaskUrl(icon),
            maskImage: browserCssMaskUrl(icon)
          }
        })
      : h("img", {
          className: "rad-node__icon",
          src: icon,
          alt: "",
          "data-radius-part": "icon",
          onError: () => setFailedIcon(data.icon)
        })
    : null;
  const head = h(
    "div",
    {
      className:
        badge ? "rad-node__head rad-node__head--with-badge" : "rad-node__head"
    },
    artwork,
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
  const legacyContent =
    settings.legacyMode ?
      h(
        "div",
        { style: { padding: "2px", fontSize: "0.6rem" } },
        artwork,
        h(
          "h3",
          { style: { textAlign: "center" }, "data-radius-part": "node-title" },
          data.nodeName
        ),
        h("hr"),
        h("h6", { "data-radius-part": "node-type" }, data.resourceType)
      )
    : null;
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
          "aria-label": portalLinkLabel(data.nodeName, portalUrl),
          onClick: (event: MouseEvent) => event.stopPropagation()
        },
        head,
        type
      )
    : h("div", { className: "rad-node__content" }, head, type);

  return h(
    "div",
    { className: "rad-node-shell" },
    targetHandle,
    h(
      "div",
      {
        ref: cardRef,
        className: "rad-node",
        role: "group",
        "aria-label": data.nodeName,
        "data-node-id": data.id,
        "data-radius-resource-type": data.resourceType,
        "data-radius-icon": data.icon || undefined,
        "data-radius-badge": data.deployBadgeKind || undefined,
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
      legacyContent || content,
      source,
      settings.liveMode && !settings.legacyMode && data.provisioningState ?
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
    sourceHandle
  );
}
