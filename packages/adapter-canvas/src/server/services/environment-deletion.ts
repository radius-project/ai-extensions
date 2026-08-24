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
//   4. Note the app registration: Radius never touches the Entra app
//      registration during an environment deletion. An app registration can be
//      shared by other environments or callers, so deleting it — or even probing
//      it — is out of scope for an environment teardown. This stage only records
//      an informational step so the user knows it was intentionally left in
//      place and can remove it manually if it is no longer needed.
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
  hasWarnings,
  touchOperation,
  STAGE_DELETE_RADIUS_ENV,
  STAGE_DELETE_CREDENTIAL,
  STAGE_DELETE_GITHUB_ENV,
  STAGE_REVIEW_APP_REGISTRATION
} from "../../operations.js";
import {
  buildFederatedCredentialListArgs,
  buildFederatedCredentialDeleteArgs,
  parseFederatedCredentials,
  federatedCredentialListUnreadable,
  selectEnvironmentFederatedCredentials,
  isAzResourceNotFound
} from "../../azure-oidc.js";
import {
  planCredentialReclamation,
  type CredentialProvenanceRecord,
  type CredentialRetentionReason
} from "../../credential-provenance.js";
import type { GitHubEnvDeletionOutcome } from "./github-environment.js";

export type { GitHubEnvDeletionOutcome };

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
  withCredentialProvenanceLock<T>(work: () => Promise<T>): Promise<T>;
  // Delete the GitHub environment (idempotent).
  deleteGitHubEnvironment(input: {
    repo: string;
    environment: string;
  }): Promise<GitHubEnvDeletionOutcome>;
  // The durable provenance records for a repo + environment (issue #331). Used
  // to prove Radius created a live federated credential before deleting it. An
  // empty list means "no proof", which the plan treats as retain (fail-safe).
  readCredentialProvenance(
    clientId: string
  ): CredentialProvenanceRecord[] | Promise<CredentialProvenanceRecord[]>;
  readAzureIdentity(clientId: string): Promise<{
    tenantId: string;
    applicationObjectId: string;
  }>;
  removeCredentialProvenance(
    clientId: string,
    credentialId: string
  ): Promise<void>;
  clearEnvironmentCredentialProvenance(
    repoId: number,
    environment: string
  ): Promise<void>;
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
    tenantId?: string;
    repoId?: number;
    [key: string]: unknown;
  };
  inputRequired?: unknown;
  state?: string;
  [key: string]: unknown;
}

