import { describe, expect, it } from "vitest";
import type {
  SetupProviderConfigurationEvent,
  SetupWorkflowPublicationEvent
} from "@radius-project/core";
import {
  buildManualRoleAssignmentGuidance,
  describeWorkflowCommitFailure,
  presentProviderCredentialStatus,
  reportProviderConfiguration,
  reportWorkflowPublication,
  VERIFY_WORKFLOW_PATH,
  WORKFLOW_SCOPE_HINT,
  WRITE_ACCESS_HINT
} from "./create-environment-workflow-publisher.js";
import { FORK_REPOSITORY_SETUP_GUIDANCE } from "../../repository-access-guidance.js";

describe("provider configuration presentation", () => {
  it.each([
    {
      provider: "azure",
      note: "Azure OIDC credentials (client ID, tenant ID, and subscription ID) are not fully configured for this environment. Use auto-setup or enter them manually, then verify credentials from the Environments list."
    },
    {
      provider: "aws",
      note: "The AWS IAM role ARN is not configured for this environment. Enter it (or use auto-setup), then verify credentials from the Environments list."
    }
  ] as const)(
    "presents $provider readiness without changing it",
    ({ provider, note }) => {
      expect(
        presentProviderCredentialStatus({
          provider,
          credentialsComplete: false
        })
      ).toEqual({
        credentialsComplete: false,
        missingCredNote: note
      });
      expect(
        presentProviderCredentialStatus({ provider, credentialsComplete: true })
      ).toEqual({
        credentialsComplete: true,
        missingCredNote: ""
      });
    }
  );

  it.each<{ event: SetupProviderConfigurationEvent; message: string }>([
    {
      event: { kind: "configuration-started" },
      message: "Setting environment variables and secrets..."
    },
    {
      event: { kind: "azure-values-configured", count: 8 },
      message: "Set 8 environment value(s) for Azure."
    },
    {
      event: { kind: "credentials-missing", provider: "azure" },
      message:
        "⚠️ Missing OIDC credentials (clientId/tenantId/subscriptionId). Use auto-setup or enter them manually."
    },
    {
      event: { kind: "credentials-missing", provider: "aws" },
      message:
        "⚠️ Missing AWS role ARN. Enter it or use auto-setup before verifying credentials."
    },
    {
      event: {
        kind: "azure-role-guidance",
        assignee: "client",
        scope: "/subscriptions/sub/resourceGroups/rg"
      },
      message:
        'ℹ️ If credential verification fails with "No subscriptions found", the configured identity has no subscription-visible role. Grant one, then retry: az role assignment create --assignee client --role Contributor --scope /subscriptions/sub/resourceGroups/rg'
    }
  ])(
    "narrates $event without owning configuration policy",
    ({ event, message }) => {
      const steps: string[] = [];
      reportProviderConfiguration(event, {
        pushStep: (step) => {
          steps.push(step);
        }
      });
      expect(steps).toEqual([message]);
    }
  );

  it("builds the manual role assignment command without executing it", () => {
    expect(
      buildManualRoleAssignmentGuidance("app-1", "/subscriptions/sub-1")
    ).toBe(
      "az role assignment create --assignee app-1 --role Contributor --scope /subscriptions/sub-1"
    );
  });
});

