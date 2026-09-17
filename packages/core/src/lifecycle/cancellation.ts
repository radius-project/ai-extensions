import type { LifecycleResponseFor } from "./contracts/catalog.js";
import {
  portCancelled,
  portForbidden,
  portSuccess,
  portUnavailable,
  type PortResult
} from "./errors.js";
import { isTerminalOperation, sameLifecycleData } from "./operations.js";
import { reduceExecutionObservation } from "./execution-result.js";
import type {
  AuthorizationRequest,
  AuthorizedScope,
  CallerContext,
  CancellationReceipt,
  ClockPort,
  ExecutionIdentity,
  OperationRegistryPort,
  ReadonlyData,
  RequestControl,
  WorkflowExecutionPort
} from "./ports.js";

export function createCancellation(deps: {
  readonly registry: OperationRegistryPort;
  readonly identity: {
    authorize(
      request: AuthorizationRequest<"operation.cancel">,
      control: RequestControl
    ): Promise<PortResult<AuthorizedScope<"operation.cancel">>>;
  };
  readonly clock: Pick<ClockPort, "now">;
  readonly workflow?: Pick<WorkflowExecutionPort, "cancel" | "observe">;
  readonly local?: {
    cancel(
      scope: AuthorizedScope<"operation.cancel">,
      operationId: string,
      control: RequestControl
    ): Promise<PortResult<CancellationReceipt>>;
  };
}) {
  if (
    [
      deps?.registry?.get,
      deps?.registry?.compareAndSwap,
      deps?.identity?.authorize,
      deps?.clock?.now,
      ...(deps.workflow ? [deps.workflow.cancel, deps.workflow.observe] : []),
      ...(deps.local ? [deps.local.cancel] : [])
    ].some((method) => typeof method !== "function")
  )
    throw new Error(
      "Cancellation requires registry, current authority, clock and complete selected controllers."
    );
  return {
    async cancel(
      scope: AuthorizedScope<"operation.cancel">,
      caller: CallerContext,
      operationId: string,
      control: RequestControl
    ): Promise<
      PortResult<
        ReadonlyData<LifecycleResponseFor<"operation.cancel">["result"]>
      >
    > {
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const read = await deps.registry.get(scope, operationId, control);
      if (read.status === "absent")
        return portUnavailable("OPERATION_UNAVAILABLE", {
          ...read.observation,
          quality: "unknown",
          completeness: "unavailable"
        });
      if (read.status !== "ok") return read;
      const operation = read.value.operation;
      const result = (
        status: LifecycleResponseFor<"operation.cancel">["result"]["cancellation"]["status"],
        current = operation,
        reason?: string
      ) =>
        portSuccess({
          cancellation: {
            status,
            ...(current.cancellationRequestedAt ?
              { requestedAt: current.cancellationRequestedAt }
            : {}),
            ...(reason ? { reason } : {})
          },
          operation: current
        });
      if (isTerminalOperation(operation))
        return result(
          "not_cancellable",
          operation,
          "The known operation already completed; no rollback was requested."
        );
      if (operation.cancellationRequestedAt) return result("already_requested");
      const authorized = await deps.identity.authorize(
        {
          caller,
          operation: "operation.cancel",
          operationId,
          target: operation.target,
          ...(operation.source ? { source: operation.source } : {})
        },
        control
      );
      if (authorized.status !== "ok") return authorized;
      if (
        !authorized.value.authorizationRef ||
        authorized.value.operation !== "operation.cancel" ||
        authorized.value.principalRef !== caller.principalRef ||
        authorized.value.operationId !== operationId ||
        !sameLifecycleData(authorized.value.target, operation.target) ||
        !sameLifecycleData(authorized.value.source, operation.source)
      )
        return portForbidden();
      const attempt = operation.attempts.at(-1);
      let identity: ExecutionIdentity | undefined;
      if (
        deps.workflow &&
        operation.operation === "deployment.start" &&
        operation.source?.kind === "git" &&
        operation.target.environment &&
        operation.target.application &&
        attempt?.run
      ) {
        const { conclusion: _conclusion, ...run } = attempt.run;
        identity = {
          operationId,
          attemptId: attempt.attemptId,
          operation: "deployment.start",
          target: {
            repo: operation.target.repo,
            environment: operation.target.environment,
            application: operation.target.application
          },
          expectedCommit: operation.source.commit,
          run
        };
      }
      const workflow = deps.workflow;
      const local = deps.local;
      const execution = identity;
      const cancel =
        execution && workflow ?
          () => workflow.cancel(authorized.value, execution, control)
        : (
          local &&
          ["definition.author", "operation.repair"].includes(
            operation.operation
          )
        ) ?
          () => local.cancel(authorized.value, operationId, control)
        : undefined;
      if (!cancel)
        return result(
          "unavailable",
          operation,
          "No exact cancellable execution is established. No remote cancellation or rollback was attempted."
        );
      const reserved = await deps.registry.compareAndSwap(
        authorized.value,
        {
          operationId,
          expectedRevision: read.value.revision,
          replacement: {
            ...operation,
            cancellationRequestedAt: deps.clock.now()
          }
        },
        control
      );
      if (reserved.status !== "ok") return reserved;
      let receipt: PortResult<CancellationReceipt>;
      try {
        receipt = await cancel();
      } catch {
        receipt = portUnavailable("RESULT_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "session"
        });
      }
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const current = await deps.registry.get(
        authorized.value,
        operationId,
        control
      );
      if (current.status !== "ok")
        return current.status === "absent" ?
            portUnavailable("OPERATION_UNAVAILABLE", {
              ...current.observation,
              quality: "unknown",
              completeness: "unavailable"
            })
          : current;
      let next = current.value.operation;
      if (!isTerminalOperation(next) && identity && deps.workflow) {
        const observed = await deps.workflow.observe(
          authorized.value,
          identity,
          control
        );
        if (observed.status === "ok") {
          const reduced = reduceExecutionObservation(
            next,
            identity,
            observed.value
          );
          if (reduced.status !== "ok") return reduced;
          next = reduced.value;
        }
      } else if (
        !isTerminalOperation(next) &&
        receipt.status === "ok" &&
        receipt.value.status === "confirmed"
      ) {
        next = {
          ...next,
          state: "cancelled",
          observation: receipt.value.observation
        };
      }
      if (!sameLifecycleData(next, current.value.operation)) {
        const saved = await deps.registry.compareAndSwap(
          authorized.value,
          {
            operationId,
            expectedRevision: current.value.revision,
            replacement: next
          },
          control
        );
        if (saved.status !== "ok") return saved;
        next = saved.value.operation;
      }
      return result(
        receipt.status === "ok" ? "requested" : "unavailable",
        next,
        "Cancellation was requested for this execution only; resource rollback and state persistence are separate."
      );
    }
  };
}
