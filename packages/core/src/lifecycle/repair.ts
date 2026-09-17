import type { LifecycleRequestFor, RepairPolicy } from "./contracts/catalog.js";
import type { OperationRecord } from "./contracts/common.js";
import {
  portCancelled,
  portFailure,
  portForbidden,
  portUnavailable,
  type PortResult
} from "./errors.js";
import { sameLifecycleData } from "./operations.js";
import type {
  AuthorizationRequest,
  AuthorizedScope,
  CallerContext,
  OperationRegistryPort,
  ReadonlyData,
  RequestControl,
  SourceSelection
} from "./ports.js";

export interface RepairPlan {
  readonly failed: ReadonlyData<OperationRecord>;
  readonly target: SourceSelection;
  readonly policy: ReadonlyData<RepairPolicy>;
}
export interface RepairExecutor {
  start(
    scope: AuthorizedScope<"operation.repair">,
    caller: CallerContext,
    plan: RepairPlan,
    control: RequestControl
  ): Promise<PortResult<ReadonlyData<OperationRecord>>>;
}
export function createRepair(deps: {
  readonly registry: OperationRegistryPort;
  readonly identity: {
    authorize(
      request: AuthorizationRequest<"operation.repair">,
      control: RequestControl
    ): Promise<PortResult<AuthorizedScope<"operation.repair">>>;
  };
  readonly executor?: RepairExecutor;
}) {
  if (
    typeof deps?.registry?.get !== "function" ||
    typeof deps.identity?.authorize !== "function" ||
    (deps.executor && typeof deps.executor.start !== "function")
  )
    throw new Error(
      "Repair requires operation records, trusted authority and a complete optional executor."
    );
  let closed = false;
  const automatic = new Map<
    string,
    {
      scope: AuthorizedScope<"operation.repair">;
      caller: CallerContext;
      input: ReadonlyData<LifecycleRequestFor<"operation.repair">["input"]>;
    }
  >();
  const service = {
    async repair(
      scope: AuthorizedScope<"operation.repair">,
      caller: CallerContext,
      input: ReadonlyData<LifecycleRequestFor<"operation.repair">["input"]>,
      control: RequestControl
    ): Promise<PortResult<ReadonlyData<OperationRecord>>> {
      if (closed || control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const policy = input.repairPolicy;
      if (
        !Number.isInteger(policy.maxAttempts) ||
        policy.maxAttempts < 0 ||
        policy.maxAttempts > 5 ||
        !["manual", "automatic"].includes(policy.mode)
      )
        return portFailure("INVALID_REQUEST");
      if (policy.maxAttempts === 0) return portFailure("REPAIR_LIMIT_REACHED");
      const stored = await deps.registry.get(scope, input.operationId, control);
      if (stored.status === "absent")
        return portUnavailable("OPERATION_UNAVAILABLE", {
          ...stored.observation,
          quality: "unknown",
          completeness: "unavailable"
        });
      if (stored.status !== "ok") return stored;
      const failed = stored.value.operation;
      if (
        failed.state !== "failed" ||
        !failed.target.definition ||
        !failed.error ||
        !["definition.author", "deployment.start", "operation.repair"].includes(
          failed.operation
        )
      )
        return portFailure("PRECONDITION_FAILED");
      if (!deps.executor || !caller.agentBindingRef)
        return portUnavailable("CAPABILITY_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "session",
          limitation:
            "Repair requires authenticated agent assignment and guarded workspace editing."
        });
      if (
        !scope.approvalRef ||
        scope.approvalRef !== caller.approvedHostActionRef ||
        (input.approvalRef !== undefined &&
          input.approvalRef !== scope.approvalRef)
      )
        return portForbidden();
      const target = {
        ...failed.target,
        definition: failed.target.definition,
        source: input.source
      };
      const authorized = await deps.identity.authorize(
        {
          caller,
          operation: "operation.repair",
          target,
          operationId: failed.operationId,
          approvalRef: scope.approvalRef,
          repairPolicy: policy
        },
        control
      );
      if (authorized.status !== "ok") return authorized;
      if (
        !authorized.value.authorizationRef ||
        authorized.value.principalRef !== caller.principalRef ||
        authorized.value.operation !== "operation.repair" ||
        authorized.value.operationId !== failed.operationId ||
        authorized.value.approvalRef !== scope.approvalRef ||
        !sameLifecycleData(authorized.value.target, target) ||
        !sameLifecycleData(authorized.value.repairPolicy, policy)
      )
        return portForbidden();
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const started = await deps.executor.start(
        authorized.value,
        caller,
        { failed, target, policy },
        control
      );
      if (started.status === "ok" && policy.mode === "automatic" && !closed)
        automatic.set(started.value.operationId, {
          scope: {
            ...authorized.value,
            operationId: started.value.operationId
          },
          caller,
          input: { ...input, operationId: started.value.operationId }
        });
      return started;
    },
    async afterResponse(operationId: string, control: RequestControl) {
      const admitted = automatic.get(operationId);
      automatic.delete(operationId);
      if (!admitted || closed) return;
      const current = await deps.registry.get(
        admitted.scope,
        operationId,
        control
      );
      if (
        current.status !== "ok" ||
        current.value.operation.state !== "failed" ||
        current.value.operation.cancellationRequestedAt
      )
        return;
      return service.repair(
        admitted.scope,
        admitted.caller,
        admitted.input,
        control
      );
    },
    close() {
      closed = true;
      automatic.clear();
    }
  };
  return service;
}
