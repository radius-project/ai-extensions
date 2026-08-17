// Canvas adapter — the vendored graph libraries as narrow injected ports.
//
// React, ReactDOM, React Flow and dagre are inlined into the page by vendor.ts
// and reach the browser as globals. Every graph module receives them through
// these interfaces instead of reading a global, so a unit test can drive the
// real rendering decisions with recording fakes, and a page whose vendor bundle
// did not load reports that instead of throwing somewhere deeper.

import { isCallable, isRecord } from "../json.js";
import type { DagreLike } from "./layout.js";
import type { GraphEdge, GraphNode } from "./build.js";

export interface ReactRef<T> {
  current: T;
}

export type ReactCleanup = (() => void) | void;

export interface ReactComponentInstance {
  props: Record<string, unknown>;
  state: Record<string, unknown>;
}

export type ReactComponentClass = new (
  props: Record<string, unknown>
) => ReactComponentInstance;

export interface ReactLike {
  createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
  useRef<T>(initial: T): ReactRef<T>;
  useEffect(effect: () => ReactCleanup, deps?: readonly unknown[]): void;
  useLayoutEffect(effect: () => ReactCleanup, deps?: readonly unknown[]): void;
  Component: ReactComponentClass;
}

export interface ReactRoot {
  render(element: unknown): void;
  unmount(): void;
}

export interface ReactDomLike {
  createRoot(container: unknown): ReactRoot;
}

// React Flow's state hooks return [value, setValue, onChange].
export type StateHook<T> = (
  initial: readonly T[]
) => [readonly T[], (next: readonly T[]) => void, unknown];

export interface ReactFlowInstance {
  fitView(options: Record<string, unknown>): void;
}

export interface ReactFlowLike {
  default: unknown;
  Background: unknown;
  Controls: unknown;
  Handle: unknown;
  Position: { Top: unknown; Bottom: unknown };
  useNodesState: StateHook<GraphNode>;
  useEdgesState: StateHook<GraphEdge>;
}

export interface GraphVendor {
  readonly react: ReactLike;
  readonly reactDom: ReactDomLike;
  readonly reactFlow: ReactFlowLike;
  // Optional: layoutGraph falls back to a single column without it.
  readonly dagre: DagreLike | null;
}

function readMember(scope: unknown, name: string): unknown {
  return isRecord(scope) ? scope[name] : undefined;
}

function isReactLike(value: unknown): value is ReactLike {
  return (
    isRecord(value) &&
    isCallable(value.createElement) &&
    isCallable(value.useRef) &&
    isCallable(value.useEffect) &&
    isCallable(value.useLayoutEffect) &&
    isCallable(value.Component)
  );
}

function isReactDomLike(value: unknown): value is ReactDomLike {
  return isRecord(value) && isCallable(value.createRoot);
}

function isReactFlowLike(value: unknown): value is ReactFlowLike {
  return (
    isRecord(value) &&
    value.default !== undefined &&
    isCallable(value.useNodesState) &&
    isCallable(value.useEdgesState) &&
    isRecord(value.Position)
  );
}

function isDagreLike(value: unknown): value is DagreLike {
  const graphlib = readMember(value, "graphlib");
  return (
    isRecord(value) &&
    isCallable(value.layout) &&
    isRecord(graphlib) &&
    isCallable(graphlib.Graph)
  );
}

// Resolve the vendored libraries from the page's global object. Null means the
// inlined vendor bundle is not present, which the renderer reports as a
// recoverable "graph library failed to load" state rather than an exception.
export function resolveGraphVendor(scope: unknown): GraphVendor | null {
  const react = readMember(scope, "React");
  const reactDom = readMember(scope, "ReactDOM");
  const reactFlow = readMember(scope, "ReactFlow");
  if (
    !isReactLike(react) ||
    !isReactDomLike(reactDom) ||
    !isReactFlowLike(reactFlow)
  ) {
    return null;
  }
  const dagre = readMember(scope, "dagre");
  return {
    react,
    reactDom,
    reactFlow,
    dagre: isDagreLike(dagre) ? dagre : null
  };
}
