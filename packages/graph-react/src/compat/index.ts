import { createElement as h, useMemo } from "react";
import type { ReactElement } from "react";
import { normalizeLegacyLiveGraph } from "@radius-project/core/graph";
import type { LegacyAppGraphData } from "@radius-project/core/graph";
import { RadiusGraph } from "../graph.js";

export type { LegacyAppGraphData as AppGraphData } from "@radius-project/core/graph";

/** Context-free legacy input is explicit; it is never a selected live query. */
export function AppGraph({
  graph
}: {
  graph: LegacyAppGraphData;
}): ReactElement {
  const normalized = useMemo(() => normalizeLegacyLiveGraph(graph), [graph]);
  return h(RadiusGraph, {
    graph: normalized,
    style: { width: "100%", height: "100%", minHeight: 0 },
    options: { enablePopup: false, showLegend: false }
  });
}
