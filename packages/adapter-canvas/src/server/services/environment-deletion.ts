// Canvas adapter — environment-deletion runner.
//
// The background runner that tears an environment down when the user deletes it
// from the picker. It mirrors the environment-creation operation (issue #303,
// reusing Ryan Waite's async OperationRecord + progress-panel model) but walks a
// delete-specific stage inventory:
//
//   1. Delete the Radius environment on the cluster (via a dispatched workflow).
//   2. Remove the per-environment Azure federated credential(s).
//   3. Delete the GitHub environment.
//   4. Review the app registration: when it has no federated credentials left
//      it is unused. Radius never deletes an app registration automatically —
//      removing one can break other callers that still rely on it — so it always
//      prompts for a decision, tailoring the message by whether Radius created
//      it (`radius-managed` tag) or the user brought their own. When credentials
//      remain (it is still shared with another environment) or the list cannot
//      be read, it is left in place. An app that is already gone is a clean,
//      idempotent success and needs no prompt.
//
// Sequencing is load-bearing: the Radius-env-delete workflow authenticates to
// the cluster with the environment's own federated credential, so the credential
// must survive until after step 1. Step 1 fails closed: if the Radius
// environment delete cannot be confirmed (dispatch failure, missing run,
// timeout, or a non-guard workflow failure) the operation terminates as a
// retryable partial failure BEFORE any credential or GitHub-environment cleanup
// runs, so a failed delete never strips the identity a retry needs. Steps 2–4
// are best-effort and idempotent — a missing credential or app registration is a
// warning, not a failure — so a partially-completed prior deletion still
// converges.
//
// Only genuine I/O is injected; the pure operation-state mutators and the pure
// Azure argv/parse helpers are imported directly so the runner stays unit-
// testable against real OperationRecords with a handful of fakes.

import {
  enterStage,
  addStep,
  setStageState,
  finish,
  finishSucceeded,
  requireInput,
  hasWarnings,
  touchOperation,
  INPUT_REQUIRED_STATE,
  STAGE_DELETE_RADIUS_ENV,
  STAGE_DELETE_CREDENTIAL,
  STAGE_DELETE_GITHUB_ENV,
  STAGE_REVIEW_APP_REGISTRATION
} from "../../operations.js";
import {
  buildFederatedCredentialListArgs,
  buildFederatedCredentialDeleteArgs,
  buildAppDeleteArgs,
  buildAppTagShowArgs,
  parseFederatedCredentials,
  federatedCredentialListUnreadable,
  parseAppTags,
  parseRadiusAppProvenanceTags,
  selectEnvironmentFederatedCredentials,
  isAzResourceNotFound
} from "../../azure-oidc.js";
import {
  planCredentialReclamation,
  type CredentialProvenanceRecord,
  type CredentialRetentionReason
} from "../../credential-provenance.js";

// The in-panel prompt raised when an unused app registration was NOT created by
// Radius. The resume route and the browser progress controller key off the same
// literal.
export const DELETE_APP_REGISTRATION_DECISION =
  "delete-app-registration-decision";

export interface DeletionCommandResult {
  code?: string | number;
  stdout?: string;
  stderr?: string;
}

// Outcome of deleting the Radius environment through the dispatched workflow.
// `notFound` means there was no environment to delete (idempotent success);
// `failed` records a best-effort warning without aborting the operation;
// `apps_present` means the environment still has deployed applications, which is
// a hard stop — the whole deletion is aborted so nothing else is torn down.
export interface RadiusEnvDeletionOutcome {
  outcome: "deleted" | "not_found" | "failed" | "apps_present";
  detail?: string;
}

export interface GitHubEnvDeletionOutcome {
  outcome: "deleted" | "not_found" | "failed";
  detail?: string;
}

