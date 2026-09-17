// The safety contract of the two Cloud E2E workflow files.
//
// These workflows cannot run yet - the identity, secrets, and variables they
// need are still outstanding - so there is no green run to point at. What can
// be proved without executing them is that the
// files say what they are supposed to say, and every property asserted here is
// one whose absence would be either dangerous or silently inert:
//
//   Dangerous: a `pull_request_target` trigger would hand fork-authored code an
//   Azure identity; a missing repository guard would let a fork spend our
//   subscription quota; a floating action tag would let an upstream compromise
//   reach a job holding cloud credentials; an untagged resource-group sweep
//   would delete something the suite did not create.
//
//   Silently inert: a workflow that never invokes `test:cloud`, or never sets
//   the environment variable that switches the suite on, still reports success.
//
// The timeout ordering deserves its own note. Both sides of that inequality are
// derived - the Playwright timeout from the config module, the job timeout from
// the parsed YAML - so the invariant holds if either number changes, which is
// the point of asserting it at all.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import cloudConfig from "../../playwright.cloud.config.js";
import { redactCredentials } from "../../src/credential-redaction.js";
import {
  ENVIRONMENT_NAME_PREFIX,
  RESOURCE_GROUP_PREFIX
} from "../e2e-cloud/support/fixture-repository.js";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);
const RUN_WORKFLOW = "cloud-e2e.yml";
const CLEANUP_WORKFLOW = "cloud-e2e-cleanup.yml";
const GUARD = "github.repository == 'radius-project/ai-extensions'";

interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly "continue-on-error"?: boolean;
  readonly "working-directory"?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly if?: string;
  readonly "runs-on"?: string;
  readonly "timeout-minutes"?: number;
  readonly permissions?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
  readonly on?: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
  readonly concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
    queue?: string;
  };
  readonly jobs?: Record<string, WorkflowJob>;
}

async function readWorkflow(file: string): Promise<string> {
  return readFile(
    path.join(REPOSITORY_ROOT, ".github/workflows", file),
    "utf8"
  );
}

async function parseWorkflow(file: string): Promise<Workflow> {
  return parse(await readWorkflow(file)) as Workflow;
}

function steps(job: WorkflowJob | undefined): readonly WorkflowStep[] {
  return job?.steps ?? [];
}

const WORKFLOWS = [RUN_WORKFLOW, CLEANUP_WORKFLOW] as const;

