import { needsWorkflowScope } from "./create-environment-gh-runner.js";
import type { CreateEnvironmentRequestData } from "./create-environment-refusals.js";
import type {
  CreateEnvironmentOperation,
  WorkflowCommitOutcome
} from "./create-environment-types.js";
import { cloudCredentialsComplete } from "../../deploy.js";
import { ProviderMutationRecoveryError } from "../services/provider-mutation-recovery.js";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  type GhCommandPresentation
} from "../../gh-command-display.js";

// Seam 5 of the `POST /api/create-environment` slice: steps 2, 3, 4 and 4b —
// writing the provider's configuration onto the GitHub environment, then
// publishing the verify, deploy and delete workflow files.
//
// `fail` stays in the use case. This module never finalizes an operation or
// writes a response; a commit failure comes back as a `WorkflowPublishRefusal`
// describing the status, message and code the use case should fail with, so the
// decision to end the request is still made in exactly one place.
//
// `checkpoint` also stays in the use case, which passes its own gate in as
// `gate`. The gate is invoked at the same points, in the same order, as when
// this code was inline: after each committed file. The use case still owns what
// a gate means and when cancellation is observed; this module only calls it.

export const WRITE_ACCESS_HINT =
  " Get write access or fork the repository, attach the writable repository to the session, confirm GitHub Actions is enabled, and retry.";

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

export interface ProviderConfigurationPorts {
  azureCredential(): Record<string, unknown>;
  awsCredential(): Record<string, unknown>;
  optionalString(value: unknown): string;
  setEnvironmentVariable(name: string, value: unknown): Promise<boolean>;
  pushStep(message: string): void;
}

// Whether the identifying cloud credentials the verify-credentials workflow
// needs to authenticate were actually configured. When they're absent the use
// case skips dispatching verify (issue #219) and surfaces `missingCredNote`
// instead; `missingCredNote` is "" when the credentials are complete.
export interface ProviderCredentialStatus {
  credentialsComplete: boolean;
  missingCredNote: string;
}

export function providerCredentialStatus(
  provider: string,
  data: CreateEnvironmentRequestData,
  ports: Pick<
    ProviderConfigurationPorts,
    "azureCredential" | "awsCredential" | "optionalString"
  >
): ProviderCredentialStatus {
  if (provider === "azure") {
    const azureCreds = ports.azureCredential();
    const credentialsComplete = cloudCredentialsComplete("azure", {
      clientId: data.clientId || ports.optionalString(azureCreds.clientId),
      tenantId: data.tenantId || ports.optionalString(azureCreds.tenantId),
      subscriptionId:
        data.subscriptionId || ports.optionalString(azureCreds.subscriptionId)
    });
    return {
      credentialsComplete,
      missingCredNote:
        credentialsComplete ? "" : (
          "Azure OIDC credentials (client ID, tenant ID, and subscription ID) are not fully configured for this environment. Use auto-setup or enter them manually, then verify credentials from the Environments list."
        )
    };
  }

  const credentialsComplete = cloudCredentialsComplete("aws", {
    roleArn: data.roleArn || ""
  });
  return {
    credentialsComplete,
    missingCredNote:
      credentialsComplete ? "" : (
        "The AWS IAM role ARN is not configured for this environment. Enter it (or use auto-setup), then verify credentials from the Environments list."
      )
  };
}

