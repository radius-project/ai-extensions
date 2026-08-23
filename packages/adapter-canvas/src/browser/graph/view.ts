// Canvas adapter — the React Flow view (BU-05, BU-06).
//
// The node card, the flow application and the error boundary the legacy inline
// renderer built with React are constructed here from an injected React, so a
// unit test drives the real component functions with a recording fake and
// asserts the element tree, the handlers and the update path without a browser.
// Layout, painting and pointer behaviour remain Chromium concerns.

import type { ClockPort, DomElement } from "../ports.js";
import type {
  GraphEdge,
  GraphNode,
  GraphNodeData,
  GraphSettings
} from "./build.js";
import type {
  GraphVendor,
  ReactFlowInstance,
  ReactLike,
  ReactRoot
} from "./vendor.js";
import { safeExternalUrl } from "./details.js";

const TYPE_LABEL_MAX_PX = 13;
const TYPE_LABEL_MIN_PX = 7;
const TYPE_LABEL_STEP_PX = 0.5;

interface MeasuredElement {
  scrollWidth: number;
  clientWidth: number;
  style: { fontSize: string };
}

function isMeasured(value: unknown): value is MeasuredElement {
  if (typeof value !== "object" || value === null) return false;
  const element = value as Record<string, unknown>;
  return (
    typeof element.scrollWidth === "number" &&
    typeof element.clientWidth === "number" &&
    typeof element.style === "object" &&
    element.style !== null
  );
}

// Shrink a node's type label until it fits its card, down to a floor. Measuring
// is the only thing this needs from the element, so it is read through a guard
// rather than widening the shared DOM port.
export function fitTypeLabel(element: unknown): number | null {
  if (!isMeasured(element)) return null;
  let size = TYPE_LABEL_MAX_PX;
  element.style.fontSize = size + "px";
  while (
    element.scrollWidth > element.clientWidth &&
    size > TYPE_LABEL_MIN_PX
  ) {
    size -= TYPE_LABEL_STEP_PX;
    element.style.fontSize = size + "px";
  }
  return size;
}

export interface NodeCardDeps {
  // Opens a repo-relative worktree file in the editor canvas, with the node's
  // remote URL as the fallback.
  openLocalSource(relPath: string, line: number, fallbackUrl: string): void;
  // Opens or closes the details panel for a card.
  toggleDetails(data: GraphNodeData, card: DomElement | null): void;
  openDetails(data: GraphNodeData, card: DomElement | null): void;
}

interface NodeProps {
  data: GraphNodeData;
}

function asElement(value: unknown): DomElement | null {
  return typeof value === "object" && value !== null ?
      (value as DomElement)
    : null;
}

function closestCard(value: unknown): DomElement | null {
  const element = asElement(value);
  if (!element || typeof element.closest !== "function") return element;
  return element.closest(".rad-node") ?? element;
}