describe.each(WORKFLOWS)("%s - properties both workflows share", (file) => {
  it("never uses pull_request_target, in the parsed triggers or the raw text", async () => {
    // Both, because a parsed-only check misses a commented-out trigger someone
    // is one keystroke from restoring, and a text-only check misses nothing but
    // is the cheaper of the two to reason about. Neither alone is convincing.
    const [raw, workflow] = await Promise.all([
      readWorkflow(file),
      parseWorkflow(file)
    ]);
    expect(Object.keys(workflow.on ?? {})).not.toContain("pull_request_target");
    expect(raw).not.toMatch(/pull_request_target\s*:/);
  });

  it("grants nothing at the top level", async () => {
    const workflow = await parseWorkflow(file);
    expect(workflow.permissions).toEqual({});
  });

  it("serializes on a shared group and never cancels a run in flight", async () => {
    // Cancelling strands a resource group, a cluster, an Entra application, and
    // an environment. The group is shared with the other workflow so a purge
    // cannot run while a journey is asserting on the state it would delete.
    const workflow = await parseWorkflow(file);
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(workflow.concurrency?.group).toBe("cloud-e2e-shared-cloud-estate");
    expect(workflow.concurrency?.queue).toBe("max");
  });

  it("is triggered only on a schedule or by hand", async () => {
    const workflow = await parseWorkflow(file);
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
      "schedule",
      "workflow_dispatch"
    ]);
  });

  it("guards every job against running in a fork", async () => {
    // Scheduled workflows keep running in forks that enable Actions, and both
    // of these spend or destroy shared resources.
    const workflow = await parseWorkflow(file);
    for (const job of Object.values(workflow.jobs ?? {}))
      expect(job.if).toContain(GUARD);
  });

  it("pins every action to a full commit SHA with a version comment", async () => {
    // A tag is mutable, and these jobs hold an Azure token and an App
    // installation token. The trailing comment is what makes the pin
    // reviewable and updatable by Dependabot.
    const raw = await readWorkflow(file);
    const uses = [...raw.matchAll(/^\s*uses:\s*(\S+)\s*(#.*)?$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, reference, comment] of uses) {
      expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(comment ?? "").toMatch(/^#\s*v\d+\.\d+\.\d+/);
    }
  });

  it("requests an OIDC token only on the job that exchanges it", async () => {
    // Kept off the top level so no future job inherits the ability to mint a
    // token for the Azure identity.
    const workflow = await parseWorkflow(file);
    expect(workflow.permissions?.["id-token"]).toBeUndefined();

    const withOidc = Object.values(workflow.jobs ?? {}).filter(
      (job) => job.permissions?.["id-token"] === "write"
    );
    expect(withOidc).toHaveLength(1);
    expect(
      steps(withOidc[0]).some((step) => step.uses?.startsWith("azure/login@"))
    ).toBe(true);
  });

  it("points a reader at the runbook rather than at the YAML", async () => {
    const raw = await readWorkflow(file);
    expect(raw).toContain("docs/eng/CLOUD_E2E_RUNBOOK.md");
  });

  it("raises an issue when a scheduled run fails", async () => {
    // An overnight failure nobody sees is the same as no test at all.
    const workflow = await parseWorkflow(file);
    const notify = workflow.jobs?.["notify-scheduled-result"];
    expect(notify?.permissions).toEqual({ issues: "write" });
    expect(notify?.if).toContain("always()");
    expect(notify?.if).toContain("github.event_name == 'schedule'");
    expect(
      steps(notify)
        .map((step) => step.run)
        .join("\n")
    ).toContain("gh issue create");
  });
});

describe("cloud-e2e.yml", () => {
  it("omits merge_group, so the merge queue never waits on Azure", async () => {
    // Deferred rather than rejected, matching the design note: a `merge_group`
    // run makes the merge queue - and therefore every merge - depend on Azure
    // and Entra being available. Asserted so that adding it stays a deliberate
    // decision with a track record behind it, rather than something that
    // arrives unnoticed in a trigger list.
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    expect(Object.keys(workflow.on ?? {})).not.toContain("merge_group");
  });

  it("guards the job that spends Azure quota", async () => {
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    expect(workflow.jobs?.["cloud-e2e"]?.if).toBe(GUARD);
  });

  it("gives the job a longer budget than Playwright's test and suite timeouts", async () => {
    // The ordering is the requirement, not the numbers: Playwright has to be
    // the thing that gives up first, because it writes the trace on the way
    // out. All values are derived, so changing any of them keeps the invariant
    // honest instead of silently invalidating a hardcoded pair.
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    const jobMinutes = workflow.jobs?.["cloud-e2e"]?.["timeout-minutes"];
    const playwrightMinutes = (cloudConfig.timeout ?? 0) / 60_000;
    const playwrightGlobalMinutes = (cloudConfig.globalTimeout ?? 0) / 60_000;

    expect(playwrightMinutes).toBeGreaterThan(0);
    expect(playwrightGlobalMinutes).toBeGreaterThan(playwrightMinutes);
    expect(jobMinutes).toBeGreaterThan(playwrightMinutes);
    expect(jobMinutes).toBeGreaterThanOrEqual(playwrightGlobalMinutes + 10);
  });

  it("switches the suite on and runs it", async () => {
    // Without RADIUS_CLOUD_E2E the journey skips, and a skipped suite reports
    // success - the exact shape of a test tier that silently does nothing.
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    const job = workflow.jobs?.["cloud-e2e"];
    expect(job?.env?.RADIUS_CLOUD_E2E).toBe("1");

    const run = steps(job).find((step) => step.run?.includes("test:cloud"));
    expect(run?.["working-directory"]).toBe("packages/adapter-canvas");
    expect(run?.env).toMatchObject({
      GH_TOKEN: "${{ steps.app-token.outputs.token }}",
      CLOUD_E2E_BOT_CLIENT_ID: "${{ secrets.CLOUD_E2E_BOT_CLIENT_ID }}",
      CLOUD_E2E_BOT_PRIVATE_KEY: "${{ secrets.CLOUD_E2E_BOT_PRIVATE_KEY }}"
    });
  });

  it("isolates package credentials while using OIDC and an installation token", async () => {
    // Azure and repository access credentials are minted per run and expire
    // with it. The App signing key and package PAT remain masked secrets.
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    const used = steps(workflow.jobs?.["cloud-e2e"]).map((step) => step.uses);
    expect(used.some((use) => use?.startsWith("azure/login@"))).toBe(true);
    expect(
      used.some((use) => use?.startsWith("actions/create-github-app-token@"))
    ).toBe(true);
    const run = steps(workflow.jobs?.["cloud-e2e"]).find((step) =>
      step.run?.includes("test:cloud")
    );
    expect(run?.env).toMatchObject({
      AIEXT_CLOUD_E2E_AKS_CLUSTER_NAME:
        "${{ vars.AIEXT_CLOUD_E2E_AKS_CLUSTER_NAME }}",
      AIEXT_CLOUD_E2E_AZURE_LOCATION:
        "${{ vars.AIEXT_CLOUD_E2E_AZURE_LOCATION }}",
      AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY:
        "${{ steps.fixture.outputs.full-name }}",
      AIEXT_CLOUD_E2E_RESOURCE_GROUP:
        "${{ vars.AIEXT_CLOUD_E2E_RESOURCE_GROUP }}",
      CLOUD_E2E_BOT_CLIENT_ID: "${{ secrets.CLOUD_E2E_BOT_CLIENT_ID }}",
      CLOUD_E2E_BOT_INSTALLATION_ID:
        "${{ steps.app-token.outputs.installation-id }}",
      CLOUD_E2E_BOT_PRIVATE_KEY: "${{ secrets.CLOUD_E2E_BOT_PRIVATE_KEY }}",
      GH_PACKAGES_TOKEN: "${{ secrets.GH_RAD_CI_BOT_PAT }}",
      GH_PACKAGES_USER: "${{ secrets.CLOUD_E2E_PACKAGES_USER }}"
    });
    expect(run?.env?.GH_TOKEN).toBe("${{ steps.app-token.outputs.token }}");
    expect(workflow.jobs?.["cloud-e2e"]?.permissions?.packages).toBeUndefined();
  });

  it("inherits the fixture-scoped App grants so actions variables remain available", async () => {
    // The pinned token action cannot express the App's actions_variables
    // permission. Passing any permission inputs would narrow the token and
    // silently remove that grant, so the token must inherit the installation's
    // already-reviewed permission union.
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    const token = steps(workflow.jobs?.["cloud-e2e"]).find((step) =>
      step.uses?.startsWith("actions/create-github-app-token@")
    );
    expect(token?.with).toMatchObject({
      "client-id": "${{ secrets.CLOUD_E2E_BOT_CLIENT_ID }}",
      owner: "${{ steps.fixture.outputs.owner }}",
      repositories: "${{ steps.fixture.outputs.name }}"
    });
    expect(
      Object.keys(token?.with ?? {}).filter((key) =>
        key.startsWith("permission-")
      )
    ).toEqual([]);
  });

  it("stages and uploads one predictable diagnostics tree whether or not the run failed", async () => {
    // `always()`, because a run that fails during teardown still produced the
    // trace that explains it, and a passing run's artifact is the baseline a
    // later failure is read against.
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    const jobSteps = steps(workflow.jobs?.["cloud-e2e"]);
    const collect = jobSteps.find(
      (step) => step.name === "Collect az and gh diagnostics"
    );
    const stage = jobSteps.find(
      (step) => step.name === "Stage Playwright traces and report"
    );
    const upload = jobSteps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@")
    );
    expect(collect?.run).toContain('out="$RUNNER_TEMP/cloud-e2e-artifact"');
    expect(collect?.run).toContain("redactCredentials");
    expect(collect?.run).toContain("2>&1 | redact_azure");
    expect(stage?.if).toContain("always()");
    expect(stage?.run).toContain("packages/adapter-canvas/test-results/cloud");
    expect(stage?.run).toContain(
      "packages/adapter-canvas/playwright-report-cloud"
    );
    expect(upload?.if).toBe("always()");
    expect(upload?.with?.path).toBe("${{ runner.temp }}/cloud-e2e-artifact");
  });

  it("redacts credential-shaped Azure output before it can enter Playwright artifacts", () => {
    const jwt =
      "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJmaXh0dXJlIn0.fixture_signature";
    expect(redactCredentials(`az failed: ${jwt}`)).toBe(
      "az failed: [REDACTED]"
    );
  });

  it("collects the fixture repository's own failing workflow logs", async () => {
    // Anything the product commits and dispatches runs in the fixture
    // repository, so its failure is invisible in this job's log.
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    const diagnostics = steps(workflow.jobs?.["cloud-e2e"]).find(
      (step) => step.name === "Collect az and gh diagnostics"
    );
    expect(diagnostics?.if).toContain("always()");
    expect(diagnostics?.run).toContain("--log-failed");
    expect(diagnostics?.run).toContain("az group list");
  });

  it("mints a fresh least-privilege installation token immediately before diagnostics", async () => {
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    const jobSteps = steps(workflow.jobs?.["cloud-e2e"]);
    const tokenIndex = jobSteps.findIndex(
      (step) =>
        step.name ===
        "Create a fresh read-only GitHub App token for diagnostics"
    );
    const diagnosticsIndex = jobSteps.findIndex(
      (step) => step.name === "Collect az and gh diagnostics"
    );
    const token = jobSteps[tokenIndex];
    const diagnostics = jobSteps[diagnosticsIndex];

    expect(tokenIndex).toBeGreaterThan(0);
    expect(diagnosticsIndex).toBe(tokenIndex + 1);
    expect(token?.uses).toMatch(/^actions\/create-github-app-token@/);
    expect(token?.if).toContain("always()");
    expect(token?.["continue-on-error"]).toBe(true);
    expect(token?.with).toMatchObject({
      "permission-actions": "read",
      "permission-administration": "read",
      "permission-contents": "read",
      "permission-pull-requests": "read"
    });
    expect(
      Object.keys(token?.with ?? {}).filter((key) =>
        key.startsWith("permission-")
      )
    ).not.toContain("permission-workflows");
    expect(diagnostics?.env?.GH_TOKEN).toBe(
      "${{ steps.diagnostics-token.outputs.token }}"
    );
  });

  it("skips rather than fails while the fixture repository is unpublished", async () => {
    // This is scheduled, and the variable it needs is published by Terraform
    // that has not been applied. A job that fails every night for a reason
    // nobody in this repository can fix trains people to ignore the alert -
    // which is the one thing this tier cannot afford. Every step that would
    // touch the cloud is gated on the same resolved flag.
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    const [resolve, ...rest] = steps(workflow.jobs?.["cloud-e2e"]).slice(1);

    expect(resolve?.name).toBe("Resolve the fixture repository");
    expect(resolve?.run).toContain("configured=false");
    for (const step of rest) {
      // The artifact upload is the one deliberate exemption: it is `always()`
      // and nothing more, so a run that dies before the gate is even evaluated
      // still surfaces whatever it managed to write.
      if (step.uses?.startsWith("actions/upload-artifact@")) {
        expect(step.if).toBe("always()");
        continue;
      }
      expect(step.if).toContain("steps.fixture.outputs.configured == 'true'");
    }
  });

  it("resolves the fixture repository before spending time on a toolchain", async () => {
    // Ordering, not just gating: a skipped run should cost a checkout, not a
    // dependency install and a browser download.
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    const names = steps(workflow.jobs?.["cloud-e2e"]).map((step) => step.name);
    expect(names.indexOf("Resolve the fixture repository")).toBeLessThan(
      names.indexOf("Install dependencies")
    );
  });

  it("refuses to run when the published fixture and source pin disagree", async () => {
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    const verify = steps(workflow.jobs?.["cloud-e2e"]).find(
      (step) =>
        step.name === "Verify the published fixture repository matches the pin"
    );

    expect(verify?.if).toContain("steps.fixture.outputs.configured == 'true'");
    expect(verify?.run).toContain(
      "test/e2e-cloud/support/fixture-repository.ts"
    );
    expect(verify?.run).toContain("Refusing to run against an ambiguous scope");
  });
});

