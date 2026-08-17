// Canvas adapter — hierarchical graph layout (BU-05).
//
// React Flow renders the nodes and edges; dagre only computes node positions.
// Node size is fixed to the .rad-node card footprint so the layout is stable
// before the DOM is ever measured, and the vendored library is injected rather
// than read from a global, so the fallback paths — no dagre at all, and a dagre
// that throws — are ordinary unit tests.

import type { GraphEdge, GraphNode } from "./build.js";

export const GRAPH_NODE_WIDTH = 220;
export const GRAPH_NODE_HEIGHT = 118;
const STACK_GAP = 48;

export interface DagreNodeSize {
  width: number;
  height: number;
}

export interface DagrePlacedNode {
  x: number;
  y: number;
}

export interface DagreGraph {
  setGraph(config: Record<string, unknown>): void;
  setDefaultEdgeLabel(factory: () => Record<string, unknown>): void;
  setNode(id: string, size: DagreNodeSize): void;
  setEdge(source: string, target: string): void;
  hasNode(id: string): boolean;
  node(id: string): DagrePlacedNode | undefined;
}

export interface DagreLike {
  graphlib: { Graph: new () => DagreGraph };
  layout(graph: DagreGraph): void;
}

// One column, top to bottom. Used when dagre is unavailable or fails, so a
// graph without a layout engine is still readable instead of a pile at (0, 0).
function stack(nodes: readonly GraphNode[]): void {
  for (let index = 0; index < nodes.length; index++) {
    nodes[index].position = {
      x: 0,
      y: index * (GRAPH_NODE_HEIGHT + STACK_GAP)
    };
  }
}

export function layoutGraph(
  dagre: DagreLike | null,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): void {
  if (!dagre) {
    stack(nodes);
    return;
  }
  try {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({
      rankdir: "TB",
      nodesep: 55,
      ranksep: 80,
      marginx: 24,
      marginy: 24,
      ranker: "network-simplex"
    });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of nodes) {
      graph.setNode(node.id, {
        width: GRAPH_NODE_WIDTH,
        height: GRAPH_NODE_HEIGHT
      });
    }
    for (const edge of edges) {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        graph.setEdge(edge.source, edge.target);
      }
    }
    dagre.layout(graph);
    for (const node of nodes) {
      const placed = graph.node(node.id);
      if (placed) {
        node.position = {
          x: placed.x - GRAPH_NODE_WIDTH / 2,
          y: placed.y - GRAPH_NODE_HEIGHT / 2
        };
      }
    }
  } catch {
    // A layout failure happens before dagre exposes usable placements. Stack the
    // whole graph so placeholder (0, 0) positions do not collapse every card.
    stack(nodes);
  }
}
