// The safety contract of the two Cloud E2E workflow files.
//
// These workflows cannot run yet - the identity, the secrets, the variables,
// and the fixture repository they need are all outstanding - so there is no
// green run to point at. What can be proved without executing them is that the
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
  readonly concurrency?: { group?: string; "cancel-in-progress"?: boolean };
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
    expect(jobMinutes).toBeGreaterThan(playwrightGlobalMinutes);
  });

  it("switches the suite on and runs it", async () => {
    // Without RADIUS_CLOUD_E2E the journey skips, and a skipped suite reports
    // success - the exact shape of a test tier that silently does nothing.
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    const job = workflow.jobs?.["cloud-e2e"];
    expect(job?.env?.RADIUS_CLOUD_E2E).toBe("1");

    const run = steps(job).find((step) => step.run?.includes("test:cloud"));
    expect(run?.["working-directory"]).toBe("packages/adapter-canvas");
  });

  it("authenticates to Azure by OIDC and to GitHub by installation token", async () => {
    // No long-lived cloud secret exists to leak: both credentials are minted
    // per run and expire with it.
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    const used = steps(workflow.jobs?.["cloud-e2e"]).map((step) => step.uses);
    expect(used.some((use) => use?.startsWith("azure/login@"))).toBe(true);
    expect(
      used.some((use) => use?.startsWith("actions/create-github-app-token@"))
    ).toBe(true);
  });

  it("requests the workflow scope explicitly rather than discovering it is missing", async () => {
    // A token silently missing `workflows` sends the product down its
    // pull-request fallback path, and the journey would pass without ever
    // having committed a workflow to the default branch. Asking for the
    // permission turns that into a loud failure at token-request time.
    const workflow = await parseWorkflow(RUN_WORKFLOW);
    const token = steps(workflow.jobs?.["cloud-e2e"]).find((step) =>
      step.uses?.startsWith("actions/create-github-app-token@")
    );
    expect(token?.with?.["permission-actions"]).toBe("read");
    expect(token?.with?.["permission-workflows"]).toBe("write");
    expect(token?.with?.["permission-environments"]).toBe("write");
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
  it("deletes tagged resource groups the suite creates without waiting for age", async () => {
    // The shared Radius purge job remains a safety net, but this workflow owns
    // test leaks first. The fixture tag is what stops a prefix match from
    // becoming a broad subscription sweep.
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const purge = steps(workflow.jobs?.purge).find((step) =>
      step.run?.includes("selectTestResourceGroups")
    );
    const script = purge?.run ?? "";

    expect(purge?.if).toBe("steps.pin.outputs.provisioned == 'true'");
    expect(purge?.env?.RESOURCE_GROUP_PREFIX).toBe(
      "${{ steps.pin.outputs.resource-group-prefix }}"
    );
    expect(purge?.env?.SUBSCRIPTION_ID).toBe(
      "${{ secrets.AZURE_SUBSCRIPTION_ID }}"
    );
    expect(script).toContain("starts_with(name, '$RESOURCE_GROUP_PREFIX')");
    expect(script).toContain('--subscription "$SUBSCRIPTION_ID"');
    expect(script).not.toContain("MAX_AGE_HOURS hours ago");
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

  it("purges nothing until the fixture repository is provisioned", async () => {
    // Today the pin is a placeholder, so every destructive step is gated off.
    // The gate is the reason this workflow can be merged before its
    // prerequisites exist without being a hazard.
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const destructive = steps(workflow.jobs?.purge).filter(
      (step) =>
        step.run?.includes("az group delete") ||
        step.run?.includes("az ad app delete") ||
        step.run?.includes("-X DELETE") ||
        step.run?.includes("-X PATCH")
    );
    expect(destructive.length).toBeGreaterThan(0);
    for (const step of destructive)
      expect(step.if).toBe("steps.pin.outputs.provisioned == 'true'");
  });

  it("keeps the age threshold for Entra and GitHub state", async () => {
    // Without a provable age a purge cannot tell leaked state from a run in
    // progress, and the shared concurrency group is only half that guarantee.
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const job = workflow.jobs?.purge;
    expect(job?.env?.MAX_AGE_HOURS).toBe("6");

    for (const step of steps(job).filter(
      (candidate) =>
        candidate.run?.includes("az ad app delete") ||
        candidate.run?.includes("-X DELETE")
    ))
      expect(step.run).toContain("MAX_AGE_HOURS hours ago");
  });

  it("deletes age-eligible service principals before applications", async () => {
    const workflow = await parseWorkflow(CLEANUP_WORKFLOW);
    const purge = steps(workflow.jobs?.purge).find((step) =>
      step.run?.includes("az ad sp delete")
    );
    const script = purge?.run ?? "";

    expect(script).toContain("selectExpiredDirectoryObjects");
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

    expect(purge?.if).toBe("steps.pin.outputs.provisioned == 'true'");
    expect(script).toContain("MAX_AGE_HOURS hours ago");
    expect(script).toContain("git/matching-refs/heads/$FALLBACK_BRANCH_PREFIX");
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