describe("cloud-e2e-cleanup.yml", () => {
  it("requests Actions write access for Radius cleanup dispatch without package write", async () => {
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const token = steps(workflow.jobs?.purge).find((step) =>
      step.uses?.startsWith("actions/create-github-app-token@")
    );

    expect(token?.with?.["permission-actions"]).toBe("write");
    expect(token?.with?.["permission-environments"]).toBe("write");
    // cloud-e2e.yml mints its journey token with no permission inputs, so any
    // grant added to this installation widens that token too.
    expect(token?.with?.["permission-packages"]).toBeUndefined();
  });

  it("deletes legacy resource groups only after the Radius applications on them", async () => {
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const purge = steps(workflow.jobs?.purge);
    const radiusIndex = purge.findIndex(
      (step) =>
        step.name === "Delete stale Radius applications before recovery state"
    );
    const legacyIndex = purge.findIndex((step) =>
      step.run?.includes("selectTestResourceGroups")
    );

    expect(radiusIndex).toBeGreaterThanOrEqual(0);
    expect(legacyIndex).toBeGreaterThan(radiusIndex);
    expect(purge[legacyIndex]?.if).toContain(
      "steps.radius-app-cleanup.outcome == 'success'"
    );
  });

  it("deletes stale Radius applications before recovery inputs", async () => {
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const purge = steps(workflow.jobs?.purge);
    const radiusCleanup = purge.find(
      (step) =>
        step.name === "Delete stale Radius applications before recovery state"
    );
    const protectedSteps = purge.filter((step) =>
      [
        "Purge stale Entra identities",
        "Purge stale GHCR deployment state",
        "Purge stale GitHub Environments",
        "Purge stale fallback pull requests and branches",
        "Reset an idle fixture repository to the pinned baseline"
      ].includes(step.name ?? "")
    );

    expect(radiusCleanup?.run).toContain(
      "gh workflow run delete-application.yml"
    );
    expect(radiusCleanup?.run).toContain('gh run watch "$run_id"');
    for (const step of protectedSteps)
      expect(step.if).toContain(
        "steps.radius-app-cleanup.outcome == 'success'"
      );
  });

  it("deletes only fixture-linked private GHCR state after Radius cleanup", async () => {
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const stateCleanup = steps(workflow.jobs?.purge).find(
      (step) => step.name === "Purge stale GHCR deployment state"
    );
    const script = stateCleanup?.run ?? "";

    expect(stateCleanup?.if).toContain(
      "steps.radius-app-cleanup.outcome == 'success'"
    );
    expect(stateCleanup?.env?.GH_PACKAGES_TOKEN).toBe(
      "${{ secrets.GH_RAD_CI_BOT_PAT }}"
    );
    expect(script).toContain("stateRegistryForEnvironment");
    expect(script).toContain(
      '[[ "$visibility" != "private" && "$visibility" != "internal" ]]'
    );
    expect(script).toContain(
      '[[ "${linked_repository,,}" != "${FIXTURE_REPOSITORY,,}" ]]'
    );
    expect(script).toContain(
      'GH_TOKEN="$GH_PACKAGES_TOKEN" gh api --method DELETE "$package_path"'
    );
  });

  it("sweeps orphaned GHCR state before the environments that name it are deleted", async () => {
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const purge = steps(workflow.jobs?.purge);
    const orphanIndex = purge.findIndex(
      (step) => step.name === "Purge orphaned GHCR deployment state"
    );
    const environmentIndex = purge.findIndex((step) =>
      step.run?.includes("selectExpiredEnvironments")
    );
    const orphanCleanup = purge[orphanIndex];
    const script = orphanCleanup?.run ?? "";

    expect(orphanIndex).toBeGreaterThanOrEqual(0);
    expect(environmentIndex).toBeGreaterThanOrEqual(0);
    // A failed application delete is one of the ways state is orphaned, so
    // gating recovery on it would skip exactly the runs that need it.
    expect(orphanCleanup?.if).not.toContain("steps.radius-app-cleanup");
    expect(orphanCleanup?.env?.GH_PACKAGES_TOKEN).toBe(
      "${{ secrets.GH_RAD_CI_BOT_PAT }}"
    );
    expect(script).toContain("selectOrphanedStatePackages");
    expect(script).toContain("stateRegistryPrefix");
    expect(script).toContain(
      '[[ "$visibility" != "private" && "$visibility" != "internal" ]]'
    );
    expect(script).toContain(
      '[[ "${linked_repository,,}" != "${FIXTURE_REPOSITORY,,}" ]]'
    );
    // Sweeping after the environment purge would strand no packages, it would
    // report every one of them as orphaned.
    expect(
      purge.findIndex((step) =>
        step.name?.startsWith("Purge stale GitHub Environments")
      )
    ).toBeGreaterThan(orphanIndex);
  });

  it("reclaims leaked cluster workloads with credentials for the shared cluster", async () => {
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const clusterCleanup = steps(workflow.jobs?.purge).find(
      (step) =>
        step.name === "Reclaim leaked Radius workloads from the shared cluster"
    );
    const script = clusterCleanup?.run ?? "";

    expect(clusterCleanup?.if).toContain(
      "steps.azure-login.outcome == 'success'"
    );
    // A workload is stranded here precisely when that delete fails.
    expect(clusterCleanup?.if).not.toContain("steps.radius-app-cleanup");
    expect(clusterCleanup?.env?.FIXTURE_APPLICATION).toBe(
      "${{ steps.pin.outputs.fixture-application }}"
    );
    expect(clusterCleanup?.env?.AKS_CLUSTER_NAME).toBe(
      "${{ vars.AIEXT_CLOUD_E2E_AKS_CLUSTER_NAME }}"
    );
    expect(clusterCleanup?.env?.RESOURCE_GROUP).toBe(
      "${{ vars.AIEXT_CLOUD_E2E_RESOURCE_GROUP }}"
    );
    expect(script).toContain("az aks get-credentials");
    expect(script).toContain("--selector radapp.io/environment");
    expect(script).toContain("selectLeakedClusterWorkloads");
    expect(script).toContain('kubectl delete "${kind,,}/$name"');
  });

  it("removes only allowlisted assignments before deleting leaked service principals", async () => {
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const purge = steps(workflow.jobs?.purge).find((step) =>
      step.run?.includes("selectExpectedRoleAssignments")
    );
    const script = purge?.run ?? "";

    expect(purge?.env?.RESOURCE_GROUP).toBe(
      "${{ vars.AIEXT_CLOUD_E2E_RESOURCE_GROUP }}"
    );
    expect(purge?.env?.AKS_CLUSTER_NAME).toBe(
      "${{ vars.AIEXT_CLOUD_E2E_AKS_CLUSTER_NAME }}"
    );
    expect(script).toContain("selectExpectedRoleAssignments");
    expect(script).toContain(
      'roleDefinitionName: "Azure Kubernetes Service RBAC Cluster Admin"'
    );
    expect(script).toContain(
      'az role assignment delete --ids "$assignment_id"'
    );
    expect(script.indexOf("az role assignment delete")).toBeLessThan(
      script.indexOf("az ad sp delete")
    );
    expect(script).toContain("assignment_failure");
    expect(script).toContain("blocked-application-ids.txt");
    expect(script).toContain(
      "preserve application $id because service principal cleanup"
    );
    // Deleting an application cascade-deletes its principal, so a principal the
    // age filter never selected must block its parent rather than ride along.
    expect(script).toContain("selectAppIdsWithUnprocessedServicePrincipals");
    expect(script).toContain(
      "preserve appId $unprocessed_app_id because a matching service principal was not a deletion candidate"
    );
  });

  it("deletes tagged resource groups the suite creates without waiting for age", async () => {
    // The shared Radius purge job remains a safety net, but this workflow owns
    // test leaks first. The fixture tag is what stops a prefix match from
    // becoming a broad subscription sweep.
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const purge = steps(workflow.jobs?.purge).find((step) =>
      step.run?.includes("selectTestResourceGroups")
    );
    const script = purge?.run ?? "";

    expect(purge?.if).toContain("always()");
    expect(purge?.if).toContain("steps.azure-login.outcome == 'success'");
    expect(purge?.env?.RESOURCE_GROUP_PREFIX).toBe(
      "${{ steps.pin.outputs.resource-group-prefix }}"
    );
    expect(purge?.env?.SHARED_RESOURCE_GROUP).toBe(
      "${{ vars.AIEXT_CLOUD_E2E_RESOURCE_GROUP }}"
    );
    expect(purge?.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(purge?.env?.SUBSCRIPTION_ID).toBe(
      "${{ secrets.AZURE_SUBSCRIPTION_ID }}"
    );
    expect(script).toContain("starts_with(name, '$RESOURCE_GROUP_PREFIX')");
    expect(script).toContain(
      "selectTestResourceGroups(groups, prefix, sharedResourceGroup)"
    );
    expect(script).toContain('--subscription "$SUBSCRIPTION_ID"');
    expect(script).not.toContain("MAX_AGE_HOURS hours ago");
    expect(script).toContain("gh run view");
    expect(script).toContain('status" != "completed"');
    expect(script).toContain("failures+=");
    expect(script).toContain("az group delete");
    expect(RESOURCE_GROUP_PREFIX.startsWith("radtest-")).toBe(true);
  });

  it("reads the reset target from the suite's pin rather than restating it", async () => {
    // A second copy of a force-push target is precisely the drift that turns a
    // cleanup job into a destructive operation against the wrong ref.
    const raw = await readWorkflow(CLEANUP_WORKFLOW);
    expect(raw).toContain("test/e2e-cloud/support/fixture-repository.ts");
    expect(raw).toContain("FIXTURE_BASELINE_SHA");
  });

  it("exports cleanup scope constants from the fixture pin", async () => {
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const pin = steps(workflow.jobs?.purge).find(
      (step) => step.name === "Resolve the pinned fixture repository"
    );
    const script = pin?.run ?? "";

    expect(script).toContain(
      "`resource-group-prefix=${pin.RESOURCE_GROUP_PREFIX}`"
    );
    expect(script).toContain(
      "`environment-prefix=${pin.ENVIRONMENT_NAME_PREFIX}`"
    );
    expect(script).toContain(
      "`workflow-fallback-branch-prefix=${pin.WORKFLOW_FALLBACK_BRANCH_PREFIX}`"
    );
    expect(script).toContain("`lease-ref=${pin.CLOUD_E2E_LEASE_REF}`");
  });

  it("resets the fixture only while holding the shared lease", async () => {
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const reset = steps(workflow.jobs?.purge).find(
      (step) =>
        step.name === "Reset the fixture default branch under the shared lease"
    );
    const script = reset?.run ?? "";

    expect(reset?.env?.LEASE_REF).toBe("${{ steps.pin.outputs.lease-ref }}");
    expect(reset?.env?.SOURCE_GH_TOKEN).toBe("${{ github.token }}");
    expect(script).toContain("parseCloudE2ELeaseOwnerRunId");
    expect(script).toContain("node --input-type=module -e");
    expect(script).not.toContain("<<'NODE'");
    expect(script).toContain('owner_status" != "completed"');
    expect(script).toContain("no verifiable GitHub Actions owner");
    expect(script).toContain("Could not verify workflow run");
    expect(script).toContain("was acquired concurrently");
    expect(script).toContain(
      "changed while cleanup was establishing ownership"
    );
    expect(script).toContain("changed before release");
    expect(script).toContain('gh api -X DELETE "$lease_write_path"');
    // lastIndexOf, not indexOf: the failure-path trap defined at the top of the
    // script also releases the lease, so the final occurrence is the normal
    // release that must follow the branch reset.
    expect(script.indexOf("gh api -X PATCH")).toBeLessThan(
      script.lastIndexOf('gh api -X DELETE "$lease_write_path"')
    );
  });

  it("survives a read-after-write lag instead of dying while holding the lease", async () => {
    // A ref read issued immediately after creating that ref can 404 on a stale
    // replica. Under `set -e` an unretried read aborts the step between
    // acquiring and releasing the mutex, so the lease outlives the run and
    // every Cloud E2E run fails until the next scheduled cleanup reclaims it.
    //
    // These are structural assertions only: they pin the wiring in place but
    // cannot tell a working retry from a broken one. The behavior itself is
    // executed against stubbed `gh`/`node`/`sleep` in
    // build/scripts/cloud-e2e-lease_test.sh, which is what actually fails when
    // one of these paths regresses.
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const reset = steps(workflow.jobs?.purge).find(
      (step) =>
        step.name === "Reset the fixture default branch under the shared lease"
    );
    const script = reset?.run ?? "";

    expect(script).toContain("read_lease_sha()");
    // Both post-write verifications must go through the retry, never a bare read.
    expect(script).not.toContain(
      'verify_lease_sha="$(gh api "$lease_read_path" --jq .object.sha)"'
    );
    expect(
      script.match(/verify_lease_sha="\$\(read_lease_sha\)"/g)?.length
    ).toBe(2);

    // Failing anywhere while holding the lease must still release it. Anchored
    // so a commented-out trap cannot satisfy the assertion.
    expect(script).toMatch(/^\s*trap release_orphaned_lease EXIT\s*$/m);
    expect(script).toContain(
      "Released $LEASE_REF after cleanup failed while holding it."
    );
    // Both acquisition paths - reclaiming an abandoned lease and creating a new
    // one - must mark ownership, or the trap silently skips the release.
    expect(script.match(/^\s*lease_held_by_us=1\s*$/gm)?.length).toBe(2);
    // The release must stay guarded so a concurrent owner is never deleted.
    expect(script).toContain('"$current" != "$held_lease_sha"');
    // A create that reports failure may still have landed. Ownership is settled
    // by comparing the ref against this run's own lease commit, never by the
    // mere existence of a ref.
    expect(script).toContain('"$created_lease_sha" != "$held_lease_sha"');
  });

  it("runs the lease behavior suite in CI", async () => {
    // The structural assertions above are only a tripwire; the executable
    // coverage lives in a shell suite. If it stops being wired into a workflow
    // it stops running, and nothing else would notice.
    const selftests = await readWorkflow("extension-selftests.yml");

    expect(selftests).toContain("build/scripts/cloud-e2e-lease_test.sh");
    expect(selftests).toContain("build/scripts/cloud-e2e-lease*.sh");
  });

  it("matches environments by the prefix the suite actually applies", async () => {
    // Taken from the module, so a rename there cannot leave this sweeping a
    // prefix nothing uses - or, worse, one something else does.
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const purge = steps(workflow.jobs?.purge).find(
      (step) => step.env?.ENVIRONMENT_PREFIX !== undefined
    );
    expect(purge?.env?.ENVIRONMENT_PREFIX).toBe(
      "${{ steps.pin.outputs.environment-prefix }}"
    );
    expect(ENVIRONMENT_NAME_PREFIX).toBe("radtest-");
  });

  it("purges nothing until the pin and published repository agree", async () => {
    // The checked-in pin proves the target is intentional, while the published
    // variable proves infrastructure provisioning has selected the same
    // repository. Both gates must open before any destructive step can run.
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const verify = steps(workflow.jobs?.purge).find(
      (step) => step.name === "Verify the published variable matches the pin"
    );
    const destructive = steps(workflow.jobs?.purge).filter(
      (step) =>
        step.run?.includes("az group delete") ||
        step.run?.includes("az ad app delete") ||
        step.run?.includes("-X DELETE") ||
        step.run?.includes("-X PATCH")
    );
    expect(verify?.run).toContain('echo "configured=false"');
    expect(verify?.run).toContain('echo "configured=true"');
    expect(destructive.length).toBeGreaterThan(0);
    for (const step of destructive) {
      expect(step.if).toContain("always()");
      expect(step.if).toContain("steps.pin.outputs.provisioned == 'true'");
      expect(step.if).toContain(
        "steps.verify-scope.outputs.configured == 'true'"
      );
    }
  });

  it("keeps the age threshold for Entra and GitHub state", async () => {
    // Without a provable age a purge cannot tell leaked state from a run in
    // progress, and the shared concurrency group is only half that guarantee.
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const job = workflow.jobs?.purge;
    expect(job?.env?.MAX_AGE_HOURS).toBe("6");

    const ageGatedDestructiveSteps = steps(job).filter(
      (candidate) =>
        (candidate.run?.includes("az ad app delete") ||
          candidate.run?.includes("-X DELETE")) &&
        candidate.name !==
          "Reset the fixture default branch under the shared lease"
    );
    expect(ageGatedDestructiveSteps).toHaveLength(3);
    for (const step of ageGatedDestructiveSteps)
      expect(step.run).toContain("MAX_AGE_HOURS hours ago");
  });

  it("deletes age-eligible service principals before applications", async () => {
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const purge = steps(workflow.jobs?.purge).find((step) =>
      step.run?.includes("az ad sp delete")
    );
    const script = purge?.run ?? "";

    expect(purge?.if).toContain("always()");
    expect(purge?.if).toContain("steps.azure-login.outcome == 'success'");
    expect(script).toContain("selectExpiredApplications");
    expect(script).toContain("selectExpiredServicePrincipals");
    expect(script).toContain("$ENVIRONMENT_PREFIX");
    expect(script).toContain("$FIXTURE_REPOSITORY");
    expect(script).toContain("appId");
    expect(script).toContain("failures+=");
    expect(script.indexOf("az ad sp delete")).toBeLessThan(
      script.indexOf("az ad app delete")
    );
  });

  it("closes old fallback pull requests before deleting their exact head refs", async () => {
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const purge = steps(workflow.jobs?.purge).find((step) =>
      step.run?.includes("selectExpiredFallbackPullRequests")
    );
    const script = purge?.run ?? "";

    expect(purge?.if).toContain("always()");
    expect(purge?.if).toContain("steps.app-token.outcome == 'success'");
    expect(script).toContain("MAX_AGE_HOURS hours ago");
    expect(script).toContain("selectOpenPullRequestHeadRefs");
    expect(script).toContain("$FIXTURE_REPOSITORY");
    expect(script).toContain("$DEFAULT_BRANCH");
    expect(script).toContain("failures+=");
    expect(script).toContain("git/matching-refs/heads/$FALLBACK_BRANCH_PREFIX");
    expect(purge?.env?.FALLBACK_BRANCH_PREFIX).toBe(
      "${{ steps.pin.outputs.workflow-fallback-branch-prefix }}"
    );
    expect(script.indexOf("-f state=closed")).toBeLessThan(
      script.indexOf("-X DELETE")
    );
  });

  it("selects stale environments through the fail-closed timestamp helper", async () => {
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const purge = steps(workflow.jobs?.purge).find((step) =>
      step.run?.includes("selectExpiredEnvironments")
    );

    expect(purge?.run).toContain("expired-environments.json");
    expect(purge?.run).not.toContain(".created_at < $cutoff");
  });

  it("gives AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY a real consumer", async () => {
    // The published variable is otherwise never read: the suite pins the
    // repository in source instead. Cross-checking it here means a variable
    // that disagrees with the pin fails loudly rather than going unnoticed.
    const raw = await readWorkflow(CLEANUP_WORKFLOW);
    expect(raw).toContain("AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY");
    expect(raw).toContain("Refusing to purge against an ambiguous scope");
  });
});

describe.each(WORKFLOWS)("%s - shell scripts parse", (file) => {
  it("terminates every heredoc at column zero", async () => {
    // `<<'TAG'` requires the terminator to start at column 0 of the script.
    // YAML block scalars strip only the block's base indentation, so a
    // terminator indented to match the surrounding bash nesting survives review
    // and passes YAML and actionlint, then makes bash swallow the rest of the
    // script as heredoc body: "unexpected EOF". The step cannot run at all, and
    // nothing before this test caught it - a purge step shipped broken and
    // silently stopped reclaiming leaked cloud state.
    const workflow = await parseWorkflow(file);
    const offenders: string[] = [];

    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of steps(job)) {
        if (typeof step.run !== "string") continue;
        const lines = step.run.split("\n");

        lines.forEach((line, index) => {
          // `<<-` is excluded deliberately: it strips leading tabs, so an
          // indented terminator is legal there.
          const opened = /<<'([A-Za-z_][A-Za-z0-9_]*)'/.exec(line);
          if (!opened || line.includes("<<-")) return;
          const tag = opened[1];
          const nextOpen = lines.findIndex(
            (candidate, candidateIndex) =>
              candidateIndex > index &&
              /<<'([A-Za-z_][A-Za-z0-9_]*)'/.test(candidate) &&
              !candidate.includes("<<-")
          );
          const terminated = lines
            .slice(index + 1, nextOpen === -1 ? undefined : nextOpen)
            .some((candidate) => candidate === tag);
          if (!terminated) {
            offenders.push(
              `${file} ${jobName} > ${step.name ?? "(unnamed)"}: <<'${tag}' opened on script line ${index + 1}`
            );
          }
        });
      }
    }

    expect(offenders).toEqual([]);
  });
});
