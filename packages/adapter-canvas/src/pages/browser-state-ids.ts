// Stable element ids shared by server-rendered page state and the generated
// browser entries that consume it. Keeping these behavior-free contracts under
// pages prevents executable browser modules from entering the Node artifact.

import type { CanvasGraphResource, CanvasState } from "../shared.js";

export const GRAPH_PAGE_STATE_ID = "radius-graph-page-state";
export const PLANNED_GRAPH_STATE_ID = "radius-planned-graph-state";
export const GRAPH_DIFF_STATE_ID = "radius-graph-diff-state";
export const DEPLOYED_GRAPH_STATE_ID = "radius-deployed-graph-state";
export const DEPLOY_RESULT_STATE_ID = "radius-deploy-result-state";
export const DEPLOYING_PAGE_STATE_ID = "radius-deploying-state";
export const ENVIRONMENT_PAGE_STATE_ID = "radius-environment-state";

interface RepositoryPageState {
  repo: string;
  branch: string;
}

export interface PageStateById {
  [GRAPH_PAGE_STATE_ID]: RepositoryPageState & {
    resources: CanvasGraphResource[];
    loaded: boolean;
    localSource: boolean;
    followWorkspaceBranch: boolean;
  };
  [PLANNED_GRAPH_STATE_ID]: RepositoryPageState & {
    environment: string;
    provider: string;
    resources: CanvasGraphResource[];
    localSource: boolean;
    followWorkspaceBranch: boolean;
  };
  [GRAPH_DIFF_STATE_ID]: {
    repo: string;
    base: string;
    head: string;
    workspaceBranch: string;
    resources: CanvasGraphResource[];
    modelingError: string;
  };
  [DEPLOYED_GRAPH_STATE_ID]: RepositoryPageState & {
    graphBranch: string;
    provider: string;
    mutationNonce: string;
  };
  [DEPLOY_RESULT_STATE_ID]: {
    attemptId: string;
  };
  [DEPLOYING_PAGE_STATE_ID]: RepositoryPageState & {
    mutationNonce: string;
  };
  [ENVIRONMENT_PAGE_STATE_ID]: RepositoryPageState & {
    activeSubtab: "credentials" | "environments";
    ghCommandPresentation?: CanvasState["ghCommandPresentation"];
    mutationNonce: string;
  };
}

export type PageStateId = keyof PageStateById;
