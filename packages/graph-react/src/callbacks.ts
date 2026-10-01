import type { GraphNodeData } from "./build.js";

export interface GraphCallbacks {
  onOpenExternal?(url: string): void;
  onOpenSource?(source: {
    path: string;
    line: number;
    fallbackUrl: string;
  }): void;
  onSelect?(node: GraphNodeData): void;
  onDetails?(node: GraphNodeData, open: boolean): void;
  onNavigate?(node: GraphNodeData): void;
  onRetry?(): void;
  /**
   * Called once when rendering fails and the graph shows its error state, so
   * the host can log or report the failure. Errors thrown here propagate.
   */
  onError?(error: unknown): void;
}
