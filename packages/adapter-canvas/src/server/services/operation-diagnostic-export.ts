import { createHash } from "node:crypto";

const UNKNOWN = "unknown";

const LIFECYCLE_STATES = new Set([
  "running",
  "input_required",
  "succeeded",
  "succeeded_with_warnings",
  "action_required",
  "failed",
  "failed_partial",
  "cancelled"
]);
const TERMINAL_STATES = new Set([
  "succeeded",
  "succeeded_with_warnings",
  "action_required",
  "failed",
  "failed_partial",
  "cancelled"
]);
const SUCCESS_STATES = new Set(["succeeded", "succeeded_with_warnings"]);
const STAGES = new Set([
  "authorize_identity",
  "configure_environment",
  "verify"
]);
const STAGE_STATES = new Set([
  "pending",
  "running",
  "succeeded",
  "warning",
  "failed",
  "skipped"
]);
const FAILURE_CLASSIFICATIONS = new Set([
  "user-fixable",
  "system",
  "unknown",
  "needs-someone-else",
  "verification-dispatch-failed",
  "workflow-installation-pending"
]);
const COMMAND_KINDS = new Set([
  "stop",
  "resume_input",
  "continue_setup",
  "cancel_workflow",
  "retry_setup",
  "retry_verification",
  "rollback",
  "retry_cleanup",
  "exit_setup"
]);
const COMMAND_STATES = new Set(["accepted", "running", "finished"]);
const CLEANUP_STATES = new Set([
  "not_started",
  "pending",
  "running",
  "succeeded",
  "succeeded_with_warnings",
  "not_needed"
]);
const CLEANUP_ARTIFACT_TYPES = new Set([
  "workflow_file",
  "github_environment_variable",
  "github_environment",
  "role_assignment",
  "federated_credential",
  "service_principal",
  "azure_app"
]);
const CLEANUP_OUTCOMES = new Set([
  "deleted",
  "restored",
  "not_found",
  "warning",
  "skipped"
]);
const RECOVERY_STATES = new Set([
  "idle",
  "reconciling",
  "rollback_pending",
  "manual_required",
  "unrecoverable_legacy",
  "complete"
]);
const MUTATION_STATUSES = new Set([
  "prepared",
  "confirmed",
  "not_applied",
  "outcome_unknown",
  "manual_required"
]);
const VERIFICATION_WORKFLOW_STATES = new Set([
  "active",
  "inactive",
  "cancelling",
  "unknown"
]);
const PROVIDERS = new Set(["azure"]);
const OPERATION_ID =
  /^op_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PRODUCT_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTEXT_LIMITS = {
  repository: 200,
  branch: 255,
  environment: 255,
  githubLogin: 100
} as const;

type UnknownRecord = Record<string, unknown>;

export interface OperationDiagnosticExport {
  diagnosticSchemaVersion: 2;
  generatedAt: string;
  productVersion: string;
  identifierProfile: "support_safe" | "support_safe_with_identifiers";
  contextualIdentifiers: OperationDiagnosticContext | null;
  operation: {
    operationId: string;
    operationSchemaVersion: number | null;
    provider: string;
    lifecycle: {
      state: string;
      terminalState: string | null;
      currentStage: string | null;
    };
    timing: {
      startedAt: string | null;
      lastActivityAt: string | null;
      endedAt: string | null;
      durationMs: number | null;
    };
    stages: Array<{ id: string; state: string }>;
    attempts: {
      setup: number;
      verification: number;
    };
    failure: { classification: string; stage: string | null } | null;
    stop: { requested: boolean; acknowledged: boolean };
    commandCounts: Array<{ kind: string; state: string; count: number }>;
    cleanup: {
      state: string;
      attempts: number;
      outcomeCounts: Array<{
        artifactType: string;
        outcome: string;
        count: number;
      }>;
      warningCount: number;
    };
    recovery: {
      state: string | null;
      mutationStatusCounts: Array<{ status: string; count: number }>;
    };
    verificationDispatched: boolean;
    verificationWorkflowState: string | null;
    unrecognizedValueCount: number;
  };
}

export interface OperationDiagnosticContext {
  repository: string | null;
  branch: string | null;
  environment: string | null;
  githubLogin: string | null;
  omittedFieldCount: number;
}

interface DiagnosticState {
  unrecognizedValueCount: number;
}

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as UnknownRecord)
    : null;
}

function nested(
  source: UnknownRecord | null,
  key: string
): UnknownRecord | null {
  return source ? record(source[key]) : null;
}

function entries(source: UnknownRecord | null, key: string): unknown[] {
  return source && Array.isArray(source[key]) ? source[key] : [];
}

function recognized(
  value: unknown,
  allowed: ReadonlySet<string>,
  state: DiagnosticState
): string {
  if (typeof value === "string" && allowed.has(value)) return value;
  state.unrecognizedValueCount += 1;
  return UNKNOWN;
}

