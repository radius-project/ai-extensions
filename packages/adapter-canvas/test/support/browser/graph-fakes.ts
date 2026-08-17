// Deterministic fakes for the vendored graph libraries.
//
// The graph modules receive React, ReactDOM, React Flow and dagre through
// ports, so a unit test can run the real component functions against recording
// fakes: the element tree, the handlers and the update path are all observable
// without a browser. Layout, painting and pointer behaviour stay Chromium
// concerns and are not simulated here.
//
// Test-support only: production modules never import this.

import type {
  GraphVendor,
  ReactFlowInstance,
  ReactRoot
} from "../../../src/browser/graph/vendor.js";
import type {
  DagreGraph,
  DagreLike,
  DagrePlacedNode
} from "../../../src/browser/graph/layout.js";
import type { GraphEdge, GraphNode } from "../../../src/browser/graph/build.js";

export interface FakeReactElement {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
}

export function isFakeElement(value: unknown): value is FakeReactElement {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "props" in value &&
    "children" in value
  );
}

// Depth-first walk of a rendered tree, so a test can find a node by class,
// tag or prop without re-deriving the traversal.
export function flattenElements(root: unknown): FakeReactElement[] {
  if (!isFakeElement(root)) return [];
  return [root, ...root.children.flatMap((child) => flattenElements(child))];
}

export function findByClass(
  root: unknown,
  className: string
): FakeReactElement | undefined {
  return flattenElements(root).find(
    (element) => element.props.className === className
  );
}

export function findAllByType(
  root: unknown,
  type: unknown
): FakeReactElement[] {
  return flattenElements(root).filter((element) => element.type === type);
}

export interface FakeEffect {
  effect: () => (() => void) | void;
  deps: readonly unknown[] | undefined;
}

export interface FakeReact {
  createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): FakeReactElement;
  useRef<T>(initial: T): { current: T };
  useEffect(effect: () => (() => void) | void, deps?: readonly unknown[]): void;
  useLayoutEffect(
    effect: () => (() => void) | void,
    deps?: readonly unknown[]
  ): void;
  Component: new (props: Record<string, unknown>) => {
    props: Record<string, unknown>;
    state: Record<string, unknown>;
  };
  // Runs every effect the last render queued and keeps their cleanups.
  runEffects(): void;
  runCleanups(): void;
  readonly effects: readonly FakeEffect[];
  readonly layoutEffects: readonly FakeEffect[];
  // Values handed to useRef, in call order, so a test can drive a ref the
  // component stored.
  readonly refs: ReadonlyArray<{ current: unknown }>;
}

class FakeComponentBase {
  props: Record<string, unknown>;
  state: Record<string, unknown> = {};

  constructor(props: Record<string, unknown>) {
    this.props = props;
  }
}

export function createFakeReact(): FakeReact {
  const effects: FakeEffect[] = [];
  const layoutEffects: FakeEffect[] = [];
  const refs: Array<{ current: unknown }> = [];
  const cleanups: Array<() => void> = [];
  return {
    effects,
    layoutEffects,
    refs,
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.filter(
          (child) => child !== null && child !== undefined
        )
      };
    },
    useRef(initial) {
      const ref = { current: initial as unknown };
      refs.push(ref);
      return ref as { current: typeof initial };
    },
    useEffect(effect, deps) {
      effects.push({ effect, deps });
    },
    useLayoutEffect(effect, deps) {
      layoutEffects.push({ effect, deps });
    },
    Component: FakeComponentBase,
    runEffects() {
      for (const entry of [...layoutEffects, ...effects]) {
        const cleanup = entry.effect();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
    },
    runCleanups() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    }
  };
}

export interface FakeReactRoot extends ReactRoot {
  readonly rendered: readonly unknown[];
  readonly unmounts: number;
  failUnmount: boolean;
}

export interface FakeReactDom {
  createRoot(container: unknown): FakeReactRoot;
  readonly roots: readonly FakeReactRoot[];
  readonly hosts: readonly unknown[];
}

export function createFakeReactDom(): FakeReactDom {
  const roots: FakeReactRoot[] = [];
  const hosts: unknown[] = [];
  return {
    roots,
    hosts,
    createRoot(container) {
      hosts.push(container);
      const rendered: unknown[] = [];
      let unmounts = 0;
      const root: FakeReactRoot = {
        rendered,
        failUnmount: false,
        get unmounts() {
          return unmounts;
        },
        render(element) {
          rendered.push(element);
        },
        unmount() {
          unmounts += 1;
          if (root.failUnmount) throw new Error("root already discarded");
        }
      };
      roots.push(root);
      return root;
    }
  };
}

