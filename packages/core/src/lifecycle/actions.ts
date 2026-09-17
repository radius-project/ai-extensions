import type {
  ActionResponse,
  OperationRecord,
  RequiredAction
} from "./contracts/common.js";
import {
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable,
  type PortResult
} from "./errors.js";
import type {
  AuthorizedScope,
  CallerContext,
  ClockPort,
  IdentityPort,
  IdPort,
  OperationRegistryPort,
  ReadonlyData,
  RequestControl,
  VersionedOperation
} from "./ports.js";
import {
  isTerminalOperation,
  matchesOperationTarget,
  reduceOperation,
  sameLifecycleData,
  type OperationEvent
} from "./operations.js";

export interface ActionContinuationContext {
  readonly operation: ReadonlyData<OperationRecord>;
  readonly action: ReadonlyData<RequiredAction>;
  readonly response: ReadonlyData<ActionResponse>;
  readonly caller: CallerContext;
  readonly scope: AuthorizedScope<"operation.respond">;
  readonly control: RequestControl;
}
export interface ActionContinuation {
  revalidate(context: ActionContinuationContext): Promise<PortResult<void>>;
  continue(
    context: ActionContinuationContext
  ): Promise<PortResult<OperationEvent>>;
}
type ActionDetails =
  RequiredAction extends infer Action ?
    Action extends RequiredAction ?
      Omit<Action, "actionId" | "operationId" | "target" | "source" | "status">
    : never
  : never;
export interface ActionResponder {
  readonly principalRef: string;
  readonly sessionRef: string;
  readonly agentBindingRef?: string;
}

function unavailable() {
  return portUnavailable("CAPABILITY_UNAVAILABLE", {
    quality: "unknown",
    completeness: "unavailable",
    evidence: "session"
  });
}