// The figma .rad-node card, rendered as real React elements so the source link
// and the details button are genuinely clickable. Interactive children carry
// React Flow's nodrag/nopan classes so the pane's drag layer never swallows
// their clicks.
export function createNodeComponent(
  vendor: GraphVendor,
  settings: GraphSettings,
  deps: NodeCardDeps
): (props: NodeProps) => unknown {
  const react: ReactLike = vendor.react;
  const h = react.createElement.bind(react);
  const { Handle, Position } = vendor.reactFlow;

  return function RadNode(props: NodeProps): unknown {
    const data = props.data;
    const typeRef = react.useRef<unknown>(null);
    react.useLayoutEffect(() => {
      fitTypeLabel(typeRef.current);
    }, [data.typeLabel]);

    const icon =
      data.icon ?
        h("img", { className: "rad-node__icon", src: data.icon, alt: "" })
      : null;
    const glyph = h(
      "span",
      { className: "rad-node__source-glyph" },
      "</" + ">"
    );
    const label = h("span", null, "View source code");

    // "View source code" behaviour depends on where the graph was resolved
    // from: a local-workspace graph opens the on-disk file in the editor canvas
    // (with the remote URL as the fallback), a remote graph is a native anchor
    // the host opens in the system browser, and a local graph with no reference
    // for this node shows a disabled row.
    let sourceRow: unknown;
    if (settings.localSource && data.srcPath) {
      sourceRow = h(
        "a",
        {
          className: "rad-node__source nodrag nopan nokey",
          href: data.sourceUrl || "#",
          onClick: (event: {
            preventDefault(): void;
            stopPropagation(): void;
          }) => {
            event.preventDefault();
            event.stopPropagation();
            deps.openLocalSource(data.srcPath, data.srcLine, data.sourceUrl);
          }
        },
        glyph,
        label
      );
    } else if (settings.localSource) {
      sourceRow = h(
        "span",
        {
          className: "rad-node__source",
          role: "button",
          "aria-disabled": "true",
          title: "No source reference found",
          style: { opacity: 0.5, cursor: "default" }
        },
        glyph,
        label
      );
    } else if (data.sourceUrl) {
      sourceRow = h(
        "a",
        {
          className: "rad-node__source nodrag nopan nokey",
          href: data.sourceUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          onClick: (event: { stopPropagation(): void }) => {
            event.stopPropagation();
          }
        },
        glyph,
        label
      );
    } else {
      sourceRow = h(
        "span",
        { className: "rad-node__source", role: "button" },
        glyph,
        label
      );
    }

    const dots = h(
      "button",
      {
        type: "button",
        // "nokey" keeps React Flow's node keyboard handler off this control:
        // it treats Space as "select the node" and cancels the key, which would
        // otherwise stop the browser activating the button.
        className: "rad-node__dots nodrag nopan nokey",
        "aria-label": "Show details",
        onClick: (event: {
          preventDefault(): void;
          stopPropagation(): void;
          currentTarget?: unknown;
        }) => {
          event.preventDefault();
          event.stopPropagation();
          deps.toggleDetails(data, closestCard(event.currentTarget));
        }
      },
      "\u2022\u2022\u2022"
    );

    // Deploy-status badge (spinner / green check / red X) shown top-right while
    // a deployment is in flight; absent outside deployMode.
    const badge =
      data.deployBadge ?
        h("img", {
          className: "rad-node__badge",
          src: data.deployBadge,
          alt:
            data.deployBadgeKind === "failed" ? "Failed"
            : data.deployBadgeKind === "success" ? "Deployed"
            : "In progress"
        })
      : null;
    const portalUrl =
      settings.deployMode ? safeExternalUrl(data.portalUrl) : null;
    const head = h(
      "div",
      { className: "rad-node__head" },
      icon,
      h("span", { className: "rad-node__title" }, data.nodeName)
    );
    const type = h(
      "div",
      { className: "rad-node__type", ref: typeRef, title: data.typeLabel },
      data.typeLabel
    );
    const mainContent =
      portalUrl ?
        h(
          "a",
          {
            className: "rad-node__portal nodrag nopan nokey",
            href: portalUrl,
            target: "_blank",
            rel: "noopener noreferrer",
            "aria-label": `Open ${data.nodeName} in Azure Portal`,
            onClick: (event: { stopPropagation(): void }) => {
              event.stopPropagation();
            }
          },
          head,
          type
        )
      : h("div", { className: "rad-node__content" }, head, type);

    const card = h(
      "div",
      {
        className: "rad-node",
        "data-node-id": data.id,
        style: {
          boxSizing: "border-box",
          background: data.bgColor || "var(--rad-node-bg)",
          borderStyle: data.borderStyle || "solid",
          borderWidth: (data.borderWidth || 2.5) + "px",
          borderColor: data.borderColor || "var(--rad-node-border)"
        },
        onClick: (event: { currentTarget?: unknown }) =>
          deps.openDetails(data, asElement(event.currentTarget))
      },
      dots,
      badge,
      mainContent,
      sourceRow
    );

    return h(
      "div",
      { className: "rad-node-shell" },
      h(Handle, {
        type: "target",
        position: Position.Top,
        isConnectable: false,
        className: "rad-handle"
      }),
      card,
      h(Handle, {
        type: "source",
        position: Position.Bottom,
        isConnectable: false,
        className: "rad-handle"
      })
    );
  };
}

export type GraphUpdater =
  ((nodes: readonly GraphNode[], edges: readonly GraphEdge[]) => void) | null;

export interface UpdaterBinding {
  fn: GraphUpdater;
}

interface AppProps {
  initialNodes: readonly GraphNode[];
  initialEdges: readonly GraphEdge[];
}

const FIT_VIEW_OPTIONS = { padding: 0.18 };
const FIT_AFTER_MOUNT_MS = 30;
const FIT_AFTER_UPDATE_MS = 40;

function fitView(
  instance: ReactFlowInstance,
  options: Record<string, unknown>
): void {
  try {
    instance.fitView(options);
  } catch {
    // Fitting is presentation only: a viewport that refuses to fit must not
    // take the graph down with it.
  }
}

