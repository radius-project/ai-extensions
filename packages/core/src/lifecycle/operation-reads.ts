import type { LifecycleResponseFor } from "./contracts/catalog.js";
import type {
  AuthorizedScope,
  ExecutionCorrelation,
  OperationRegistryPort,
  Pagination,
  ReadonlyData,
  RequestControl,
  WorkflowExecutionPort
} from "./ports.js";
import { portSuccess, portUnavailable, type PortResult } from "./errors.js";
import { reduceExecutionObservation } from "./execution-result.js";

export function createOperationReads(deps: {
  readonly registry: OperationRegistryPort;
  readonly workflow?: Pick<WorkflowExecutionPort, "reconcile" | "observe">;
}) {
  return {
    async get(
      scope: AuthorizedScope<"operation.get">,
      operationId: string,
      control: RequestControl
    ): Promise<
      PortResult<ReadonlyData<LifecycleResponseFor<"operation.get">["result"]>>
    > {
      const stored = await deps.registry.get(scope, operationId, control);
      if (stored.status === "absent")
        return portUnavailable("OPERATION_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "session",
          limitation: "Only this session's known operations are available."
        });
      if (stored.status !== "ok") return stored;
      const operation = stored.value.operation;
      const attempt = operation.attempts.at(-1);
      if (
        !deps.workflow ||
        operation.operation !== "deployment.start" ||
        operation.source?.kind !== "git" ||
        !attempt ||
        !operation.target.environment ||
        !operation.target.application
      )
        return portSuccess(operation);
      const correlation: ExecutionCorrelation = {
        operationId,
        attemptId: attempt.attemptId,
        operation: "deployment.start",
        target: {
          repo: operation.target.repo,
          environment: operation.target.environment,
          application: operation.target.application
        },
        expectedCommit: operation.source.commit
      };
      let run = attempt.run;
      if (!run) {
        const matched = await deps.workflow.reconcile(
          scope,
          correlation,
          control
        );
        if (matched.status !== "ok" || matched.value.matches.length !== 1)
          return portSuccess({
            ...operation,
            observation: {
              ...operation.observation,
              quality: "unknown",
              completeness: "partial",
              limitation:
                "No unique correlated workflow is confirmed; do not repeat dispatch."
            }
          });
        run = { ...matched.value.matches[0], conclusion: "unknown" };
      }
      const { conclusion: _conclusion, ...runIdentity } = run;
      const identity = { ...correlation, run: runIdentity };
      const observed = await deps.workflow.observe(scope, identity, control);
      if (observed.status !== "ok")
        return portSuccess({
          ...operation,
          observation: {
            ...operation.observation,
            quality: operation.observation.observedAt ? "stale" : "unknown",
            completeness: "partial",
            limitation:
              "Workflow observation unavailable; execution state retained."
          }
        });
      const reduced = reduceExecutionObservation(
        operation,
        identity,
        observed.value
      );
      if (reduced.status !== "ok") return reduced;
      const updated = await deps.registry.compareAndSwap(
        scope,
        {
          operationId,
          expectedRevision: stored.value.revision,
          replacement: reduced.value
        },
        control
      );
      if (updated.status === "ok") return portSuccess(updated.value.operation);
      // A concurrent read can win the registry revision. Read its result;
      // never redispatch or replay a stale state update.
      if (
        updated.status === "failed" &&
        updated.error.code === "PRECONDITION_FAILED"
      ) {
        const current = await deps.registry.get(scope, operationId, control);
        if (current.status === "ok")
          return portSuccess(current.value.operation);
      }
      return updated;
    },
    async list(
      scope: AuthorizedScope<"operation.list">,
      pagination: Pagination,
      control: RequestControl
    ): Promise<
      PortResult<ReadonlyData<LifecycleResponseFor<"operation.list">["result"]>>
    > {
      const result = await deps.registry.list(scope, pagination, control);
      if (result.status !== "ok") return result;
      return portSuccess({
        ...result.value,
        items: result.value.items.map((entry) => entry.operation),
        observation: {
          ...result.value.observation,
          limitation:
            "Session-owned operations only; no durable history or restart reconstruction."
        }
      });
    }
  };
}
