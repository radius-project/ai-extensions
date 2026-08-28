import {
  prepareProviderMutation,
  providerMutationRecord,
  recordProviderMutationDiagnostics,
  settleProviderMutation,
  type ProviderMutationRecord
} from "../../operations.js";
import {
  findExactVerificationRun,
  hasPostDispatchVerificationRuns
} from "../../verification-run-identity.js";
import { parseVerifyWorkflowRunUrl } from "../../verification-plan.js";
import {
  providerMutationOutcomeUnknown,
  ProviderMutationRecoveryError,
  type ProviderMutationCommandResult
} from "./provider-mutation-recovery.js";

const RECONCILE_DELAYS_MS = Object.freeze([0, 2000, 5000]);
const REGISTRATION_RETRY_DELAYS_MS = Object.freeze([2000, 5000]);

export interface VerificationDispatchIdentity {
  dispatchedAt: number;
  baselineRunId: number | null;
  ref: string;
  environment: string;
  operationMarker: string | null;
}

export type VerificationDispatchOutcome =
  | {
      state: "accepted";
      runId: string;
      runUrl: string;
      recovered: boolean;
    }
  | { state: "manual_required"; guidance: string }
  | {
      state: "rejected";
      detail: string;
      result: ProviderMutationCommandResult;
    }
  | {
      state: "baseline_failed";
      detail: string;
      result: ProviderMutationCommandResult | null;
      unreadable: boolean;
    }
  | { state: "cancelled" };

export interface VerificationDispatchPorts {
  runGh(args: string[]): Promise<ProviderMutationCommandResult>;
  sendDispatch(): Promise<ProviderMutationCommandResult>;
  persist(): Promise<void>;
  stopBoundary(boundary: string): Promise<boolean>;
  applyIdentity(
    identity: VerificationDispatchIdentity,
    run: { runId: string; runUrl: string } | null
  ): void;
  terminalizeManualRequired(guidance: string): void;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface VerificationDispatchInput {
  operation: object;
  kind: "github_workflow.dispatch" | "github_workflow.dispatch_retry";
  target: string;
  repo: string;
  workflowPath: string;
  workflowFile: string;
  environment: string;
  ref: string;
  operationMarker: string;
  allowRegistrationRetry: boolean;
  host?: string;
  ports: VerificationDispatchPorts;
}

function commandDiagnostic(result: ProviderMutationCommandResult): string {
  const detail = (result.stderr || result.stdout || "").trim();
  return `GitHub CLI exited with ${String(result.code)}${
    result.timedOut ? " after timing out" : ""
  }: ${detail || "no diagnostic"}`;
}

function thrownDiagnostic(error: unknown): string {
  return `GitHub CLI ended without a response: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

async function persistOrThrow(
  persist: () => Promise<void>,
  phase: string
): Promise<void> {
  try {
    await persist();
  } catch (error) {
    throw new ProviderMutationRecoveryError(
      `Could not persist the verification dispatch ${phase}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "provider-mutation-recovery-persistence-failed"
    );
  }
}

export function parseVerificationBaselineRunId(stdout: string): number | null {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub returned a non-array workflow run list.");
  }
  if (
    parsed.some((run) => {
      if (run === null || typeof run !== "object") return true;
      const id = (run as { databaseId?: unknown }).databaseId;
      return typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0;
    })
  ) {
    throw new Error(
      "GitHub returned a workflow run without a valid databaseId."
    );
  }
  return parsed.reduce<number | null>((latest, run) => {
    const id = (run as { databaseId: number }).databaseId;
    return latest === null || id > latest ? id : latest;
  }, null);
}

export function hasFreshWorkflowWriteProvenance(
  operation: unknown,
  workflowPath: string,
  ref: string
): boolean {
  if (!operation || typeof operation !== "object") return false;
  const files = (
    operation as {
      setupArtifacts?: {
        commit?: { workflowFiles?: unknown };
      };
    }
  ).setupArtifacts?.commit?.workflowFiles;
  return (
    Array.isArray(files) &&
    files.some(
      (file) =>
        file !== null &&
        typeof file === "object" &&
        (file as { path?: unknown }).path === workflowPath &&
        (file as { branch?: unknown }).branch === ref &&
        (file as { state?: unknown }).state === "committed" &&
        typeof (file as { commitSha?: unknown }).commitSha === "string" &&
        Boolean((file as { commitSha: string }).commitSha) &&
        typeof (file as { blobSha?: unknown }).blobSha === "string" &&
        Boolean((file as { blobSha: string }).blobSha) &&
        typeof (file as { contentSha256?: unknown }).contentSha256 ===
          "string" &&
        Boolean((file as { contentSha256: string }).contentSha256)
    )
  );
}

