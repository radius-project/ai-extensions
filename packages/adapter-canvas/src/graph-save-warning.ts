import type { CanvasState } from "./shared.js";

export const GRAPH_SAVE_WARNING_ID = "graph-save-warning";
export const GRAPH_SAVE_WARNING =
  "The application graph is available here, but the saved app-graph.json may be stale because the new graph could not be saved.";

export interface GraphSaveWarningIdentity {
  workspacePath: string | undefined;
  repo: string;
  branch: string;
  definitionHash: string;
}

export function clearGraphSaveWarningForSelection(
  state: CanvasState,
  repo: string,
  branch: string
): void {
  const warning = state.graphSaveWarning;
  if (
    warning &&
    (warning.workspacePath !== state.workspacePath ||
      warning.repo !== repo ||
      warning.branch !== branch)
  ) {
    delete state.graphSaveWarning;
  }
}

export function modeledGraphSaveWarning(
  state: CanvasState,
  repo: string,
  branch: string
): { saveWarning?: string } {
  const warning = state.graphSaveWarning;
  return (
      warning &&
        warning.workspacePath === state.workspacePath &&
        warning.repo === repo &&
        warning.branch === branch &&
        warning.definitionHash === state.graphDefinitionHash
    ) ?
      { saveWarning: GRAPH_SAVE_WARNING }
    : {};
}