function optionalRecognized(
  value: unknown,
  allowed: ReadonlySet<string>,
  state: DiagnosticState
): string | null {
  if (value === null || value === undefined || value === "") return null;
  return recognized(value, allowed, state);
}

function timestamp(
  value: unknown,
  state: DiagnosticState
): { text: string | null; milliseconds: number | null } {
  if (value === null || value === undefined || value === "") {
    return { text: null, milliseconds: null };
  }
  if (typeof value === "string") {
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) {
      return {
        text: new Date(milliseconds).toISOString(),
        milliseconds
      };
    }
  }
  state.unrecognizedValueCount += 1;
  return { text: null, milliseconds: null };
}

function nonnegativeInteger(value: unknown, state: DiagnosticState): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  state.unrecognizedValueCount += 1;
  return 0;
}

function optionalSchemaVersion(
  value: unknown,
  state: DiagnosticState
): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  state.unrecognizedValueCount += 1;
  return null;
}

function recordedTimestamp(value: unknown, state: DiagnosticState): boolean {
  return timestamp(value, state).text !== null;
}

function countPairs(
  pairs: ReadonlyArray<readonly [string, string]>
): Array<{ first: string; second: string; count: number }> {
  const counts = new Map<
    string,
    { first: string; second: string; count: number }
  >();
  for (const [first, second] of pairs) {
    const key = `${first}\0${second}`;
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { first, second, count: 1 });
  }
  return [...counts.values()].sort(
    (left, right) =>
      left.first.localeCompare(right.first) ||
      left.second.localeCompare(right.second)
  );
}

function countValues(values: readonly string[]): Array<{
  status: string;
  count: number;
}> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => ({ status, count }));
}

function productVersion(value: string): string {
  const trimmed = value.trim();
  return PRODUCT_VERSION.test(trimmed) ? trimmed : UNKNOWN;
}

