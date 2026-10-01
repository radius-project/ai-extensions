import type {
  DagreGraph,
  DagreLike,
  DagrePlacedNode
} from "../../src/layout.js";

interface RecordedGraph {
  config: Record<string, unknown>;
  nodes: Array<{ id: string; width: number; height: number }>;
  edges: Array<{ source: string; target: string }>;
}

export function createFakeDagre(): DagreLike & {
  graphs: RecordedGraph[];
  placements: Map<string, DagrePlacedNode>;
  failLayout: boolean;
} {
  const graphs: RecordedGraph[] = [];
  const placements = new Map<string, DagrePlacedNode>();
  const fake = {
    graphs,
    placements,
    failLayout: false,
    graphlib: {
      Graph: class implements DagreGraph {
        private readonly recorded: RecordedGraph = {
          config: {},
          nodes: [],
          edges: []
        };
        constructor() {
          graphs.push(this.recorded);
        }
        setGraph(config: Record<string, unknown>) {
          this.recorded.config = config;
        }
        setDefaultEdgeLabel(factory: () => Record<string, unknown>) {
          factory();
        }
        setNode(id: string, size: { width: number; height: number }) {
          this.recorded.nodes.push({ id, ...size });
        }
        setEdge(source: string, target: string) {
          this.recorded.edges.push({ source, target });
        }
        hasNode(id: string) {
          return this.recorded.nodes.some((node) => node.id === id);
        }
        node(id: string) {
          return placements.get(id);
        }
      }
    },
    layout() {
      if (fake.failLayout) throw new Error("dagre layout failed");
    }
  };
  return fake;
}