// The narrow I/O ports the runner needs. Everything else is a pure import.
export interface EnvironmentDeletionPorts {
  // Dispatch the delete-environment workflow and wait for the run to finish.
  // `onHeartbeat`, when provided, is invoked periodically while the run is being
  // polled so the caller can keep the operation's activity timestamp fresh and
  // avoid the staleness sweep abandoning a legitimately long-running deletion.
  deleteRadiusEnvironment(
    input: {
      repo: string;
      environment: string;
      provider: string;
    },
    onHeartbeat?: () => void | Promise<void>
  ): Promise<RadiusEnvDeletionOutcome>;
  // Run an `az` command. Never throws; a spawn failure surfaces as a result.
  runAz(args: string[]): Promise<DeletionCommandResult>;
  // Delete the GitHub environment (idempotent).
  deleteGitHubEnvironment(input: {
    repo: string;
    environment: string;
  }): Promise<GitHubEnvDeletionOutcome>;
  // The durable provenance records for a repo + environment (issue #331). Used
  // to prove Radius created a live federated credential before deleting it. An
  // empty list means "no proof", which the plan treats as retain (fail-safe).
  readCredentialProvenance(
    repo: string,
    environment: string
  ): CredentialProvenanceRecord[];
  // Forget the provenance for a repo + environment once its credentials have
  // been reclaimed, so a later re-setup starts from a clean slate.
  clearCredentialProvenance(repo: string, environment: string): Promise<void>;
  // Durably record the operation after each state transition.
  persist(): Promise<void>;
  errorMessage(error: unknown): string;
  log?(message: string): void;
}

interface DeletionOperation {
  provider?: string;
  repo?: string;
  environment?: string;
  currentStage?: string | null;
  stages: Array<{ id: string; state: string }>;
  request?: {
    clientId?: string;
    appDisplayName?: string;
    deleteAppRegistration?: boolean;
    [key: string]: unknown;
  };
  inputRequired?: unknown;
  state?: string;
  [key: string]: unknown;
}

function stageState(op: DeletionOperation, stageId: string): string | null {
  const stage = op.stages.find((s) => s.id === stageId);
  return stage ? stage.state : null;
}

// A stage present in the inventory that has not already reached a terminal
// verdict still needs its work run. An absent stage (provider without Azure
// cleanup) returns null and is skipped.
function stagePending(op: DeletionOperation, stageId: string): boolean {
  const state = stageState(op, stageId);
  return state === "pending" || state === "running";
}

/**
 * Run (or resume) an environment-deletion operation to completion.
 *
 * Resume-safe: each stage is skipped when it already holds a terminal verdict,
 * so re-invoking after an interruption picks up at the first unfinished stage.
 */
