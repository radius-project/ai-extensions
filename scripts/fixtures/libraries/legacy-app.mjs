import "@radius-project/graph-react/styles.css";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { AppGraph } from "@radius-project/graph-react/compat";

const prefix = "/planes/radius/local/resourceGroups/demo/providers/";
const web = {
  id: prefix + "Applications.Core/containers/web",
  name: "legacy-web",
  type: "Applications.Core/containers",
  provider: "Applications.Core",
  provisioningState: "RawPending"
};
const dependency = {
  ...web,
  id: prefix + "Applications.Core/gateways/edge",
  name: "edge",
  type: "Applications.Core/gateways"
};
createRoot(globalThis.document.getElementById("root")).render(
  h(AppGraph, {
    graph: {
      name: "context-free",
      resources: [
        { ...web, connections: [{ id: dependency.id, direction: "Inbound" }] },
        dependency
      ]
    }
  })
);
