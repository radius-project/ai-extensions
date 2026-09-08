import { describe, expect, it } from "vitest";
import {
  applyProviderConfiguration,
  azureRoleScope,
  buildManualRoleAssignmentGuidance,
  describeWorkflowCommitFailure,
  publishWorkflowFiles,
  VERIFY_WORKFLOW_PATH,
  WORKFLOW_SCOPE_HINT,
  WRITE_ACCESS_HINT,
  type ProviderConfigurationPorts,
  type WorkflowPublisherPorts
} from "./create-environment-workflow-publisher.js";
import type { CreateEnvironmentRequestData } from "./create-environment-refusals.js";
import type {
  CreateEnvironmentOperation,
  WorkflowCommitOutcome
} from "./create-environment-types.js";

function configurationRecorder(
  overrides: Partial<ProviderConfigurationPorts> = {}
) {
  const variables: Array<[string, unknown]> = [];
  const steps: string[] = [];
  const ports: ProviderConfigurationPorts = {
    azureCredential: () => ({}),
    awsCredential: () => ({}),
    optionalString: (value) => (typeof value === "string" ? value : ""),
    setEnvironmentVariable: async (name, value) => {
      variables.push([name, value]);
      return true;
    },
    pushStep: (message) => {
      steps.push(message);
    },
    ...overrides
  };
  return { ports, variables, steps };
}

