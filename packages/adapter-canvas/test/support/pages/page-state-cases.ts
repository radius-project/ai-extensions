import {
  DEPLOYED_GRAPH_STATE_ID,
  DEPLOYING_PAGE_STATE_ID,
  DEPLOY_RESULT_STATE_ID,
  ENVIRONMENT_PAGE_STATE_ID,
  GRAPH_DIFF_STATE_ID,
  GRAPH_PAGE_STATE_ID,
  PLANNED_GRAPH_STATE_ID,
  type PageStateById,
  type PageStateId
} from "../../../src/pages/browser-state-ids.js";
import type { CanvasGraphResource, CanvasState } from "../../../src/shared.js";

// Space-free and accepted by `git check-ref-format --branch`. The sentinel
// only records execution; these fixtures never invoke alerts or external URLs.
export const HOSTILE_GIT_BRANCH =
  "topic</script><svg/onload=globalThis.__radiusStateExecuted=1>";
export const HOSTILE_PAGE_TEXT =
  "end</ScRiPt></div><script>globalThis.__radiusStateExecuted=1</script>" +
  '<svg onload="globalThis.__radiusStateExecuted=1" data-state-injected>' +
  "<!--<script>&amp;&quot;&#39;'\"\\\u0000\b\f\r\n\t\u2028\u2029\ud83d\ude00\ud800|\udfff";
export const STATE_REPOSITORY = "fixture/radius-app";
export const STATE_ATTEMPT_ID = `attempt:${HOSTILE_PAGE_TEXT}`;
export const STATE_MUTATION_NONCE = "page-state-fixture-nonce";

export const STATE_RESOURCE: CanvasGraphResource = {
  id: "fixture/web",
  name: HOSTILE_PAGE_TEXT,
  type: "Applications.Core/containers",
  connections: [],
  diffStatus: "unchanged"
};

interface PageStateCase {
  name: string;
  page: string;
  id: PageStateId;
  state: CanvasState;
  expected: PageStateById[PageStateId];
  marker: string;
}

export function pageStateCases(
  mutationNonce = STATE_MUTATION_NONCE
): PageStateCase[] {
  const context: CanvasState = {
    contextRepo: STATE_REPOSITORY,
    contextBranch: HOSTILE_GIT_BRANCH,
    browserMutationNonce: mutationNonce,
    graphFromWorkspace: false,
    graphFollowsWorkspaceBranch: false,
    plannedFromWorkspace: false,
    plannedFollowsWorkspaceBranch: false
  };
  const repository = {
    repo: STATE_REPOSITORY,
    branch: HOSTILE_GIT_BRANCH
  };
  const planned = {
    ...repository,
    environment: HOSTILE_PAGE_TEXT,
    provider: "azure",
    localSource: false,
    followWorkspaceBranch: false
  };
  const diff = {
    repo: STATE_REPOSITORY,
    base: "main",
    head: HOSTILE_GIT_BRANCH,
    workspaceBranch: HOSTILE_GIT_BRANCH,
    modelingError: HOSTILE_PAGE_TEXT
  };
  return [
    {
      name: "modeled graph",
      page: "graph",
      id: GRAPH_PAGE_STATE_ID,
      state: { ...context, graphResources: [STATE_RESOURCE] },
      expected: {
        ...repository,
        resources: [STATE_RESOURCE],
        loaded: true,
        localSource: false,
        followWorkspaceBranch: false
      },
      marker: "modeled-subtitle"
    },
    ...[false, true].map((populated): PageStateCase => ({
      name: `planned graph ${populated ? "populated" : "empty"}`,
      page: "planned",
      id: PLANNED_GRAPH_STATE_ID,
      state: {
        ...context,
        plannedEnvironment: HOSTILE_PAGE_TEXT,
        plannedResources: populated ? [STATE_RESOURCE] : []
      },
      expected: {
        ...planned,
        resources: populated ? [STATE_RESOURCE] : []
      },
      marker: "planned-subtitle"
    })),
    ...[false, true].map((populated): PageStateCase => ({
      name: `graph diff ${populated ? "populated" : "empty"}`,
      page: "graph-diff",
      id: GRAPH_DIFF_STATE_ID,
      state: {
        ...context,
        diffBase: "main",
        diffHead: HOSTILE_GIT_BRANCH,
        workspacePath: "fixture-workspace",
        workspaceRepo: STATE_REPOSITORY,
        workspaceBranch: HOSTILE_GIT_BRANCH,
        diffModelingFailed: true,
        diffError: HOSTILE_PAGE_TEXT,
        diffResources: populated ? [STATE_RESOURCE] : []
      },
      expected: { ...diff, resources: populated ? [STATE_RESOURCE] : [] },
      marker: "graph-diff-subtitle"
    })),
    {
      name: "deployed graph",
      page: "deployed",
      id: DEPLOYED_GRAPH_STATE_ID,
      state: context,
      expected: {
        ...repository,
        graphBranch: HOSTILE_GIT_BRANCH,
        provider: "azure",
        mutationNonce
      },
      marker: "deployed-subtitle"
    },
    {
      name: "deployments",
      page: "deploying",
      id: DEPLOYING_PAGE_STATE_ID,
      state: context,
      expected: { ...repository, mutationNonce },
      marker: "deploy-app-select"
    },
    {
      name: "environments",
      page: "environment",
      id: ENVIRONMENT_PAGE_STATE_ID,
      state: context,
      expected: {
        ...repository,
        activeSubtab: "environments",
        mutationNonce
      },
      marker: "env-subtabs"
    },
    {
      name: "deployment result",
      page: "environment",
      id: DEPLOY_RESULT_STATE_ID,
      state: {
        ...context,
        deployResult: { message: HOSTILE_PAGE_TEXT },
        deployAttempt: { id: STATE_ATTEMPT_ID }
      },
      expected: { attemptId: STATE_ATTEMPT_ID },
      marker: "back-btn"
    }
  ];
}
