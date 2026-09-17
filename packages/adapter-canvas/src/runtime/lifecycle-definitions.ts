import {
  LIFECYCLE_API_VERSION,
  createDefinitionAuthoring,
  createDefinitionValidation,
  lifecycleError,
  registerLifecycleOperation,
  type DefinitionAuthoringDependencies,
  type DefinitionAuthoringSourcePort,
  type DefinitionValidationPort,
  type SourceAccessPort,
  type LifecycleErrorResponse,
  type LifecycleReadCapability,
  type PortResult
} from "@radius-project/core/lifecycle";
import type { LifecycleAgent } from "./lifecycle-agent.js";
import type { createLifecycleRouting } from "./lifecycle-routing.js";
import { unavailableCanvasLifecyclePrerequisite } from "./lifecycle-authorization.js";

export interface LifecycleDefinitionDependencies {
  readonly source: Pick<SourceAccessPort, "capture" | "releaseSnapshot">;
  readonly validator: DefinitionValidationPort;
  readonly authoring?: {
    readonly source: DefinitionAuthoringSourcePort;
    readonly agent: LifecycleAgent;
  };
}
function failure(
  result: PortResult<unknown>,
  requestId: string
): LifecycleErrorResponse {
  return {
    apiVersion: LIFECYCLE_API_VERSION,
    requestId,
    error:
      "error" in result ? result.error : lifecycleError("PRECONDITION_FAILED")
  };
}
export function createLifecycleDefinitionRegistrations(
  deps: LifecycleDefinitionDependencies &
    Pick<
      DefinitionAuthoringDependencies,
      "identity" | "registry" | "actions" | "clock" | "ids"
    > & {
      readonly routing: Pick<
        ReturnType<typeof createLifecycleRouting>,
        "selection"
      >;
    }
) {
  const validation = createDefinitionValidation(deps);
  if (deps.authoring && typeof deps.authoring.agent.close !== "function")
    throw new Error("Authoring requires an owned agent lifecycle.");
  const authoring =
    deps.authoring ?
      createDefinitionAuthoring({
        ...deps,
        source: deps.authoring.source,
        agent: deps.authoring.agent
      })
    : undefined;
  let cleanup: Promise<void> | undefined;
  const capabilities: readonly LifecycleReadCapability[] = [
    {
      operation: "definition.validate",
      contexts: ["workspace", "git"],
      providers: ["azure", "aws"],
      requiresAgent: false,
      limitations: [
        "Required unavailable evidence produces incomplete validation; compilation alone is not sufficient.",
        "Validation uses supported captured sources and isolated local compiler inputs, without source mutation or deployment."
      ]
    },
    ...(authoring ?
      [
        {
          operation: "definition.author" as const,
          contexts: ["workspace" as const],
          providers: ["azure" as const],
          requiresAgent: true,
          limitations: [
            "Authoring requires current source-bound host approval and authenticated operation/action assignment.",
            "Guarded authoring currently supports .radius/app.bicep; unknown original dependency baselines are incomplete.",
            "Authoring never commits, pushes, publishes recipes or deploys."
          ]
        }
      ]
    : [])
  ];
  return {
    capabilities,
    registrations: [
      registerLifecycleOperation(
        "definition.validate",
        { validation },
        ["validation"],
        async (request, context, ports) => {
          const result = await ports.validation.validate(
            context.scope,
            request.target,
            context.control
          );
          return result.status === "ok" ?
              {
                apiVersion: LIFECYCLE_API_VERSION,
                requestId: request.requestId,
                operation: "definition.validate",
                result: result.value
              }
            : failure(result, request.requestId);
        }
      ),
      registerLifecycleOperation(
        "definition.author",
        {},
        [],
        async (request, context) => {
          if (!authoring)
            return failure(
              unavailableCanvasLifecyclePrerequisite(),
              request.requestId
            );
          if (deps.routing.selection("definition").writer !== "lifecycle")
            return {
              apiVersion: LIFECYCLE_API_VERSION,
              requestId: request.requestId,
              error: lifecycleError("PRECONDITION_FAILED")
            };
          const result = await authoring.author(
            context.scope,
            context.caller,
            request.target,
            request.input,
            context.control
          );
          if (result.status !== "ok") return failure(result, request.requestId);
          const record = result.value;
          if (record.source?.kind !== "workspace")
            return {
              apiVersion: LIFECYCLE_API_VERSION,
              requestId: request.requestId,
              error: lifecycleError("EVIDENCE_MISMATCH")
            };
          const common = {
            operationId: record.operationId,
            target: request.target,
            source: record.source,
            observation: record.observation
          };
          if (record.state === "action_required") {
            const requiredAction = record.actions.find(
              (action) => action.status === "outstanding"
            );
            if (!requiredAction)
              return {
                apiVersion: LIFECYCLE_API_VERSION,
                requestId: request.requestId,
                error: lifecycleError("EVIDENCE_MISMATCH")
              };
            return {
              apiVersion: LIFECYCLE_API_VERSION,
              requestId: request.requestId,
              operation: "definition.author",
              result: { ...common, state: "action_required", requiredAction }
            };
          }
          if (record.state === "succeeded") {
            if (record.result?.kind !== "definition")
              return {
                apiVersion: LIFECYCLE_API_VERSION,
                requestId: request.requestId,
                error: lifecycleError("EVIDENCE_MISMATCH")
              };
            return {
              apiVersion: LIFECYCLE_API_VERSION,
              requestId: request.requestId,
              operation: "definition.author",
              result: {
                ...common,
                state: "succeeded",
                proposal: record.result.proposal
              }
            };
          }
          if (record.state === "failed") {
            return {
              apiVersion: LIFECYCLE_API_VERSION,
              requestId: request.requestId,
              operation: "definition.author",
              result: {
                ...common,
                state: "failed",
                error: record.error ?? lifecycleError("EVIDENCE_MISMATCH"),
                ...(record.result?.kind === "definition" ?
                  { proposal: record.result.proposal }
                : {})
              }
            };
          }
          return {
            apiVersion: LIFECYCLE_API_VERSION,
            requestId: request.requestId,
            operation: "definition.author",
            result: { ...common, state: record.state }
          };
        }
      )
    ],
    close() {
      if (cleanup) return cleanup;
      validation.close();
      cleanup = Promise.resolve().then(async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => deps.authoring?.agent.close()),
          Promise.resolve().then(async () => {
            const result = await authoring?.close();
            if (result && result.status !== "ok")
              throw new Error("Definition authoring cleanup failed.");
          })
        ]);
        const failures = results.filter(
          (result) => result.status === "rejected"
        );
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Definition cleanup failed."
          );
      });
      return cleanup;
    }
  };
}