export async function runEnvironmentDeletion(
  op: DeletionOperation,
  ports: EnvironmentDeletionPorts
): Promise<void> {
  const repo = String(op.repo || "");
  const environment = String(op.environment || "");
  const provider = String(op.provider || "");
  const log = ports.log || (() => {});

  // Stage 1 — delete the Radius environment on the cluster.
  if (stagePending(op, STAGE_DELETE_RADIUS_ENV)) {
    enterStage(op, STAGE_DELETE_RADIUS_ENV);
    addStep(op, {
      stage: STAGE_DELETE_RADIUS_ENV,
      kind: "mutation",
      label: "Deleting the Radius environment on the cluster",
      state: "running"
    });
    await ports.persist();
    let outcome: RadiusEnvDeletionOutcome;
    try {
      // Heartbeat while the delete workflow run is polled so the operation is
      // not swept as stale (and its single-flight lock released) during a run
      // that can legitimately take much longer than the idle-stale window.
      const heartbeat = async () => {
        touchOperation(op);
        await ports.persist();
      };
      outcome = await ports.deleteRadiusEnvironment(
        {
          repo,
          environment,
          provider
        },
        heartbeat
      );
    } catch (error) {
      outcome = { outcome: "failed", detail: ports.errorMessage(error) };
    }
    if (outcome.outcome === "deleted") {
      addStep(op, {
        stage: STAGE_DELETE_RADIUS_ENV,
        kind: "mutation",
        label: "Deleted the Radius environment",
        state: "succeeded"
      });
      setStageState(op, STAGE_DELETE_RADIUS_ENV, "succeeded");
    } else if (outcome.outcome === "not_found") {
      addStep(op, {
        stage: STAGE_DELETE_RADIUS_ENV,
        kind: "observation",
        label: "No Radius environment to delete",
        state: "succeeded"
      });
      setStageState(op, STAGE_DELETE_RADIUS_ENV, "succeeded");
    } else if (outcome.outcome === "apps_present") {
      // A live application is still deployed to this environment. Deleting the
      // environment out from under it would orphan its resources, so abort the
      // whole operation before any cleanup (federated credential, GitHub
      // environment, app registration) runs and tell the user to delete their
      // application(s) first. This fails closed: nothing was torn down.
      const userMessage =
        outcome.detail ||
        "This environment still has one or more deployed applications. Delete the application(s) first, then delete the environment.";
      addStep(op, {
        stage: STAGE_DELETE_RADIUS_ENV,
        kind: "observation",
        label: "Environment still has deployed applications — deletion stopped",
        state: "failed"
      });
      setStageState(op, STAGE_DELETE_RADIUS_ENV, "failed");
      finish(op, "action_required", {
        terminal: {
          userMessage,
          code: "environment-has-applications"
        }
      });
      await ports.persist();
      return;
    } else {
      // The Radius environment delete could not be confirmed: the workflow
      // dispatch failed, the run was never found, it timed out, or it finished
      // with a non-guard failure. We must NOT proceed to the destructive
      // cleanup stages. Removing the federated credential and the GitHub
      // environment would strip the identity and inputs the delete workflow
      // needs, leaving the Radius environment stranded on the cluster with no
      // way to retry. Fail closed as a retryable partial failure and stop here
      // before any cleanup runs. (This is deterministic for AWS: the delete
      // route accepts AWS but the bundled env-delete workflow is Azure-only, so
      // an AWS provider always lands here rather than tearing down credentials.)
      log(`radius env delete failed: ${outcome.detail || "unknown"}`);
      const userMessage =
        outcome.detail ||
        "Radius could not confirm the environment was deleted from the cluster. Nothing else was removed — retry the deletion.";
      addStep(op, {
        stage: STAGE_DELETE_RADIUS_ENV,
        kind: "observation",
        label: "Could not delete the Radius environment — deletion stopped",
        state: "failed"
      });
      setStageState(op, STAGE_DELETE_RADIUS_ENV, "failed");
      finish(op, "failed_partial", {
        failure: {
          code: "radius-env-delete-failed",
          stage: STAGE_DELETE_RADIUS_ENV,
          stepSeq: null,
          message: userMessage,
          classification: "user-fixable",
          evidence: null
        }
      });
      await ports.persist();
      return;
    }
    await ports.persist();
  }

  // Stage 2 — remove the per-environment Azure federated credential(s).
  const clientId = String(op.request?.clientId || "");
  if (stagePending(op, STAGE_DELETE_CREDENTIAL)) {
    enterStage(op, STAGE_DELETE_CREDENTIAL);
    await ports.persist();
    await deleteEnvironmentCredentials(op, ports, {
      repo,
      environment,
      clientId
    });
    await ports.persist();
  }

  // Stage 3 — delete the GitHub environment.
  if (stagePending(op, STAGE_DELETE_GITHUB_ENV)) {
    enterStage(op, STAGE_DELETE_GITHUB_ENV);
    addStep(op, {
      stage: STAGE_DELETE_GITHUB_ENV,
      kind: "mutation",
      label: "Deleting the GitHub environment",
      state: "running"
    });
    await ports.persist();
    let ghOutcome: GitHubEnvDeletionOutcome;
    try {
      ghOutcome = await ports.deleteGitHubEnvironment({ repo, environment });
    } catch (error) {
      ghOutcome = { outcome: "failed", detail: ports.errorMessage(error) };
    }
    if (ghOutcome.outcome === "failed") {
      addStep(op, {
        stage: STAGE_DELETE_GITHUB_ENV,
        kind: "warning",
        label: "Could not delete the GitHub environment",
        warning: {
          code: "github-env-delete-failed",
          message: ghOutcome.detail || "The GitHub environment delete failed.",
          impact: "The GitHub environment may still exist. Retry the deletion."
        }
      });
      setStageState(op, STAGE_DELETE_GITHUB_ENV, "warning");
    } else {
      addStep(op, {
        stage: STAGE_DELETE_GITHUB_ENV,
        kind: "mutation",
        label:
          ghOutcome.outcome === "not_found" ?
            "No GitHub environment to delete"
          : "Deleted the GitHub environment",
        state: "succeeded"
      });
      setStageState(op, STAGE_DELETE_GITHUB_ENV, "succeeded");
    }
    await ports.persist();
  }

  // Stage 4 — review the app registration (Azure only). When it has no
  // federated credentials left it is unused. Radius never auto-deletes an app
  // registration: removing one can break other environments or callers that
  // still rely on it, so it always prompts for a decision. When credentials
  // remain (still shared) or the list cannot be read, it is left in place.
  if (stagePending(op, STAGE_REVIEW_APP_REGISTRATION)) {
    enterStage(op, STAGE_REVIEW_APP_REGISTRATION);
    await ports.persist();
    await reviewAppRegistration(op, ports, clientId);
    await ports.persist();
  }

  // A user-provenance prompt parks the operation in `input_required`; it must
  // not be finished until the user answers and the runner is resumed.
  if (op.state === INPUT_REQUIRED_STATE) return;

  finishSucceeded(
    op,
    hasWarnings(op) ? "succeeded_with_warnings" : "succeeded"
  );
  await ports.persist();
}

