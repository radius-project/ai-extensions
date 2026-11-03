import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "reactflow";
import { ResourceNode } from "@radius-project/graph-react/compat/reactflow11";
import "reactflow/dist/base.css";

createRoot(globalThis.document.getElementById("root")).render(
  h(
    ReactFlowProvider,
    null,
    h(ResourceNode, {
      data: {
        id: "/planes/radius/local/resourceGroups/demo/providers/Applications.Core/containers/web",
        name: "standalone-legacy-web",
        type: "Applications.Core/containers",
        provider: "Applications.Core",
        provisioningState: "RawPending"
      }
    })
  )
);
