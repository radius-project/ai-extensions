import { createElement as h } from "react";
import { Handle, Position } from "reactflow";
import type { ReactElement } from "react";
import type { LegacyResource } from "@radius-project/core/graph";
import { buildGraph, resolveGraphSettings } from "../build.js";
import { ResourceNodeCard } from "../node-card.js";

const settings = resolveGraphSettings({
  liveMode: true,
  legacyMode: true,
  enablePopup: false,
  showLegend: false
});

/** The optional Flow 11 peer supplies handles; card presentation stays shared. */
export function ResourceNode({ data }: { data: LegacyResource }): ReactElement {
  const built = buildGraph(settings, [data]);
  return h(ResourceNodeCard, {
    data: built.nodes[0].data,
    interaction: { settings, callbacks: {}, showDetails() {} },
    targetHandle: h(Handle, { type: "target", position: Position.Top }),
    sourceHandle: h(Handle, { type: "source", position: Position.Bottom })
  });
}