function contextualIdentifier(
  value: unknown,
  maximumLength: number
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed.length > maximumLength ||
    CONTROL_CHARACTERS.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

export function createOperationDiagnosticContext(
  operation: unknown
): OperationDiagnosticContext {
  const source = record(operation);
  if (!source) throw new Error("Operation record is required.");
  const context = nested(source, "context");
  const journey = nested(source, "journey");
  const resumeTarget = nested(journey, "resumeTarget");
  const identifiers = {
    repository: contextualIdentifier(source.repo, CONTEXT_LIMITS.repository),
    branch: contextualIdentifier(
      journey?.resumeBranch ?? resumeTarget?.branch,
      CONTEXT_LIMITS.branch
    ),
    environment: contextualIdentifier(
      source.environment,
      CONTEXT_LIMITS.environment
    ),
    githubLogin: contextualIdentifier(
      context?.githubLogin,
      CONTEXT_LIMITS.githubLogin
    )
  };
  return {
    ...identifiers,
    omittedFieldCount: Object.values(identifiers).filter(
      (value) => value === null
    ).length
  };
}

export function operationDiagnosticContextFingerprint(
  context: OperationDiagnosticContext
): string {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

export function operationDiagnosticAvailable(operation: unknown): boolean {
  const source = record(operation);
  if (!source) return false;
  if (typeof source.state === "string" && SUCCESS_STATES.has(source.state)) {
    return false;
  }
  if (typeof source.state === "string" && TERMINAL_STATES.has(source.state)) {
    return true;
  }
  if (source.state === "input_required") return true;
  const stop = nested(nested(source, "control"), "stop");
  return (
    typeof stop?.requestedAt === "string" &&
    Number.isFinite(Date.parse(stop.requestedAt))
  );
}

export function createOperationDiagnosticExport({
  operation,
  version,
  now,
  includeContext = false
}: {
  operation: unknown;
  version: string;
  now: number;
  includeContext?: boolean;
}): OperationDiagnosticExport {
  const source = record(operation);
  if (!source) throw new Error("Operation record is required.");
  const operationId = source.operationId;
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) {
    throw new Error("Operation record has no valid generated identifier.");
  }
  if (!Number.isFinite(now)) {
    throw new Error("Diagnostic generation time is invalid.");
  }

  const diagnosticState: DiagnosticState = { unrecognizedValueCount: 0 };
  const lifecycleState = recognized(
    source.state,
    LIFECYCLE_STATES,
    diagnosticState
  );
  const currentStage = optionalRecognized(
    source.currentStage,
    STAGES,
    diagnosticState
  );
  const startedAt = timestamp(source.startedAt, diagnosticState);
  const lastActivityAt = timestamp(source.lastActivityAt, diagnosticState);
  const endedAt = timestamp(source.endedAt, diagnosticState);
  const durationEnd = endedAt.milliseconds ?? lastActivityAt.milliseconds;
  const durationMs =
    (
      startedAt.milliseconds !== null &&
      durationEnd !== null &&
      durationEnd >= startedAt.milliseconds
    ) ?
      durationEnd - startedAt.milliseconds
    : null;
  if (
    startedAt.milliseconds !== null &&
    durationEnd !== null &&
    durationEnd < startedAt.milliseconds
  ) {
    diagnosticState.unrecognizedValueCount += 1;
  }

  const stages = entries(source, "stages").map((value) => {
    const stage = record(value);
    return {
      id: recognized(stage?.id, STAGES, diagnosticState),
      state: recognized(stage?.state, STAGE_STATES, diagnosticState)
    };
  });

  const control = nested(source, "control");
  const attempts = nested(control, "attempts");
  const stop = nested(control, "stop");
  const commandPairs = entries(control, "commands").map(
    (value): readonly [string, string] => {
      const command = record(value);
      return [
        recognized(command?.kind, COMMAND_KINDS, diagnosticState),
        recognized(command?.state, COMMAND_STATES, diagnosticState)
      ];
    }
  );

  const setupArtifacts = nested(source, "setupArtifacts");
  const cleanup = nested(setupArtifacts, "cleanup");
  const cleanupPairs = entries(cleanup, "results").map(
    (value): readonly [string, string] => {
      const result = record(value);
      return [
        recognized(
          result?.artifactType,
          CLEANUP_ARTIFACT_TYPES,
          diagnosticState
        ),
        recognized(result?.outcome, CLEANUP_OUTCOMES, diagnosticState)
      ];
    }
  );
  const countedCleanupPairs = countPairs(cleanupPairs);

  const recovery = nested(source, "providerRecovery");
  const mutationStatuses = entries(recovery, "mutations").map((value) => {
    const mutation = record(value);
    return recognized(mutation?.status, MUTATION_STATUSES, diagnosticState);
  });

  const failureSource =
    source.failure === null || source.failure === undefined ?
      null
    : record(source.failure);
  if (
    source.failure !== null &&
    source.failure !== undefined &&
    failureSource === null
  ) {
    diagnosticState.unrecognizedValueCount += 1;
  }
  const failure =
    failureSource ?
      {
        classification: recognized(
          failureSource.classification,
          FAILURE_CLASSIFICATIONS,
          diagnosticState
        ),
        stage: optionalRecognized(failureSource.stage, STAGES, diagnosticState)
      }
    : null;

  const verification = nested(source, "verification");
  const dispatchedAt = verification?.dispatchedAt;

  return {
    diagnosticSchemaVersion: 2,
    generatedAt: new Date(now).toISOString(),
    productVersion: productVersion(version),
    identifierProfile:
      includeContext ? "support_safe_with_identifiers" : "support_safe",
    contextualIdentifiers:
      includeContext ? createOperationDiagnosticContext(source) : null,
    operation: {
      operationId,
      operationSchemaVersion: optionalSchemaVersion(
        source.schemaVersion,
        diagnosticState
      ),
      provider: recognized(source.provider, PROVIDERS, diagnosticState),
      lifecycle: {
        state: lifecycleState,
        terminalState:
          lifecycleState === UNKNOWN ? UNKNOWN
          : TERMINAL_STATES.has(lifecycleState) ? lifecycleState
          : null,
        currentStage
      },
      timing: {
        startedAt: startedAt.text,
        lastActivityAt: lastActivityAt.text,
        endedAt: endedAt.text,
        durationMs
      },
      stages,
      attempts: {
        setup: nonnegativeInteger(attempts?.setup, diagnosticState),
        verification: nonnegativeInteger(
          attempts?.verification,
          diagnosticState
        )
      },
      failure,
      stop: {
        requested: recordedTimestamp(stop?.requestedAt, diagnosticState),
        acknowledged: recordedTimestamp(stop?.acknowledgedAt, diagnosticState)
      },
      commandCounts: countPairs(commandPairs).map(
        ({ first, second, count }) => ({
          kind: first,
          state: second,
          count
        })
      ),
      cleanup: {
        state: recognized(cleanup?.state, CLEANUP_STATES, diagnosticState),
        attempts: nonnegativeInteger(cleanup?.attempts, diagnosticState),
        outcomeCounts: countedCleanupPairs.map(({ first, second, count }) => ({
          artifactType: first,
          outcome: second,
          count
        })),
        warningCount: countedCleanupPairs
          .filter(({ second }) => second === "warning")
          .reduce((total, entry) => total + entry.count, 0)
      },
      recovery: {
        state: optionalRecognized(
          recovery?.state,
          RECOVERY_STATES,
          diagnosticState
        ),
        mutationStatusCounts: countValues(mutationStatuses)
      },
      verificationDispatched:
        typeof dispatchedAt === "number" &&
        Number.isFinite(dispatchedAt) &&
        dispatchedAt > 0,
      verificationWorkflowState: optionalRecognized(
        verification?.workflowState,
        VERIFICATION_WORKFLOW_STATES,
        diagnosticState
      ),
      unrecognizedValueCount: diagnosticState.unrecognizedValueCount
    }
  };
}
