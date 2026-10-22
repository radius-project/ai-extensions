import { needsWorkflowScope } from "./create-environment-gh-runner.js";
import type {
  SetupProviderConfigurationEvent,
  SetupProviderCredentialStatus,
  SetupWorkflowPublicationEvent
} from "@radius-project/core";
export { azureRoleScope } from "@radius-project/core";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  type GhCommandPresentation
} from "../../gh-command-display.js";
import { FORK_REPOSITORY_SETUP_GUIDANCE } from "../../repository-access-guidance.js";

export const WRITE_ACCESS_HINT = `Check that you have write access to the repository and that GitHub Actions is enabled. ${FORK_REPOSITORY_SETUP_GUIDANCE}`;

function appendGuidance(detail: string, hint: string): string {
  const separator = /[.!?]$/.test(detail) ? " " : ". ";
  return `${detail}${separator}${hint.trimStart()}`;
}

function workflowScopeHint(
  ghCommandPresentation: GhCommandPresentation
): string {
  const refreshCommand = displayGhCommand(ghCommandPresentation, [
    "auth",
    "refresh",
    "-h",
    "github.com",
    "-s",
    "workflow"
  ]);
  if (!refreshCommand) {
    return ` Your GitHub token is missing the "workflow" scope. ${ghCommandPresentation.installationNote}`;
  }
  const installation =
    ghCommandPresentation.installationNote ?
      ` ${ghCommandPresentation.installationNote}`
    : "";
  return ` Your GitHub token is missing the "workflow" scope. Run \`${refreshCommand}\` in a terminal, then retry.${installation}`;
}

export const WORKFLOW_SCOPE_HINT = workflowScopeHint(
  BARE_GH_COMMAND_PRESENTATION
);

export const VERIFY_WORKFLOW_PATH =
  ".github/workflows/radius-verify-credentials.yml";

// Whether the identifying cloud credentials the verify-credentials workflow
// needs to authenticate were actually configured. When they're absent the use
// case skips dispatching verify (issue #219) and surfaces `missingCredNote`
// instead; `missingCredNote` is "" when the credentials are complete.
export interface ProviderCredentialStatus {
  credentialsComplete: boolean;
  missingCredNote: string;
}

export function presentProviderCredentialStatus({
  provider,
  credentialsComplete
}: SetupProviderCredentialStatus): ProviderCredentialStatus {
  return {
    credentialsComplete,
    missingCredNote:
      credentialsComplete ? ""
      : provider === "azure" ?
        "Azure OIDC credentials (client ID, tenant ID, and subscription ID) are not fully configured for this environment. Use auto-setup or enter them manually, then verify credentials from the Environments list."
      : "The AWS IAM role ARN is not configured for this environment. Enter it (or use auto-setup), then verify credentials from the Environments list."
  };
}

// The exact `az role assignment create` command a user can run to grant the
// configured identity a subscription-visible role. Uses the app/client id as the
// assignee (what the user has on hand); az resolves it to the service principal.
// On the manual-credentials path the extension surfaces this command rather than
// running it: the app registration may be shared or owned by another team, so we
// don't silently grant Contributor to it using the operator's local az. Pure.
export function buildManualRoleAssignmentGuidance(
  assignee: string,
  scope: string
): string {
  return `az role assignment create --assignee ${assignee} --role Contributor --scope ${scope}`;
}

export function reportProviderConfiguration(
  event: SetupProviderConfigurationEvent,
  ports: { pushStep(message: string): void }
): void {
  switch (event.kind) {
    case "configuration-started":
      return ports.pushStep("Setting environment variables and secrets...");
    case "azure-values-configured": {
      const setCount = event.count;
      return ports.pushStep(`Set ${setCount} environment value(s) for Azure.`);
    }
    case "credentials-missing":
      if (event.provider === "azure") {
        return ports.pushStep(
          "⚠️ Missing OIDC credentials (clientId/tenantId/subscriptionId). Use auto-setup or enter them manually."
        );
      }
      return ports.pushStep(
        "⚠️ Missing AWS role ARN. Enter it or use auto-setup before verifying credentials."
      );
    case "azure-role-guidance":
      return ports.pushStep(
        'ℹ️ If credential verification fails with "No subscriptions found", the configured identity has no subscription-visible role. Grant one, then retry: ' +
          buildManualRoleAssignmentGuidance(event.assignee, event.scope)
      );
  }
}

// The message a failed workflow commit is reported with. Pure, so the hint
// selection is assertable without driving a commit: a missing `workflow` scope
// is a token problem the user fixes with `gh auth refresh`, anything else is
// reported as a repository write-access problem.
export function describeWorkflowCommitFailure(
  kind: "verify" | "deploy",
  path: string,
  targetRepo: string,
  stderr: string | undefined,
  ghCommandPresentation: GhCommandPresentation = BARE_GH_COMMAND_PRESENTATION
): { status: number; error: string; code: string } {
  const hint =
    needsWorkflowScope(stderr) ?
      workflowScopeHint(ghCommandPresentation)
    : WRITE_ACCESS_HINT;
  const label =
    kind === "verify" ? "verify-credentials workflow" : "deploy workflow";
  return {
    status: 400,
    error:
      "Failed to commit the " +
      label +
      " (" +
      path +
      ") to " +
      targetRepo +
      ". " +
      appendGuidance(
        (stderr || "").trim() || "The GitHub API request failed.",
        hint
      ),
    code:
      kind === "verify" ?
        "verify-workflow-commit-failed"
      : "deploy-workflow-commit-failed"
  };
}

export function reportWorkflowPublication(
  event: SetupWorkflowPublicationEvent,
  ports: {
    pushStep(message: string): void;
    errorMessage(error: unknown): string;
  }
): void {
  switch (event.kind) {
    case "checking":
      return ports.pushStep(
        event.workflow === "verify" ? "Checking verify-credentials workflow..."
        : event.workflow === "deploy" ? "Checking deploy workflows..."
        : "Checking delete workflows..."
      );
    case "commit-failed":
      if (event.workflow === "verify")
        return ports.pushStep(
          "❌ Failed to commit verify-credentials workflow."
        );
      return ports.pushStep(
        "❌ Failed to commit deploy workflow " + event.fileName + "."
      );
    case "verify-completed":
      if (event.changed) return ports.pushStep("✅ Verify workflow committed.");
      return ports.pushStep("✅ Verify workflow already up to date.");
    case "deploy-completed":
      if (event.changed)
        return ports.pushStep("✅ Deploy workflows committed.");
      return ports.pushStep("✅ Deploy workflows already up to date.");
    case "delete-completed":
      if (event.outcome === "warnings")
        return ports.pushStep(
          "⚠️ Delete workflow checks completed with warnings."
        );
      if (event.outcome === "changed")
        return ports.pushStep("✅ Delete workflows committed.");
      return ports.pushStep("✅ Delete workflows already up to date.");
    case "delete-commit-failed":
      return ports.pushStep(
        "⚠️ Could not commit delete workflow " +
          event.fileName +
          ": " +
          (event.stderr.trim() || "GitHub API request failed.")
      );
    case "delete-generation-failed":
      return ports.pushStep(
        "⚠️ Could not generate/commit delete workflows: " +
          ports.errorMessage(event.error)
      );
  }
}
