import type {
  ExecutionAttempt,
  LifecycleState,
  Observation,
  OperationRecord,
  Target
} from "./contracts/common.js";
import {
  portAbsent,
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  type PortResult
} from "./errors.js";
import type {
  AuthorizedScope,
  ClockPort,
  IdPort,
  OperationRegistryPort,
  ReadonlyData,
  RequestControl,
  VersionedOperation
} from "./ports.js";

export function sameLifecycleData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  )
    return false;
  const a = Object.entries(left);
  const b = Object.entries(right);
  return (
    a.length === b.length &&
    a.every(
      ([key, value]) =>
        Object.hasOwn(right, key) &&
        sameLifecycleData(value, Reflect.get(right, key))
    )
  );
}

export function isTerminalOperation(
  operation: ReadonlyData<OperationRecord>
): operation is ReadonlyData<OperationRecord> & {
  readonly state: "succeeded" | "failed" | "cancelled";
} {
  return ["succeeded", "failed", "cancelled"].includes(operation.state);
}

export function matchesOperationTarget(
  scope: ReadonlyData<Target>,
  target: ReadonlyData<Target>
): boolean {
  return (
    scope.repo.toLowerCase() === target.repo.toLowerCase() &&
    scope.environment === target.environment &&
    scope.application === target.application &&
    (scope.definition === undefined ||
      scope.definition === target.definition) &&
    (scope.source === undefined ||
      sameLifecycleData(scope.source, target.source))
  );
}

export function createOperationRecord(
  deps: { readonly ids: IdPort; readonly clock: Pick<ClockPort, "now"> },
  input: Pick<ReadonlyData<OperationRecord>, "operation" | "target" | "source">
): ReadonlyData<OperationRecord> {
  return {
    operation: input.operation,
    target: input.target,
    ...(input.source === undefined ? {} : { source: input.source }),
    operationId: deps.ids.next("operation"),
    state: "queued",
    attempts: [],
    actions: [],
    observation: {
      quality: "current",
      completeness: "complete",
      evidence: "session",
      observedAt: deps.clock.now()
    }
  };
}

export function createExecutionAttempt(
  ids: IdPort,
  operation: ReadonlyData<OperationRecord>
): ReadonlyData<ExecutionAttempt> {
  return {
    attemptId: ids.next("attempt"),
    operationId: operation.operationId,
    ...(operation.source?.kind === "git" ?
      { expectedCommit: operation.source.commit }
    : {}),
    phases: [],
    observation: {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "session"
    }
  };
}

function uncertain(
  operation: ReadonlyData<OperationRecord>,
  observation: ReadonlyData<Observation>
) {
  return {
    ...operation,
    observation: {
      ...observation,
      quality: "unknown" as const,
      completeness: "partial" as const,
      limitation:
        "Completion is unconfirmed; the existing operation must not be redispatched."
    }
  };
}

export type OperationEvent =
  | {
      readonly kind: "definition_completed";
      readonly state: "succeeded" | "failed" | "cancelled";
      readonly observation: ReadonlyData<Observation>;
      readonly result?: ReadonlyData<
        Extract<OperationRecord["result"], { kind: "definition" }>
      >;
      readonly error?: ReadonlyData<OperationRecord["error"]>;
    }
  | {
      readonly kind: "observed";
      readonly observation: ReadonlyData<Observation>;
    }
  | {
      readonly kind: "started";
      readonly observation: ReadonlyData<Observation>;
    }
  | { readonly kind: "cancel_requested"; readonly requestedAt: string }
  | {
      readonly kind: "completed";
      readonly state: Extract<
        LifecycleState,
        "succeeded" | "failed" | "cancelled"
      >;
      readonly attempt: ReadonlyData<ExecutionAttempt>;
    };