export interface FakeReactFlow {
  default: string;
  Background: string;
  Controls: string;
  Handle: string;
  Position: { Top: string; Bottom: string };
  useNodesState(
    initial: readonly GraphNode[]
  ): [readonly GraphNode[], (next: readonly GraphNode[]) => void, unknown];
  useEdgesState(
    initial: readonly GraphEdge[]
  ): [readonly GraphEdge[], (next: readonly GraphEdge[]) => void, unknown];
  readonly nodeUpdates: ReadonlyArray<readonly GraphNode[]>;
  readonly edgeUpdates: ReadonlyArray<readonly GraphEdge[]>;
}

export function createFakeReactFlow(): FakeReactFlow {
  const nodeUpdates: Array<readonly GraphNode[]> = [];
  const edgeUpdates: Array<readonly GraphEdge[]> = [];
  return {
    default: "ReactFlow",
    Background: "Background",
    Controls: "Controls",
    Handle: "Handle",
    Position: { Top: "top", Bottom: "bottom" },
    nodeUpdates,
    edgeUpdates,
    useNodesState(initial) {
      return [
        initial,
        (next) => {
          nodeUpdates.push(next);
        },
        "onNodesChange"
      ];
    },
    useEdgesState(initial) {
      return [
        initial,
        (next) => {
          edgeUpdates.push(next);
        },
        "onEdgesChange"
      ];
    }
  };
}

export interface FakeDagre extends DagreLike {
  readonly graphs: ReadonlyArray<{
    config: Record<string, unknown>;
    nodes: ReadonlyArray<{ id: string; width: number; height: number }>;
    edges: ReadonlyArray<{ source: string; target: string }>;
  }>;
  // Positions dagre reports back, keyed by node id.
  placements: Map<string, DagrePlacedNode>;
  failLayout: boolean;
}

export function createFakeDagre(): FakeDagre {
  const graphs: Array<{
    config: Record<string, unknown>;
    nodes: Array<{ id: string; width: number; height: number }>;
    edges: Array<{ source: string; target: string }>;
  }> = [];
  const fake: FakeDagre = {
    graphs,
    placements: new Map<string, DagrePlacedNode>(),
    failLayout: false,
    graphlib: {
      Graph: class implements DagreGraph {
        private readonly record = {
          config: {} as Record<string, unknown>,
          nodes: [] as Array<{ id: string; width: number; height: number }>,
          edges: [] as Array<{ source: string; target: string }>
        };

        constructor() {
          graphs.push(this.record);
        }

        setGraph(config: Record<string, unknown>): void {
          this.record.config = config;
        }

        setDefaultEdgeLabel(factory: () => Record<string, unknown>): void {
          factory();
        }

        setNode(id: string, size: { width: number; height: number }): void {
          this.record.nodes.push({ id, ...size });
        }

        setEdge(source: string, target: string): void {
          this.record.edges.push({ source, target });
        }

        hasNode(id: string): boolean {
          return this.record.nodes.some((node) => node.id === id);
        }

        node(id: string): DagrePlacedNode | undefined {
          return fake.placements.get(id);
        }
      }
    },
    layout() {
      if (fake.failLayout) throw new Error("dagre layout failed");
    }
  };
  return fake;
}

export interface FakeGraphVendor extends GraphVendor {
  react: FakeReact;
  reactDom: FakeReactDom;
  reactFlow: FakeReactFlow;
  dagre: FakeDagre | null;
}

export function createFakeGraphVendor(
  options: { dagre?: boolean } = {}
): FakeGraphVendor {
  return {
    react: createFakeReact(),
    reactDom: createFakeReactDom(),
    reactFlow: createFakeReactFlow(),
    dagre: options.dagre === false ? null : createFakeDagre()
  };
}

export interface FakeFlowInstance extends ReactFlowInstance {
  readonly fits: ReadonlyArray<Record<string, unknown>>;
  failing: boolean;
}

export function createFakeFlowInstance(): FakeFlowInstance {
  const fits: Array<Record<string, unknown>> = [];
  const instance: FakeFlowInstance = {
    fits,
    failing: false,
    fitView(options) {
      if (instance.failing) throw new Error("viewport not ready");
      fits.push(options);
    }
  };
  return instance;
}
