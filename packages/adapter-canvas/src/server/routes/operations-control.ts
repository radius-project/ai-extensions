import type { CanvasRequestContext } from "../request-context.js";
import {
  templatePathParameters,
  type RouteHandlerRegistry
} from "../route-table.js";
import {
  createOperationsControlService,
  type OperationControlInput,
  type OperationControlService,
  type OperationsControlDependencies
} from "../services/operation-control.js";

export {
  retryRefusalMessage,
  type OperationsControlDependencies,
  type OperationScheduleKind,
  type RepositoryLockResult
} from "../services/operation-control.js";

export const STOP_OPERATION_ROUTE = "/api/operations/:operationId/stop";
export const CONTINUE_OPERATION_ROUTE = "/api/operations/:operationId/continue";
export const ROLLBACK_OPERATION_ROUTE = "/api/operations/:operationId/rollback";
export const EXIT_OPERATION_ROUTE = "/api/operations/:operationId/exit";
export const CANCEL_WORKFLOW_ROUTE =
  "/api/operations/:operationId/cancel-workflow";
export const RETRY_OPERATION_ROUTE =
  "/api/operations/:operationId/retry/:retryKind";

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

async function runControlRoute(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies,
  template: string,
  command: OperationControlInput["command"],
  service = createOperationsControlService(dependencies)
): Promise<void> {
  await context.readTextBody();
  const params = templatePathParameters(template, context.pathname);
  await service(
    {
      instanceId: context.instanceId,
      operationId: decodeSegment(params?.operationId ?? ""),
      command,
      retryKind: decodeSegment(params?.retryKind ?? ""),
      abandon: context.url.searchParams.get("mode") === "abandon"
    },
    ({ status, body }) => {
      context.response.setHeader("Content-Type", "application/json");
      context.response.setHeader("Cache-Control", "no-store");
      context.response.writeHead(status);
      context.response.end(JSON.stringify(body));
    }
  );
}

export function handleStopOperation(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies
): Promise<void> {
  return runControlRoute(context, dependencies, STOP_OPERATION_ROUTE, "stop");
}

export function handleContinueOperation(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies
): Promise<void> {
  return runControlRoute(
    context,
    dependencies,
    CONTINUE_OPERATION_ROUTE,
    "continue"
  );
}

export function handleCancelWorkflow(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies
): Promise<void> {
  return runControlRoute(
    context,
    dependencies,
    CANCEL_WORKFLOW_ROUTE,
    "cancel-workflow"
  );
}

export function handleRollbackOperation(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies
): Promise<void> {
  return runControlRoute(
    context,
    dependencies,
    ROLLBACK_OPERATION_ROUTE,
    "rollback"
  );
}

export function handleExitOperation(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies
): Promise<void> {
  return runControlRoute(context, dependencies, EXIT_OPERATION_ROUTE, "exit");
}

export function handleRetryOperation(
  context: CanvasRequestContext,
  dependencies: OperationsControlDependencies
): Promise<void> {
  return runControlRoute(context, dependencies, RETRY_OPERATION_ROUTE, "retry");
}

export function createOperationsControlRoutes(
  dependencies: OperationsControlDependencies,
  service: OperationControlService = createOperationsControlService(
    dependencies
  )
): RouteHandlerRegistry {
  const bind =
    (template: string, command: OperationControlInput["command"]) =>
    (context: CanvasRequestContext) =>
      runControlRoute(context, dependencies, template, command, service);
  return {
    [`POST ${STOP_OPERATION_ROUTE}`]: bind(STOP_OPERATION_ROUTE, "stop"),
    [`POST ${CONTINUE_OPERATION_ROUTE}`]: bind(
      CONTINUE_OPERATION_ROUTE,
      "continue"
    ),
    [`POST ${CANCEL_WORKFLOW_ROUTE}`]: bind(
      CANCEL_WORKFLOW_ROUTE,
      "cancel-workflow"
    ),
    [`POST ${ROLLBACK_OPERATION_ROUTE}`]: bind(
      ROLLBACK_OPERATION_ROUTE,
      "rollback"
    ),
    [`POST ${EXIT_OPERATION_ROUTE}`]: bind(EXIT_OPERATION_ROUTE, "exit"),
    [`POST ${RETRY_OPERATION_ROUTE}`]: bind(RETRY_OPERATION_ROUTE, "retry")
  };
}
