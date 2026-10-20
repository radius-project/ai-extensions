import type {
  SetupEnvironmentEvent,
  SetupEnvironmentFailure,
  SetupVerificationSkipReason
} from "@radius-project/core";
import {
  describeWorkflowCommitFailure,
  presentProviderCredentialStatus,
  reportProviderConfiguration,
  reportWorkflowPublication
} from "./create-environment-workflow-publisher.js";
import {
  automaticBranchVerificationPolicyMessage,
  describeVerificationDispatch,
  describePullRequestNextStep
} from "../../verification-plan.js";
import type { GhCommandPresentation } from "../../gh-command-display.js";

export function presentSetupVerificationSkip(
  reason: SetupVerificationSkipReason | null
): string {
  if (!reason) return "";
  return reason.kind === "credentials" ?
      presentProviderCredentialStatus({
        provider: reason.provider,
        credentialsComplete: false
      }).missingCredNote
    : reason.reason ||
        "Credential verification will run automatically once the workflows are on the default branch.";
}

export function reportSetupEnvironment(
  event: SetupEnvironmentEvent,
  ports: {
    pushStep(message: string): void;
    errorMessage(error: unknown): string;
    login: string;
    credentialSource: "injected" | "keyring";
    verifyWorkflowFile: string;
  }
): void {
  switch (event.kind) {
    case "environment-owned":
      return ports.pushStep(
        `✅ GitHub environment "${event.envName}" created by this setup — Radius owns it and can remove it.`
      );
    case "environment-unowned":
      return ports.pushStep(
        `ℹ️ Radius left GitHub environment "${event.envName}" outside its cleanup scope. ${event.detail}`
      );
    case "environment-resolved":
      return ports.pushStep(
        `✅ GitHub environment "${event.envName}" resolved.`
      );
    case "environment-canonicalized":
      return ports.pushStep(
        `✅ GitHub resolved requested environment "${event.requestedEnvName}" as "${event.envName}".`
      );
    case "package-creating":
      return ports.pushStep(
        'Creating private GHCR state package "' + event.stateRegistry + '"...'
      );
    case "package-created":
      return ports.pushStep(
        `✅ GHCR state package is ${event.visibility} and linked to ${event.targetRepo}.`
      );
    case "package-configuring":
      return ports.pushStep(
        'Configuring Radius state package "' + event.stateRegistry + '"...'
      );
    case "package-configured":
      return ports.pushStep(
        `✅ Radius state package configured with archive tag "${event.archive}".`
      );
    case "provider-configuration":
      return reportProviderConfiguration(event.event, ports);
    case "workflow-publication":
      return reportWorkflowPublication(event.event, ports);
    case "automatic-policy-disabled":
      return ports.pushStep(
        `⚠️ Setup-branch credential verification is disabled: ${automaticBranchVerificationPolicyMessage(event.policy)}`
      );
    case "pull-request-opened":
      return ports.pushStep(
        "✅ Opened pull request #" + event.number + ": " + event.url
      );
    case "pull-request-failed":
      return ports.pushStep(
        '⚠️ Committed workflows to branch "' +
          event.branch +
          '" but could not open a pull request automatically: ' +
          (event.detail.trim() || "GitHub API request failed.") +
          ' Open one manually from that branch into "' +
          event.base +
          '".'
      );
    case "verification-merge-skip":
      return ports.pushStep(
        `⏭️ Skipping credential verification until the pull request is merged — ${event.reason || "the workflows are not on the default branch yet"}.`
      );
    case "verification-credentials-skip":
      return ports.pushStep(
        "⏭️ Skipping credential verification — cloud credentials are not fully configured. " +
          presentSetupVerificationSkip({
            kind: "credentials",
            provider: event.provider
          })
      );
    case "verification-discovering":
      return ports.pushStep(
        `Discovering credential verification started automatically on branch "${event.ref}"...`
      );
    case "verification-automatic":
      return ports.pushStep(
        "✅ Credential verification started automatically."
      );
    case "verification-run":
      return ports.pushStep("Verify run: " + event.url);
    case "verification-dispatch-identity":
      return ports.pushStep(
        `ℹ️ ${describeVerificationDispatch({
          login: ports.login,
          credentialSource: ports.credentialSource,
          workflowFile: ports.verifyWorkflowFile,
          targetRepo: event.targetRepo,
          envName: event.envName,
          ref: event.ref
        })}`
      );
    case "verification-dispatching":
      return ports.pushStep("Dispatching verify-credentials workflow...");
    case "verification-dispatched":
      return ports.pushStep("✅ Credential verification dispatched.");
    case "verification-dispatch-failed":
      return ports.pushStep(
        "❌ Could not dispatch verify workflow: " + event.detail
      );
    case "pull-request-next-step": {
      const next = describePullRequestNextStep(event);
      if (event.outcome === "verification-running")
        return ports.pushStep(`ℹ️ ${next}`);
      return ports.pushStep(`👉 ${next}`);
    }
  }
}

export function describeSetupEnvironmentFailure(
  failure:
    | Exclude<
        SetupEnvironmentFailure,
        {
          kind:
            | "repository-access"
            | "package-access"
            | "workflow-reconciliation-pending";
        }
      >
    | { kind: "workflow-reconciliation-pending" },
  ports: {
    steps: string[];
    ociStateBackend: string;
    defaultStateArchive: string;
    ghCommandPresentation?: GhCommandPresentation;
  }
): {
  status: number;
  error: string;
  code: string;
  extra: Record<string, unknown>;
} {
  const { steps } = ports;
  switch (failure.kind) {
    case "default-branch-unavailable":
      return {
        status: 400,
        error: `Could not determine the default branch for ${failure.targetRepo}, so Radius did not commit workflow files with guessed deletion provenance.`,
        code: "default-branch-unavailable",
        extra: { steps }
      };
    case "workflow-commit":
      return {
        ...describeWorkflowCommitFailure(
          failure.publication.workflow,
          failure.publication.path,
          failure.targetRepo,
          failure.publication.stderr,
          ports.ghCommandPresentation
        ),
        extra: { steps, ghError: failure.publication.stderr }
      };
    case "workflow-reconciliation-pending":
      return {
        status: 409,
        error:
          "Provider reconciliation is still pending for a workflow file Radius wrote. Radius will not complete setup or start another provider mutation.",
        code: "provider-reconciliation-pending",
        extra: { steps }
      };
    case "verification-baseline":
      return {
        status: 502,
        error:
          failure.unreadable ?
            "GitHub returned an unreadable verification-run baseline, so Radius did not dispatch the workflow."
          : "Radius could not read the verification-run baseline, so it did not dispatch the workflow. Retry after GitHub Actions run history is readable.",
        code: "verify-baseline-read-failed",
        extra:
          failure.unreadable ? { steps } : { steps, ghError: failure.detail }
      };
    case "verification-dispatch":
      return {
        status: 400,
        error:
          "Environment and state package were configured, but GitHub definitively rejected the verify workflow dispatch. " +
          failure.detail,
        code: "verify-dispatch-failed",
        extra: {
          environment: failure.environment,
          event: "workflow_dispatch",
          operationMarker: failure.operationMarker,
          provider: failure.provider,
          repo: failure.repo,
          stateBackend: ports.ociStateBackend,
          stateRegistry: failure.stateRegistry,
          stateArchive: ports.defaultStateArchive,
          steps,
          ghError: failure.detail
        }
      };
  }
}
