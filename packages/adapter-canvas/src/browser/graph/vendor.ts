// Canvas adapter — the graph libraries as narrow injected ports. Production
// receives the esbuild-bundled modules while tests provide recording fakes.

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
