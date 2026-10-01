import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { RadiusGraph } from "@radius-project/graph-react";

const graph = {
  kind: "modeled",
  resources: [
    {
      id: "web",
      name: "web",
      type: "Radius.Core/containers",
      codeReference: "src/web.ts",
      diffStatus: "modified",
      deployStatus: "running",
      provisioningState: "CandidatePending",
      connections: [{ id: "db", direction: "Outbound" }]
    },
    { id: "db", name: "db", type: "Radius.Core/databases" }
  ]
};
const options = {
  showLegend: true,
  repoUrl: "https://github.com/radius-project/packed-fixture",
  branch: "main"
};

function Host({ includeDefault }) {
  const [opened, setOpened] = useState("");
  return h(
    "main",
    null,
    h(
      "button",
      {
        id: "restyle",
        onClick: () => {
          const link = globalThis.document.createElement("link");
          link.rel = "stylesheet";
          link.href = "/host-alternate.css";
          globalThis.document.head.append(link);
        }
      },
      "Change host stylesheet"
    ),
    h("output", { id: "opened-link" }, opened),
    h(
      "div",
      { className: "host-grid" },
      includeDefault ?
        h(
          "div",
          { className: "host-frame" },
          h(RadiusGraph, {
            graph,
            options,
            ariaLabel: "Default styled graph",
            className: "packed-default"
          })
        )
      : null,
      h(
        "div",
        { className: "host-frame" },
        h(RadiusGraph, {
          graph,
          options,
          appearance: "custom",
          ariaLabel: "Custom styled graph",
          className: "packed-custom",
          callbacks: { onOpenExternal: setOpened }
        })
      )
    )
  );
}

export function mountStyledGraphs(includeDefault) {
  const root = createRoot(globalThis.document.getElementById("root"));
  root.render(h(Host, { includeDefault }));
}