export function reduceOperation(
  operation: ReadonlyData<OperationRecord>,
  event: OperationEvent
): PortResult<ReadonlyData<OperationRecord>> {
  if (event.kind === "definition_completed") {
    if (
      operation.operation !== "definition.author" ||
      isTerminalOperation(operation) ||
      (event.state === "succeeded" &&
        (!event.result ||
          event.result.proposal.promotion !== "promoted" ||
          event.result.proposal.validation.status !== "passed" ||
          event.result.proposal.validation.sourceFingerprint !==
            operation.source?.fingerprint ||
          !event.result.proposal.validation.proposalFingerprint ||
          event.result.proposal.originalFingerprint !==
            operation.source?.fingerprint ||
          event.result.proposal.operationId !== operation.operationId ||
          !operation.actions.some(
            (action) =>
              action.actionId === event.result?.proposal.actionId &&
              action.status === "accepted"
          )))
    )
      return portFailure("PRECONDITION_FAILED");
    return portSuccess({
      ...operation,
      state: event.state,
      observation: event.observation,
      ...(event.result ? { result: event.result } : {}),
      ...(event.error ? { error: event.error } : {})
    });
  }
  if (event.kind === "observed") {
    return portSuccess({ ...operation, observation: event.observation });
  }
  if (event.kind === "cancel_requested") {
    return portSuccess(
      isTerminalOperation(operation) ? operation : (
        {
          ...operation,
          cancellationRequestedAt:
            operation.cancellationRequestedAt ?? event.requestedAt
        }
      )
    );
  }
  if (event.kind === "started") {
    if (isTerminalOperation(operation) || operation.cancellationRequestedAt)
      return portFailure("PRECONDITION_FAILED");
    return portSuccess({
      ...operation,
      state:
        operation.actions.some((action) => action.status === "outstanding") ?
          "action_required"
        : "running",
      observation: event.observation
    });
  }
  const attempt = event.attempt;
  const known = operation.attempts.find(
    (item) => item.attemptId === attempt.attemptId
  );
  const run = attempt.run;
  if (
    !known ||
    attempt.operationId !== operation.operationId ||
    known.expectedCommit !== attempt.expectedCommit ||
    known.provider !== attempt.provider ||
    known.repairsOperationId !== attempt.repairsOperationId ||
    known.repairsAttemptId !== attempt.repairsAttemptId ||
    (operation.source?.kind === "git" &&
      operation.source.commit !== attempt.expectedCommit) ||
    !run ||
    run.repo.toLowerCase() !== operation.target.repo.toLowerCase() ||
    !attempt.expectedCommit ||
    run.commit !== attempt.expectedCommit ||
    (known.run &&
      (known.run.runId !== run.runId ||
        known.run.runAttempt !== run.runAttempt ||
        known.run.workflow !== run.workflow ||
        known.run.commit !== run.commit))
  )
    return portFailure("EVIDENCE_MISMATCH");
  if (isTerminalOperation(operation)) {
    return portSuccess(
      operation.state === event.state ?
        operation
      : uncertain(operation, attempt.observation)
    );
  }
  const phases = attempt.phases;
  const complete =
    attempt.observation.quality === "current" &&
    attempt.observation.completeness === "complete";
  const success =
    run.conclusion === "success" &&
    [
      "dispatch",
      "checkout",
      "restore",
      "command",
      "state-save",
      "cleanup"
    ].every(
      (phase) =>
        phases.filter((item) => item.phase === phase).length === 1 &&
        phases.some(
          (item) => item.phase === phase && item.status === "succeeded"
        )
    );
  const failed =
    ["failure", "timed_out"].includes(run.conclusion) ||
    phases.some((phase) => phase.status === "failed");
  const cancelled = run.conclusion === "cancelled";
  if (
    (event.state === "succeeded" && !complete) ||
    attempt.observation.quality !== "current" ||
    !(event.state === "succeeded" ? success
    : event.state === "failed" ? failed
    : cancelled)
  ) {
    return portSuccess(uncertain(operation, attempt.observation));
  }
  return portSuccess({
    ...operation,
    state: event.state,
    observation: attempt.observation,
    attempts: operation.attempts.map((item) =>
      item.attemptId === attempt.attemptId ? attempt : item
    ),
    actions: operation.actions.map((action) =>
      action.status === "outstanding" ?
        { ...action, status: "superseded" }
      : action
    )
  });
}

