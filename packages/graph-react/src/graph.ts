import {
  Component,
  createElement as h,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState
} from "@xyflow/react";
import dagre from "dagre";
import type { KeyboardEvent, MouseEvent, ReactElement, ReactNode } from "react";
import type { ReactFlowInstance } from "@xyflow/react";
import type {
  GraphResource,
  RadiusGraphData
} from "@radius-project/core/graph";
import { graphContextKey } from "@radius-project/core/graph";
import { buildGraph, resolveGraphSettings } from "./build.js";
import type { GraphNodeData, GraphOptions, GraphSettings } from "./build.js";
import {
  anchorPosition,
  buildDetailRows,
  closesDetails,
  focusReturnTarget
} from "./details.js";
import type { FocusTarget } from "./details.js";
import { DetailsOverlay } from "./details-panel.js";
import { requestFit } from "./fit.js";
import { layoutGraph } from "./layout.js";
import {
  buildCategoryLegendHtml,
  buildStatusLegendHtml,
  collectLegendCategories
} from "./legend.js";
import { NodeInteractionContext, ResourceNode } from "./node.js";
import type { ResourceFlowNode } from "./node.js";
import type { GraphCallbacks } from "./callbacks.js";
import { graphStyle, styledEdges } from "./theme.js";
import type { GraphStyle, GraphTheme, StyledEdge } from "./theme.js";
export type { GraphStyle, GraphTheme } from "./theme.js";

export interface RadiusGraphProps {
  graph: RadiusGraphData;
  options?: Omit<
    GraphOptions,
    "liveMode" | "diffMode" | "deployMode" | "plannedMode"
  >;
  theme?: GraphTheme;
  /** Use the default skin or let the host stylesheet own appearance. */
  appearance?: "default" | "custom";
  callbacks?: GraphCallbacks;
  className?: string;
  style?: GraphStyle;
  ariaLabel?: string;
}

const EMPTY_CALLBACKS: GraphCallbacks = {};
const EMPTY_OPTIONS = {};
const NODE_TYPES = { rad: ResourceNode };
const FIT_OPTIONS = { padding: 0.18 };
// React Flow v12 anchors each dot half a gap from the pattern origin; v11
// anchored it half a dot. This offset keeps the established grid position.
const GRID_GAP = 16;
const GRID_DOT_SIZE = 1;
const GRID_DOT_OFFSET = (GRID_DOT_SIZE - GRID_GAP) / 2;
// createElement cannot infer React Flow's node and edge generics, so bind them.
const ResourceFlow = ReactFlow<ResourceFlowNode, StyledEdge>;
// Only these callbacks cross a memoized boundary, so only these need a stable
// facade. `onSelect` and `onDetails` fire through a ref, and `onRetry` is read
// from props by the error boundary, so all three stay current on their own.
const FORWARDED_CALLBACKS = [
  "onOpenExternal",
  "onOpenSource",
  "onNavigate"
] as const satisfies readonly (keyof GraphCallbacks)[];

interface OpenDetails {
  id: string;
  card: HTMLElement;
  left: number;
  top: number;
}

