// The production graph libraries, unmodified, as the injected graph ports.
//
// These are the same packages and versions the build inlines into
// extension.mjs, so a browser component test drives React's real hooks,
// ReactDOM's real concurrent root, React Flow's real measurement and dagre's
// real layout. Nothing here stands in for a library.
//
// Test-support only: production modules never import this.

import * as React from "react";
import * as ReactDOM from "react-dom/client";
import * as ReactFlow from "@xyflow/react";
import dagre from "dagre";
import "@xyflow/react/dist/style.css";
import type { GraphVendor } from "../../../src/browser/graph/vendor.js";

export function realGraphVendor(): GraphVendor {
  return {
    react: React as unknown as GraphVendor["react"],
    reactDom: ReactDOM as unknown as GraphVendor["reactDom"],
    reactFlow: {
      ...ReactFlow,
      default: ReactFlow.ReactFlow
    } as unknown as GraphVendor["reactFlow"],
    dagre: dagre as unknown as GraphVendor["dagre"]
  };
}

// React Flow measures its container, so a mounted graph needs a host with a
// real box. The element is removed again by the returned disposer.
export function createGraphHost(): { host: HTMLElement; dispose(): void } {
  const host = document.createElement("div");
  host.style.width = "800px";
  host.style.height = "600px";
  document.body.appendChild(host);
  return {
    host,
    dispose() {
      host.remove();
    }
  };
}
