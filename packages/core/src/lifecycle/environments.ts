import type { createActionService } from "./actions.js";
import type {
  LifecycleRequestFor,
  LifecycleResponseFor
} from "./contracts/catalog.js";
import type { Provider, RequiredAction } from "./contracts/common.js";
import { authorizeConfiguration } from "./configuration-authority.js";
import { unsupportedConfiguration, verifiedIdentity } from "./credentials.js";
import { planEnvironmentConfiguration } from "./environment-configuration.js";
import {
  lifecycleError,
  portCancelled,
  portFailure,
  portSuccess,
  type PortResult
} from "./errors.js";
import {
  createOperationRecord,
  sameLifecycleData,
  type OperationEvent
} from "./operations.js";
import type {
  AuthorizedScope,
  CallerContext,
  ClockPort,
  EnvironmentAccessPort,
  EnvironmentChange,
  EnvironmentConfigurationPlan,
  EnvironmentInspection,
  IdentityPort,
  IdPort,
  OperationRegistryPort,
  ReadonlyData,
  RequestControl
} from "./ports.js";

type EnvironmentOperation = "environment.create" | "environment.configure";
type EnvironmentRequest = ReadonlyData<
  LifecycleRequestFor<EnvironmentOperation>
>;
export interface EnvironmentDependencies {
  readonly identity: Pick<IdentityPort, "inspect" | "authorize">;
  readonly environment: Pick<EnvironmentAccessPort, "inspect" | "configure">;
  readonly providers: readonly Provider[];
  readonly registry: OperationRegistryPort;
  readonly actions: ReturnType<typeof createActionService>;
  readonly ids: IdPort;
  readonly clock: Pick<ClockPort, "now">;
}
function baseline(inspection: EnvironmentInspection | null) {
  return (
    inspection && {
      target: inspection.target,
      configuration: inspection.configuration,
      protections: inspection.protections
    }
  );
}

