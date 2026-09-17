import type {
  LifecycleRequestFor,
  LifecycleResponseFor
} from "./contracts/catalog.js";
import {
  lifecycleError,
  portCancelled,
  portFailure,
  portSuccess,
  portUnavailable,
  type PortResult
} from "./errors.js";
import {
  createExecutionAttempt,
  createOperationRecord,
  sameLifecycleData
} from "./operations.js";
import type {
  AuthorizedScope,
  CallerContext,
  ClockPort,
  IdPort,
  IdentityPort,
  OperationRegistryPort,
  ReadonlyData,
  RequestControl,
  SourceAccessPort,
  WorkflowExecutionPort
} from "./ports.js";
import { verifySourceExpectation } from "./source.js";
import { buildDeploymentPolicy } from "./deployment-policy.js";

export interface DeploymentDependencies {
  readonly source: Pick<SourceAccessPort, "capture" | "releaseSnapshot">;
  readonly identity: Pick<IdentityPort, "authorize">;
  readonly registry: OperationRegistryPort;
  readonly workflow: WorkflowExecutionPort;
  readonly ids: IdPort;
  readonly clock: Pick<ClockPort, "now">;
}
export function createDeployment(deps: DeploymentDependencies) {
  return {
    async start(
      scope: AuthorizedScope<"deployment.start">,
      caller: CallerContext,
      request: ReadonlyData<LifecycleRequestFor<"deployment.start">>,
      control: RequestControl
    ): Promise<PortResult<LifecycleResponseFor<"deployment.start">["result"]>> {
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      if (!sameLifecycleData(scope.target, request.target))
        return portFailure("PRECONDITION_FAILED");
      if (request.input.repairPolicy.mode !== "manual")
        return portUnavailable("CAPABILITY_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "session",
          limitation:
            "Automatic repair is not implemented; status only observes."
        });
      const captured = await deps.source.capture(
        scope,
        request.target,
        control
      );
      if (captured.status === "absent")
        return portFailure("DEFINITION_NOT_FOUND");
      if (captured.status !== "ok") return captured;
      if (captured.value.status !== "captured")
        return portUnavailable("SOURCE_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "source"
        });
      const snapshot = captured.value.snapshot;
      const checked = verifySourceExpectation(
        request.target,
        snapshot.provenance,
        snapshot.manifest,
        control.cancellation
      );
      const released = await deps.source.releaseSnapshot(snapshot);
      if (released.status !== "ok") return released;
      if (snapshot.provenance.kind !== "git")
        return portFailure("SOURCE_CHANGED");
      if (checked.status !== "ok") return checked;
      if (
        !sameLifecycleData(
          {
            repo: snapshot.selection.repo,
            definition: snapshot.selection.definition,
            source: snapshot.selection.source
          },
          {
            repo: request.target.repo,
            definition: request.target.definition,
            source: request.target.source
          }
        )
      )
        return portFailure("EVIDENCE_MISMATCH");
      const source = snapshot.provenance;
      const base = createOperationRecord(deps, {
        operation: "deployment.start",
        target: request.target,
        source
      });
      const attempt = createExecutionAttempt(deps.ids, base);
      const operation = {
        ...base,
        attempts: [attempt],
        observation: {
          quality: "unknown" as const,
          completeness: "unavailable" as const,
          evidence: "workflow" as const,
          limitation:
            "Dispatch may have started. Observe this operation; do not automatically repeat it."
        }
      };
      const authorized = await deps.identity.authorize(
        {
          caller,
          operation: "deployment.start",
          target: request.target,
          source,
          operationId: operation.operationId,
          ...(request.input.approvalRef ?
            { approvalRef: request.input.approvalRef }
          : {})
        },
        control
      );
      if (authorized.status !== "ok") return authorized;
      const preparation = {
        scope: authorized.value,
        intent: {
          operation: "deployment.start" as const,
          target: request.target
        },
        source,
        correlation: {
          operationId: operation.operationId,
          attemptId: attempt.attemptId,
          operation: "deployment.start" as const,
          target: {
            repo: request.target.repo,
            environment: request.target.environment,
            application: request.target.application
          },
          expectedCommit: source.commit
        }
      };
      const policy = buildDeploymentPolicy(preparation);
      if (policy.status !== "ok") return policy;
      if (authorized.value.principalRef !== caller.principalRef)
        return portFailure("PRECONDITION_FAILED");
      const prepared = await deps.workflow.prepare(preparation, control);
      if (prepared.status !== "ok") return prepared;
      if (!sameLifecycleData(prepared.value.preparation, preparation))
        return portFailure("EVIDENCE_MISMATCH");
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const stored = await deps.registry.create(
        authorized.value,
        operation,
        control
      );
      if (stored.status !== "ok") return stored;
      const dispatch = await deps.workflow.dispatch(prepared.value, control);
      const updated = {
        ...operation,
        observation: {
          quality: "unknown" as const,
          completeness: "unavailable" as const,
          evidence: "workflow" as const,
          limitation:
            "Dispatch may have started. Observe this operation; do not automatically repeat it."
        },
        ...(dispatch.status === "dispatched" ?
          {
            attempts: [
              {
                ...attempt,
                run: { ...dispatch.identity.run, conclusion: "queued" as const }
              }
            ]
          }
        : {}),
        ...(dispatch.status === "unconfirmed" ? { error: dispatch.error } : {})
      };
      const failure =
        dispatch.status !== "dispatched" && dispatch.status !== "unconfirmed";
      const replacement =
        failure ?
          {
            ...updated,
            state: "failed" as const,
            error:
              "error" in dispatch ?
                dispatch.error
              : lifecycleError("PRECONDITION_FAILED"),
            observation: {
              ...operation.observation,
              evidence: "session" as const
            }
          }
        : updated;
      // An accepted operation is recorded even when its dispatch is rejected.
      const saved = await deps.registry.compareAndSwap(
        authorized.value,
        {
          operationId: operation.operationId,
          expectedRevision: stored.value.revision,
          replacement
        },
        {
          ...control,
          // Finish local bookkeeping after a possibly delivered dispatch even
          // when the caller has stopped waiting. This does not authorize new IO.
          cancellation: { aborted: false, onAbort: () => () => {} }
        }
      );
      if (saved.status !== "ok") return saved;
      if (failure)
        return portFailure("PRECONDITION_FAILED", {
          operationId: operation.operationId
        });
      return portSuccess({
        operationId: operation.operationId,
        target: request.target,
        source,
        state: "queued",
        observation: updated.observation
      });
    }
  };
}