describe("applyProviderConfiguration", () => {
  it("writes every azure value the request carries and counts what was set", async () => {
    const { ports, variables, steps } = configurationRecorder();
    const data: CreateEnvironmentRequestData = {
      clientId: "client",
      tenantId: "tenant",
      subscriptionId: "sub",
      resourceGroup: "rg",
      cluster: "aks",
      location: "westus2",
      namespace: "radius"
    };

    await applyProviderConfiguration("azure", data, ports);

    expect(variables).toEqual([
      ["AZURE_CLIENT_ID", "client"],
      ["AZURE_TENANT_ID", "tenant"],
      ["AZURE_SUBSCRIPTION_ID", "sub"],
      ["AZURE_RESOURCE_GROUP", "rg"],
      ["AZURE_AKS_CLUSTER_NAME", "aks"],
      ["AZURE_LOCATION", "westus2"],
      ["KUBERNETES_NAMESPACE", "radius"]
    ]);
    expect(steps).toEqual([
      "Setting environment variables and secrets...",
      "Set 7 environment value(s) for Azure.",
      'ℹ️ If credential verification fails with "No subscriptions found", the configured identity has no subscription-visible role. Grant one, then retry: az role assignment create --assignee client --role Contributor --scope /subscriptions/sub/resourceGroups/rg'
    ]);
  });

  it("falls back to the shared azure credential for values the request omits", async () => {
    const { ports, variables } = configurationRecorder({
      azureCredential: () => ({
        clientId: "shared-client",
        tenantId: "shared-tenant",
        subscriptionId: "shared-sub"
      })
    });

    await applyProviderConfiguration("azure", {}, ports);

    expect(variables.slice(0, 3)).toEqual([
      ["AZURE_CLIENT_ID", "shared-client"],
      ["AZURE_TENANT_ID", "shared-tenant"],
      ["AZURE_SUBSCRIPTION_ID", "shared-sub"]
    ]);
  });

  // `||`, not `??`: an empty string in the request is "not supplied" and must
  // still reach the shared credential.
  it("treats an empty request value as absent rather than as an override", async () => {
    const { ports, variables } = configurationRecorder({
      azureCredential: () => ({ clientId: "shared-client" })
    });

    await applyProviderConfiguration("azure", { clientId: "" }, ports);

    expect(variables[0]).toEqual(["AZURE_CLIENT_ID", "shared-client"]);
  });

  it("warns when the azure OIDC triple is incomplete", async () => {
    const { ports, steps } = configurationRecorder();

    await applyProviderConfiguration(
      "azure",
      { clientId: "client", tenantId: "tenant" },
      ports
    );

    expect(steps).toContain(
      "⚠️ Missing OIDC credentials (clientId/tenantId/subscriptionId). Use auto-setup or enter them manually."
    );
    expect(steps).toContain("Set 2 environment value(s) for Azure.");
  });

  it("does not warn when all three azure OIDC values are present", async () => {
    const { ports, steps } = configurationRecorder();

    await applyProviderConfiguration(
      "azure",
      { clientId: "c", tenantId: "t", subscriptionId: "s" },
      ports
    );

    expect(steps.some((step) => step.startsWith("⚠️"))).toBe(false);
  });

  it("surfaces the manual subscription-role grant command when creds are complete", async () => {
    // Issue #280: complete creds can still fail verify at Azure Login with
    // "No subscriptions found"; the publisher surfaces the exact grant command,
    // scoped to the resource group when one is set, without running it.
    const { ports, steps } = configurationRecorder();

    await applyProviderConfiguration(
      "azure",
      {
        clientId: "app-1",
        tenantId: "t",
        subscriptionId: "sub-1",
        resourceGroup: "rg-1"
      },
      ports
    );

    expect(
      steps.some(
        (step) =>
          step.startsWith("ℹ️") &&
          step.includes(
            "az role assignment create --assignee app-1 --role Contributor --scope /subscriptions/sub-1/resourceGroups/rg-1"
          )
      )
    ).toBe(true);
  });

  it("writes the aws values and neither counts them nor warns", async () => {
    const { ports, variables, steps } = configurationRecorder();
    const data: CreateEnvironmentRequestData = {
      roleArn: "arn:aws:iam::1:role/r",
      region: "eu-west-1",
      accountId: "1",
      cluster: "eks",
      vpcId: "vpc-1",
      subnetIds: "subnet-1",
      namespace: "radius"
    };

    await applyProviderConfiguration("aws", data, ports);

    expect(variables).toEqual([
      ["AWS_ROLE_ARN", "arn:aws:iam::1:role/r"],
      ["AWS_REGION", "eu-west-1"],
      ["AWS_ACCOUNT_ID", "1"],
      ["AWS_EKS_CLUSTER_NAME", "eks"],
      ["RADIUS_VPC_ID", "vpc-1"],
      ["RADIUS_SUBNET_IDS", "subnet-1"],
      ["KUBERNETES_NAMESPACE", "radius"]
    ]);
    expect(steps).toEqual(["Setting environment variables and secrets..."]);
  });

  it("defaults the aws region only after the shared credential is also empty", async () => {
    const withShared = configurationRecorder({
      awsCredential: () => ({ region: "ap-south-1" })
    });
    await applyProviderConfiguration("aws", {}, withShared.ports);
    expect(withShared.variables[1]).toEqual(["AWS_REGION", "ap-south-1"]);

    const withoutShared = configurationRecorder();
    await applyProviderConfiguration("aws", {}, withoutShared.ports);
    expect(withoutShared.variables[1]).toEqual(["AWS_REGION", "us-east-1"]);
  });

  // Any provider that is not "azure" takes the aws branch, which is how the
  // route's `data.provider || "azure"` default behaves for an unknown value.
  it("takes the aws branch for any non-azure provider", async () => {
    const { ports, variables } = configurationRecorder();

    await applyProviderConfiguration("gcp", {}, ports);

    expect(variables.map(([name]) => name)).toContain("AWS_ROLE_ARN");
  });
});

describe("azureRoleScope", () => {
  it("scopes to the resource group when one is configured", () => {
    expect(azureRoleScope("sub-1", "rg-1")).toBe(
      "/subscriptions/sub-1/resourceGroups/rg-1"
    );
  });

  it("falls back to the whole subscription when the resource group is absent or blank", () => {
    expect(azureRoleScope("sub-1")).toBe("/subscriptions/sub-1");
    expect(azureRoleScope("sub-1", "   ")).toBe("/subscriptions/sub-1");
  });
});