export interface SessionOperationRegistry extends OperationRegistryPort {
  hasActiveOperations(): boolean;
  knownOperations(): readonly ReadonlyData<OperationRecord>[];
}

export function createSessionOperationRegistry(deps: {
  readonly ids: IdPort;
  readonly clock: Pick<ClockPort, "now">;
}): SessionOperationRegistry {
  if (
    typeof deps?.ids?.next !== "function" ||
    typeof deps.clock?.now !== "function"
  )
    throw new Error("Operation registry requires session IDs and clock.");
  const records = new Map<
    string,
    { principalRef: string; value: VersionedOperation }
  >();
  const cursors = new Map<
    string,
    { principalRef: string; target: ReadonlyData<Target>; offset: number }
  >();
  let closed = false;
  const observation = () => ({
    quality: "current" as const,
    completeness: "complete" as const,
    evidence: "session" as const,
    observedAt: deps.clock.now()
  });
  function gate(control: RequestControl) {
    if (closed) return portCancelled("session_shutdown");
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    return undefined;
  }
  function accessible(
    scope: AuthorizedScope,
    entry: { principalRef: string; value: VersionedOperation }
  ) {
    return (
      scope.principalRef === entry.principalRef &&
      matchesOperationTarget(scope.target, entry.value.operation.target) &&
      (scope.operationId === undefined ||
        scope.operationId === entry.value.operation.operationId)
    );
  }
  function store(
    scope: AuthorizedScope,
    operation: ReadonlyData<OperationRecord>
  ) {
    const value = {
      revision: deps.ids.next("revision"),
      operation: structuredClone(operation)
    };
    records.set(operation.operationId, {
      principalRef: scope.principalRef,
      value
    });
    return portSuccess(structuredClone(value));
  }
  function stableAttempts(
    previous: ReadonlyData<OperationRecord>,
    next: ReadonlyData<OperationRecord>
  ) {
    return (
      new Set(next.attempts.map((attempt) => attempt.attemptId)).size ===
        next.attempts.length &&
      next.attempts.every(
        (attempt) => attempt.operationId === next.operationId
      ) &&
      previous.attempts.every((attempt, index) => {
        const updated = next.attempts[index];
        return (
          updated !== undefined &&
          sameLifecycleData(
            {
              ...attempt,
              phases: updated.phases,
              observation: updated.observation,
              run:
                updated.run ?
                  { ...updated.run, conclusion: attempt.run?.conclusion }
                : undefined
            },
            {
              ...updated,
              run:
                updated.run ?
                  { ...updated.run, conclusion: attempt.run?.conclusion }
                : undefined
            }
          ) &&
          (!attempt.run ||
            (updated.run !== undefined &&
              sameLifecycleData(
                { ...attempt.run, conclusion: updated.run.conclusion },
                updated.run
              )))
        );
      })
    );
  }
  function evidencedTerminal(
    previous: ReadonlyData<OperationRecord>,
    next: ReadonlyData<OperationRecord>
  ) {
    if (!isTerminalOperation(next) || isTerminalOperation(previous))
      return true;
    if (next.operation === "definition.author") {
      const reduced = reduceOperation(previous, {
        kind: "definition_completed",
        state: next.state,
        observation: next.observation,
        ...(next.result?.kind === "definition" ? { result: next.result } : {}),
        ...(next.error ? { error: next.error } : {})
      });
      return reduced.status === "ok" && sameLifecycleData(reduced.value, next);
    }
    if (
      next.state === "failed" &&
      next.error &&
      next.observation.evidence === "session"
    )
      return true;
    if (
      next.state === "cancelled" &&
      next.attempts.length === 0 &&
      next.cancellationRequestedAt &&
      next.observation.evidence === "session" &&
      next.observation.quality === "current" &&
      next.observation.completeness === "complete"
    )
      return true;
    const state = next.state;
    return next.attempts.some((attempt) => {
      const reduction = reduceOperation(previous, {
        kind: "completed",
        state,
        attempt
      });
      return reduction.status === "ok" && reduction.value.state === next.state;
    });
  }
  return {
    async create(scope, operation, control) {
      const stopped = gate(control);
      if (stopped) return stopped;
      if (
        !matchesOperationTarget(scope.target, operation.target) ||
        scope.operation !== operation.operation
      )
        return portForbidden();
      if (records.has(operation.operationId))
        return portFailure("PRECONDITION_FAILED");
      if (operation.state !== "queued")
        return portFailure("PRECONDITION_FAILED");
      return store(scope, operation);
    },
    async get(scope, operationId, control) {
      const stopped = gate(control);
      if (stopped) return stopped;
      const entry = records.get(operationId);
      if (!entry) return portAbsent(observation());
      return accessible(scope, entry) ?
          portSuccess(structuredClone(entry.value))
        : portForbidden();
    },
    async list(scope, pagination, control) {
      const stopped = gate(control);
      if (stopped) return stopped;
      const cursor =
        pagination.continuationToken ?
          cursors.get(pagination.continuationToken)
        : undefined;
      if (
        pagination.continuationToken &&
        (!cursor ||
          cursor.principalRef !== scope.principalRef ||
          !sameLifecycleData(cursor.target, scope.target))
      )
        return portFailure("INVALID_REQUEST");
      const items = [...records.values()].filter(
        (entry) =>
          entry.principalRef === scope.principalRef &&
          scope.target.repo.toLowerCase() ===
            entry.value.operation.target.repo.toLowerCase() &&
          (scope.target.environment === undefined ||
            scope.target.environment ===
              entry.value.operation.target.environment) &&
          (scope.target.application === undefined ||
            scope.target.application ===
              entry.value.operation.target.application)
      );
      const limit = pagination.pageSize ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return portFailure("INVALID_REQUEST");
      const offset = cursor?.offset ?? 0;
      const continuationToken =
        items.length > offset + limit ? deps.ids.next("revision") : undefined;
      if (continuationToken)
        cursors.set(continuationToken, {
          principalRef: scope.principalRef,
          target: structuredClone(scope.target),
          offset: offset + limit
        });
      return portSuccess({
        target: scope.target,
        items: structuredClone(
          items.slice(offset, offset + limit).map((entry) => entry.value)
        ),
        ...(continuationToken ? { continuationToken } : {}),
        observation:
          items.length > offset + limit ?
            {
              ...observation(),
              completeness: "partial",
              limitation:
                "The requested page does not include all session operations."
            }
          : observation()
      });
    },
    async compareAndSwap(scope, update, control) {
      const stopped = gate(control);
      if (stopped) return stopped;
      const entry = records.get(update.operationId);
      if (!entry) return portFailure("PRECONDITION_FAILED");
      if (!accessible(scope, entry)) return portForbidden();
      const previous = entry.value.operation;
      const next = update.replacement;
      if (
        entry.value.revision !== update.expectedRevision ||
        next.operationId !== previous.operationId ||
        next.operation !== previous.operation ||
        next.repairsOperationId !== previous.repairsOperationId ||
        next.repairsAttemptId !== previous.repairsAttemptId ||
        (previous.cancellationRequestedAt !== undefined &&
          next.cancellationRequestedAt !== previous.cancellationRequestedAt) ||
        !sameLifecycleData(next.target, previous.target) ||
        !sameLifecycleData(next.source, previous.source) ||
        !stableAttempts(previous, next) ||
        !evidencedTerminal(previous, next) ||
        (isTerminalOperation(previous) &&
          !sameLifecycleData(
            { ...previous, observation: next.observation },
            next
          )) ||
        previous.actions.some(
          (action) =>
            action.status !== "outstanding" &&
            !next.actions.some((candidate) =>
              sameLifecycleData(candidate, action)
            )
        )
      )
        return portFailure("PRECONDITION_FAILED");
      return store(scope, next);
    },
    hasActiveOperations() {
      return (
        !closed &&
        [...records.values()].some(
          (entry) => !isTerminalOperation(entry.value.operation)
        )
      );
    },
    knownOperations() {
      return structuredClone(
        [...records.values()].map((entry) => entry.value.operation)
      );
    },
    async close() {
      const already = closed;
      closed = true;
      return portSuccess({ status: already ? "already_released" : "released" });
    }
  };
}
