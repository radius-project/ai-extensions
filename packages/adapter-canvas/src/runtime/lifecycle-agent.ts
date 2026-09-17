import {
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable,
  sameLifecycleData,
  validateSourcePath,
  verifySourceExpectation,
  type AgentAction,
  type AgentAssignment,
  type AgentAssistancePort,
  type AgentDelivery,
  type AgentOutcome,
  type AuthorizedScope,
  type CallerContext,
  type CancellationReceipt,
  type PortResult,
  type RequestControl
} from "@radius-project/core/lifecycle";
import type { DefinitionPromotionAdapter } from "@radius-project/adapter-shared";

export interface LifecycleAgentSkill {
  readonly skillRef: string;
}
export interface LifecycleAgentReceipt extends AgentDelivery {
  readonly principalRef: string;
  readonly sessionRef: string;
  readonly agentBindingRef: string;
}
type AssignmentScope = AuthorizedScope<
  "definition.author" | "operation.repair"
>;

/** Optional, authenticated host authority. The current SDK does not implement this port.
 * Methods must return adapter-redacted lifecycle diagnostics, never raw host logs.
 */
export interface TrustedLifecycleAgentHost {
  binding(): CallerContext;
  /** Issues a receipt without dispatch; binds current approval, source and action ownership. */
  issueAssignment(
    scope: AssignmentScope,
    assignment: AgentAssignment,
    control: RequestControl
  ): Promise<PortResult<LifecycleAgentReceipt>>;
  /** Rechecks receipt ownership, live approval, action and unchanged source, without consuming the action. */
  verifyAssignment(
    receipt: LifecycleAgentReceipt,
    scope: AssignmentScope,
    assignment: AgentAssignment,
    control: RequestControl
  ): Promise<PortResult<void>>;
  dispatch(
    receipt: LifecycleAgentReceipt,
    work: {
      readonly assignment: AgentAssignment;
      readonly skill: LifecycleAgentSkill;
      readonly stagingLocation: string;
    },
    control: RequestControl
  ): Promise<PortResult<void>>;
  /** Verifies actual host outcome evidence, not a caller-set source or completion field.
   * Identical verification must work before and after core atomically consumes the action.
   */
  verifyOutcome(
    receipt: LifecycleAgentReceipt,
    caller: CallerContext,
    action: AgentAction,
    outcome: AgentOutcome,
    control: RequestControl
  ): Promise<PortResult<void>>;
  /** Revalidates cancellation authority before requesting cancellation of the exact receipt. */
  cancel(
    scope: AuthorizedScope<"operation.cancel">,
    receipt: LifecycleAgentReceipt,
    control: RequestControl
  ): Promise<PortResult<CancellationReceipt>>;
}

export interface LifecycleAgentDependencies {
  readonly host?: TrustedLifecycleAgentHost;
  readonly discoverSkill: () => Promise<PortResult<LifecycleAgentSkill>>;
  readonly stagingLocation: DefinitionPromotionAdapter["stagingLocation"];
}
export interface LifecycleAgent extends AgentAssistancePort {
  /** Fences local continuations; does not claim remote cancellation or rollback. */
  close(): void;
}
interface OwnedAssignment {
  readonly scope: AssignmentScope;
  readonly assignment: AgentAssignment;
  receipt?: LifecycleAgentReceipt;
  delivered: boolean;
  cancelled: boolean;
  outcome?: AgentOutcome;
}

function unavailable() {
  const limitation =
    "The host does not provide authenticated operation-bound agent assignments and outcomes.";
  return portUnavailable(
    "CAPABILITY_UNAVAILABLE",
    {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "session",
      limitation
    },
    { diagnostics: [{ message: limitation, truncated: false }] }
  );
}
function opaque(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(ref);
}
function validAssignment(
  scope: AssignmentScope,
  work: AgentAssignment
): boolean {
  const { action, staging } = work;
  return (
    scope.operation === "definition.author" &&
    work.operation === "definition.author" &&
    !!scope.authorizationRef &&
    !!scope.approvalRef &&
    !!scope.principalRef &&
    opaque(action.operationId) &&
    opaque(action.actionId) &&
    opaque(staging.stagingRef) &&
    scope.operationId === action.operationId &&
    action.operationId === staging.operationId &&
    action.actionId === staging.actionId &&
    action.kind === "agent.author_definition" &&
    action.responder === "agent" &&
    action.response.kind === "agent.outcome" &&
    action.status === "outstanding" &&
    sameLifecycleData(scope.target, action.target) &&
    sameLifecycleData(scope.target, staging.snapshot.selection) &&
    scope.source?.kind === "workspace" &&
    sameLifecycleData(scope.source, action.source) &&
    sameLifecycleData(scope.source, staging.snapshot.provenance) &&
    scope.source.fingerprint === staging.snapshot.manifest.fingerprint
  );
}
function validOutputs(outcome: AgentOutcome, stagingRef: string): boolean {
  if (outcome.status !== "completed") return true;
  const refs = outcome.stagedOutputRefs;
  const prefix = `${stagingRef}/`;
  return (
    refs.length > 0 &&
    refs.length <= 100 &&
    new Set(refs.map((ref) => ref.toLowerCase())).size === refs.length &&
    refs.every((ref) => {
      if (!ref.startsWith(prefix)) return false;
      const filename = ref.slice(prefix.length);
      return (
        validateSourcePath(filename).status === "ok" &&
        !filename.includes("/") &&
        !filename.includes("\\")
      );
    })
  );
}