describe("buildManualRoleAssignmentGuidance", () => {
  it("builds the az role assignment create command with the assignee and scope", () => {
    expect(
      buildManualRoleAssignmentGuidance("app-1", "/subscriptions/sub-1")
    ).toBe(
      "az role assignment create --assignee app-1 --role Contributor --scope /subscriptions/sub-1"
    );
  });
});

describe("describeWorkflowCommitFailure", () => {
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
    expect(failure.error).toContain("protected branch");
    expect(failure.error.endsWith(WRITE_ACCESS_HINT)).toBe(true);
  });

  it.each<[stderr: string | undefined, label: string]>([
    ["", "an empty stderr"],
    ["   ", "a whitespace-only stderr"],
    [undefined, "an absent stderr"]
  ])("substitutes a generic detail for %s", (stderr) => {
    const failure = describeWorkflowCommitFailure(
      "verify",
      VERIFY_WORKFLOW_PATH,
      "octo/app",
      stderr
    );

    expect(failure.error).toContain("The GitHub API request failed.");
  });
});

const operation: CreateEnvironmentOperation = { operationId: "op-1" };

interface PublisherScript {
  commits?: Record<string, WorkflowCommitOutcome>;
  deployFiles?: Record<string, string>;
  deleteFiles?: Record<string, string>;
  deleteThrows?: boolean;
  legacyDeleteCancelled?: boolean;
  gateFalseOnCall?: number;
  viaPr?: boolean;
}

function publisherRecorder(script: PublisherScript = {}) {
  const steps: string[] = [];
  const committed: Array<{
    path: string;
    branch: string | null;
    mode: string;
    commitSha: string | null;
    blobSha: string | null;
    contentSha256: string | null;
    previousBlobSha: string | null;
  }> = [];
  const commitCalls: string[] = [];
  const journal: string[] = [];
  let gateCalls = 0;

  const ports: WorkflowPublisherPorts = {
    generateVerifyWorkflow: async () => "verify-yaml",
    generateDeployWorkflow: async () =>
      script.deployFiles ?? { "run-rad-commands.yml": "deploy-yaml" },
    generateDeleteWorkflow: async () => {
      if (script.deleteThrows) throw new Error("generator exploded");
      return script.deleteFiles ?? { "radius-delete.yml": "delete-yaml" };
    },
    commitWorkflowFileSmart: async (path) => {
      commitCalls.push(path);
      return (
        script.commits?.[path] ?? {
          ok: true,
          changed: true,
          viaPr: script.viaPr ?? false,
          commitSha: `commit-${commitCalls.length}`,
          blobSha: `blob-${commitCalls.length}`,
          contentSha256: `digest-${commitCalls.length}`,
          previousBlobSha: null,
          previousBlobKnown: true
        }
      );
    },
    recordCommittedWorkflowFile: (_operation, entry) => {
      committed.push(entry);
    },
    deleteLegacyDeployWorkflow: async () => {
      journal.push("deleteLegacyDeployWorkflow");
      return script.legacyDeleteCancelled ? "cancelled" : true;
    },
    usingPullRequestBranch: () => script.viaPr ?? false,
    pullRequestBranch: () =>
      script.viaPr ? "radius/setup-dev-workflows" : null,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    pushStep: (message) => {
      steps.push(message);
    },
    gate: async () => {
      gateCalls += 1;
      journal.push(`gate:${gateCalls}`);
      return gateCalls !== script.gateFalseOnCall;
    }
  };

  const target = {
    operation,
    targetRepo: "octo/app",
    envName: "dev",
    provider: "azure",
    defaultBranch: "main"
  };

  return {
    ports,
    target,
    steps,
    committed,
    commitCalls,
    journal,
    gateCount: () => gateCalls
  };
}

