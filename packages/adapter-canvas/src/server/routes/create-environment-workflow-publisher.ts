import { needsWorkflowScope } from "./create-environment-gh-runner.js";
import type { CreateEnvironmentRequestData } from "./create-environment-refusals.js";
import type {
  CreateEnvironmentOperation,
  WorkflowCommitOutcome
} from "./create-environment-types.js";

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

export const WORKFLOW_SCOPE_HINT =
  ' Your GitHub token is missing the "workflow" scope. Run `gh auth refresh -h github.com -s workflow` in a terminal, then retry.';
export const WRITE_ACCESS_HINT =
  " Check that you have write access to the repository and that GitHub Actions is enabled.";

export const VERIFY_WORKFLOW_PATH =
  ".github/workflows/radius-verify-credentials.yml";

export interface ProviderConfigurationPorts {
  azureCredential(): Record<string, unknown>;
  awsCredential(): Record<string, unknown>;
  optionalString(value: unknown): string;
  setEnvironmentVariable(name: string, value: unknown): Promise<boolean>;
  pushStep(message: string): void;
}

// Step 2. Values from the request win; anything absent falls back to the
// shared credential record. `||` rather than `??` throughout, so an empty
// string is treated as absent exactly as it was inline.
export async function applyProviderConfiguration(
  provider: string,
  data: CreateEnvironmentRequestData,
  ports: ProviderConfigurationPorts
): Promise<void> {
  ports.pushStep("Setting environment variables and secrets...");
  const azureCreds = ports.azureCredential();
  const awsCreds = ports.awsCredential();

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
    await ports.setEnvironmentVariable("RADIUS_NAMESPACE", data.namespace);

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
    if (!clientId || !tenantId || !subscriptionId) {
      ports.pushStep(
        "⚠️ Missing OIDC credentials (clientId/tenantId/subscriptionId). Use auto-setup or enter them manually."
      );
    }
    return;
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
  await ports.setEnvironmentVariable("RADIUS_NAMESPACE", data.namespace);
}

// The message a failed workflow commit is reported with. Pure, so the hint
// selection is assertable without driving a commit: a missing `workflow` scope
// is a token problem the user fixes with `gh auth refresh`, anything else is
// reported as a repository write-access problem.
export function describeWorkflowCommitFailure(
  kind: "verify" | "deploy",
  path: string,
  targetRepo: string,
  stderr: string | undefined
): { status: number; error: string; code: string } {
  const hint =
    needsWorkflowScope(stderr) ? WORKFLOW_SCOPE_HINT : WRITE_ACCESS_HINT;
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
    entry: { path: string; branch: string | null; mode: string }
  ): void;
  deleteLegacyDeployWorkflow(repo: string): Promise<boolean>;
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
  const commitRecord = (path: string, commit: WorkflowCommitOutcome) => ({
    path,
    branch: commit.viaPr ? ports.pullRequestBranch() : defaultBranch,
    mode: commit.viaPr ? "pull_request" : "default_branch"
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

  if (!verifyCommit.ok) {
    ports.pushStep("❌ Failed to commit verify-credentials workflow.");
    return {
      outcome: "refused",
      ...describeWorkflowCommitFailure(
        "verify",
        VERIFY_WORKFLOW_PATH,
        targetRepo,
        verifyCommit.stderr
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

    if (!deployCommit.ok) {
      ports.pushStep("❌ Failed to commit deploy workflow " + fileName + ".");
      return {
        outcome: "refused",
        ...describeWorkflowCommitFailure(
          "deploy",
          deployPath,
          targetRepo,
          deployCommit.stderr
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
  if (!ports.usingPullRequestBranch())
    await ports.deleteLegacyDeployWorkflow(targetRepo);
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

      if (!delCommit.ok) {
        ports.pushStep(
          "⚠️ Could not commit delete workflow " +
            fileName +
            ": " +
            ((delCommit.stderr || "").trim() || "GitHub API request failed.")
        );
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
    // Delete workflows are non-critical to environment creation, so surface the
    // failure but don't abort the whole flow.
    ports.pushStep(
      "⚠️ Could not generate/commit delete workflows: " +
        ports.errorMessage(delErr)
    );
  }

  return { outcome: "published" };
}
