// graph/ — pure application-graph logic: bicep/ARM compilation, regex parsing,
// the modeled-graph builder, and the shared diff algorithm.

export {
  MODELED_GRAPH_DEFAULTS,
  computeDiffHash,
  buildModeledGraph,
  stripAPIVersion,
  addInboundConnections,
  buildResourceID,
} from "./model.js";
export {
  compileBicepToARM,
  buildGraphFromBicep,
  parseBicepResources,
} from "./bicep.js";
export { computeGraphDiff } from "./diff.js";