export function createLifecycleAgent(
  deps: LifecycleAgentDependencies
): LifecycleAgent {
  const { host } = deps;
  if (
    host &&
    [
      host.binding,
      host.issueAssignment,
      host.verifyAssignment,
      host.dispatch,
      host.verifyOutcome,
      host.cancel,
      deps.discoverSkill,
      deps.stagingLocation
    ].some((method) => typeof method !== "function")
  )
    throw new TypeError(
      "Lifecycle agent requires complete trusted host, skill and staging ports."
    );

  const owned = new Map<string, OwnedAssignment>();
  let closed = false;
  function stopped(control: RequestControl) {
    return (
      closed ? portCancelled("session_shutdown")
      : control.cancellation.aborted ? portCancelled("request_cancelled")
      : undefined
    );
  }
  function matchesBinding(
    receipt: LifecycleAgentReceipt,
    binding: CallerContext
  ): boolean {
    return (
      !!receipt.principalRef &&
      !!receipt.sessionRef &&
      !!receipt.agentBindingRef &&
      receipt.principalRef === binding.principalRef &&
      receipt.sessionRef === binding.sessionRef &&
      receipt.agentBindingRef === binding.agentBindingRef &&
      binding.responder === "agent"
    );
  }
  async function guarded<T>(
    control: RequestControl,
    run: (host: TrustedLifecycleAgentHost) => Promise<PortResult<T>>
  ): Promise<PortResult<T>> {
    if (!host) return unavailable();
    const stop = stopped(control);
    if (stop) return stop;
    try {
      const result = await run(host);
      return stopped(control) ?? result;
    } catch {
      return stopped(control) ?? unavailable();
    }
  }
  return {
    assign(scopeInput, assignmentInput, control) {
      return guarded(control, async (host) => {
        const scope = structuredClone(scopeInput);
        const assignment = structuredClone(assignmentInput);
        const staging = assignmentInput.staging;
        if (!validAssignment(scope, assignment))
          return portFailure("PRECONDITION_FAILED");
        const snapshot = assignment.staging.snapshot;
        const source = verifySourceExpectation(
          snapshot.selection,
          snapshot.provenance,
          snapshot.manifest
        );
        if (source.status !== "ok") return source;
        if (owned.has(assignment.action.actionId))
          return portFailure("ACTION_NOT_OUTSTANDING");
        const item: OwnedAssignment = {
          scope,
          assignment,
          delivered: false,
          cancelled: false
        };
        // Reserve before the first await. Uncertain issuance/dispatch is never retried.
        owned.set(assignment.action.actionId, item);
        const binding = structuredClone(host.binding());
        const issued = await host.issueAssignment(scope, assignment, control);
        if (issued.status !== "ok") return issued;
        const receipt = structuredClone(issued.value);
        item.receipt = receipt;
        const current = () =>
          stopped(control) ??
          ((
            !item.cancelled &&
            matchesBinding(receipt, binding) &&
            matchesBinding(receipt, host.binding()) &&
            receipt.principalRef === scope.principalRef &&
            receipt.operationId === assignment.action.operationId &&
            receipt.actionId === assignment.action.actionId &&
            opaque(receipt.deliveryRef)
          ) ?
            undefined
          : portForbidden());
        let invalid = current();
        if (invalid) return invalid;
        const verified = await host.verifyAssignment(
          receipt,
          scope,
          assignment,
          control
        );
        invalid = current();
        if (invalid) return invalid;
        if (verified.status !== "ok") return verified;
        const skill = await deps.discoverSkill();
        invalid = current();
        if (invalid) return invalid;
        if (skill.status !== "ok") return skill;
        if (!skill.value.skillRef) return unavailable();
        // Preserve the actual adapter-owned staging object: its identity is the authority.
        const location = await deps.stagingLocation(staging, control);
        invalid = current();
        if (invalid) return invalid;
        if (location.status !== "ok") return location;
        if (!location.value) return unavailable();
        const ready = await host.verifyAssignment(
          receipt,
          scope,
          assignment,
          control
        );
        invalid = current();
        if (invalid) return invalid;
        if (ready.status !== "ok") return ready;
        let sent: PortResult<void>;
        try {
          sent = await host.dispatch(
            receipt,
            {
              assignment,
              skill: skill.value,
              stagingLocation: location.value
            },
            control
          );
        } catch {
          sent = portFailure("DISPATCH_UNCONFIRMED", {
            diagnostics: [
              {
                message:
                  "Host assignment dispatch threw; delivery is unconfirmed.",
                truncated: false
              }
            ]
          });
        }
        invalid = current();
        if (invalid) return invalid;
        if (sent.status !== "ok")
          return sent.status === "cancelled" ?
              sent
            : portFailure("DISPATCH_UNCONFIRMED", {
                diagnostics: sent.error.details
              });
        item.delivered = true;
        return portSuccess({
          deliveryRef: receipt.deliveryRef,
          operationId: receipt.operationId,
          actionId: receipt.actionId
        });
      });
    },
    authenticateOutcome(callerInput, actionInput, outcomeInput, control) {
      return guarded(control, async (host) => {
        const caller = structuredClone(callerInput);
        const action = structuredClone(actionInput);
        const outcome = structuredClone(outcomeInput);
        const item = owned.get(action.actionId);
        const receipt = item?.receipt;
        if (
          !item ||
          !receipt ||
          !item.delivered ||
          item.cancelled ||
          !matchesBinding(receipt, caller) ||
          !matchesBinding(receipt, host.binding())
        )
          return portForbidden();
        if (
          !["outstanding", "accepted"].includes(action.status) ||
          !sameLifecycleData(
            { ...action, status: "outstanding" },
            item.assignment.action
          ) ||
          !validOutputs(outcome, item.assignment.staging.stagingRef) ||
          (item.outcome && !sameLifecycleData(item.outcome, outcome))
        )
          return portFailure("ACTION_RESPONSE_INVALID");
        const current = () =>
          stopped(control) ??
          (item.cancelled || !matchesBinding(receipt, host.binding()) ?
            portForbidden()
          : undefined);
        const authorized = await host.verifyAssignment(
          receipt,
          item.scope,
          item.assignment,
          control
        );
        let invalid = current();
        if (invalid) return invalid;
        if (authorized.status !== "ok") return authorized;
        const verified = await host.verifyOutcome(
          receipt,
          caller,
          action,
          outcome,
          control
        );
        invalid = current();
        if (invalid) return invalid;
        if (verified.status !== "ok") return verified;
        // Verification is repeatable; only the core action service consumes responses.
        if (item.outcome && !sameLifecycleData(item.outcome, outcome))
          return portFailure("ACTION_RESPONSE_INVALID");
        item.outcome = outcome;
        return portSuccess({
          agentBindingRef: receipt.agentBindingRef,
          operationId: receipt.operationId,
          actionId: receipt.actionId,
          outcome: structuredClone(outcome)
        });
      });
    },
    cancel(scope, delivery, control) {
      return guarded(control, async (host) => {
        const item = owned.get(delivery.actionId);
        const receipt = item?.receipt;
        if (
          !item ||
          !receipt ||
          !matchesBinding(receipt, host.binding()) ||
          scope.principalRef !== receipt.principalRef ||
          scope.operation !== "operation.cancel" ||
          !scope.authorizationRef ||
          scope.operationId !== receipt.operationId ||
          delivery.operationId !== receipt.operationId ||
          delivery.deliveryRef !== receipt.deliveryRef ||
          !sameLifecycleData(scope.target, item.scope.target) ||
          !sameLifecycleData(scope.source, item.scope.source)
        )
          return portForbidden();
        if (item.cancelled) return portFailure("ACTION_NOT_OUTSTANDING");
        item.cancelled = true;
        const result = await host.cancel(
          structuredClone(scope),
          receipt,
          control
        );
        return matchesBinding(receipt, host.binding()) ? result : (
            portForbidden()
          );
      });
    },
    close() {
      closed = true;
      owned.clear();
    }
  };
}