function GraphContent({
  graph,
  appearance,
  options = EMPTY_OPTIONS,
  callbacks = EMPTY_CALLBACKS
}: RadiusGraphProps): ReactElement {
  // Hosts routinely pass an inline options object. Keying on its identity would
  // rebuild the graph and reset dragged node positions on every unrelated host
  // render, so key on the option values instead. Every option is a primitive.
  const optionsKey = JSON.stringify(options);
  const settings: GraphSettings = useMemo(
    () =>
      resolveGraphSettings({
        ...options,
        liveMode: graph.kind === "live",
        diffMode: graph.kind === "diff",
        plannedMode: graph.kind === "planned",
        deployMode: graph.kind === "deployed-projection"
      }),
    [optionsKey, graph.kind]
  );
  const enablePopup = settings.enablePopup;
  const built = useMemo(() => {
    const resources: GraphResource[] = graph.resources.map((resource) => ({
      ...resource,
      connections: resource.connections ? [...resource.connections] : []
    }));
    const result = buildGraph(settings, resources);
    const warning = layoutGraph(dagre, result.nodes, result.edges);
    return { ...result, edges: styledEdges(result.edges), warning };
  }, [graph, settings]);
  const [nodes, setNodes, onNodesChange] = useNodesState<ResourceFlowNode>(
    built.nodes
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<StyledEdge>(
    built.edges
  );
  const flowRef = useRef<ReactFlowInstance<
    ResourceFlowNode,
    StyledEdge
  > | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  // Which node's details are open, the card they are anchored to, and where
  // that put them. React owns the panel, so this is ordinary component state
  // rather than a handle on a detached element.
  const [details, setDetails] = useState<OpenDetails | null>(null);
  // Event handlers must stay referentially stable to keep the memoized node
  // context intact, so they read the open panel through a mirror of the state
  // instead of closing over it.
  const detailsRef = useRef<OpenDetails | null>(null);
  const restoreFocusRef = useRef<FocusTarget | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  // An inline callbacks object changes identity on every host render. Depending
  // on that identity would tear down and rebuild the open details panel each
  // time, losing the open node and the focus to restore. Presence still decides
  // which affordances render, so track that rather than the object.
  const callbackPresence = FORWARDED_CALLBACKS.map((name) =>
    callbacks[name] ? "1" : "0"
  ).join("");
  const stableCallbacks = useMemo<GraphCallbacks>(() => {
    const current = callbacksRef.current;
    const facade: GraphCallbacks = {};
    if (current.onOpenExternal)
      facade.onOpenExternal = (url) =>
        callbacksRef.current.onOpenExternal?.(url);
    if (current.onOpenSource)
      facade.onOpenSource = (source) =>
        callbacksRef.current.onOpenSource?.(source);
    if (current.onNavigate)
      facade.onNavigate = (node) => callbacksRef.current.onNavigate?.(node);
    return facade;
  }, [callbackPresence]);
  const signature = JSON.stringify([
    graph.kind,
    graph.kind === "live" ? graphContextKey(graph.context) : "",
    built.nodes.map((node) => node.id).sort()
  ]);
  const previousSignature = useRef(signature);
  const refitRef = useRef(false);
  const applyDetails = useCallback((next: OpenDetails | null) => {
    detailsRef.current = next;
    setDetails(next);
  }, []);
  const closeDetails = useCallback(() => {
    if (!detailsRef.current) return;
    applyDetails(null);
    // Return focus where it was before the panel took it, so keyboard users
    // are not dropped at the top of the document.
    const restore = restoreFocusRef.current;
    restoreFocusRef.current = null;
    restore?.focus();
  }, [applyDetails]);

  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
    // The panel reads its rows from the newest build, so refreshed data shows
    // without reopening. A node that disappeared takes its panel with it.
    const open = detailsRef.current;
    if (open && !built.dataById[open.id]) closeDetails();
    if (signature !== previousSignature.current) {
      previousSignature.current = signature;
      refitRef.current = true;
      closeDetails();
    }
  }, [built, signature, setNodes, setEdges, closeDetails]);

  // React Flow copies the nodes prop into its store from its own passive
  // effect, which runs before this parent effect. Asking for the fit here lets
  // v12 queue it against the new nodes and apply it once they are measured;
  // asked earlier, it could frame the previous graph. The initial fit comes
  // from the fitView prop.
  useEffect(() => {
    if (!refitRef.current) return;
    refitRef.current = false;
    requestFit(flowRef.current, FIT_OPTIONS);
  }, [nodes]);

  // Re-anchor an open panel once the cards it points at have been laid out
  // again, so a relayout or a drag does not leave it behind.
  useEffect(() => {
    const open = detailsRef.current;
    if (!open) return;
    const moved = anchorPosition(viewportRef.current, open.card);
    if (moved.left !== open.left || moved.top !== open.top) {
      applyDetails({ ...open, ...moved });
    }
  }, [nodes, applyDetails]);

  const showDetails = useCallback(
    (node: GraphNodeData, card: HTMLElement, toggle: boolean) => {
      callbacksRef.current.onSelect?.(node);
      if (!enablePopup) return;
      const open = detailsRef.current;
      // Clicking the same card, or its "…" button, again closes the panel; a
      // different card re-anchors it.
      if (toggle && open?.card === card) {
        closeDetails();
        callbacksRef.current.onDetails?.(node, false);
        return;
      }
      if (!open) {
        restoreFocusRef.current = focusReturnTarget(
          card.ownerDocument.activeElement
        );
      }
      applyDetails({
        id: node.id,
        card,
        ...anchorPosition(viewportRef.current, card)
      });
      callbacksRef.current.onDetails?.(node, true);
    },
    [applyDetails, closeDetails, enablePopup]
  );

  // Clicking the empty pane, the controls or the legend closes the panel.
  // Clicking a card or the panel itself does not: those have their own
  // handlers.
  const onViewportClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!detailsRef.current) return;
      if (closesDetails(event.target)) closeDetails();
    },
    [closeDetails]
  );
  const onViewportKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") closeDetails();
    },
    [closeDetails]
  );

  const openData = details ? built.dataById[details.id] : undefined;
  const rows = useMemo(
    () => (openData ? buildDetailRows(settings, openData) : []),
    [openData, settings]
  );
  const interaction = useMemo(
    () => ({ settings, callbacks: stableCallbacks, showDetails, appearance }),
    [settings, stableCallbacks, showDetails, appearance]
  );
  const legend =
    !settings.showLegend || settings.diffMode ? ""
    : settings.deployMode ? buildStatusLegendHtml(built.resources)
    : buildCategoryLegendHtml(collectLegendCategories(built.resources));

  return h(
    NodeInteractionContext.Provider,
    { value: interaction },
    legend ?
      h("div", {
        className: "legend",
        "data-radius-part": "legend",
        dangerouslySetInnerHTML: { __html: legend }
      })
    : null,
    built.warning ?
      h(
        "div",
        {
          role: "status",
          className: "radius-graph__warning",
          "data-radius-part": "warning"
        },
        built.warning
      )
    : null,
    graph.kind === "live" && graph.warnings.length > 0 ?
      h(
        "div",
        {
          role: "status",
          className: "radius-graph__warning",
          "data-radius-part": "warning"
        },
        graph.warnings.map((warning) => warning.message).join(" ")
      )
    : null,
    h(
      "div",
      {
        className: "radius-graph__viewport",
        "data-radius-part": "viewport",
        ref: viewportRef,
        onClick: onViewportClick,
        onKeyDown: onViewportKeyDown
      },
      built.nodes.length === 0 ?
        h(
          "div",
          {
            role: "status",
            className: "radius-graph__empty",
            "data-radius-part": "empty"
          },
          "No resources in this application."
        )
      : h(
          ResourceFlow,
          {
            nodes,
            edges,
            nodeTypes: NODE_TYPES,
            onNodesChange,
            onEdgesChange,
            fitView: true,
            fitViewOptions: FIT_OPTIONS,
            minZoom: 0.2,
            maxZoom: 2,
            nodesDraggable: true,
            nodesConnectable: false,
            nodesFocusable: false,
            edgesFocusable: false,
            elementsSelectable: true,
            proOptions: { hideAttribution: true },
            onInit: (
              instance: ReactFlowInstance<ResourceFlowNode, StyledEdge>
            ) => {
              flowRef.current = instance;
            }
          },
          h(Background, {
            gap: GRID_GAP,
            size: GRID_DOT_SIZE,
            offset: GRID_DOT_OFFSET
          }),
          h(Controls, { showInteractive: false })
        ),
      enablePopup && built.nodes.length > 0 ?
        h(DetailsOverlay, {
          id: `node-popup-${panelId}`,
          rows,
          open: openData !== undefined,
          left: details?.left ?? 0,
          top: details?.top ?? 0,
          onOpenExternal: stableCallbacks.onOpenExternal,
          onOpenLocalSource:
            stableCallbacks.onOpenSource ?
              (path, line, fallbackUrl) =>
                stableCallbacks.onOpenSource?.({ path, line, fallbackUrl })
            : undefined
        })
      : null
    )
  );
}

