import {
  buildDeploymentPolicy,
  lifecycleError,
  portCancelled,
  portFailure,
  portSuccess,
  portUnavailable,
  sameLifecycleData,
  type AuthorizedScope,
  type ClockPort,
  type ExecutionCorrelation,
  type ExecutionIdentity,
  type IdPort,
  type PortResult,
  type PreparedWorkflow,
  type ReadResult,
  type RequestControl,
  type WorkflowExecutionPort,
  type WorkflowObservation,
  type WorkflowPreparation,
  type WorkflowRunIdentity
} from "@radius-project/core/lifecycle";
import { createExecutionEvidenceReader } from "./execution-evidence.js";
import { qualifiedLifecycleWorkflowAssets } from "./workflow-qualification.js";

export interface WorkflowQualification {
  readonly repo: string;
  readonly environment: string;
  readonly commit: string;
  readonly definition: string;
  readonly application: string;
  readonly workflow: string;
  readonly executionVersion: 1;
  readonly producerRef: string;
  readonly selectedFiles: Readonly<Record<string, string>>;
  readonly reviewedFiles: Readonly<Record<string, string>>;
  /** Bytes fetched at producerRef, not the repository's current default branch. */
  readonly producerFiles: Readonly<Record<string, string>>;
  /** The host's trusted packaged audit copy, never request-supplied templates. */
  readonly reviewedProducerFiles: Readonly<Record<string, string>>;
  readonly protections: "verified";
}
export interface WorkflowExecutionDependencies {
  readonly ids: IdPort;
  readonly clock: ClockPort;
  qualify(
    input: WorkflowPreparation,
    control: RequestControl
  ): Promise<PortResult<WorkflowQualification>>;
  revalidate(
    input: WorkflowPreparation,
    control: RequestControl
  ): Promise<PortResult<WorkflowQualification>>;
  dispatch(
    args: readonly string[],
    control: RequestControl
  ): Promise<{
    readonly code: number;
    readonly timedOut?: boolean;
    readonly rejected?: boolean;
  }>;
  runs(
    scope: AuthorizedScope<"operation.get" | "operation.cancel">,
    correlation: ExecutionCorrelation,
    control: RequestControl
  ): Promise<ReadResult<readonly ExecutionIdentity[]>>;
  observation(
    scope: AuthorizedScope<"operation.get" | "operation.cancel">,
    identity: ExecutionIdentity,
    control: RequestControl
  ): Promise<
    ReadResult<{
      readonly identity: ExecutionIdentity;
      readonly conclusion: WorkflowObservation["conclusion"];
      readonly artifact?: string;
      readonly progress?: string;
    }>
  >;
  cancelRun?(
    args: readonly string[],
    control: RequestControl
  ): Promise<PortResult<void>>;
}
export function createWorkflowExecution(
  deps: WorkflowExecutionDependencies
): WorkflowExecutionPort {
  const preparations = new Map<
    string,
    {
      prepared: PreparedWorkflow;
      qualification: WorkflowQualification;
      consumed: boolean;
      inputs: Readonly<Record<string, string>>;
    }
  >();
  const reader = createExecutionEvidenceReader();
  const unavailable = () =>
    portUnavailable("RESULT_UNAVAILABLE", {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "workflow"
    });
  function qualified(input: WorkflowPreparation, value: WorkflowQualification) {
    return (
      input.intent.operation === "deployment.start" &&
      value.repo === input.correlation.target.repo &&
      value.environment === input.correlation.target.environment &&
      value.application === input.correlation.target.application &&
      value.definition === input.intent.target.definition &&
      value.commit === input.source.commit &&
      value.protections === "verified" &&
      qualifiedLifecycleWorkflowAssets(value)
    );
  }
  async function read<T>(
    execute: () => Promise<ReadResult<T>>,
    control: RequestControl
  ): Promise<ReadResult<T>> {
    for (let attempt = 0; ; attempt++) {
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const result = await execute();
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      if (
        result.status !== "unavailable" ||
        !result.error.retryable ||
        attempt === 2
      )
        return result;
      const waited = await deps.clock.wait(
        250 * 2 ** attempt,
        control.cancellation
      );
      if (waited.status !== "ok") return waited;
    }
  }
  const correlationOf = ({ run: _run, ...correlation }: ExecutionIdentity) =>
    correlation;
  return {
    async prepare(input, control) {
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      input = structuredClone(input);
      const policy = buildDeploymentPolicy(input);
      if (policy.status !== "ok") return policy;
      const qualification = await deps.qualify(structuredClone(input), control);
      if (qualification.status !== "ok") return qualification;
      if (!qualified(input, qualification.value))
        return portFailure("PRECONDITION_FAILED");
      const prepared: PreparedWorkflow = {
        preparationRef: deps.ids.next("revision"),
        preparation: structuredClone(input),
        concurrencyScope: "repository"
      };
      preparations.set(prepared.preparationRef, {
        prepared,
        qualification: structuredClone(qualification.value),
        consumed: false,
        inputs: policy.value.inputs
      });
      return portSuccess(structuredClone(prepared));
    },
    async dispatch(prepared, control) {
      const record = preparations.get(prepared.preparationRef);
      if (
        !record ||
        record.consumed ||
        !sameLifecycleData(record.prepared, prepared)
      )
        return portFailure("PRECONDITION_FAILED");
      // Consume before awaits, including failures: a request is never a retry
      // token for a possibly delivered mutation.
      record.consumed = true;
      const preparation = record.prepared.preparation;
      const qualification = await deps.revalidate(
        structuredClone(preparation),
        control
      );
      if (qualification.status !== "ok") return qualification;
      if (
        !qualified(preparation, qualification.value) ||
        !sameLifecycleData(record.qualification, qualification.value)
      )
        return portFailure("PRECONDITION_FAILED");
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const args = [
        "workflow",
        "run",
        record.qualification.workflow,
        "--repo",
        record.qualification.repo,
        "--ref",
        preparation.source.ref,
        ...Object.entries(record.inputs).flatMap(([key, value]) => [
          "-f",
          `${key}=${value}`
        ])
      ];
      let delivered: Awaited<
        ReturnType<WorkflowExecutionDependencies["dispatch"]>
      >;
      try {
        delivered = await deps.dispatch(args, control);
      } catch {
        // A transport exception cannot establish that GitHub rejected the call.
        delivered = { code: 1, timedOut: true };
      }
      if (delivered.code !== 0 && delivered.rejected && !delivered.timedOut)
        return portFailure("PRECONDITION_FAILED");
      return {
        status: "unconfirmed",
        correlation: preparation.correlation,
        error: {
          ...lifecycleError("DISPATCH_UNCONFIRMED", {
            operationId: preparation.correlation.operationId
          }),
          code: "DISPATCH_UNCONFIRMED"
        }
      };
    },
    async reconcile(scope, correlation, control) {
      const result = await read(
        () => deps.runs(scope, correlation, control),
        control
      );
      if (result.status === "absent")
        return portSuccess({ matches: [], observation: result.observation });
      if (result.status !== "ok") return result;
      const matches: WorkflowRunIdentity[] = result.value
        .filter(
          (candidate) =>
            sameLifecycleData(correlationOf(candidate), correlation) &&
            candidate.run.repo === correlation.target.repo &&
            candidate.run.commit === correlation.expectedCommit &&
            candidate.run.runAttempt === 1 &&
            candidate.run.workflow === ".github/workflows/run-rad-commands.yml"
        )
        .map((candidate) => candidate.run);
      return portSuccess({
        matches,
        observation: {
          quality: matches.length === 1 ? "current" : "unknown",
          completeness: matches.length === 1 ? "complete" : "partial",
          evidence: "workflow",
          observedAt: deps.clock.now()
        }
      });
    },
    async observe(scope, identity, control) {
      const result = await read(
        () => deps.observation(scope, identity, control),
        control
      );
      if (result.status !== "ok") return result;
      if (!sameLifecycleData(result.value.identity, identity))
        return portFailure("EVIDENCE_MISMATCH");
      return portSuccess({
        identity,
        conclusion: result.value.conclusion,
        evidence:
          result.value.artifact !== undefined ?
            reader.read(result.value.artifact, identity)
          : result.value.progress !== undefined ?
            reader.readProgress(result.value.progress, identity)
          : unavailable(),
        observation: {
          quality: "current",
          completeness:
            result.value.artifact === undefined ? "partial" : "complete",
          evidence: "workflow",
          observedAt: deps.clock.now()
        }
      });
    },
    async cancel(scope, identity, control) {
      if (!deps.cancelRun)
        return portUnavailable("CAPABILITY_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "session",
          limitation: "The selected host cannot cancel an exact workflow run."
        });
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      if (
        scope.operation !== "operation.cancel" ||
        !scope.authorizationRef ||
        scope.operationId !== identity.operationId ||
        scope.target.repo !== identity.target.repo ||
        scope.target.environment !== identity.target.environment ||
        scope.target.application !== identity.target.application ||
        identity.run.repo !== identity.target.repo ||
        identity.run.commit !== identity.expectedCommit ||
        !/^[1-9][0-9]*$/.test(identity.run.runId) ||
        !Number.isSafeInteger(identity.run.runAttempt) ||
        identity.run.runAttempt < 1
      )
        return portFailure("PRECONDITION_FAILED");
      const current = await read(
        () => deps.observation(scope, identity, control),
        control
      );
      if (current.status === "absent") return unavailable();
      if (current.status !== "ok") return current;
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      if (!sameLifecycleData(current.value.identity, identity))
        return portFailure("EVIDENCE_MISMATCH");
      const observation = {
        quality: "current" as const,
        completeness: "partial" as const,
        evidence: "workflow" as const,
        observedAt: deps.clock.now()
      };
      const requestedAt = deps.clock.now();
      if (
        ["success", "failure", "cancelled", "timed_out", "skipped"].includes(
          current.value.conclusion
        )
      )
        return portSuccess({
          status:
            current.value.conclusion === "cancelled" ?
              "confirmed"
            : "already_completed",
          requestedAt,
          observation
        });
      if (current.value.conclusion === "unknown") return unavailable();
      let requested: PortResult<void>;
      try {
        requested = await deps.cancelRun(
          ["run", "cancel", identity.run.runId, "--repo", identity.run.repo],
          control
        );
      } catch {
        return unavailable();
      }
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      if (requested.status !== "ok") return requested;
      return portSuccess({
        status: "requested",
        requestedAt,
        observation: {
          ...observation,
          quality: "unknown",
          limitation:
            "Cancellation request received; termination and final state-save/cleanup remain unconfirmed."
        }
      });
    }
  };
}
