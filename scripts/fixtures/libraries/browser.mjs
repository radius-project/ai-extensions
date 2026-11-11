import "@radius-project/graph-react/styles.css";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { RadiusGraph } from "@radius-project/graph-react";
import { normalizeLiveGraph } from "@radius-project/core/graph";

const prefix =
  "/planes/radius/local/resourceGroups/demo/providers/Radius.Core/";
const graph = normalizeLiveGraph(
  {
    resources: [
      {
        id: prefix + "containers/web",
        name: "web",
        type: "Radius.Core/containers",
        iconHash: "f".repeat(64),
        provisioningState: "CandidatePending",
        connections: [{ id: prefix + "databases/db", direction: "Outbound" }]
      },
      { id: prefix + "databases/db", name: "db", type: "Radius.Core/databases" }
    ],
    icons: {
      ["f".repeat(64)]:
        '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" onload="document.body.dataset.iconExecuted = 1"><script>document.body.dataset.iconExecuted = 1</script><image href="https://icons.example.test/beacon"/><rect width="13" height="13" fill="#126789"/></svg>'
    }
  },
  {
    connectionId: "isolated-packed-smoke",
    plane: { type: "radius", name: "local" },
    applicationId: prefix + "applications/example"
  }
);
const root = createRoot(globalThis.document.getElementById("root"));
root.render(createElement(RadiusGraph, { graph }));

export { RadiusGraph, mountRadiusGraph } from "@radius-project/graph-react";
export { normalizeLiveGraph } from "@radius-project/core/graph";
export { parseResourceId } from "@radius-project/core/domain";