describe("workflow publication presentation", () => {
  it.each<{ event: SetupWorkflowPublicationEvent; message: string }>([
    {
      event: { kind: "checking", workflow: "verify" },
      message: "Checking verify-credentials workflow..."
    },
    {
      event: { kind: "checking", workflow: "deploy" },
      message: "Checking deploy workflows..."
    },
    {
      event: { kind: "checking", workflow: "delete" },
      message: "Checking delete workflows..."
    },
    {
      event: { kind: "commit-failed", workflow: "verify" },
      message: "❌ Failed to commit verify-credentials workflow."
    },
    {
      event: {
        kind: "commit-failed",
        workflow: "deploy",
        fileName: "deploy.yml"
      },
      message: "❌ Failed to commit deploy workflow deploy.yml."
    },
    {
      event: { kind: "verify-completed", changed: true },
      message: "✅ Verify workflow committed."
    },
    {
      event: { kind: "verify-completed", changed: false },
      message: "✅ Verify workflow already up to date."
    },
    {
      event: { kind: "deploy-completed", changed: true },
      message: "✅ Deploy workflows committed."
    },
    {
      event: { kind: "deploy-completed", changed: false },
      message: "✅ Deploy workflows already up to date."
    },
    {
      event: { kind: "delete-completed", outcome: "warnings" },
      message: "⚠️ Delete workflow checks completed with warnings."
    },
    {
      event: { kind: "delete-completed", outcome: "changed" },
      message: "✅ Delete workflows committed."
    },
    {
      event: { kind: "delete-completed", outcome: "unchanged" },
      message: "✅ Delete workflows already up to date."
    },
    {
      event: {
        kind: "delete-commit-failed",
        fileName: "delete.yml",
        stderr: "HTTP 404"
      },
      message: "⚠️ Could not commit delete workflow delete.yml: HTTP 404"
    },
    {
      event: {
        kind: "delete-commit-failed",
        fileName: "delete.yml",
        stderr: " "
      },
      message:
        "⚠️ Could not commit delete workflow delete.yml: GitHub API request failed."
    },
    {
      event: {
        kind: "delete-generation-failed",
        error: new Error("generator exploded")
      },
      message:
        "⚠️ Could not generate/commit delete workflows: generator exploded"
    }
  ])("narrates $event", ({ event, message }) => {
    const steps: string[] = [];
    reportWorkflowPublication(event, {
      pushStep: (step) => {
        steps.push(step);
      },
      errorMessage: (error) => {
        if (!(error instanceof Error)) throw new Error("Unexpected diagnostic");
        return error.message;
      }
    });
    expect(steps).toEqual([message]);
  });
});

describe("describeWorkflowCommitFailure", () => {
  it("gives installation guidance rather than an unusable command when GitHub CLI is unavailable", () => {
    const failure = describeWorkflowCommitFailure(
      "verify",
      VERIFY_WORKFLOW_PATH,
      "octo/app",
      "missing workflow scope",
      {
        kind: "unavailable",
        shell: "powershell",
        installationNote: "Install GitHub CLI system-wide."
      }
    );
    expect(failure).toMatchObject({
      status: 400,
      code: "verify-workflow-commit-failed"
    });
    expect(failure.error).toContain(
      'Your GitHub token is missing the "workflow" scope. Install GitHub CLI system-wide.'
    );
    expect(failure.error).not.toContain("auth refresh");
  });

  it("uses the bundled GitHub CLI path for workflow-scope guidance", () => {
    const failure = describeWorkflowCommitFailure(
      "verify",
      VERIFY_WORKFLOW_PATH,
      "octo/app",
      "missing workflow scope",
      {
        kind: "absolute",
        shell: "posix",
        executablePath: "/opt/Copilot Tools/gh",
        installationNote: "Install GitHub CLI system-wide."
      }
    );
    expect(failure.error).toContain(
      "'/opt/Copilot Tools/gh' auth refresh -h github.com -s workflow"
    );
    expect(failure.error).toContain("Install GitHub CLI system-wide.");
  });

  it("points at the missing token scope when that is what gh reported", () => {
    const failure = describeWorkflowCommitFailure(
      "verify",
      VERIFY_WORKFLOW_PATH,
      "octo/app",
      "refusing to allow an OAuth App to create or update workflow without `workflow` scope"
    );
    expect(failure.status).toBe(400);
    expect(failure.code).toBe("verify-workflow-commit-failed");
    expect(failure.error).toContain(VERIFY_WORKFLOW_PATH);
    expect(failure.error).toContain("octo/app");
    expect(failure.error.endsWith(WORKFLOW_SCOPE_HINT)).toBe(true);
  });

  it("points at repository write access for any other failure", () => {
    const failure = describeWorkflowCommitFailure(
      "deploy",
      ".github/workflows/run-rad-commands.yml",
      "octo/app",
      "protected branch"
    );
    expect(failure.code).toBe("deploy-workflow-commit-failed");
    expect(failure.error).toContain("protected branch. Check that");
    expect(failure.error.endsWith(WRITE_ACCESS_HINT)).toBe(true);
    expect(failure.error).toContain(FORK_REPOSITORY_SETUP_GUIDANCE);
  });

  it.each(["", "   ", undefined])(
    "substitutes a generic detail for %j",
    (stderr) => {
      expect(
        describeWorkflowCommitFailure(
          "verify",
          VERIFY_WORKFLOW_PATH,
          "octo/app",
          stderr
        ).error
      ).toContain("The GitHub API request failed.");
    }
  );
});
