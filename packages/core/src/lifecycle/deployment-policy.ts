import type { LifecycleRequestFor } from "./contracts/catalog.js";
import type {
  AuthorizedScope,
  ReadonlyData,
  WorkflowPreparation
} from "./ports.js";
import { portFailure, portForbidden, portSuccess } from "./errors.js";
import { sameLifecycleData } from "./operations.js";
import { validateSourceSelection } from "./source.js";

export const DEPLOYMENT_COMPLETION_PHASES = [
  "dispatch",
  "checkout",
  "restore",
  "command",
  "state-save",
  "cleanup"
] as const;

export function buildDeploymentPolicy(input: WorkflowPreparation) {
  const { scope, correlation, intent, source } = input;
  if (intent.operation !== "deployment.start")
    return portFailure("VERSION_UNSUPPORTED");
  const target = intent.target;
  const selection = validateSourceSelection(target);
  if (selection.status !== "ok") return selection;
  if (
    source.kind !== "git" ||
    target.source.kind !== "git" ||
    source.commit !== target.source.expectedCommit ||
    source.repo !== target.repo ||
    source.ref !== target.source.ref ||
    correlation.expectedCommit !== source.commit
  )
    return portFailure("SOURCE_CHANGED");
  if (
    scope.operation !== intent.operation ||
    !sameLifecycleData(scope.target, target) ||
    !sameLifecycleData(scope.source, source) ||
    !scope.approvalRef ||
    !scope.authorizationRef ||
    scope.operationId !== correlation.operationId
  )
    return portForbidden();
  if (
    correlation.operation !== intent.operation ||
    !sameLifecycleData(correlation.target, {
      repo: target.repo,
      environment: target.environment,
      application: target.application
    }) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(correlation.operationId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(correlation.attemptId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.application) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.environment)
  )
    return portFailure("INVALID_REQUEST");
  return portSuccess({
    operation: intent.operation,
    target,
    requiredPhases: DEPLOYMENT_COMPLETION_PHASES,
    argv: [
      "deploy",
      target.definition,
      "--environment",
      target.environment,
      "--application",
      target.application
    ],
    inputs: {
      environment: target.environment,
      lifecycle_version: "1",
      lifecycle_operation: intent.operation,
      operation_id: correlation.operationId,
      attempt_id: correlation.attemptId,
      expected_commit: source.commit
    }
  });
}

export type DeploymentScope = AuthorizedScope<"deployment.start">;
export type DeploymentTarget = ReadonlyData<
  LifecycleRequestFor<"deployment.start">["target"]
>;