describe("publishWorkflowFiles", () => {
  it("commits verify, deploy and delete workflows in that order and gates after each", async () => {
    const recorder = publisherRecorder();

    const result = await publishWorkflowFiles(recorder.ports, recorder.target);

    expect(result).toEqual({ outcome: "published" });
    expect(recorder.commitCalls).toEqual([
      VERIFY_WORKFLOW_PATH,
      ".github/workflows/run-rad-commands.yml",
      ".github/workflows/radius-delete.yml"
    ]);
    expect(recorder.gateCount()).toBe(4);
    // Each file is recorded with the provenance of its own write, so a later
    // rollback verifies the blob that belongs to that path rather than a shared
    // guess.
    expect(recorder.committed).toEqual([
      {
        path: VERIFY_WORKFLOW_PATH,
        branch: "main",
        mode: "default_branch",
        commitSha: "commit-1",
        blobSha: "blob-1",
        contentSha256: "digest-1",
        previousBlobSha: null,
        previousBlobKnown: true
      },
      {
        path: ".github/workflows/run-rad-commands.yml",
        branch: "main",
        mode: "default_branch",
        commitSha: "commit-2",
        blobSha: "blob-2",
        contentSha256: "digest-2",
        previousBlobSha: null,
        previousBlobKnown: true
      },
      {
        path: ".github/workflows/radius-delete.yml",
        branch: "main",
        mode: "default_branch",
        commitSha: "commit-3",
        blobSha: "blob-3",
        contentSha256: "digest-3",
        previousBlobSha: null,
        previousBlobKnown: true
      }
    ]);
  });

  it("records nulls when a commit reported no provenance", async () => {
    // An older `gh` or an unreadable response still commits the file; the
    // record says so honestly instead of inventing an identity, which is what
    // later refuses to roll the file back automatically.
    const recorder = publisherRecorder({
      commits: {
        [VERIFY_WORKFLOW_PATH]: { ok: true, changed: true, viaPr: false }
      }
    });

    await publishWorkflowFiles(recorder.ports, recorder.target);

    expect(recorder.committed[0]).toEqual({
      path: VERIFY_WORKFLOW_PATH,
      branch: "main",
      mode: "default_branch",
      commitSha: null,
      blobSha: null,
      contentSha256: null,
      previousBlobSha: null,
      previousBlobKnown: false
    });
  });

  it("does not record workflows that were already up to date", async () => {
    const recorder = publisherRecorder({
      commits: {
        [VERIFY_WORKFLOW_PATH]: {
          ok: true,
          changed: false,
          viaPr: false
        },
        ".github/workflows/run-rad-commands.yml": {
          ok: true,
          changed: false,
          viaPr: false
        },
        ".github/workflows/radius-delete.yml": {
          ok: true,
          changed: false,
          viaPr: false
        }
      }
    });

    await expect(
      publishWorkflowFiles(recorder.ports, recorder.target)
    ).resolves.toEqual({ outcome: "published" });
    expect(recorder.committed).toEqual([]);
    expect(recorder.gateCount()).toBe(4);
    expect(recorder.steps).toContain("✅ Verify workflow already up to date.");
    expect(recorder.steps).toContain("✅ Deploy workflows already up to date.");
    expect(recorder.steps).toContain("✅ Delete workflows already up to date.");
    expect(recorder.steps).not.toContain("✅ Verify workflow committed.");
    expect(recorder.steps).not.toContain("✅ Deploy workflows committed.");
    expect(recorder.steps).not.toContain("✅ Delete workflows committed.");
  });

  it("records the pull-request branch when the commits fell back to one", async () => {
    const recorder = publisherRecorder({ viaPr: true });

    await publishWorkflowFiles(recorder.ports, recorder.target);

    expect(
      recorder.committed.every(
        (entry) =>
          entry.mode === "pull_request" &&
          entry.branch === "radius/setup-dev-workflows"
      )
    ).toBe(true);
  });

  it("refuses and stops when the verify workflow cannot be committed", async () => {
    const recorder = publisherRecorder({
      commits: {
        [VERIFY_WORKFLOW_PATH]: {
          ok: false,
          changed: false,
          stderr: "protected branch",
          viaPr: false
        }
      }
    });

    const result = await publishWorkflowFiles(recorder.ports, recorder.target);

    expect(result).toMatchObject({
      outcome: "refused",
      status: 400,
      code: "verify-workflow-commit-failed",
      ghError: "protected branch"
    });
    expect(recorder.commitCalls).toEqual([VERIFY_WORKFLOW_PATH]);
    expect(recorder.gateCount()).toBe(1);
    expect(recorder.steps).toContain(
      "❌ Failed to commit verify-credentials workflow."
    );
  });

  it("lets Stop win after a failed workflow write attempt", async () => {
    const recorder = publisherRecorder({
      gateFalseOnCall: 1,
      commits: {
        [VERIFY_WORKFLOW_PATH]: {
          ok: false,
          changed: false,
          stderr: "protected branch",
          viaPr: false
        }
      }
    });

    expect(await publishWorkflowFiles(recorder.ports, recorder.target)).toEqual(
      { outcome: "cancelled" }
    );
  });

  it("refuses and stops when a deploy workflow cannot be committed", async () => {
    const recorder = publisherRecorder({
      commits: {
        ".github/workflows/run-rad-commands.yml": {
          ok: false,
          changed: false,
          stderr: "",
          viaPr: false
        }
      }
    });

    const result = await publishWorkflowFiles(recorder.ports, recorder.target);

    expect(result).toMatchObject({
      outcome: "refused",
      code: "deploy-workflow-commit-failed",
      ghError: ""
    });
    expect(recorder.journal).not.toContain("deleteLegacyDeployWorkflow");
    expect(recorder.commitCalls).toHaveLength(2);
  });

  it("propagates an inner committer cancellation without rechecking Stop", async () => {
    const recorder = publisherRecorder({
      commits: {
        ".github/workflows/radius-verify-credentials.yml": {
          ok: false,
          changed: false,
          cancelled: true,
          stderr: "stopped",
          viaPr: false
        }
      }
    });

    await expect(
      publishWorkflowFiles(recorder.ports, recorder.target)
    ).resolves.toEqual({ outcome: "cancelled" });
    expect(recorder.commitCalls).toEqual([
      ".github/workflows/radius-verify-credentials.yml"
    ]);
    expect(recorder.gateCount()).toBe(0);
  });

  it("stops publication when legacy workflow deletion is cancelled", async () => {
    const recorder = publisherRecorder({ legacyDeleteCancelled: true });

    await expect(
      publishWorkflowFiles(recorder.ports, recorder.target)
    ).resolves.toEqual({ outcome: "cancelled" });
    expect(recorder.journal).toContain("deleteLegacyDeployWorkflow");
    expect(recorder.commitCalls).toHaveLength(2);
  });

  it.each<[gateCall: number, expectedCommits: number]>([
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 3]
  ])(
    "reports cancellation and touches nothing further when gate %i refuses",
    async (gateFalseOnCall, expectedCommits) => {
      const recorder = publisherRecorder({ gateFalseOnCall });

      const result = await publishWorkflowFiles(
        recorder.ports,
        recorder.target
      );

      expect(result).toEqual({ outcome: "cancelled" });
      expect(recorder.commitCalls).toHaveLength(expectedCommits);
    }
  );

  it("removes the legacy deploy workflow only when not committing through a pull request", async () => {
    const direct = publisherRecorder();
    await publishWorkflowFiles(direct.ports, direct.target);
    expect(direct.journal).toContain("deleteLegacyDeployWorkflow");

    const viaPr = publisherRecorder({ viaPr: true });
    await publishWorkflowFiles(viaPr.ports, viaPr.target);
    expect(viaPr.journal).not.toContain("deleteLegacyDeployWorkflow");
  });

  it("reports an empty gh error when the verify refusal carried no stderr", async () => {
    const recorder = publisherRecorder({
      commits: {
        [VERIFY_WORKFLOW_PATH]: {
          ok: false,
          changed: false,
          viaPr: false
        }
      }
    });

    const result = await publishWorkflowFiles(recorder.ports, recorder.target);

    expect(result).toMatchObject({ outcome: "refused", ghError: "" });
  });

  it("narrates a failed delete-workflow commit without refusing", async () => {
    const recorder = publisherRecorder({
      commits: {
        ".github/workflows/radius-delete.yml": {
          ok: false,
          changed: false,
          stderr: "HTTP 404",
          viaPr: false
        }
      }
    });

    const result = await publishWorkflowFiles(recorder.ports, recorder.target);

    expect(result).toEqual({ outcome: "published" });
    expect(recorder.steps).toContain(
      "⚠️ Could not commit delete workflow radius-delete.yml: HTTP 404"
    );
    expect(recorder.steps).toContain(
      "⚠️ Delete workflow checks completed with warnings."
    );
    expect(recorder.steps).not.toContain(
      "✅ Delete workflows already up to date."
    );
    // A refused delete commit is not recorded, but its completed write attempt
    // still consumes a gate before any later mutation can begin.
    expect(recorder.committed).toHaveLength(2);
    expect(recorder.gateCount()).toBe(4);
  });

  it("substitutes a generic detail when the delete refusal carried no stderr", async () => {
    const recorder = publisherRecorder({
      commits: {
        ".github/workflows/radius-delete.yml": {
          ok: false,
          changed: false,
          viaPr: false
        }
      }
    });

    await publishWorkflowFiles(recorder.ports, recorder.target);

    expect(recorder.steps).toContain(
      "⚠️ Could not commit delete workflow radius-delete.yml: GitHub API request failed."
    );
  });

  it("narrates a delete-workflow generator failure without refusing", async () => {
    const recorder = publisherRecorder({ deleteThrows: true });

    const result = await publishWorkflowFiles(recorder.ports, recorder.target);

    expect(result).toEqual({ outcome: "published" });
    expect(recorder.steps).toContain(
      "⚠️ Could not generate/commit delete workflows: generator exploded"
    );
    expect(recorder.steps).not.toContain("✅ Delete workflows committed.");
  });

  it("commits every generated deploy workflow before moving on", async () => {
    const recorder = publisherRecorder({
      deployFiles: {
        "radius-deploy.yml": "a",
        "radius-deploy-azure.yml": "b",
        "radius-deploy-aws.yml": "c"
      }
    });

    await publishWorkflowFiles(recorder.ports, recorder.target);

    expect(recorder.commitCalls).toEqual([
      VERIFY_WORKFLOW_PATH,
      ".github/workflows/radius-deploy.yml",
      ".github/workflows/radius-deploy-azure.yml",
      ".github/workflows/radius-deploy-aws.yml",
      ".github/workflows/radius-delete.yml"
    ]);
  });

  it("base64-encodes the generated workflow content it commits", async () => {
    const bodies: string[] = [];
    const recorder = publisherRecorder();
    const ports: WorkflowPublisherPorts = {
      ...recorder.ports,
      commitWorkflowFileSmart: async (path, contentB64) => {
        bodies.push(contentB64);
        return recorder.ports.commitWorkflowFileSmart(path, contentB64, "");
      }
    };

    await publishWorkflowFiles(ports, recorder.target);

    expect(Buffer.from(bodies[0], "base64").toString()).toBe("verify-yaml");
    expect(Buffer.from(bodies[1], "base64").toString()).toBe("deploy-yaml");
  });
});
