import type {
  createActionService,
  ActionContinuationContext
} from "./actions.js";
import type { LifecycleRequestFor } from "./contracts/catalog.js";
import type {
  DefinitionProposal,
  OperationRecord
} from "./contracts/common.js";
import type {
  DefinitionAuthoringSourcePort,
  DefinitionValidationPort
} from "./definition-ports.js";
import {
  evaluateAppSource,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE
} from "../modeling/app-source.js";
import {
  lifecycleError,
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable,
  type PortError,
  type PortSuccess,
  type PortResult
} from "./errors.js";
import {
  createOperationRecord,
  sameLifecycleData,
  type OperationEvent
} from "./operations.js";
import type {
  AgentAssistancePort,
  AuthorizationRequest,
  AuthorizedScope,
  CallerContext,
  ClockPort,
  IdPort,
  OperationRegistryPort,
  ReadonlyData,
  RequestControl,
  SourceSelection,
  SourceSnapshot,
  StagingArea,
  VersionedOperation
} from "./ports.js";
import {
  compareEffectiveInputManifests,
  validateSourceSelection,
  verifySourceExpectation
} from "./source.js";
import {
  createValidationPolicy,
  verifyValidationReport,
  type ValidationPolicy
} from "./validation-policy.js";

export interface DefinitionAuthoringDependencies {
  readonly source: DefinitionAuthoringSourcePort;
  readonly validator: DefinitionValidationPort;
  readonly registry: OperationRegistryPort;
  readonly actions: Pick<ReturnType<typeof createActionService>, "create">;
  readonly identity: {
    authorize(
      request: AuthorizationRequest<"definition.author">,
      control: RequestControl
    ): Promise<PortResult<AuthorizedScope<"definition.author">>>;
  };
  readonly agent: Pick<AgentAssistancePort, "assign" | "authenticateOutcome">;
  readonly ids: IdPort;
  readonly clock: Pick<ClockPort, "now">;
}
interface OwnedAuthoring {
  readonly snapshot: SourceSnapshot;
  readonly scope: AuthorizedScope<"definition.author">;
  readonly caller: CallerContext;
  readonly operationId: string;
  readonly policy: ValidationPolicy;
  staging?: StagingArea;
  proposal?: SourceSnapshot;
  record?: VersionedOperation;
}
export function createDefinitionAuthoring(
  deps: DefinitionAuthoringDependencies
) {
  if (
    [
      deps?.source?.captureForAuthoring,
      deps?.source?.captureProposal,
      deps?.source?.prepareStaging,
      deps?.source?.inspectStagedOutputs,
      deps?.source?.promote,
      deps?.source?.releaseSnapshot,
      deps?.source?.releaseStaging,
      deps?.validator?.validate,
      deps?.registry?.create,
      deps?.registry?.get,
      deps?.registry?.compareAndSwap,
      deps?.actions?.create,
      deps?.identity?.authorize,
      deps?.agent?.assign,
      deps?.agent?.authenticateOutcome,
      deps?.ids?.next,
      deps?.clock?.now
    ].some((method) => typeof method !== "function")
  )
    throw new Error(
      "Authoring requires complete source, validation, action, registry and trusted authority ports."
    );
  const owned = new Set<OwnedAuthoring>();
  const active = new Set<Promise<unknown>>();
  async function track<T>(work: Promise<T>): Promise<T> {
    active.add(work);
    try {
      return await work;
    } finally {
      active.delete(work);
    }
  }
  let closed = false;
  const stopped = (control: RequestControl) =>
    closed || control.cancellation.aborted;
  const unavailable = () =>
    portUnavailable("CAPABILITY_UNAVAILABLE", {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "session"
    });
  const observation = () => ({
    quality: "current" as const,
    completeness: "complete" as const,
    evidence: "source" as const,
    observedAt: deps.clock.now()
  });
  async function cleanup(
    item: OwnedAuthoring
  ): Promise<PortSuccess<void> | PortError> {
    if (!owned.delete(item)) return portSuccess(undefined);
    let failure: PortSuccess<void> | PortError = portSuccess(undefined);
    const { proposal, staging } = item;
    for (const release of [
      ...(proposal ? [() => deps.source.releaseSnapshot(proposal)] : []),
      ...(staging ? [() => deps.source.releaseStaging(staging)] : []),
      () => deps.source.releaseSnapshot(item.snapshot)
    ]) {
      try {
        const result = await release();
        if (result.status !== "ok") failure = result;
      } catch {
        failure = unavailable();
      }
    }
    return failure;
  }
  async function authority(item: OwnedAuthoring, control: RequestControl) {
    if (stopped(control)) return portCancelled("request_cancelled");
    const result = await deps.identity.authorize(
      {
        caller: item.caller,
        operation: "definition.author",
        target: item.scope.target,
        source: item.snapshot.provenance,
        operationId: item.operationId,
        approvalRef: item.scope.approvalRef
      },
      control
    );
    if (result.status !== "ok") return result;
    if (stopped(control)) return portCancelled("request_cancelled");
    if (
      !result.value.authorizationRef ||
      result.value.operation !== "definition.author" ||
      result.value.principalRef !== item.caller.principalRef ||
      result.value.operationId !== item.operationId ||
      result.value.approvalRef !== item.scope.approvalRef ||
      !sameLifecycleData(result.value.target, item.scope.target) ||
      !sameLifecycleData(result.value.source, item.snapshot.provenance)
    )
      return portForbidden();
    return result;
  }
  function completed(
    state: "succeeded" | "failed" | "cancelled",
    proposal?: ReadonlyData<DefinitionProposal>,
    error?: ReadonlyData<OperationRecord["error"]>
  ): PortSuccess<Extract<OperationEvent, { kind: "definition_completed" }>> {
    return portSuccess({
      kind: "definition_completed",
      state,
      observation: observation(),
      ...(proposal ?
        { result: { kind: "definition", proposal } as const }
      : {}),
      ...(error ? { error } : {})
    });
  }
  async function finish(
    item: OwnedAuthoring,
    context: ActionContinuationContext
  ): Promise<
    PortResult<Extract<OperationEvent, { kind: "definition_completed" }>>
  > {
    const { response, control } = context;
    if (stopped(control)) return portCancelled("request_cancelled");
    if (response.kind !== "agent.outcome" || !item.staging)
      return portFailure("ACTION_RESPONSE_INVALID");
    if (response.status !== "completed")
      return completed(
        response.status,
        undefined,
        response.status === "failed" ?
          lifecycleError("VALIDATION_FAILED", {
            diagnostics: response.diagnostics
          })
        : undefined
      );
    const outputs = await deps.source.inspectStagedOutputs(
      item.staging,
      response.stagedOutputRefs,
      control
    );
    if (outputs.status !== "ok") return outputs;
    if (
      !sameLifecycleData(outputs.value.staging, item.staging) ||
      !sameLifecycleData(outputs.value.outputRefs, response.stagedOutputRefs)
    )
      return portFailure("EVIDENCE_MISMATCH");
    if (stopped(control)) return portCancelled("request_cancelled");
    const captured = await deps.source.captureProposal(outputs.value, control);
    if (captured.status === "absent")
      return portFailure("DEFINITION_NOT_FOUND");
    if (captured.status !== "ok") return captured;
    if (captured.value.status === "incomplete")
      return portUnavailable("VALIDATION_INCOMPLETE", {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "source"
      });
    const proposed = captured.value.snapshot;
    item.proposal = proposed;
    if (stopped(control)) return portCancelled("request_cancelled");
    const complete = compareEffectiveInputManifests(
      proposed.manifest,
      proposed.manifest
    );
    if (complete.status !== "ok") return complete;
    if (
      item.proposal.snapshotRef === item.snapshot.snapshotRef ||
      !sameLifecycleData(item.proposal.selection, item.snapshot.selection) ||
      item.proposal.manifest.definition !== item.snapshot.manifest.definition ||
      item.proposal.manifest.fingerprint !==
        item.proposal.provenance.fingerprint ||
      !sameLifecycleData(
        {
          ...item.proposal.provenance,
          fingerprint: item.snapshot.provenance.fingerprint,
          resolvedAt: item.snapshot.provenance.resolvedAt
        },
        item.snapshot.provenance
      ) ||
      outputs.value.outputs.length === 0 ||
      !outputs.value.outputs.every((output) =>
        proposed.manifest.inputs.some((input) =>
          sameLifecycleData(input, output)
        )
      )
    )
      return portFailure("EVIDENCE_MISMATCH");
    const identity = {
      sourceFingerprint: item.snapshot.manifest.fingerprint,
      proposalFingerprint: item.proposal.manifest.fingerprint
    };
    const policy = item.policy;
    const validated = await deps.validator.validate(
      { snapshot: item.proposal, policy, ...identity },
      control
    );
    if (validated.status !== "ok") return validated;
    const report = verifyValidationReport(policy, validated.value, identity);
    if (report.status !== "ok") return report;
    const proposal: DefinitionProposal = {
      operationId: item.operationId,
      actionId: context.action.actionId,
      stagingRef: item.staging.stagingRef,
      outputs: outputs.value.outputs.map((output) => ({ ...output })),
      originalFingerprint: identity.sourceFingerprint,
      validation: report.value,
      promotion: "pending"
    };
    if (report.value.status !== "passed")
      return completed(
        "failed",
        { ...proposal, promotion: "refused" },
        lifecycleError(
          report.value.status === "failed" ?
            "VALIDATION_FAILED"
          : "VALIDATION_INCOMPLETE"
        )
      );
    const authorized = await authority(item, control);
    if (authorized.status !== "ok") return authorized;
    if (stopped(control)) return portCancelled("request_cancelled");
    const promoted = await deps.source.promote(
      {
        scope: authorized.value,
        outputs: outputs.value,
        proposal,
        expectedManifest: item.snapshot.manifest
      },
      control
    );
    if (promoted.status === "cancelled") return promoted;
    if (promoted.status === "promoted") {
      const match = compareEffectiveInputManifests(
        item.proposal.manifest,
        promoted.manifest
      );
      if (match.status !== "ok") return portFailure("EVIDENCE_MISMATCH");
      return completed("succeeded", { ...proposal, promotion: "promoted" });
    }
    return completed(
      "failed",
      {
        ...proposal,
        promotion:
          promoted.status === "refused" ? "refused"
          : promoted.rollback === "restored" ? "rolled_back"
          : "failed"
      },
      promoted.status === "failed" ?
        {
          ...promoted.failure.error,
          details: [
            ...(promoted.failure.error.details ?? []),
            ...promoted.diagnostics
          ].slice(0, 100)
        }
      : promoted.failure.error
    );
  }
  async function continuation(
    item: OwnedAuthoring,
    context: ActionContinuationContext
  ): Promise<PortResult<OperationEvent>> {
    let result: PortResult<
      Extract<OperationEvent, { kind: "definition_completed" }>
    >;
    try {
      result = await finish(item, context);
    } catch {
      result = unavailable();
    }
    const released = await cleanup(item);
    if (released.status !== "ok")
      return completed(
        "failed",
        result.status === "ok" ? result.value.result?.proposal : undefined,
        released.error
      );
    if (result.status === "ok") return result;
    return completed(
      result.status === "cancelled" ? "cancelled" : "failed",
      undefined,
      "error" in result ? result.error : undefined
    );
  }
  async function revalidate(
    item: OwnedAuthoring,
    context: ActionContinuationContext
  ): Promise<PortResult<void>> {
    if (stopped(context.control)) return portCancelled("request_cancelled");
    if (
      !owned.has(item) ||
      !item.staging ||
      context.operation.operationId !== item.operationId ||
      context.action.actionId !== item.staging.actionId ||
      !sameLifecycleData(context.action.source, item.snapshot.provenance) ||
      context.response.kind !== "agent.outcome" ||
      context.action.responder !== "agent"
    )
      return portFailure("ACTION_RESPONSE_INVALID");
    const authorized = await authority(item, context.control);
    if (authorized.status !== "ok") return authorized;
    const authenticated = await deps.agent.authenticateOutcome(
      context.caller,
      context.action,
      context.response,
      context.control
    );
    if (authenticated.status !== "ok") return authenticated;
    return (
        authenticated.value.agentBindingRef === item.caller.agentBindingRef &&
          authenticated.value.operationId === item.operationId &&
          authenticated.value.actionId === item.staging.actionId &&
          sameLifecycleData(authenticated.value.outcome, context.response)
      ) ?
        portSuccess(undefined)
      : portForbidden();
  }
  async function start(
    caller: CallerContext,
    target: SourceSelection,
    intent: ReadonlyData<LifecycleRequestFor<"definition.author">["input"]>,
    control: RequestControl,
    item: OwnedAuthoring
  ): Promise<PortResult<ReadonlyData<OperationRecord>>> {
    if (stopped(control)) return portCancelled("request_cancelled");
    const modelability = evaluateAppSource(
      item.snapshot.manifest.inputs
        .filter((input) => input.existed)
        .map((input) => input.path)
    );
    if (modelability.status === "unknown")
      return portUnavailable("SOURCE_UNAVAILABLE", {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "source"
      });
    if (modelability.status === "none")
      return portFailure("VALIDATION_FAILED", {
        diagnostics: [
          {
            message: UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
            classification: "modelability.no_dockerfile",
            truncated: false
          }
        ]
      });
    const authorized = await authority(item, control);
    if (authorized.status !== "ok") return authorized;
    const record = createOperationRecord(
      { ids: { next: () => item.operationId }, clock: deps.clock },
      {
        operation: "definition.author",
        target,
        source: item.snapshot.provenance
      }
    );
    const created = await deps.registry.create(
      authorized.value,
      record,
      control
    );
    if (created.status !== "ok") return created;
    let latest: VersionedOperation = created.value;
    item.record = latest;
    const action = await deps.actions.create(
      authorized.value,
      latest,
      {
        kind: "agent.author_definition",
        responder: "agent",
        message:
          "Author the definition in the operation-owned staging area; do not publish or deploy.",
        response: { kind: "agent.outcome" }
      },
      {
        principalRef: caller.principalRef,
        sessionRef: caller.sessionRef,
        agentBindingRef: caller.agentBindingRef
      },
      {
        revalidate: async (context) => {
          let result: PortResult<void>;
          try {
            result = await revalidate(item, context);
          } catch {
            result = unavailable();
          }
          if (
            result.status !== "ok" &&
            context.operation.actions.some(
              (action) =>
                action.actionId === context.action.actionId &&
                action.status === "accepted"
            )
          ) {
            const released = await cleanup(item);
            if (released.status !== "ok") return released;
          }
          return result;
        },
        continue: (context) => track(continuation(item, context))
      },
      control
    );
    if (action.status !== "ok") return action;
    latest = action.value;
    item.record = latest;
    const assignedAction = latest.operation.actions.at(-1);
    if (!assignedAction || assignedAction.responder !== "agent")
      return portFailure("EVIDENCE_MISMATCH");
    const staging = await deps.source.prepareStaging(
      authorized.value,
      {
        operationId: item.operationId,
        actionId: assignedAction.actionId,
        snapshot: item.snapshot
      },
      control
    );
    if (staging.status !== "ok") return staging;
    item.staging = staging.value;
    if (
      item.staging.operationId !== item.operationId ||
      item.staging.actionId !== assignedAction.actionId ||
      !sameLifecycleData(item.staging.snapshot, item.snapshot)
    )
      return portFailure("EVIDENCE_MISMATCH");
    if (stopped(control)) return portCancelled("request_cancelled");
    const delivery = await deps.agent.assign(
      authorized.value,
      {
        operation: "definition.author",
        action: assignedAction,
        staging: item.staging,
        intent
      },
      control
    );
    if (delivery.status !== "ok") return delivery;
    if (stopped(control)) return portCancelled("request_cancelled");
    if (
      delivery.value.operationId !== item.operationId ||
      delivery.value.actionId !== assignedAction.actionId
    )
      return portFailure("EVIDENCE_MISMATCH");
    const current = await deps.registry.get(
      authorized.value,
      item.operationId,
      control
    );
    if (current.status === "absent") return portFailure("EVIDENCE_MISMATCH");
    return current.status === "ok" ?
        portSuccess(current.value.operation)
      : current;
  }
  async function author(
    scope: AuthorizedScope<"definition.author">,
    caller: CallerContext,
    target: SourceSelection,
    intent: ReadonlyData<LifecycleRequestFor<"definition.author">["input"]>,
    control: RequestControl
  ): Promise<PortResult<ReadonlyData<OperationRecord>>> {
    if (stopped(control)) return portCancelled("request_cancelled");
    if (target.source.kind !== "workspace" || !caller.agentBindingRef)
      return unavailable();
    if (
      !scope.approvalRef ||
      scope.approvalRef !== caller.approvedHostActionRef ||
      scope.principalRef !== caller.principalRef ||
      !sameLifecycleData(scope.target, target)
    )
      return portForbidden();
    const valid = validateSourceSelection(target, control.cancellation);
    if (valid.status !== "ok") return valid;
    let item: OwnedAuthoring | undefined;
    let result: PortResult<ReadonlyData<OperationRecord>>;
    try {
      const captured = await deps.source.captureForAuthoring(
        scope,
        target,
        control
      );
      if (captured.status === "absent")
        return portUnavailable("SOURCE_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "source"
        });
      if (captured.status !== "ok") return captured;
      if (captured.value.status === "incomplete")
        return portUnavailable("VALIDATION_INCOMPLETE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "source"
        });
      item = {
        // Source snapshots are adapter-owned capabilities, not cloneable DTOs.
        snapshot: captured.value.snapshot,
        scope: structuredClone(scope),
        caller: { ...caller },
        operationId: deps.ids.next("operation"),
        policy: createValidationPolicy("authoring", intent.provider)
      };
      owned.add(item);
      const expected = verifySourceExpectation(
        target,
        item.snapshot.provenance,
        item.snapshot.manifest,
        control.cancellation
      );
      result =
        expected.status !== "ok" ? expected
        : !sameLifecycleData(item.snapshot.selection, target) ?
          portFailure("EVIDENCE_MISMATCH")
        : await start(
            caller,
            structuredClone(target),
            structuredClone(intent),
            control,
            item
          );
    } catch {
      result =
        stopped(control) ? portCancelled("request_cancelled") : unavailable();
    }
    if (item && result.status !== "ok") {
      const released = await cleanup(item);
      if (released.status !== "ok") result = released;
      if (item.record && !control.cancellation.aborted) {
        const saved = await deps.registry.compareAndSwap(
          item.scope,
          {
            operationId: item.operationId,
            expectedRevision: item.record.revision,
            replacement: {
              ...item.record.operation,
              state: result.status === "cancelled" ? "cancelled" : "failed",
              observation: observation(),
              ...("error" in result ? { error: result.error } : {})
            }
          },
          control
        );
        if (saved.status !== "ok") return saved;
      }
      if ("error" in result && item.record) {
        const failure = structuredClone(result);
        failure.error.operationId = item.operationId;
        return failure;
      }
    }
    return result;
  }
  return {
    author(...args: Parameters<typeof author>) {
      return track(author(...args));
    },
    async close(): Promise<PortResult<void>> {
      closed = true;
      await Promise.allSettled([...active]);
      let result: PortResult<void> = portSuccess(undefined);
      for (const item of owned) {
        const released = await cleanup(item);
        if (released.status !== "ok") result = released;
      }
      return result;
    }
  };
}
