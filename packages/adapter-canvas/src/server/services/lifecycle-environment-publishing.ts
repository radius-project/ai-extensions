import {
  portCancelled,
  portFailure,
  sameLifecycleData,
  type PortResult
} from "@radius-project/core/lifecycle";
import type { EnvironmentConfigurationDependencies } from "@radius-project/adapter-shared";
import {
  publishWorkflowFiles,
  type WorkflowPublisherPorts,
  type WorkflowPublisherTarget
} from "../routes/create-environment-workflow-publisher.js";

type Publisher = EnvironmentConfigurationDependencies["publish"];
export function createEnvironmentWorkflowPublisher(deps: {
  resolve(...input: Parameters<Publisher>): Promise<
    PortResult<{
      ports: WorkflowPublisherPorts;
      target: WorkflowPublisherTarget;
    }>
  >;
  readPublished: Publisher;
}): Publisher {
  if (
    typeof deps.resolve !== "function" ||
    typeof deps.readPublished !== "function"
  )
    throw new Error(
      "Environment publishing requires a scoped publisher and actual publication evidence."
    );
  return async (scope, preview, control) => {
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const binding = await deps.resolve(scope, preview, control);
    if (binding.status !== "ok") return binding;
    const { ports, target } = binding.value;
    const provider =
      preview.intent.change.operation === "environment.create" ?
        preview.intent.change.configuration.provider
      : preview.intent.change.patch.provider;
    if (
      scope.operationId !== target.operation.operationId ||
      target.targetRepo !== scope.target.repo ||
      target.envName !== scope.target.environment ||
      target.provider !== provider ||
      target.setupPushOperationMarker ||
      !sameLifecycleData(preview.intent.target, scope.target) ||
      preview.intent.operation !== scope.operation
    )
      return portFailure("PRECONDITION_FAILED");
    const [verify, deploy, deletion] = await Promise.all([
      ports.generateVerifyWorkflow(target.envName, provider),
      ports.generateDeployWorkflow(target.envName, ".radius/app.bicep"),
      ports.generateDeleteWorkflow(target.envName)
    ]);
    if (!sameLifecycleData(deploy, preview.assets.selectedFiles))
      return portFailure("EVIDENCE_MISMATCH");
    if (control.cancellation.aborted || !(await ports.gate()))
      return portCancelled("request_cancelled");
    const result = await publishWorkflowFiles(
      {
        ...ports,
        generateVerifyWorkflow: async () => verify,
        generateDeployWorkflow: async () => deploy,
        generateDeleteWorkflow: async () => deletion,
        gate: async () => !control.cancellation.aborted && (await ports.gate())
      },
      target
    );
    if (result.outcome === "cancelled")
      return portCancelled("request_cancelled");
    if (result.outcome === "refused") return portFailure("PRECONDITION_FAILED");
    return deps.readPublished(scope, preview, control);
  };
}
