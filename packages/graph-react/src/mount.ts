import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { RadiusGraph } from "./graph.js";
import type { RadiusGraphProps } from "./graph.js";

export interface MountedRadiusGraph {
  update(props: RadiusGraphProps): boolean;
  unmount(): void;
}

/** Compatibility for server-rendered hosts. React hosts render RadiusGraph directly. */
export function mountRadiusGraph(
  host: unknown,
  props: RadiusGraphProps
): MountedRadiusGraph {
  if (!(host instanceof Element))
    throw new TypeError("Graph host must be a DOM element.");
  const root = createRoot(host);
  let mounted = true;
  root.render(createElement(RadiusGraph, props));
  return {
    update(next) {
      if (!mounted) return false;
      root.render(createElement(RadiusGraph, next));
      return true;
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      root.unmount();
    }
  };
}