// Prompt/decision handling for the unused app registration. A resumed decision
// (`op.request.deleteAppRegistration`) short-circuits the provenance probe.
async function reviewAppRegistration(
  op: DeletionOperation,
  ports: EnvironmentDeletionPorts,
  clientId: string
): Promise<void> {
  const decision = op.request?.deleteAppRegistration;
  if (decision === true) {
    // Re-list the federated credentials immediately before deleting. The prompt
    // may have been open for a while, and a credential added to this app
    // registration in the meantime (e.g. another environment created against
    // it) would make it shared again. Deleting the app now would remove that
    // fresh credential too, so only delete when the app is still unused.
    const remaining = await listRemainingCredentials(ports, clientId);
    if (remaining === null) {
      addStep(op, {
        stage: STAGE_REVIEW_APP_REGISTRATION,
        kind: "warning",
        label: "Could not re-check the app registration's credentials",
        warning: {
          code: "app-registration-recheck-unavailable",
          message:
            "Re-listing the app registration's federated credentials failed after you confirmed deletion; leaving it in place.",
          impact: "The app registration was not deleted."
        }
      });
      setStageState(op, STAGE_REVIEW_APP_REGISTRATION, "warning");
      return;
    }
    if (remaining.length > 0) {
      addStep(op, {
        stage: STAGE_REVIEW_APP_REGISTRATION,
        kind: "warning",
        label: `App registration gained ${remaining.length} credential(s) while awaiting your decision; left in place`,
        warning: {
          code: "app-registration-became-shared",
          message:
            "A federated credential was added to the app registration while the delete prompt was open, so it is in use again and was not deleted.",
          impact: "The app registration was left in place."
        }
      });
      setStageState(op, STAGE_REVIEW_APP_REGISTRATION, "warning");
      return;
    }
    await deleteAppRegistration(op, ports, clientId);
    return;
  }
  if (decision === false) {
    addStep(op, {
      stage: STAGE_REVIEW_APP_REGISTRATION,
      kind: "observation",
      label: "Kept the app registration at your request",
      state: "succeeded"
    });
    setStageState(op, STAGE_REVIEW_APP_REGISTRATION, "succeeded");
    return;
  }
  const remaining = await listRemainingCredentials(ports, clientId);
  if (remaining === null) {
    addStep(op, {
      stage: STAGE_REVIEW_APP_REGISTRATION,
      kind: "warning",
      label: "Could not read the app registration's credentials",
      warning: {
        code: "app-registration-review-unavailable",
        message:
          "Listing the app registration's federated credentials failed; leaving it in place.",
        impact: "The app registration was not reviewed for deletion."
      }
    });
    setStageState(op, STAGE_REVIEW_APP_REGISTRATION, "warning");
    return;
  }
  if (remaining.length > 0) {
    addStep(op, {
      stage: STAGE_REVIEW_APP_REGISTRATION,
      kind: "observation",
      label: `App registration still has ${remaining.length} credential(s); left in place`,
      state: "succeeded"
    });
    setStageState(op, STAGE_REVIEW_APP_REGISTRATION, "succeeded");
    return;
  }
  // The app registration is unused. It is never auto-deleted: removing an app
  // registration can break other callers that still rely on it, so Radius always
  // asks before deleting one. A not-found app is already gone and needs no
  // prompt. Provenance only tailors the prompt wording.
  const provenance = await readAppProvenance(ports, clientId);
  if (provenance === "not_found") {
    addStep(op, {
      stage: STAGE_REVIEW_APP_REGISTRATION,
      kind: "observation",
      label: "App registration was already deleted",
      state: "succeeded"
    });
    setStageState(op, STAGE_REVIEW_APP_REGISTRATION, "succeeded");
    return;
  }
  const appDisplayName = String(op.request?.appDisplayName || "");
  const label = appDisplayName || clientId;
  const message =
    provenance === "managed" ?
      `App registration "${label}" is no longer used by any environment. Radius created it — delete it now?`
    : provenance === "user" ?
      `App registration "${label}" is no longer used by any environment. Radius did not create it, so it was left in place. Delete it?`
    : `App registration "${label}" is no longer used by any environment, and Radius could not confirm whether it created it. Delete it?`;
  addStep(op, {
    stage: STAGE_REVIEW_APP_REGISTRATION,
    kind: "observation",
    label: "App registration is unused — awaiting your decision",
    state: "pending"
  });
  requireInput(op, {
    code: DELETE_APP_REGISTRATION_DECISION,
    checkpoint: DELETE_APP_REGISTRATION_DECISION,
    message,
    metadata: { clientId, appDisplayName }
  });
}