// The RBAC scope at which to grant the environment identity a subscription-
// visible role. A role assignment at resource-group scope still surfaces the
// parent subscription to `az account list` / azure/login (fixing the
// "No subscriptions found" credential-verification failure, issue #280), while
// staying narrower than a subscription-wide grant, so prefer the resource group
// when one is configured; fall back to the whole subscription otherwise. Pure.
export function azureRoleScope(
  subscriptionId: string,
  resourceGroup?: string
): string {
  const rg = (resourceGroup || "").trim();
  return rg ?
      `/subscriptions/${subscriptionId}/resourceGroups/${rg}`
    : `/subscriptions/${subscriptionId}`;
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

// Step 2. Values from the request win; anything absent falls back to the
// shared credential record. `||` rather than `??` throughout, so an empty
// string is treated as absent exactly as it was inline.
export async function applyProviderConfiguration(
  provider: string,
  data: CreateEnvironmentRequestData,
  ports: ProviderConfigurationPorts
): Promise<ProviderCredentialStatus> {
  ports.pushStep("Setting environment variables and secrets...");
  const azureCreds = ports.azureCredential();
  const awsCreds = ports.awsCredential();
  const credentialStatus = providerCredentialStatus(provider, data, ports);

  if (provider === "azure") {
    const clientId = data.clientId || ports.optionalString(azureCreds.clientId);
    const tenantId = data.tenantId || ports.optionalString(azureCreds.tenantId);
    const subscriptionId =
      data.subscriptionId || ports.optionalString(azureCreds.subscriptionId);
    const rg = data.resourceGroup || "";
    const k8s = data.cluster || "";

    await ports.setEnvironmentVariable("AZURE_CLIENT_ID", clientId);
    await ports.setEnvironmentVariable("AZURE_TENANT_ID", tenantId);
    await ports.setEnvironmentVariable("AZURE_SUBSCRIPTION_ID", subscriptionId);
    await ports.setEnvironmentVariable("AZURE_RESOURCE_GROUP", rg);
    await ports.setEnvironmentVariable("AZURE_AKS_CLUSTER_NAME", k8s);
    await ports.setEnvironmentVariable("AZURE_LOCATION", data.location);
    await ports.setEnvironmentVariable("KUBERNETES_NAMESPACE", data.namespace);

    const setCount = [
      clientId,
      tenantId,
      subscriptionId,
      rg,
      k8s,
      data.location,
      data.namespace
    ].filter(Boolean).length;
    ports.pushStep(`Set ${setCount} environment value(s) for Azure.`);
    if (!credentialStatus.credentialsComplete) {
      ports.pushStep(
        "⚠️ Missing OIDC credentials (clientId/tenantId/subscriptionId). Use auto-setup or enter them manually."
      );
      return credentialStatus;
    }
    // Credentials are complete, but a manually-entered app registration may have
    // no role assignment that surfaces the subscription — verify then fails at
    // Azure Login with "No subscriptions found" (issue #280). Surface the exact
    // grant command rather than running it, since the identity may be shared or
    // owned by another team.
    const roleScope = azureRoleScope(subscriptionId, rg);
    ports.pushStep(
      'ℹ️ If credential verification fails with "No subscriptions found", the configured identity has no subscription-visible role. Grant one, then retry: ' +
        buildManualRoleAssignmentGuidance(clientId, roleScope)
    );
    return { credentialsComplete: true, missingCredNote: "" };
  }

  const roleArn = data.roleArn || "";
  const region =
    data.region || ports.optionalString(awsCreds.region) || "us-east-1";
  const accountId = data.accountId || ports.optionalString(awsCreds.accountId);
  const k8s = data.cluster || "";

  await ports.setEnvironmentVariable("AWS_ROLE_ARN", roleArn);
  await ports.setEnvironmentVariable("AWS_REGION", region);
  await ports.setEnvironmentVariable("AWS_ACCOUNT_ID", accountId);
  await ports.setEnvironmentVariable("AWS_EKS_CLUSTER_NAME", k8s);
  await ports.setEnvironmentVariable("RADIUS_VPC_ID", data.vpcId);
  await ports.setEnvironmentVariable("RADIUS_SUBNET_IDS", data.subnetIds);
  await ports.setEnvironmentVariable("KUBERNETES_NAMESPACE", data.namespace);
  if (!credentialStatus.credentialsComplete) {
    ports.pushStep(
      "⚠️ Missing AWS role ARN. Enter it or use auto-setup before verifying credentials."
    );
    return credentialStatus;
  }
  return { credentialsComplete: true, missingCredNote: "" };
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
      ((stderr || "").trim() || "The GitHub API request failed.") +
      hint,
    code:
      kind === "verify" ?
        "verify-workflow-commit-failed"
      : "deploy-workflow-commit-failed"
  };
}

