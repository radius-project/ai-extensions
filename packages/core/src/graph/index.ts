// graph/ — pure application-graph logic: the app-graph.json → canvas converter,
// the shared diff algorithm, the visualization filter, and the deployed-status
// projection. Normalization helpers stay module-internal in ./model.js.

export { applicationGraphToResources } from "./appgraph.js";
export { computeGraphDiff } from "./diff.js";
export { filterGraphVisualizationResources } from "./visualization.js";
export {
  deployStatusKeys,
  findRemovedDeployedResources,
  lookupDeployStatus,
  mergeDeployedGraphMetadata,
  projectDeployedGraph,
  selectApplicationOwnedResources
} from "./deployed.js";
export type {
  ApplicationResourceScope,
  DeployStatus,
  RemovedDeployedResource
} from "./deployed.js";
export {
  classifyLifecycleConclusion,
  lifecycleOutcomeMessage,
  stateSaveFailureWarning,
  unfinishedNodeMessage
} from "./lifecycle.js";
export type { LifecycleOperation, LifecycleOutcome } from "./lifecycle.js";