// Classify an unused app registration's provenance from its `radius-managed`
// tag. A not-found app is already gone (idempotent success); an unreadable tag
// read is "unknown" so the caller stays conservative and never auto-deletes.
async function readAppProvenance(
  ports: EnvironmentDeletionPorts,
  clientId: string
): Promise<"managed" | "user" | "not_found" | "unknown"> {
  const result = await ports.runAz(buildAppTagShowArgs({ appId: clientId }));
  if (!commandSucceeded(result)) {
    return isAzResourceNotFound(result?.stderr) ? "not_found" : "unknown";
  }
  const tags = parseAppTags(result.stdout);
  if (tags === null) return "unknown";
  return parseRadiusAppProvenanceTags(tags).managed ? "managed" : "user";
}

async function deleteEnvironmentCredentials(
  op: DeletionOperation,
  ports: EnvironmentDeletionPorts,
  {
    repo,
    environment,
    clientId
  }: { repo: string; environment: string; clientId: string }
): Promise<void> {
  if (!clientId) {
    addStep(op, {
      stage: STAGE_DELETE_CREDENTIAL,
      kind: "warning",
      label:
        "Skipped removing the federated credential (no app registration id)",
      warning: {
        code: "federated-credential-app-unknown",
        message:
          "The environment did not record an AZURE_CLIENT_ID, so its federated credential could not be targeted.",
        impact:
          "An orphaned federated credential may remain on the app registration."
      }
    });
    setStageState(op, STAGE_DELETE_CREDENTIAL, "warning");
    return;
  }
  const listResult = await ports.runAz(
    buildFederatedCredentialListArgs({ appId: clientId })
  );
  if (listNotReadable(listResult)) {
    addStep(op, {
      stage: STAGE_DELETE_CREDENTIAL,
      kind: "warning",
      label: "Could not list the app registration's federated credentials",
      warning: {
        code: "federated-credential-list-failed",
        message:
          (listResult.stderr || "").trim() ||
          "Listing federated credentials failed.",
        impact: "The environment's federated credential may still exist."
      }
    });
    setStageState(op, STAGE_DELETE_CREDENTIAL, "warning");
    return;
  }
  if (federatedCredentialListUnreadable(listResult.stdout)) {
    addStep(op, {
      stage: STAGE_DELETE_CREDENTIAL,
      kind: "warning",
      label: "Could not read the app registration's federated credentials",
      warning: {
        code: "federated-credential-list-unreadable",
        message:
          "Listing federated credentials returned output that could not be parsed.",
        impact: "The environment's federated credential may still exist."
      }
    });
    setStageState(op, STAGE_DELETE_CREDENTIAL, "warning");
    return;
  }
  const candidates = selectEnvironmentFederatedCredentials(
    parseFederatedCredentials(listResult.stdout),
    { repoFullName: repo, envName: environment }
  );
  // Provenance gate (issue #331): of the credentials that look like they belong
  // to this environment, delete only the ones Radius can prove it created and
  // that are unchanged. Everything else — a credential Radius reused, one with
  // no provenance, or one whose subject drifted since Radius created it — is
  // retained and surfaced for manual review, so a shared or user-owned
  // credential is never removed on a name/subject heuristic alone.
  const provenance = ports.readCredentialProvenance(repo, environment);
  const plan = planCredentialReclamation(candidates, provenance, clientId);
  if (plan.delete.length === 0 && plan.retain.length === 0) {
    addStep(op, {
      stage: STAGE_DELETE_CREDENTIAL,
      kind: "observation",
      label: "No federated credential to remove",
      state: "succeeded"
    });
    setStageState(op, STAGE_DELETE_CREDENTIAL, "succeeded");
    await ports.clearCredentialProvenance(repo, environment);
    return;
  }
  let warned = false;
  for (const target of plan.delete) {
    const result = await ports.runAz(
      buildFederatedCredentialDeleteArgs({
        appId: clientId,
        name: target.credential.name
      })
    );
    if (commandSucceeded(result) || isAzResourceNotFound(result.stderr)) {
      addStep(op, {
        stage: STAGE_DELETE_CREDENTIAL,
        kind: "mutation",
        label: "Removed the environment's federated credential",
        state: "succeeded"
      });
    } else {
      warned = true;
      addStep(op, {
        stage: STAGE_DELETE_CREDENTIAL,
        kind: "warning",
        label: "Could not remove a federated credential",
        warning: {
          code: "federated-credential-delete-failed",
          message:
            (result.stderr || "").trim() ||
            "Deleting the federated credential failed.",
          impact:
            "The federated credential may still exist on the app registration."
        }
      });
    }
  }
  for (const retained of plan.retain) {
    warned = true;
    addStep(op, {
      stage: STAGE_DELETE_CREDENTIAL,
      kind: "warning",
      label: "Left a federated credential in place for manual review",
      warning: {
        code: retentionWarningCode(retained.reason),
        message: retentionMessage(retained.reason, retained.credential.name),
        impact:
          `Radius did not delete federated credential "${retained.credential.name}" on ` +
          `app registration ${clientId}. Review it and remove it manually if it is no ` +
          `longer needed.`
      }
    });
  }
  setStageState(op, STAGE_DELETE_CREDENTIAL, warned ? "warning" : "succeeded");
  // Whether or not everything was reclaimed, this environment's provenance has
  // served its purpose; drop it so a re-setup does not inherit stale records.
  await ports.clearCredentialProvenance(repo, environment);
}