export interface WorkflowPublishRefusal {
  outcome: "refused";
  status: number;
  error: string;
  code: string;
  ghError: string;
}

export interface WorkflowPublishCancelled {
  outcome: "cancelled";
}

export interface WorkflowPublishCompleted {
  outcome: "published";
}

export type WorkflowPublishResult =
  WorkflowPublishRefusal | WorkflowPublishCancelled | WorkflowPublishCompleted;

export interface WorkflowPublisherPorts {
  ghCommandPresentation?: GhCommandPresentation;
  generateVerifyWorkflow(
    environment: string,
    provider: string
  ): Promise<string>;
  generateDeployWorkflow(
    environment: string,
    appFile: string
  ): Promise<Record<string, string>>;
  generateDeleteWorkflow(environment: string): Promise<Record<string, string>>;
  commitWorkflowFileSmart(
    path: string,
    contentB64: string,
    message: string
  ): Promise<WorkflowCommitOutcome>;
  recordCommittedWorkflowFile(
    operation: CreateEnvironmentOperation,
    entry: {
      path: string;
      branch: string | null;
      mode: string;
      commitSha: string | null;
      blobSha: string | null;
      contentSha256: string | null;
      previousBlobSha: string | null;
      previousBlobKnown: boolean;
    }
  ): void;
  deleteLegacyDeployWorkflow(repo: string): Promise<boolean | "cancelled">;
  usingPullRequestBranch(): boolean;
  pullRequestBranch(): string | null;
  errorMessage(error: unknown): string;
  pushStep(message: string): void;
  // The use case's own cancellation gate. `false` means the operation was
  // finalized and answered, so publication must stop without touching GitHub
  // again.
  gate(): Promise<boolean>;
}

export interface WorkflowPublisherTarget {
  operation: CreateEnvironmentOperation;
  targetRepo: string;
  envName: string;
  provider: string;
  defaultBranch: string;
}

