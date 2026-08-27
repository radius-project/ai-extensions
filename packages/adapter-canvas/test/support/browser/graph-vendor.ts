// The vendored graph libraries wired into the injected graph ports.
//
// React, React Flow and dagre are real dependencies of this package and are the
// same versions the build inlines into extension.mjs, so these tests drive the
// real element factory, the real React Flow components and the real dagre
// layout engine rather than stand-ins for them.
//
// Two seams stay recorded because this suite runs in the node environment with
// no DOM. React's hooks only run inside a renderer and ReactDOM's root needs a
// host container, so `useRef`, `useEffect`, `useLayoutEffect`, `createRoot` and
// React Flow's state hooks are recorded here and the graph modules are called
// as plain functions. Their real behaviour, along with layout, painting, focus
// and pointer behaviour, is covered by the Phase 6 Chromium suite.
//
// Test-support only: production modules never import this.

import { Component, createElement, isValidElement } from "react";
import ReactFlowComponent, {
  Background,
  Controls,
  Handle,
  Position
} from "reactflow";
import dagre from "dagre";
import type { ReactElement } from "react";
import type {
  GraphVendor,
  ReactComponentClass,
  ReactFlowInstance,
  ReactRoot
} from "../../../src/browser/graph/vendor.js";
import type {
  DagreGraph,
  DagreLike,
  DagrePlacedNode
} from "../../../src/browser/graph/layout.js";
import type { GraphEdge, GraphNode } from "../../../src/browser/graph/build.js";

// React 19 types `ReactElement["props"]` as `unknown`, so the prop bag is named
// here rather than re-asserted at every read.
export type RenderedElement = ReactElement<Record<string, unknown>>;

export function isRenderedElement(value: unknown): value is RenderedElement {
  return isValidElement(value);
}

export function elementProps(value: RenderedElement): Record<string, unknown> {
  return value.props;
}

// React 18 lifts `ref` out of props onto the element itself, and the public
// ReactElement type does not describe it, so reads go through here.
export function refOf(value: RenderedElement): unknown {
  return (value as unknown as { ref?: unknown }).ref;
}

// React keeps children inside props and flattens nothing, so a test that wants
// the rendered children of an element goes through here.
export function childrenOf(value: unknown): unknown[] {
  if (!isRenderedElement(value)) return [];
  const { children } = elementProps(value);
  if (children === undefined || children === null) return [];
  const list = Array.isArray(children) ? children : [children];
  return list.filter((child) => child !== null && child !== undefined);
}

// Depth-first walk of a rendered tree, so a test can find a node by class,
// tag or prop without re-deriving the traversal.
export function flattenElements(root: unknown): RenderedElement[] {
  if (!isRenderedElement(root)) return [];
  return [root, ...childrenOf(root).flatMap((child) => flattenElements(child))];
}

export function findByClass(
  root: unknown,
  className: string
): RenderedElement | undefined {
  return flattenElements(root).find(
    (element) => elementProps(element).className === className
  );
}

export function findAllByType(root: unknown, type: unknown): RenderedElement[] {
  return flattenElements(root).filter((element) => element.type === type);
}

// A component element the tree renders, unpacked so a test can call it the way
// React would. The graph mounts its application inside an error boundary, so
// reaching the application means reaching the boundary's single child.
export interface ComponentElement<P> {
  type: (props: P) => unknown;
  props: P;
}

export function childComponent<P = Record<string, unknown>>(
  value: unknown
): ComponentElement<P> {
  const [child] = childrenOf(value);
  if (!isRenderedElement(child) || typeof child.type !== "function") {
    throw new Error("expected the element to render a component child");
  }
  return {
    type: child.type as (props: P) => unknown,
    props: child.props as P
  };
}

export interface RecordedEffect {
  effect: () => (() => void) | void;
  deps: readonly unknown[] | undefined;
}