export function createEnvironments(deps: EnvironmentDependencies) {
  async function start(
    scope: AuthorizedScope<EnvironmentOperation>,
    caller: CallerContext,
    input: EnvironmentRequest,
    control: RequestControl
  ): Promise<PortResult<LifecycleResponseFor<"environment.create">["result"]>> {
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const request = structuredClone(input);
    if (
      !sameLifecycleData(scope.target, request.target) ||
      scope.principalRef !== caller.principalRef ||
      scope.operation !== request.operation
    )
      return portFailure("PRECONDITION_FAILED");
    const change: EnvironmentChange =
      request.operation === "environment.create" ?
        {
          operation: request.operation,
          configuration: request.input.configuration
        }
      : { operation: request.operation, patch: request.input.patch };
    const provider =
      change.operation === "environment.create" ?
        change.configuration.provider
      : change.patch.provider;
    if (!deps.providers.includes(provider)) return unsupportedConfiguration();
    const operation = createOperationRecord(deps, {
      operation: request.operation,
      target: request.target
    });

    async function readEnvironment(
      responder: CallerContext,
      nextControl: RequestControl
    ) {
      const authorization = await authorizeConfiguration<"environment.inspect">(
        deps.identity,
        responder,
        {
          apiVersion: request.apiVersion,
          requestId: nextControl.requestId,
          operation: "environment.inspect",
          target: request.target,
          input: {}
        },
        operation.operationId,
        nextControl
      );
      if (authorization.status !== "ok") return authorization;
      return deps.environment.inspect(authorization.value, nextControl);
    }
    async function readIdentity(
      responder: CallerContext,
      nextControl: RequestControl
    ) {
      const authorization = await authorizeConfiguration<"credentials.inspect">(
        deps.identity,
        responder,
        {
          apiVersion: request.apiVersion,
          requestId: nextControl.requestId,
          operation: "credentials.inspect",
          target: request.target,
          input: { provider }
        },
        operation.operationId,
        nextControl
      );
      if (authorization.status !== "ok") return authorization;
      return deps.identity.inspect(
        authorization.value,
        { provider },
        nextControl
      );
    }
    const inspected = await readEnvironment(caller, control);
    if (inspected.status !== "ok" && inspected.status !== "absent")
      return inspected;
    const planned = planEnvironmentConfiguration(
      request.target,
      change,
      inspected.status === "ok" ? inspected.value : null
    );
    if (planned.status !== "ok") return planned;
    const plan = planned.value;
    const identity = await readIdentity(caller, control);
    if (identity.status !== "ok") return identity;
    const authenticated = verifiedIdentity(
      identity.value,
      provider,
      plan.configuration.identityRef
    );
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const stored = await deps.registry.create(scope, operation, control);
    if (stored.status !== "ok") return stored;

    async function validate(
      responder: CallerContext,
      nextControl: RequestControl,
      approvalRef?: string
    ): Promise<
      PortResult<{
        scope: AuthorizedScope<EnvironmentOperation>;
        plan: EnvironmentConfigurationPlan;
      }>
    > {
      const approvedRequest: EnvironmentRequest =
        request.operation === "environment.create" ?
          {
            ...request,
            input: { ...request.input, ...(approvalRef ? { approvalRef } : {}) }
          }
        : {
            ...request,
            input: { ...request.input, ...(approvalRef ? { approvalRef } : {}) }
          };
      const authorized = await authorizeConfiguration<EnvironmentOperation>(
        deps.identity,
        responder,
        approvedRequest,
        operation.operationId,
        nextControl
      );
      if (authorized.status !== "ok") return authorized;
      const current = await readEnvironment(responder, nextControl);
      if (current.status !== "ok" && current.status !== "absent")
        return current;
      const next = planEnvironmentConfiguration(
        request.target,
        change,
        current.status === "ok" ? current.value : null
      );
      if (next.status !== "ok") return next;
      if (
        !sameLifecycleData(
          baseline(plan.expected),
          baseline(next.value.expected)
        ) ||
        !sameLifecycleData(plan.configuration, next.value.configuration)
      )
        return portFailure("PRECONDITION_FAILED");
      const actualIdentity = await readIdentity(responder, nextControl);
      if (actualIdentity.status !== "ok") return actualIdentity;
      if (
        !verifiedIdentity(
          actualIdentity.value,
          provider,
          plan.configuration.identityRef
        )
      )
        return portFailure("PRECONDITION_FAILED");
      return portSuccess({ scope: authorized.value, plan: next.value });
    }
    const created = await deps.actions.create(
      scope,
      stored.value,
      {
        kind: authenticated ? "user.decision" : "user.authenticate",
        responder: "user",
        message:
          authenticated ?
            `Continue to configure ${provider} for ${request.target.repo}/${request.target.environment}: ${JSON.stringify(plan.configuration.settings)}; ${plan.configuration.recipes.length} recipe registration(s). Existing protections are preserved. Application deployment requires separate authorization.`
          : "Configure and verify the requested identity with credentials.configure, then continue this environment setup. This action does not authenticate or deploy implicitly.",
        response: {
          kind: "user.decision",
          choices: ["continue"],
          permittedInput: ["approvalRef"]
        }
      },
      { principalRef: caller.principalRef, sessionRef: caller.sessionRef },
      {
        revalidate: async (context) => {
          const result = await validate(
            context.caller,
            context.control,
            context.response.kind === "user.decision" ?
              context.response.approvalRef
            : undefined
          );
          return result.status === "ok" ? portSuccess(undefined) : result;
        },
        continue: async (context): Promise<PortResult<OperationEvent>> => {
          const ready = await validate(
            context.caller,
            context.control,
            context.response.kind === "user.decision" ?
              context.response.approvalRef
            : undefined
          );
          if (ready.status !== "ok") return ready;
          const result = await deps.environment.configure(
            ready.value.scope,
            ready.value.plan,
            context.control
          );
          if (result.status !== "ok") return result;
          const receipt = result.value;
          const proof = receipt.inspection;
          const verified =
            receipt.state !== "succeeded" ||
            !!(
              proof &&
              sameLifecycleData(proof.target, request.target) &&
              sameLifecycleData(proof.configuration, plan.configuration) &&
              (!plan.expected ||
                sameLifecycleData(
                  proof.protections,
                  plan.expected.protections
                )) &&
              proof.recipeObservation?.quality === "current" &&
              proof.recipeObservation.completeness === "complete" &&
              proof.recipeObservation.evidence === "radius"
            );
          const currentIdentity = await readIdentity(
            context.caller,
            context.control
          );
          const identityVerified =
            currentIdentity.status === "ok" &&
            verifiedIdentity(
              currentIdentity.value,
              provider,
              plan.configuration.identityRef
            );
          return portSuccess({
            kind: "configuration_updated",
            state: !verified || !identityVerified ? "failed" : receipt.state,
            observation: receipt.observation,
            result: {
              kind: "configuration",
              provider,
              ...(identityVerified ?
                { identityRef: plan.configuration.identityRef }
              : {}),
              phases: [
                {
                  phase: "identity",
                  status: identityVerified ? "succeeded" : "failed",
                  reason:
                    identityVerified ?
                      "The scoped identity was independently verified."
                    : "The scoped identity could not be verified after configuration."
                },
                ...receipt.phases
              ]
            },
            ...(!verified || !identityVerified ?
              { error: lifecycleError("EVIDENCE_MISMATCH") }
            : receipt.error ? { error: receipt.error }
            : {})
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
  return { create: start, configure: start };
}