class GraphBoundary extends Component<
  {
    children?: ReactNode;
    onRetry?: () => void;
    onError?: (error: unknown) => void;
    identity: RadiusGraphData;
  },
  { failed: boolean; identity: RadiusGraphData }
> {
  state = { failed: false, identity: this.props.identity };

  /** A new graph identity clears a failure before its first render. */
  static getDerivedStateFromProps(
    props: Readonly<{ identity: RadiusGraphData }>,
    state: Readonly<{ identity: RadiusGraphData }>
  ): { failed: boolean; identity: RadiusGraphData } | null {
    return props.identity === state.identity ?
        null
      : { failed: false, identity: props.identity };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return h(
      "div",
      {
        className: "radius-graph__error",
        role: "alert",
        "data-radius-part": "error"
      },
      "The application graph could not be rendered. ",
      this.props.onRetry ?
        h(
          "button",
          {
            type: "button",
            onClick: this.props.onRetry,
            "data-radius-part": "retry"
          },
          "Reload graph"
        )
      : null
    );
  }
}

/** The same controlled React tree is mounted by Canvas and npm consumers. */
export function RadiusGraph(props: RadiusGraphProps): ReactElement {
  return h(
    "section",
    {
      className: `radius-graph${props.className ? ` ${props.className}` : ""}`,
      style: graphStyle(props.style, props.theme),
      "data-radius-appearance": props.appearance ?? "default",
      "data-radius-kind": props.graph.kind,
      "aria-label": props.ariaLabel || "Application graph"
    },
    h(
      GraphBoundary,
      {
        identity: props.graph,
        onRetry: props.callbacks?.onRetry,
        onError: props.callbacks?.onError
      },
      h(GraphContent, props)
    )
  );
}