export function createActionService(deps: {
  readonly registry: OperationRegistryPort;
  readonly identity: Pick<IdentityPort, "authorizeResponse">;
  readonly ids: IdPort;
  readonly clock: Pick<ClockPort, "now">;
}) {
  if (
    typeof deps?.registry?.get !== "function" ||
    typeof deps.registry.compareAndSwap !== "function" ||
    typeof deps.identity?.authorizeResponse !== "function" ||
    typeof deps.ids?.next !== "function" ||
    typeof deps.clock?.now !== "function"
  )
    throw new Error(
      "Actions require registry, trusted response authority, IDs and clock."
    );
  const bindings = new Map<
    string,
    { responder: ActionResponder; continuation: ActionContinuation }
  >();
  let closed = false;

  async function create(
    scope: AuthorizedScope,
    record: VersionedOperation,
    details: ActionDetails,
    responder: ActionResponder,
    continuation: ActionContinuation,
    control: RequestControl
  ): Promise<PortResult<VersionedOperation>> {
    if (closed) return portCancelled("session_shutdown");
    if (
      typeof continuation?.revalidate !== "function" ||
      typeof continuation.continue !== "function"
    )
      return unavailable();
    const operation = record.operation;
    if (
      isTerminalOperation(operation) ||
      operation.cancellationRequestedAt ||
      !responder.principalRef ||
      !responder.sessionRef ||
      (details.responder === "agent" &&
        (!responder.agentBindingRef || !operation.source))
    )
      return portFailure("PRECONDITION_FAILED");
    const action = {
      ...details,
      actionId: deps.ids.next("action"),
      operationId: operation.operationId,
      target: operation.target,
      ...(operation.source ? { source: operation.source } : {}),
      status: "outstanding" as const
    } as ReadonlyData<RequiredAction>;
    bindings.set(action.actionId, {
      responder: { ...responder },
      continuation
    });
    const result = await deps.registry.compareAndSwap(
      scope,
      {
        operationId: operation.operationId,
        expectedRevision: record.revision,
        replacement: {
          ...operation,
          state: "action_required",
          actions: [...operation.actions, action]
        }
      },
      control
    );
    if (result.status !== "ok") bindings.delete(action.actionId);
    return result;
  }

  async function respond(
    scope: AuthorizedScope<"operation.respond">,
    caller: CallerContext,
    responseInput: {
      readonly operationId: string;
      readonly actionId: string;
      readonly response: ReadonlyData<ActionResponse>;
    },
    control: RequestControl
  ): Promise<PortResult<ReadonlyData<OperationRecord>>> {
    const input = structuredClone(responseInput);
    if (closed) return portCancelled("session_shutdown");
    const read = await deps.registry.get(scope, input.operationId, control);
    if (read.status === "absent")
      return portUnavailable("OPERATION_UNAVAILABLE", {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "session"
      });
    if (read.status !== "ok") return read;
    const record = read.value;
    const operation = record.operation;
    const action = operation.actions.find(
      (item) => item.actionId === input.actionId
    );
    if (
      !action ||
      action.status !== "outstanding" ||
      isTerminalOperation(operation) ||
      operation.cancellationRequestedAt
    )
      return portFailure("ACTION_NOT_OUTSTANDING");
    if (
      action.expiresAt &&
      Date.parse(action.expiresAt) <= Date.parse(deps.clock.now())
    ) {
      await deps.registry.compareAndSwap(
        scope,
        {
          operationId: operation.operationId,
          expectedRevision: record.revision,
          replacement: {
            ...operation,
            actions: operation.actions.map((item) =>
              item.actionId === action.actionId ?
                { ...item, status: "expired" }
              : item
            )
          }
        },
        control
      );
      return portFailure("ACTION_NOT_OUTSTANDING");
    }
    if (
      action.operationId !== input.operationId ||
      !matchesOperationTarget(scope.target, action.target) ||
      !sameLifecycleData(action.source, operation.source) ||
      action.responder !== caller.responder ||
      input.response.kind !== action.response.kind
    )
      return portFailure("ACTION_RESPONSE_INVALID");
    const binding = bindings.get(action.actionId);
    if (!binding) return unavailable();
    if (
      binding.responder.principalRef !== caller.principalRef ||
      binding.responder.sessionRef !== caller.sessionRef ||
      binding.responder.agentBindingRef !== caller.agentBindingRef
    )
      return portForbidden();
    if (
      action.response.kind === "user.decision" &&
      input.response.kind === "user.decision"
    ) {
      const permittedInput = action.response.permittedInput;
      if (
        !action.response.choices.includes(input.response.choice) ||
        (input.response.approvalRef &&
          !action.response.permittedInput.includes("approvalRef")) ||
        Object.keys(input.response.input ?? {}).some(
          (key) => !permittedInput.some((permitted) => permitted === key)
        )
      )
        return portFailure("ACTION_RESPONSE_INVALID");
    }
    let authority;
    try {
      authority = await deps.identity.authorizeResponse(
        caller,
        action,
        input.response,
        control
      );
    } catch {
      return unavailable();
    }
    if (authority.status !== "ok") return authority;
    const authorized = authority.value;
    if (
      authorized.principalRef !== caller.principalRef ||
      authorized.operation !== "operation.respond" ||
      authorized.operationId !== operation.operationId ||
      !authorized.authorizationRef ||
      (input.response.kind === "user.decision" &&
        input.response.approvalRef !== undefined &&
        input.response.approvalRef !== authorized.approvalRef) ||
      !matchesOperationTarget(authorized.target, action.target) ||
      !sameLifecycleData(authorized.source, action.source)
    )
      return portForbidden();
    const context: ActionContinuationContext = {
      operation,
      action,
      response: input.response,
      caller,
      scope: authorized,
      control
    };
    try {
      const ready = await binding.continuation.revalidate(context);
      if (ready.status !== "ok") return ready;
    } catch {
      return unavailable();
    }
    if (closed) return portCancelled("session_shutdown");
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const replacement: ReadonlyData<OperationRecord> = {
      ...operation,
      state:
        (
          operation.actions.some(
            (item) =>
              item.actionId !== action.actionId && item.status === "outstanding"
          )
        ) ?
          "action_required"
        : "queued",
      actions: operation.actions.map((item) =>
        item.actionId === action.actionId ?
          { ...item, status: "accepted" }
        : item
      )
    };
    const claimed = await deps.registry.compareAndSwap(
      authorized,
      {
        operationId: operation.operationId,
        expectedRevision: record.revision,
        replacement
      },
      control
    );
    if (claimed.status !== "ok")
      return claimed.status === "failed" ?
          portFailure("ACTION_NOT_OUTSTANDING")
        : claimed;
    // Consumption precedes continuation. An ambiguous/failed continuation is
    // never replayed, even when its side effect returned no receipt.
    bindings.delete(action.actionId);
    let continuationRecord = claimed.value;
    let result: PortResult<OperationEvent>;
    try {
      if (closed) return portCancelled("session_shutdown");
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const ready = await binding.continuation.revalidate({
        ...context,
        operation: claimed.value.operation
      });
      if (closed) return portCancelled("session_shutdown");
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      if (ready.status === "ok") {
        const lease = await deps.registry.compareAndSwap(
          authorized,
          {
            operationId: operation.operationId,
            expectedRevision: claimed.value.revision,
            replacement: claimed.value.operation
          },
          control
        );
        if (lease.status !== "ok") return lease;
        continuationRecord = lease.value;
        if (closed) return portCancelled("session_shutdown");
        if (control.cancellation.aborted)
          return portCancelled("request_cancelled");
        result = await binding.continuation.continue({
          ...context,
          operation: continuationRecord.operation
        });
      } else result = ready;
    } catch {
      result = unavailable();
    }
    if (closed) return portCancelled("session_shutdown");
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const reduced =
      result.status === "ok" ?
        reduceOperation(continuationRecord.operation, result.value)
      : result;
    const next =
      reduced.status === "ok" ?
        reduced.value
      : {
          ...continuationRecord.operation,
          observation: {
            quality: "unknown" as const,
            completeness: "partial" as const,
            evidence: "session" as const,
            limitation:
              "Action was consumed; continuation was not confirmed and cannot be repeated."
          },
          ...("error" in reduced ? { error: reduced.error } : {})
        };
    const saved = await deps.registry.compareAndSwap(
      authorized,
      {
        operationId: operation.operationId,
        expectedRevision: continuationRecord.revision,
        replacement: next
      },
      control
    );
    if (saved.status !== "ok") return saved;
    return reduced.status === "ok" ?
        portSuccess(saved.value.operation)
      : reduced;
  }
  return {
    create,
    respond,
    close() {
      closed = true;
      bindings.clear();
    }
  };
}
