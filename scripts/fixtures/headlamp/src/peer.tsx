import { useTheme } from "@mui/material";
import { Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { version } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

const nodes = [
  {
    id: "headlamp-node",
    position: { x: 20, y: 30 },
    data: { label: "Headlamp Flow 12" }
  },
  {
    id: "headlamp-target",
    position: { x: 220, y: 150 },
    data: { label: "Headlamp Flow 12 target" }
  }
];
const edges = [
  { id: "peer-edge", source: "headlamp-node", target: "headlamp-target" }
];

export function HeadlampFrame({ children }: { children?: ReactNode }) {
  const theme = useTheme();
  return (
    <main aria-label='Radius Headlamp compatibility'>
      <h1>Radius graph in Headlamp</h1>
      <output aria-label='Host React version'>{version}</output>
      <output aria-label='Host MUI mode'>{theme.palette.mode}</output>
      <Link to='/radius-graph-away'>Leave compatibility route</Link>
      <div className='headlamp-peer-flow' style={{ width: 400, height: 240 }}>
        <ReactFlow nodes={nodes} edges={edges} fitView>
          <Controls />
        </ReactFlow>
      </div>
      {children}
    </main>
  );
}

export function Away() {
  return (
    <Link to='/radius-graph-compatibility'>Reopen compatibility route</Link>
  );
}
