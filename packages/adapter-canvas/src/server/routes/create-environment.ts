import type { IncomingMessage } from "node:http";
import {
  runCreateEnvironment,
  type CreateEnvironmentDependencies as EnvironmentDependencies
} from "@radius-project/core/github-radius/environments/create-environment";
import type { CanvasState } from "../../shared.js";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import {
  refuseUnlessServerOwned,
  type CreateEnvironmentRequestData
} from "./create-environment-refusals.js";
import {
  createWorkflowScopeGhRunner,
  type WorkflowScopeGhRunnerPorts
} from "./create-environment-gh-runner.js";
import { createWorkflowFileCommitter } from "./create-environment-workflow-committer.js";
import { LEGACY_DEPLOY_WORKFLOW_FILE } from "../../infra.js";
import * as operationDomain from "../../operations.js";

export interface CreateEnvironmentInstanceEntry {
  state: CanvasState;
}

export interface CreateEnvironmentDependencies
  extends
    Omit<
      EnvironmentDependencies,
      | "createWorkflowScopeGhRunner"
      | "createWorkflowFileCommitter"
      | "verificationDispatched"
      | "legacyDeployWorkflowFile"
      | "operationDomain"
    >,
    WorkflowScopeGhRunnerPorts {
  isServerOwnedRequest(instanceId: string, request: IncomingMessage): boolean;
  readInstanceEntry(
    instanceId: string
  ): CreateEnvironmentInstanceEntry | undefined;
}

export function environmentSetupDependencies(
  dependencies: CreateEnvironmentDependencies,
  instanceId: string
): EnvironmentDependencies {
  return {
    ...dependencies,
    operationDomain,
    legacyDeployWorkflowFile: LEGACY_DEPLOY_WORKFLOW_FILE,
    createWorkflowScopeGhRunner: (target, executor) =>
      createWorkflowScopeGhRunner(dependencies, target, executor),
    createWorkflowFileCommitter,
    verificationDispatched({ dispatchedAt, runId, runUrl }) {
      const entry = dependencies.readInstanceEntry(instanceId);
      if (!entry) return;
      entry.state.deployDispatchedAt = dispatchedAt;
      entry.state.verifyRunId = runId;
      entry.state.verifyRunUrl = runUrl;
    }
  };
}

export async function handleCreateEnvironment(
  context: CanvasRequestContext,
  dependencies: CreateEnvironmentDependencies
): Promise<void> {
  const respond = (status: number, body: Record<string, unknown>) => {
    context.response.setHeader("Content-Type", "application/json");
    context.response.writeHead(status);
    context.response.end(JSON.stringify(body));
  };
  const refusal = refuseUnlessServerOwned(
    dependencies.isServerOwnedRequest(context.instanceId, context.request)
  );
  if (refusal) {
    respond(refusal.status, refusal.body);
    return;
  }
  const body = await context.readTextBody();
  let data: CreateEnvironmentRequestData;
  try {
    data = JSON.parse(body);
  } catch (error) {
    const failure = await dependencies.finalizeSetupFailure(null, {
      status: 400,
      error: dependencies.errorMessage(error),
      code: "create-environment-unhandled",
      classification: "unknown",
      evidence: error instanceof Error ? error.stack || null : null,
      steps: [],
      runAz: null,
      runGitHubVariable: null,
      runDeleteEnvironment: null,
      readEnvironment: null
    });
    respond(failure.status, failure.body);
    return;
  }
  const result = await runCreateEnvironment(
    data,
    environmentSetupDependencies(dependencies, context.instanceId)
  );
  respond(result.status, result.body);
}

export function createCreateEnvironmentRoutes(
  dependencies: CreateEnvironmentDependencies
): RouteHandlerRegistry {
  return {
    "POST /api/create-environment": (context) =>
      handleCreateEnvironment(context, dependencies)
  };
}