export interface RecordingReact {
  createElement: typeof createElement;
  useRef<T>(initial: T): { current: T };
  useEffect(effect: () => (() => void) | void, deps?: readonly unknown[]): void;
  useLayoutEffect(
    effect: () => (() => void) | void,
    deps?: readonly unknown[]
  ): void;
  Component: ReactComponentClass;
  // Runs every effect the last render queued and keeps their cleanups.
  runEffects(): void;
  runCleanups(): void;
  readonly effects: readonly RecordedEffect[];
  readonly layoutEffects: readonly RecordedEffect[];
  // Values handed to useRef, in call order, so a test can drive a ref the
  // component stored.
  readonly refs: ReadonlyArray<{ current: unknown }>;
}

export function createRecordingReact(): RecordingReact {
  const effects: RecordedEffect[] = [];
  const layoutEffects: RecordedEffect[] = [];
  const refs: Array<{ current: unknown }> = [];
  const cleanups: Array<() => void> = [];
  return {
    effects,
    layoutEffects,
    refs,
    createElement,
    Component: Component as unknown as ReactComponentClass,
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

export interface RecordingReactRoot extends ReactRoot {
  readonly rendered: readonly unknown[];
  readonly unmounts: number;
  failUnmount: boolean;
}

export interface RecordingReactDom {
  createRoot(container: unknown): RecordingReactRoot;
  readonly roots: readonly RecordingReactRoot[];
  readonly hosts: readonly unknown[];
}

export function createRecordingReactDom(): RecordingReactDom {
  const roots: RecordingReactRoot[] = [];
  const hosts: unknown[] = [];
  return {
    roots,
    hosts,
    createRoot(container) {
      hosts.push(container);
      const rendered: unknown[] = [];
      let unmounts = 0;
      const root: RecordingReactRoot = {
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

export interface RecordingReactFlow {
  default: typeof ReactFlowComponent;
  Background: typeof Background;
  Controls: typeof Controls;
  Handle: typeof Handle;
  Position: typeof Position;
  useNodesState(
    initial: readonly GraphNode[]
  ): [readonly GraphNode[], (next: readonly GraphNode[]) => void, unknown];
  useEdgesState(
    initial: readonly GraphEdge[]
  ): [readonly GraphEdge[], (next: readonly GraphEdge[]) => void, unknown];
  readonly nodeUpdates: ReadonlyArray<readonly GraphNode[]>;
  readonly edgeUpdates: ReadonlyArray<readonly GraphEdge[]>;
}

export function createRecordingReactFlow(): RecordingReactFlow {
  const nodeUpdates: Array<readonly GraphNode[]> = [];
  const edgeUpdates: Array<readonly GraphEdge[]> = [];
  return {
    default: ReactFlowComponent,
    Background,
    Controls,
    Handle,
    Position,
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

// The real engine cannot be asked to fail, and it places every node it is
// given, so the two fallbacks a page must survive keep a recording stand-in:
// an engine that throws, and a node the engine declined to place.
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

export const realDagre = dagre as unknown as DagreLike;

export interface GraphVendorHarness extends GraphVendor {
  react: RecordingReact;
  reactDom: RecordingReactDom;
  reactFlow: RecordingReactFlow;
  dagre: DagreLike | null;
}

export function createGraphVendor(
  options: { dagre?: boolean } = {}
): GraphVendorHarness {
  return {
    react: createRecordingReact(),
    reactDom: createRecordingReactDom(),
    reactFlow: createRecordingReactFlow(),
    dagre: options.dagre === false ? null : realDagre
  };
}

// The real engine reports positions but not how often it was asked for them,
// so a test that asserts a layout ran once, twice or not at all takes the
// recording engine instead.
export interface RecordingGraphVendorHarness extends GraphVendorHarness {
  dagre: FakeDagre;
}

export function createRecordingGraphVendor(): RecordingGraphVendorHarness {
  return { ...createGraphVendor(), dagre: createFakeDagre() };
}

// A real instance only exists once React Flow has mounted in a browser, so the
// viewport port stays recorded here and is exercised for real in Chromium.
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