// Steps 3, 4 and 4b. The verify and deploy workflows are required; the delete
// workflows are best effort, so a failure there is narrated and the flow
// continues.
export async function publishWorkflowFiles(
  ports: WorkflowPublisherPorts,
  target: WorkflowPublisherTarget
): Promise<WorkflowPublishResult> {
  const { operation, targetRepo, envName, provider, defaultBranch } = target;
  // Every field a rollback needs to prove this exact write, recorded with the
  // file rather than derived later: the branch it landed on, the commit it
  // created, the blob it produced, the digest of the bytes Radius sent, and the
  // blob the path held before.
  const commitRecord = (path: string, commit: WorkflowCommitOutcome) => ({
    path,
    branch: commit.viaPr ? ports.pullRequestBranch() : defaultBranch,
    mode: commit.viaPr ? "pull_request" : "default_branch",
    commitSha: commit.commitSha ?? null,
    blobSha: commit.blobSha ?? null,
    contentSha256: commit.contentSha256 ?? null,
    previousBlobSha: commit.previousBlobSha ?? null,
    previousBlobKnown: commit.previousBlobKnown === true
  });

  // Step 3: Commit the verify-credentials workflow
  ports.pushStep("Committing verify-credentials workflow...");
  const verifyWorkflow = await ports.generateVerifyWorkflow(envName, provider);
  const verifyContent = Buffer.from(verifyWorkflow).toString("base64");

  const verifyCommit = await ports.commitWorkflowFileSmart(
    VERIFY_WORKFLOW_PATH,
    verifyContent,
    "Add Radius verify-credentials workflow for environment " + envName
  );
  if (verifyCommit.cancelled) return { outcome: "cancelled" };

  if (!verifyCommit.ok) {
    ports.pushStep("❌ Failed to commit verify-credentials workflow.");
    if (!(await ports.gate())) return { outcome: "cancelled" };
    return {
      outcome: "refused",
      ...describeWorkflowCommitFailure(
        "verify",
        VERIFY_WORKFLOW_PATH,
        targetRepo,
        verifyCommit.stderr,
        ports.ghCommandPresentation
      ),
      ghError: verifyCommit.stderr || ""
    };
  }
  ports.pushStep("✅ Verify workflow committed.");
  ports.recordCommittedWorkflowFile(
    operation,
    commitRecord(VERIFY_WORKFLOW_PATH, verifyCommit)
  );
  if (!(await ports.gate())) return { outcome: "cancelled" };

  // Step 4: Also commit the deploy workflows (dispatcher + both provider
  // workflows). The dispatcher references both provider files by path, so all
  // three must exist in the target repo.
  ports.pushStep("Committing deploy workflows...");
  const deployWorkflows = await ports.generateDeployWorkflow(
    envName,
    ".radius/app.bicep"
  );

  for (const [fileName, content] of Object.entries(deployWorkflows)) {
    const deployContent = Buffer.from(content).toString("base64");
    const deployPath = ".github/workflows/" + fileName;

    const deployCommit = await ports.commitWorkflowFileSmart(
      deployPath,
      deployContent,
      "Add Radius deploy workflow (" + fileName + ") for environment " + envName
    );
    if (deployCommit.cancelled) return { outcome: "cancelled" };

    if (!deployCommit.ok) {
      ports.pushStep("❌ Failed to commit deploy workflow " + fileName + ".");
      if (!(await ports.gate())) return { outcome: "cancelled" };
      return {
        outcome: "refused",
        ...describeWorkflowCommitFailure(
          "deploy",
          deployPath,
          targetRepo,
          deployCommit.stderr,
          ports.ghCommandPresentation
        ),
        ghError: deployCommit.stderr || ""
      };
    }
    ports.recordCommittedWorkflowFile(
      operation,
      commitRecord(deployPath, deployCommit)
    );
    if (!(await ports.gate())) return { outcome: "cancelled" };
  }
  // Best-effort: remove the legacy monolithic deploy workflow so it does not
  // double-trigger alongside the new dispatcher. Skipped in PR-fallback mode
  // since we can't push to the default branch.
  if (!ports.usingPullRequestBranch()) {
    try {
      const legacyDelete = await ports.deleteLegacyDeployWorkflow(targetRepo);
      if (legacyDelete === "cancelled") return { outcome: "cancelled" };
    } catch (error) {
      if (!(await ports.gate())) return { outcome: "cancelled" };
      throw error;
    }
    if (!(await ports.gate())) return { outcome: "cancelled" };
  }
  ports.pushStep("✅ Deploy workflows committed.");

  // Step 4b: Commit the application-delete workflows (dispatcher + Azure
  // provider workflow) so the Delete Deployment button can dispatch `rad app
  // delete`. Only Azure workflows are generated and committed; the AWS provider
  // file is never produced.
  ports.pushStep("Committing delete workflows...");
  try {
    const deleteWorkflows = await ports.generateDeleteWorkflow(envName);
    for (const [fileName, content] of Object.entries(deleteWorkflows)) {
      const delContent = Buffer.from(content).toString("base64");
      const delPath = ".github/workflows/" + fileName;

      const delCommit = await ports.commitWorkflowFileSmart(
        delPath,
        delContent,
        "Add Radius delete workflow (" +
          fileName +
          ") for environment " +
          envName
      );
      if (delCommit.cancelled) return { outcome: "cancelled" };

      if (!delCommit.ok) {
        ports.pushStep(
          "⚠️ Could not commit delete workflow " +
            fileName +
            ": " +
            ((delCommit.stderr || "").trim() || "GitHub API request failed.")
        );
        if (!(await ports.gate())) return { outcome: "cancelled" };
      }
      if (delCommit.ok) {
        ports.recordCommittedWorkflowFile(
          operation,
          commitRecord(delPath, delCommit)
        );
        if (!(await ports.gate())) return { outcome: "cancelled" };
      }
    }
    ports.pushStep("✅ Delete workflows committed.");
  } catch (delErr) {
    if (delErr instanceof ProviderMutationRecoveryError) throw delErr;
    // Delete workflows are non-critical to environment creation, so surface the
    // failure but don't abort the whole flow.
    ports.pushStep(
      "⚠️ Could not generate/commit delete workflows: " +
        ports.errorMessage(delErr)
    );
  }

  return { outcome: "published" };
}