export function isWorkflowRegistrationRejection(
  result: ProviderMutationCommandResult,
  hasFreshWriteProvenance: boolean
): boolean {
  if (
    !hasFreshWriteProvenance ||
    result.code === 0 ||
    result.code === "0" ||
    providerMutationOutcomeUnknown(result)
  ) {
    return false;
  }
  const diagnostic = `${result.stderr || ""}\n${result.stdout || ""}`;
  if (/\bHTTP\s+404\b/i.test(diagnostic)) {
    return (
      /\bworkflow\b/i.test(diagnostic) &&
      /\b(?:not found|does not exist|not available)\b/i.test(diagnostic) &&
      /\b(?:branch|ref)\b/i.test(diagnostic)
    );
  }
  return (
    /\bHTTP\s+422\b/i.test(diagnostic) &&
    /\bUnexpected inputs provided\b/i.test(diagnostic) &&
    /\b(?:radius_operation|environment)\b/i.test(diagnostic)
  );
}

function rearmRejectedMutation(mutation: ProviderMutationRecord): void {
  const now = new Date().toISOString();
  mutation.status = "prepared";
  mutation.preparedAt = now;
  mutation.updatedAt = now;
  mutation.evidence = null;
  mutation.providerId = null;
}

export async function runVerificationDispatch(
  input: VerificationDispatchInput
): Promise<VerificationDispatchOutcome> {
  const { operation, ports } = input;
  const existing = providerMutationRecord(operation, input.kind, input.target);
  if (existing && existing.status !== "not_applied") {
    const guidance =
      "Radius found an existing verification dispatch without a safely reusable result. Inspect GitHub Actions before starting setup again; Radius will not dispatch another run.";
    recordProviderMutationDiagnostics(operation, existing.mutationId, {
      final: "An existing verification dispatch was not safe to resume."
    });
    ports.terminalizeManualRequired(guidance);
    settleProviderMutation(
      operation,
      existing.mutationId,
      "manual_required",
      guidance
    );
    await persistOrThrow(ports.persist, "restored manual-required outcome");
    return { state: "manual_required", guidance };
  }
  const baselineResult = await ports.runGh([
    "run",
    "list",
    "--workflow=" + input.workflowFile,
    "--limit",
    "1",
    "--json",
    "databaseId",
    "--repo",
    input.repo
  ]);
  if (baselineResult.code !== 0 && baselineResult.code !== "0") {
    return {
      state: "baseline_failed",
      detail: commandDiagnostic(baselineResult),
      result: baselineResult,
      unreadable: false
    };
  }
  let baselineRunId: number | null;
  try {
    baselineRunId = parseVerificationBaselineRunId(baselineResult.stdout);
  } catch (error) {
    return {
      state: "baseline_failed",
      detail: error instanceof Error ? error.message : String(error),
      result: baselineResult,
      unreadable: true
    };
  }

  const identity: VerificationDispatchIdentity = {
    dispatchedAt: ports.now(),
    baselineRunId,
    ref: input.ref,
    environment: input.environment,
    operationMarker: input.operationMarker || null
  };
  ports.applyIdentity(identity, null);
  const intent = {
    dispatchedAt: identity.dispatchedAt,
    baselineRunId: identity.baselineRunId,
    ref: identity.ref,
    environment: identity.environment,
    operationMarker: identity.operationMarker,
    workflowPath: input.workflowPath
  };
  const freshWrite = hasFreshWorkflowWriteProvenance(
    operation,
    input.workflowPath,
    input.ref
  );
  const actionsUrl =
    `https://${input.host || "github.com"}/${input.repo}/actions/workflows/` +
    encodeURIComponent(input.workflowFile);

  const manualRequired = async (
    mutationId: string,
    guidance: string,
    finalDiagnostic: string
  ): Promise<VerificationDispatchOutcome> => {
    recordProviderMutationDiagnostics(operation, mutationId, {
      final: finalDiagnostic
    });
    ports.terminalizeManualRequired(guidance);
    settleProviderMutation(operation, mutationId, "manual_required", guidance);
    await persistOrThrow(ports.persist, "manual-required outcome");
    return { state: "manual_required", guidance };
  };

  const reconcile = async (
    mutationId: string
  ): Promise<VerificationDispatchOutcome> => {
    let finalDiagnostic =
      "No verification run with this operation's exact marker is visible.";
    for (const delay of RECONCILE_DELAYS_MS) {
      if (delay > 0) await ports.sleep(delay);
      const listed = await ports.runGh([
        "run",
        "list",
        "--workflow=" + input.workflowFile,
        "--limit",
        "10",
        "--json",
        "databaseId,createdAt,displayTitle,event,headBranch",
        "--repo",
        input.repo
      ]);
      if (listed.code !== 0 && listed.code !== "0") {
        finalDiagnostic = commandDiagnostic(listed);
        return manualRequired(
          mutationId,
          `Radius could not read verification runs after an ambiguous dispatch. Review ${actionsUrl}; Radius will not dispatch another run.`,
          finalDiagnostic
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(listed.stdout);
      } catch {
        finalDiagnostic = "GitHub returned an unreadable workflow run list.";
        return manualRequired(
          mutationId,
          `GitHub returned an unreadable verification run list after an ambiguous dispatch. Review ${actionsUrl}; Radius will not dispatch another run.`,
          finalDiagnostic
        );
      }
      if (!identity.operationMarker) {
        finalDiagnostic =
          "The installed workflow has no operation-specific marker.";
        return manualRequired(
          mutationId,
          `The installed verification workflow does not expose Radius's operation marker. Review ${actionsUrl}; Radius will not guess or dispatch another run.`,
          finalDiagnostic
        );
      }
      const exact = findExactVerificationRun(parsed, {
        baselineRunId: identity.baselineRunId,
        dispatchedAt: identity.dispatchedAt,
        ref: identity.ref,
        environment: identity.environment,
        operationMarker: identity.operationMarker
      });
      if (exact.state === "applied") {
        const runUrl = `https://${input.host || "github.com"}/${input.repo}/actions/runs/${exact.runId}`;
        ports.applyIdentity(identity, { runId: exact.runId, runUrl });
        finalDiagnostic =
          "The exact operation-marked verification run was adopted.";
        recordProviderMutationDiagnostics(operation, mutationId, {
          final: finalDiagnostic
        });
        settleProviderMutation(
          operation,
          mutationId,
          "confirmed",
          finalDiagnostic,
          exact.runId
        );
        await persistOrThrow(ports.persist, "reconciled run identity");
        return {
          state: "accepted",
          runId: exact.runId,
          runUrl,
          recovered: true
        };
      }
      if (
        exact.state === "ambiguous" ||
        hasPostDispatchVerificationRuns(
          parsed,
          identity.baselineRunId,
          identity.dispatchedAt
        )
      ) {
        finalDiagnostic =
          exact.state === "ambiguous" ?
            "Multiple runs match the exact operation marker."
          : "New workflow runs exist, but none matches the exact operation marker.";
        return manualRequired(
          mutationId,
          `Radius could not identify exactly one verification run after an ambiguous dispatch. Review ${actionsUrl}; Radius will not guess or dispatch another run.`,
          finalDiagnostic
        );
      }
    }
    return manualRequired(
      mutationId,
      `No exact verification run appeared after an ambiguous dispatch. Review ${actionsUrl}; Radius will not dispatch another run.`,
      finalDiagnostic
    );
  };

  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) {
      await ports.sleep(REGISTRATION_RETRY_DELAYS_MS[attempt - 2]);
    }
    const mutation = prepareProviderMutation(operation, {
      kind: input.kind,
      target: input.target,
      providerIdempotencyKey: identity.operationMarker,
      intent
    });
    if (mutation.status === "not_applied") {
      rearmRejectedMutation(mutation);
    }
    await persistOrThrow(ports.persist, "intent before contacting GitHub");
    if (
      !(await ports.stopBoundary(
        `before-verification-dispatch-attempt:${attempt}`
      ))
    ) {
      settleProviderMutation(
        operation,
        mutation.mutationId,
        "not_applied",
        "Radius stopped before sending the verification dispatch."
      );
      await persistOrThrow(ports.persist, "cancelled outcome");
      return { state: "cancelled" };
    }

    let result: ProviderMutationCommandResult;
    try {
      result = await ports.sendDispatch();
    } catch (error) {
      const diagnostic = thrownDiagnostic(error);
      recordProviderMutationDiagnostics(operation, mutation.mutationId, {
        initial: diagnostic
      });
      settleProviderMutation(
        operation,
        mutation.mutationId,
        "outcome_unknown",
        diagnostic
      );
      await persistOrThrow(ports.persist, "ambiguous dispatch outcome");
      return reconcile(mutation.mutationId);
    }

    const diagnostic = commandDiagnostic(result);
    recordProviderMutationDiagnostics(operation, mutation.mutationId, {
      initial: diagnostic,
      final: diagnostic
    });
    if (providerMutationOutcomeUnknown(result, input.target)) {
      settleProviderMutation(
        operation,
        mutation.mutationId,
        "outcome_unknown",
        diagnostic
      );
      await persistOrThrow(ports.persist, "ambiguous dispatch outcome");
      return reconcile(mutation.mutationId);
    }

    if (result.code === 0 || result.code === "0") {
      let run;
      try {
        run = parseVerifyWorkflowRunUrl(result.stdout, {
          targetRepo: input.repo,
          host: input.host
        });
      } catch (error) {
        const malformed = `${diagnostic}; ${
          error instanceof Error ? error.message : String(error)
        }`;
        recordProviderMutationDiagnostics(operation, mutation.mutationId, {
          final: malformed
        });
        settleProviderMutation(
          operation,
          mutation.mutationId,
          "outcome_unknown",
          malformed
        );
        await persistOrThrow(ports.persist, "ambiguous dispatch response");
        return reconcile(mutation.mutationId);
      }
      ports.applyIdentity(identity, run);
      settleProviderMutation(
        operation,
        mutation.mutationId,
        "confirmed",
        "GitHub CLI returned the created workflow run URL.",
        run.runId
      );
      await persistOrThrow(ports.persist, "returned run identity");
      return { state: "accepted", ...run, recovered: false };
    }

    const canRetry =
      input.allowRegistrationRetry &&
      attempt < 3 &&
      isWorkflowRegistrationRejection(result, freshWrite);
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "not_applied",
      diagnostic
    );
    await persistOrThrow(ports.persist, "rejected dispatch outcome");
    if (!canRetry) {
      return { state: "rejected", detail: diagnostic, result };
    }
  }
}