function parseFederatedCredentialObject(
  stdout: string
): ReturnType<typeof parseFederatedCredentials>[number] | null {
  try {
    return parseFederatedCredentials([JSON.parse(stdout)])[0] ?? null;
  } catch {
    return null;
  }
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
      // before any cleanup runs. (Non-Azure providers never reach this runner:
      // the delete route rejects them up front with a provider-unsupported
      // error, because the bundled env-delete workflow is Azure-only.)
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

  // Stages 2 & 3 — remove the per-environment Azure federated credential(s) and
  // delete the GitHub environment. For an Azure environment both mutations run
  // under a SINGLE credential-provenance lock acquisition, so the invariant
  // "the GitHub-environment delete is owned by the same lock that retired the
  // credential" is expressed in exactly one place. `deleteEnvironmentCredentials`
  // sets the `credentialConsumerRetirementReady` handoff that
  // `deleteGitHubEnvironmentStage` consumes; keeping both inside one lock keeps
  // that producer/consumer pair together. On the resume path the credential
  // stage is already done, so only the GitHub delete runs — still under the same
  // lock. Non-Azure environments have no federated credential to retire, so
  // their GitHub delete needs no lock.
  const clientId = String(op.request?.clientId || "");
  const tenantId = String(op.request?.tenantId || "");
  const repoId = Number(op.request?.repoId);
  const credentialStagePending = stagePending(op, STAGE_DELETE_CREDENTIAL);

  if (credentialStagePending || stagePending(op, STAGE_DELETE_GITHUB_ENV)) {
    if (op.provider === "azure") {
      try {
        const stopped = await ports.withCredentialProvenanceLock(async () => {
          if (stagePending(op, STAGE_DELETE_CREDENTIAL)) {
            enterStage(op, STAGE_DELETE_CREDENTIAL);
            await ports.persist();
            const complete = await deleteEnvironmentCredentials(op, ports, {
              repo,
              environment,
              clientId,
              tenantId,
              repoId
            });
            await ports.persist();
            // Credential cleanup failed closed and already latched the terminal
            // state; do NOT delete the GitHub environment a retry still needs.
            if (complete === false) return true;
          }
          await deleteGitHubEnvironmentStage(
            op,
            ports,
            repo,
            environment,
            repoId
          );
          return false;
        });
        await ports.persist();
        if (stopped) return;
      } catch (error) {
        // The lock gates BOTH mutations, so a lock-acquisition failure stops the
        // operation. Attribute it to whichever stage still needed the lock: the
        // credential stage on a fresh run, or the GitHub stage on resume.
        const lockFailureStage =
          credentialStagePending ?
            STAGE_DELETE_CREDENTIAL
          : STAGE_DELETE_GITHUB_ENV;
        addStep(op, {
          stage: lockFailureStage,
          kind: "warning",
          label: "Could not lock credential ownership records",
          warning: {
            code: "credential-provenance-lock-unavailable",
            message: ports.errorMessage(error),
            impact:
              credentialStagePending ?
                "Radius did not mutate credentials without an exclusive lock."
              : "The GitHub environment was kept so deletion can be retried."
          }
        });
        setStageState(op, lockFailureStage, "failed");
        finish(op, "failed_partial", {
          failure: {
            code: "credential-provenance-lock-unavailable",
            stage: lockFailureStage,
            stepSeq: null,
            message:
              "Radius could not lock the credential ownership records. The GitHub environment was kept so deletion can be retried.",
            classification: "user-fixable",
            evidence: null
          }
        });
        await ports.persist();
        return;
      }
    } else {
      await deleteGitHubEnvironmentStage(op, ports, repo, environment, repoId);
      await ports.persist();
    }
  }

  // Stage 4 — the Entra app registration. Radius never touches it during an
  // environment deletion: an app registration can be shared by other
  // environments or callers, so removing it — or even probing it — is out of
  // scope for an environment teardown. Record an informational step so the user
  // knows it was intentionally left in place and can remove it manually if it is
  // no longer needed.
  if (stagePending(op, STAGE_REVIEW_APP_REGISTRATION)) {
    enterStage(op, STAGE_REVIEW_APP_REGISTRATION);
    addStep(op, {
      stage: STAGE_REVIEW_APP_REGISTRATION,
      kind: "observation",
      label: `Left the app registration (${clientId}) in place — Radius does not delete Entra app registrations. Remove it manually if it is no longer needed.`,
      state: "succeeded"
    });
    setStageState(op, STAGE_REVIEW_APP_REGISTRATION, "succeeded");
    await ports.persist();
  }

  finishSucceeded(
    op,
    hasWarnings(op) ? "succeeded_with_warnings" : "succeeded"
  );
  await ports.persist();
}

async function deleteGitHubEnvironmentStage(
  op: DeletionOperation,
  ports: EnvironmentDeletionPorts,
  repo: string,
  environment: string,
  repoId: number
): Promise<void> {
  if (!stagePending(op, STAGE_DELETE_GITHUB_ENV)) return;
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
    if (op.request?.credentialConsumerRetirementReady) {
      try {
        await ports.clearEnvironmentCredentialProvenance(repoId, environment);
      } catch (error) {
        addStep(op, {
          stage: STAGE_DELETE_GITHUB_ENV,
          kind: "warning",
          label:
            "Deleted the environment but could not retire its credential record",
          warning: {
            code: "credential-provenance-clear-failed",
            message: ports.errorMessage(error),
            impact:
              "A stale local consumer record may cause Radius to retain a shared credential during later cleanup."
          }
        });
        setStageState(op, STAGE_DELETE_GITHUB_ENV, "warning");
      }
    }
  }
  await ports.persist();
}

