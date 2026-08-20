// BU-05: hierarchical layout.
//
// dagre only computes positions, so these cover what it is asked for, what it
// answers, and the two fallbacks a page must survive: no layout engine at all,
// and an engine that throws.

import { describe, it, expect } from "vitest";
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, layoutGraph } from "./layout.js";
import { buildGraph, resolveGraphSettings } from "./build.js";
import { createFakeDagre } from "../../../test/support/browser/graph-vendor.js";

function graph() {
  return buildGraph(resolveGraphSettings(), [
    { id: "a", name: "a", connections: [{ id: "b" }] },
    { id: "b", name: "b" },
    { id: "c", name: "c", connections: [{ id: "missing" }] }
  ]);
}

describe("layoutGraph", () => {
  it("lays the graph out top to bottom with the card footprint", () => {
    const dagre = createFakeDagre();
    const built = graph();
    dagre.placements.set("a", { x: 110, y: 59 });
    dagre.placements.set("b", { x: 310, y: 259 });

    layoutGraph(dagre, built.nodes, built.edges);

    expect(dagre.graphs).toHaveLength(1);
    expect(dagre.graphs[0].config).toEqual({
      rankdir: "TB",
      nodesep: 55,
      ranksep: 80,
      marginx: 24,
      marginy: 24,
      ranker: "network-simplex"
    });
    expect(dagre.graphs[0].nodes).toEqual([
      { id: "a", width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT },
      { id: "b", width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT },
      { id: "c", width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }
    ]);
    expect(dagre.graphs[0].edges).toEqual([{ source: "a", target: "b" }]);
    // Positions are the card's top-left corner, from dagre's centre point.
    expect(built.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(built.nodes[1].position).toEqual({ x: 200, y: 200 });
    // A node dagre did not place keeps the position it already had.
    expect(built.nodes[2].position).toEqual({ x: 0, y: 0 });
  });

  it("skips an edge whose endpoints are not both in the layout", () => {
    const dagre = createFakeDagre();
    const built = graph();
    built.edges.push({
      id: "a-->ghost",
      source: "a",
      target: "ghost",
      type: "default",
      style: { stroke: "x", strokeWidth: 2.5 }
    });
    layoutGraph(dagre, built.nodes, built.edges);
    expect(dagre.graphs[0].edges).toEqual([{ source: "a", target: "b" }]);
  });

  it("stacks the nodes in one column when there is no layout engine", () => {
    const built = graph();
    layoutGraph(null, built.nodes, built.edges);
    expect(built.nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: GRAPH_NODE_HEIGHT + 48 },
      { x: 0, y: (GRAPH_NODE_HEIGHT + 48) * 2 }
    ]);
  });

  it("keeps the graph when the layout engine throws", () => {
    const dagre = createFakeDagre();
    dagre.failLayout = true;
    const built = graph();
    expect(() => layoutGraph(dagre, built.nodes, built.edges)).not.toThrow();
    expect(built.nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: GRAPH_NODE_HEIGHT + 48 },
      { x: 0, y: (GRAPH_NODE_HEIGHT + 48) * 2 }
    ]);
  });
});
