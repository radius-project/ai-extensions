import { registerRoute } from "@kinvolk/headlamp-plugin/lib";
import { useTheme } from "@mui/material";
import { useState } from "react";
import { RadiusGraph } from "@radius-project/graph-react";
import type { GraphStyle } from "@radius-project/graph-react";
import { normalizeLiveGraph } from "@radius-project/core/graph";
import { parseResourceId } from "@radius-project/core/domain";
import "@radius-project/graph-react/styles.css";
import { Away, HeadlampFrame } from "./peer";

const prefix =
  "/planes/radius/local/resourceGroups/demo/providers/Radius.Core/";
const applicationId = prefix + "applications/headlamp";
if (!parseResourceId(applicationId)) {
  throw new Error("Packed graph helper exports are unavailable.");
}
const graph = normalizeLiveGraph(
  {
    resources: [
      {
        id: prefix + "containers/web",
        name: "web",
        type: "Radius.Core/containers",
        provisioningState: "Succeeded",
        connections: [{ id: prefix + "databases/db", direction: "Outbound" }]
      },
      {
        id: prefix + "databases/db",
        name: "db",
        type: "Radius.Core/databases"
      }
    ]
  },
  {
    connectionId: "headlamp-offline-fixture",
    plane: { type: "radius", name: "local" },
    applicationId
  }
);
const style: GraphStyle = { "--radius-graph-host-token": "14px" };
const modeled = {
  kind: "modeled" as const,
  resources: [
    {
      id: "modeled-web",
      name: "modeled-web",
      type: "Radius.Core/containers",
      codeReference: "src/web.ts"
    }
  ]
};

function HeadlampGraphConsumer() {
  const theme = useTheme();
  const [visible, setVisible] = useState(true);
  const [selected, setSelected] = useState("");
  return (
    <HeadlampFrame>
      <button onClick={() => setVisible(!visible)}>Toggle Radius graph</button>
      <output aria-label='Graph navigation'>{selected}</output>
      <div style={{ width: 850, height: 600 }}>
        {visible && (
          <RadiusGraph
            graph={graph}
            appearance='default'
            style={style}
            theme={{
              colorScheme: theme.palette.mode,
              background: theme.palette.background.paper,
              text: theme.palette.text.primary,
              accent: theme.palette.primary.main
            }}
            callbacks={{ onNavigate: (node) => setSelected(node.id) }}
          />
        )}
      </div>
      <div style={{ width: 650, height: 500 }}>
        {visible && (
          <RadiusGraph
            graph={modeled}
            ariaLabel='Modeled source graph'
            options={{
              repoUrl: "https://github.com/radius-project/offline-fixture",
              branch: "main"
            }}
            callbacks={{ onOpenExternal: setSelected }}
          />
        )}
      </div>
    </HeadlampFrame>
  );
}

registerRoute({
  path: "/radius-graph-compatibility",
  sidebar: null,
  useClusterURL: false,
  noAuthRequired: true,
  component: HeadlampGraphConsumer
});

registerRoute({
  path: "/radius-graph-away",
  sidebar: null,
  useClusterURL: false,
  noAuthRequired: true,
  component: Away
});