// The mounted flow application. It binds the updater so the controller can push
// new nodes and edges into React state while preserving the viewport.
export function createGraphApp(
  vendor: GraphVendor,
  clock: ClockPort,
  nodeTypes: Record<string, unknown>,
  updater: UpdaterBinding
): (props: AppProps) => unknown {
  const react = vendor.react;
  const h = react.createElement.bind(react);
  const flow = vendor.reactFlow;

  return function RadGraphApp(props: AppProps): unknown {
    const [nodes, setNodes, onNodesChange] = flow.useNodesState(
      props.initialNodes
    );
    const [edges, setEdges, onEdgesChange] = flow.useEdgesState(
      props.initialEdges
    );
    const instanceRef = react.useRef<ReactFlowInstance | null>(null);

    react.useEffect(() => {
      updater.fn = (nextNodes, nextEdges) => {
        setNodes(nextNodes);
        setEdges(nextEdges);
        const instance = instanceRef.current;
        if (instance) {
          clock.setTimeout(
            () => fitView(instance, { padding: 0.18, duration: 200 }),
            FIT_AFTER_UPDATE_MS
          );
        }
      };
      return () => {
        updater.fn = null;
      };
    }, []);

    return h(
      flow.default,
      {
        nodes,
        edges,
        onNodesChange,
        onEdgesChange,
        nodeTypes,
        fitView: true,
        fitViewOptions: FIT_VIEW_OPTIONS,
        minZoom: 0.2,
        maxZoom: 2,
        nodesDraggable: true,
        nodesConnectable: false,
        // The card owns its own focusable controls (source link, details
        // button). Leaving React Flow's wrapper focusable would make it an
        // interactive element containing interactive elements, which fails
        // WCAG 4.1.2 and adds an empty stop to the tab order.
        nodesFocusable: false,
        edgesFocusable: false,
        elementsSelectable: true,
        proOptions: { hideAttribution: true },
        onInit: (instance: ReactFlowInstance) => {
          instanceRef.current = instance;
          clock.setTimeout(
            () => fitView(instance, FIT_VIEW_OPTIONS),
            FIT_AFTER_MOUNT_MS
          );
        }
      },
      h(flow.Background, { gap: 16, size: 1 }),
      h(flow.Controls, { showInteractive: false })
    );
  };
}

// A render failure inside React would otherwise blank the panel, so the tree is
// wrapped in a boundary that offers a reload instead.
export function createErrorBoundary(
  vendor: GraphVendor,
  reload: () => void
): GraphErrorBoundaryClass {
  const react = vendor.react;
  const h = react.createElement.bind(react);

  class RadGraphErrorBoundary extends react.Component {
    constructor(props: Record<string, unknown>) {
      super(props);
      this.state = { failed: false };
    }

    static getDerivedStateFromError(): Record<string, unknown> {
      return { failed: true };
    }

    render(): unknown {
      if (this.state.failed !== true) return this.props.children;
      return h(
        "div",
        { className: "status error" },
        "The application graph could not be rendered. ",
        h(
          "button",
          {
            type: "button",
            className: "rad-btn rad-btn--secondary",
            onClick: reload
          },
          "Reload graph"
        )
      );
    }
  }

  return RadGraphErrorBoundary;
}

export interface GraphErrorBoundaryInstance {
  state: Record<string, unknown>;
  render(): unknown;
}

export interface GraphErrorBoundaryClass {
  new (props: Record<string, unknown>): GraphErrorBoundaryInstance;
  getDerivedStateFromError(): Record<string, unknown>;
}

export interface MountedGraph {
  update(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): boolean;
  unmount(): void;
}

export interface MountOptions {
  vendor: GraphVendor;
  clock: ClockPort;
  host: unknown;
  settings: GraphSettings;
  deps: NodeCardDeps;
  reload: () => void;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
}

// Mount the flow application into its own host element and return the handle
// the graph controller drives.
export function mountGraph(options: MountOptions): MountedGraph {
  const { vendor, clock } = options;
  const h = vendor.react.createElement.bind(vendor.react);
  const nodeTypes = {
    rad: createNodeComponent(vendor, options.settings, options.deps)
  };
  const updater: UpdaterBinding = { fn: null };
  const app = createGraphApp(vendor, clock, nodeTypes, updater);
  const boundary = createErrorBoundary(vendor, options.reload);
  const root: ReactRoot = vendor.reactDom.createRoot(options.host);
  root.render(
    h(
      boundary,
      null,
      h(app, { initialNodes: options.nodes, initialEdges: options.edges })
    )
  );
  return {
    update(nodes, edges) {
      if (!updater.fn) return false;
      updater.fn(nodes, edges);
      return true;
    },
    unmount() {
      updater.fn = null;
      try {
        root.unmount();
      } catch {
        // A root React already discarded is still torn down from this side.
      }
    }
  };
}
