export const GRAPH_APP_BICEP_TIMEOUT_MS = 300_000;
export const GRAPH_APP_BICEP_TIMEOUT_MESSAGE =
  "Copilot has not produced .radius/app.bicep for this branch. It may be unable to model this repository — check the Copilot conversation for the reason, then reload to try again.";

export const GRAPH_MODELING_FAILURE_MESSAGE =
  "Radius could not build the application graph from .radius/app.bicep. Ask Copilot to review the application model, then try again.";

export class GraphModelingFailure extends Error {
  constructor(cause: unknown) {
    super(GRAPH_MODELING_FAILURE_MESSAGE, { cause });
    this.name = "GraphModelingFailure";
  }
}
