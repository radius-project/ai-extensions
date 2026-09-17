import type { createActionService } from "./actions.js";
import type {
  LifecycleRequestFor,
  LifecycleResponseFor
} from "./contracts/catalog.js";
import type { Provider, RequiredAction } from "./contracts/common.js";
import { authorizeConfiguration } from "./configuration-authority.js";
import {
  createOperationRecord,
  sameLifecycleData,
  type OperationEvent
} from "./operations.js";
import {
  lifecycleError,
  portCancelled,
  portFailure,
  portSuccess,
  portUnavailable,
  type PortResult
} from "./errors.js";
import type {
  AuthorizedScope,
  CallerContext,
  ClockPort,
  IdentityObservation,
  IdentityPort,
  IdPort,
  OperationRegistryPort,
  ReadonlyData,
  RequestControl
} from "./ports.js";

export interface CredentialDependencies {
  readonly identity: Pick<IdentityPort, "inspect" | "authorize"> &
    Partial<Pick<IdentityPort, "configure">>;
  readonly providers: readonly Provider[];
  readonly registry: OperationRegistryPort;
  readonly actions: ReturnType<typeof createActionService>;
  readonly ids: IdPort;
  readonly clock: Pick<ClockPort, "now">;
}

export function verifiedIdentity(
  observation: IdentityObservation,
  provider: Provider,
  identityRef: string
): boolean {
  const matching = observation.prerequisites.filter(
    (item) => item.provider === provider
  );
  return (
    observation.observation.quality === "current" &&
    observation.observation.completeness === "complete" &&
    matching.length === 1 &&
    matching[0].status === "satisfied" &&
    matching[0].identityRef === identityRef
  );
}

export function unsupportedConfiguration() {
  return portUnavailable("CAPABILITY_UNAVAILABLE", {
    quality: "unknown",
    completeness: "unavailable",
    evidence: "configuration",
    limitation: "The selected provider has no qualified configuration binding."
  });
}

export function createCredentials(deps: CredentialDependencies) {
  async function inspect(
    scope: AuthorizedScope<"credentials.inspect">,
    input: ReadonlyData<LifecycleRequestFor<"credentials.inspect">["input"]>,
    control: RequestControl
  ): Promise<
    PortResult<LifecycleResponseFor<"credentials.inspect">["result"]>
  > {
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    if (input.provider && !deps.providers.includes(input.provider))
      return unsupportedConfiguration();
    const result = await deps.identity.inspect(scope, input, control);
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    if (result.status === "ok") {
      const expected = input.provider ? [input.provider] : deps.providers;
      if (
        result.value.prerequisites.length !== expected.length ||
        expected.some(
          (provider) =>
            result.value.prerequisites.filter(
              (item) => item.provider === provider
            ).length !== 1
        ) ||
        result.value.prerequisites.some(
          (item) => item.status === "satisfied" && !item.identityRef
        )
      )
        return portFailure("EVIDENCE_MISMATCH");
    }
    return result.status === "ok" ?
        portSuccess({
          target: scope.target,
          prerequisites: structuredClone([...result.value.prerequisites]),
          actions: [],
          observation: structuredClone(result.value.observation)
        })
      : result;
  }
  async function configure(
    scope: AuthorizedScope<"credentials.configure">,
    caller: CallerContext,
    input: ReadonlyData<LifecycleRequestFor<"credentials.configure">>,
    control: RequestControl
  ): Promise<
    PortResult<LifecycleResponseFor<"credentials.configure">["result"]>
  > {
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const request = structuredClone(input);
    if (
      !sameLifecycleData(scope.target, request.target) ||
      scope.principalRef !== caller.principalRef
    )
      return portFailure("PRECONDITION_FAILED");
    if (!deps.providers.includes(request.input.provider))
      return unsupportedConfiguration();
    const configureIdentity = deps.identity.configure;
    if (!configureIdentity) return unsupportedConfiguration();
    if (
      request.input.intent === "select_identity" &&
      !request.input.identityRef
    )
      return portFailure("INVALID_REQUEST");
    const operation = createOperationRecord(deps, {
      operation: request.operation,
      target: request.target
    });
    const stored = await deps.registry.create(scope, operation, control);
    if (stored.status !== "ok") return stored;
    const created = await deps.actions.create(
      scope,
      stored.value,
      {
        kind:
          request.input.intent === "authenticate" ?
            "user.authenticate"
          : "user.decision",
        responder: "user",
        message:
          request.input.intent === "authenticate" ?
            "Continue to authenticate the selected provider. Completion is verified independently. This does not deploy an application."
          : "Continue to select the requested identity for this repository. This does not deploy an application.",
        response: {
          kind: "user.decision",
          choices: ["continue"],
          permittedInput: []
        }
      },
      { principalRef: caller.principalRef, sessionRef: caller.sessionRef },
      {
        revalidate: async (context) => {
          const authorized =
            await authorizeConfiguration<"credentials.configure">(
              deps.identity,
              context.caller,
              request,
              operation.operationId,
              context.control
            );
          return authorized.status === "ok" ?
              portSuccess(undefined)
            : authorized;
        },
        continue: async (context): Promise<PortResult<OperationEvent>> => {
          const authorized =
            await authorizeConfiguration<"credentials.configure">(
              deps.identity,
              context.caller,
              request,
              operation.operationId,
              context.control
            );
          if (authorized.status !== "ok") return authorized;
          const configured = await configureIdentity.call(
            deps.identity,
            authorized.value,
            request.input,
            context.control
          );
          if (configured.status !== "ok") return configured;
          if (context.control.cancellation.aborted)
            return portCancelled("request_cancelled");
          const observation = await deps.identity.inspect(
            { ...authorized.value, operation: "credentials.inspect" },
            { provider: request.input.provider },
            context.control
          );
          if (observation.status !== "ok") return observation;
          const verified =
            verifiedIdentity(
              observation.value,
              request.input.provider,
              configured.value.identityRef
            ) &&
            (!request.input.identityRef ||
              request.input.identityRef === configured.value.identityRef) &&
            configured.value.observation.quality === "current" &&
            configured.value.observation.completeness === "complete";
          return portSuccess({
            kind: "configuration_updated",
            state: verified ? "succeeded" : "failed",
            observation: observation.value.observation,
            result: {
              kind: "configuration",
              provider: request.input.provider,
              ...(verified ?
                { identityRef: configured.value.identityRef }
              : {}),
              phases: [
                {
                  phase: "identity",
                  status: verified ? "succeeded" : "failed",
                  reason:
                    verified ?
                      "The selected identity was verified after explicit configuration."
                    : "The requested identity could not be verified after configuration."
                }
              ]
            },
            ...(verified ?
              {}
            : { error: lifecycleError("PRECONDITION_FAILED") })
          });
        }
      },
      control
    );
    if (created.status !== "ok") return created;
    return portSuccess({
      operationId: operation.operationId,
      target: request.target,
      state: "action_required",
      requiredAction: structuredClone(created.value.action) as RequiredAction,
      observation: operation.observation
    });
  }
  return { inspect, configure };
}