function retentionWarningCode(reason: CredentialRetentionReason): string {
  switch (reason) {
    case "reused":
      return "federated-credential-retained-reused";
    case "evidence-changed":
      return "federated-credential-retained-changed";
    default:
      return "federated-credential-retained-unverified";
  }
}

function retentionMessage(
  reason: CredentialRetentionReason,
  name: string
): string {
  switch (reason) {
    case "reused":
      return (
        `Federated credential "${name}" was already present when Radius set up this ` +
        `environment, so Radius reused it rather than creating it. It is left in place.`
      );
    case "evidence-changed":
      return (
        `Federated credential "${name}" no longer matches what Radius recorded when it ` +
        `created it, so Radius cannot safely delete it.`
      );
    default:
      return (
        `Federated credential "${name}" has no Radius provenance, so Radius cannot prove ` +
        `it created the credential and will not delete it.`
      );
  }
}

// Returns the app's remaining federated credentials, or null when the list
// could not be read (so the caller can warn rather than prompt on bad data).
async function listRemainingCredentials(
  ports: EnvironmentDeletionPorts,
  clientId: string
): Promise<ReturnType<typeof parseFederatedCredentials> | null> {
  if (!clientId) return null;
  const result = await ports.runAz(
    buildFederatedCredentialListArgs({ appId: clientId })
  );
  if (listNotReadable(result)) return null;
  if (federatedCredentialListUnreadable(result.stdout)) return null;
  return parseFederatedCredentials(result.stdout);
}

async function deleteAppRegistration(
  op: DeletionOperation,
  ports: EnvironmentDeletionPorts,
  clientId: string
): Promise<void> {
  const result = await ports.runAz(buildAppDeleteArgs({ appId: clientId }));
  if (commandSucceeded(result) || isAzResourceNotFound(result.stderr)) {
    addStep(op, {
      stage: STAGE_REVIEW_APP_REGISTRATION,
      kind: "mutation",
      label: "Deleted the unused app registration",
      state: "succeeded"
    });
    setStageState(op, STAGE_REVIEW_APP_REGISTRATION, "succeeded");
    return;
  }
  addStep(op, {
    stage: STAGE_REVIEW_APP_REGISTRATION,
    kind: "warning",
    label: "Could not delete the app registration",
    warning: {
      code: "app-registration-delete-failed",
      message:
        (result.stderr || "").trim() || "Deleting the app registration failed.",
      impact:
        "The app registration still exists; delete it manually if intended."
    }
  });
  setStageState(op, STAGE_REVIEW_APP_REGISTRATION, "warning");
}

function commandSucceeded(result: DeletionCommandResult): boolean {
  return result?.code === 0;
}

// An `az ... list` that failed for a reason OTHER than "the app is gone" is
// unreadable. A not-found app lists as empty (idempotent), so it is readable.
function listNotReadable(result: DeletionCommandResult): boolean {
  if (commandSucceeded(result)) return false;
  return !isAzResourceNotFound(result?.stderr);
}