async function deleteEnvironmentCredentials(
  op: DeletionOperation,
  ports: EnvironmentDeletionPorts,
  {
    repo,
    environment,
    clientId,
    tenantId,
    repoId
  }: {
    repo: string;
    environment: string;
    clientId: string;
    tenantId: string;
    repoId: number;
  }
): Promise<boolean | void> {
  if (!clientId || !tenantId || !Number.isFinite(repoId) || repoId <= 0) {
    addStep(op, {
      stage: STAGE_DELETE_CREDENTIAL,
      kind: "warning",
      label:
        "Skipped removing the federated credential (identity evidence incomplete)",
      warning: {
        code: "federated-credential-app-unknown",
        message:
          "The environment did not record a complete tenant, app registration, and stable repository identity, so its federated credential could not be targeted safely.",
        impact:
          "An orphaned federated credential may remain on the app registration."
      }
    });
    return stopCredentialCleanup(
      op,
      "federated-credential-app-unknown",
      "Radius could not establish the complete credential identity. The GitHub environment was kept so deletion can be retried."
    );
  }
  let liveIdentity: {
    tenantId: string;
    applicationObjectId: string;
  };
  try {
    liveIdentity = await ports.readAzureIdentity(clientId);
  } catch (error) {
    addStep(op, {
      stage: STAGE_DELETE_CREDENTIAL,
      kind: "warning",
      label: "Could not verify the app registration identity",
      warning: {
        code: "federated-credential-identity-unverified",
        message: ports.errorMessage(error),
        impact: "The environment's federated credential may still exist."
      }
    });
    return stopCredentialCleanup(
      op,
      "federated-credential-identity-unavailable",
      "Radius could not verify the active Azure identity. The GitHub environment was kept so deletion can be retried."
    );
  }
  if (liveIdentity.tenantId.toLowerCase() !== tenantId.toLowerCase()) {
    addStep(op, {
      stage: STAGE_DELETE_CREDENTIAL,
      kind: "warning",
      label: "Left federated credentials in place after a tenant mismatch",
      warning: {
        code: "federated-credential-tenant-mismatch",
        message: `The active Entra tenant (${liveIdentity.tenantId}) does not match the environment's recorded tenant (${tenantId}).`,
        impact: "Radius did not mutate credentials in the unexpected tenant."
      }
    });
    return stopCredentialCleanup(
      op,
      "federated-credential-tenant-mismatch",
      "The active Azure tenant does not match this environment. The GitHub environment was kept so you can switch tenants and retry."
    );
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
    return stopCredentialCleanup(
      op,
      "federated-credential-list-failed",
      "Radius could not list the app registration's credentials. The GitHub environment was kept so deletion can be retried."
    );
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
    return stopCredentialCleanup(
      op,
      "federated-credential-list-unreadable",
      "Radius could not read the app registration's credentials. The GitHub environment was kept so deletion can be retried."
    );
  }
  let provenance: CredentialProvenanceRecord[];
  try {
    provenance = await ports.readCredentialProvenance(clientId);
  } catch (error) {
    addStep(op, {
      stage: STAGE_DELETE_CREDENTIAL,
      kind: "warning",
      label: "Could not read credential ownership records",
      warning: {
        code: "credential-provenance-unavailable",
        message: ports.errorMessage(error),
        impact: "Radius could not prove which credentials are safe to remove."
      }
    });
    return stopCredentialCleanup(
      op,
      "credential-provenance-unavailable",
      "Radius could not read the credential ownership records. The GitHub environment was kept so deletion can be retried."
    );
  }
  const context = {
    tenantId,
    clientId,
    applicationObjectId: liveIdentity.applicationObjectId,
    repoId,
    environment
  };
  const liveCredentials = parseFederatedCredentials(listResult.stdout);
  const heuristicCandidateIds = new Set(
    selectEnvironmentFederatedCredentials(liveCredentials, {
      repoFullName: repo,
      envName: environment
    }).map((credential) => credential.id)
  );
  const recordedCandidateIds = new Set(
    provenance
      .filter(
        (record) =>
          record.tenantId.toLowerCase() === tenantId.toLowerCase() &&
          record.clientId.toLowerCase() === clientId.toLowerCase() &&
          record.applicationObjectId === liveIdentity.applicationObjectId &&
          record.repoId === repoId &&
          record.environment === environment
      )
      .map((record) => record.credentialId)
  );
  const candidates = liveCredentials.filter(
    (credential) =>
      heuristicCandidateIds.has(credential.id) ||
      recordedCandidateIds.has(credential.id)
  );
  const plan = planCredentialReclamation(candidates, provenance, context);
  if (plan.delete.length === 0 && plan.retain.length === 0) {
    addStep(op, {
      stage: STAGE_DELETE_CREDENTIAL,
      kind: "observation",
      label: "No federated credential to remove",
      state: "succeeded"
    });
    setStageState(op, STAGE_DELETE_CREDENTIAL, "succeeded");
    if (op.request) op.request.credentialConsumerRetirementReady = true;
    return;
  }
  let warned = false;
  for (const target of plan.delete) {
    const showResult = await ports.runAz([
      "ad",
      "app",
      "federated-credential",
      "show",
      "--id",
      clientId,
      "--federated-credential-id",
      target.credential.id,
      "-o",
      "json"
    ]);
    if (
      !commandSucceeded(showResult) &&
      isAzResourceNotFound(showResult.stderr)
    ) {
      try {
        await ports.removeCredentialProvenance(clientId, target.credential.id);
      } catch (error) {
        warned = true;
        addStep(op, {
          stage: STAGE_DELETE_CREDENTIAL,
          kind: "warning",
          label:
            "Credential was already deleted but its provenance could not be cleared",
          warning: {
            code: "credential-provenance-clear-failed",
            message: ports.errorMessage(error),
            impact:
              "The stale local record cannot authorize deletion of a replacement because the Entra credential object id is different."
          }
        });
      }
      addStep(op, {
        stage: STAGE_DELETE_CREDENTIAL,
        kind: "observation",
        label: "Federated credential was already deleted",
        state: "succeeded"
      });
      continue;
    }
    const revalidated =
      commandSucceeded(showResult) ?
        parseFederatedCredentialObject(showResult.stdout || "")
      : null;
    if (!revalidated) {
      addStep(op, {
        stage: STAGE_DELETE_CREDENTIAL,
        kind: "observation",
        label:
          "Could not revalidate the federated credential — deletion stopped",
        state: "failed"
      });
      setStageState(op, STAGE_DELETE_CREDENTIAL, "failed");
      finish(op, "failed_partial", {
        failure: {
          code: "federated-credential-revalidation-unavailable",
          stage: STAGE_DELETE_CREDENTIAL,
          stepSeq: null,
          message:
            "Radius could not re-read the federated credential immediately before deletion. Nothing else was removed; retry the environment deletion.",
          classification: "user-fixable",
          evidence: null
        }
      });
      return false;
    }
    const revalidatedPlan = planCredentialReclamation(
      [revalidated],
      provenance,
      context
    );
    if (revalidatedPlan.delete[0]?.credential.id !== target.credential.id) {
      warned = true;
      addStep(op, {
        stage: STAGE_DELETE_CREDENTIAL,
        kind: "warning",
        label: "Left a changed federated credential in place",
        warning: {
          code: "federated-credential-revalidation-failed",
          message: `Federated credential "${target.credential.name}" changed immediately before deletion.`,
          impact:
            "Radius retained the credential because its live identity no longer matched the creation record."
        }
      });
      continue;
    }
    const result = await ports.runAz(
      buildFederatedCredentialDeleteArgs({
        appId: clientId,
        credentialId: target.credential.id
      })
    );
    if (commandSucceeded(result) || isAzResourceNotFound(result.stderr)) {
      addStep(op, {
        stage: STAGE_DELETE_CREDENTIAL,
        kind: "mutation",
        label: "Removed the environment's federated credential",
        state: "succeeded"
      });
      try {
        await ports.removeCredentialProvenance(clientId, target.credential.id);
      } catch (error) {
        warned = true;
        addStep(op, {
          stage: STAGE_DELETE_CREDENTIAL,
          kind: "warning",
          label: "Removed the credential but could not clear its provenance",
          warning: {
            code: "credential-provenance-clear-failed",
            message: ports.errorMessage(error),
            impact:
              "The stale local record cannot authorize deletion of a replacement because the Entra credential object id is different."
          }
        });
      }
    } else {
      addStep(op, {
        stage: STAGE_DELETE_CREDENTIAL,
        kind: "observation",
        label: "Could not remove a federated credential — deletion stopped",
        state: "failed"
      });
      setStageState(op, STAGE_DELETE_CREDENTIAL, "failed");
      finish(op, "failed_partial", {
        failure: {
          code: "federated-credential-delete-failed",
          stage: STAGE_DELETE_CREDENTIAL,
          stepSeq: null,
          message:
            (result.stderr || "").trim() ||
            "Deleting the federated credential failed. The GitHub environment was kept so you can retry.",
          classification: "user-fixable",
          evidence: null
        }
      });
      return false;
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
  if (op.request) {
    op.request.credentialConsumerRetirementReady = plan.retain.every(
      (retained) =>
        retained.reason !== "evidence-changed" &&
        retained.reason !== "shared-custom-subject"
    );
  }
  setStageState(op, STAGE_DELETE_CREDENTIAL, warned ? "warning" : "succeeded");
}

function stopCredentialCleanup(
  op: DeletionOperation,
  code: string,
  message: string
): false {
  setStageState(op, STAGE_DELETE_CREDENTIAL, "failed");
  finish(op, "failed_partial", {
    failure: {
      code,
      stage: STAGE_DELETE_CREDENTIAL,
      stepSeq: null,
      message,
      classification: "user-fixable",
      evidence: null
    }
  });
  return false;
}

function retentionWarningCode(reason: CredentialRetentionReason): string {
  switch (reason) {
    case "reused":
      return "federated-credential-retained-reused";
    case "shared-consumer":
      return "federated-credential-retained-shared";
    case "shared-custom-subject":
      return "federated-credential-retained-custom-subject";
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
    case "shared-consumer":
      return (
        `Federated credential "${name}" is also recorded as in use by another ` +
        `Radius environment, so Radius left it in place.`
      );
    case "shared-custom-subject":
      return (
        `Federated credential "${name}" uses a custom OIDC subject whose historical ` +
        `configuration does not prove stable repository and environment exclusivity.`
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

function commandSucceeded(result: DeletionCommandResult): boolean {
  return result?.code === 0;
}

// An `az ... list` that failed for a reason OTHER than "the app is gone" is
// unreadable. A not-found app lists as empty (idempotent), so it is readable.
function listNotReadable(result: DeletionCommandResult): boolean {
  if (commandSucceeded(result)) return false;
  return !isAzResourceNotFound(result?.stderr);
}
