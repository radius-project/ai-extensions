import { describe, it, expect, beforeEach, vi } from "vitest";
import { REPO_RADIUS_PINSET, pinActionRefs } from "@radius-project/core";

// Fake GitHub. `committed` is keyed by branch so a plan computed against the
// default branch and a worktree branch can diverge, and every write is recorded
// so a test can assert that the read-only paths issue none.
const h = vi.hoisted(() => ({
    committed: {},
    heads: {},
    commits: [],
    reads: [],
    branchRefs: [],
    pulls: [],
    defaultBranch: "main",
    commitError: null, // stderr to reject the next commitFileToRepo with
    branchRefError: null,
    pullError: null,
}));

vi.mock("./gh.mjs", async () => {
    const actual = await vi.importActual("./gh.mjs");
    return {
        // The stderr classifiers are pure; exercise the real ones so the tests
        // assert on genuine `gh` output rather than a restated regex.
        isProtectedBranchFailure: actual.isProtectedBranchFailure,
        needsWorkflowScope: actual.needsWorkflowScope,
        getDefaultBranch: async () => h.defaultBranch,
        getBranchHeadSha: async (_repo, branch) => h.heads[branch] || "",
        fetchFileFromRepo: async (_repo, path, branch = "main") => {
            h.reads.push(path);
            const files = h.committed[branch];
            return files && path in files ? files[path] : null;
        },
        commitFileToRepo: async (_repo, path, content, branch, message) => {
            if (h.commitError) throw new Error(h.commitError);
            h.commits.push({ path, content, branch, message });
            (h.committed[branch] ||= {})[path] = content;
            return true;
        },
        createBranchRef: async (_repo, branch, fromSha) => {
            if (h.branchRefError) return { ok: false, stderr: h.branchRefError };
            h.branchRefs.push({ branch, fromSha });
            h.committed[branch] = { ...(h.committed[h.defaultBranch] || {}) };
            h.heads[branch] = fromSha;
            return { ok: true, stderr: "" };
        },
        createPullRequestApi: async (_repo, head, base, title, body) => {
            if (h.pullError) return { ok: false, stderr: h.pullError };
            h.pulls.push({ head, base, title, body });
            return { ok: true, url: "https://github.com/acme/app/pull/7", number: 7 };
        },
    };
});

const { planWorkflowUpgrade, applyWorkflowUpgrade, workflowPath } = await import("./workflow-pins.mjs");

const DISPATCHER = "run-rad-commands.yml";
const AZURE = "run-rad-commands-azure.yml";
const DELETE_AZURE = "delete-azure.yml";
const PINNED_SHA = REPO_RADIUS_PINSET.templateSource.sha;

// A provider workflow the way a repo created before pinning carries it: the
// Radius action on a moving branch, third-party actions already SHA-pinned.
const STALE_AZURE = `name: deploy-azure
jobs:
  azure:
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
      - uses: radius-project/radius/.github/extension/actions/run-rad-commands@main
`;
const PINNED_AZURE = pinActionRefs(STALE_AZURE, REPO_RADIUS_PINSET);
// The dispatcher only references local workflow files, so it is never stale.
const DISPATCHER_BODY = "jobs:\n  azure:\n    uses: ./.github/workflows/run-rad-commands-azure.yml\n";
// Carries `id-token: write` and four pinset-governed actions upstream, so a
// stale copy runs old code against the user's cloud exactly as a deploy would.
const STALE_DELETE = `name: delete-azure
jobs:
  azure:
    steps:
      - uses: radius-project/radius/.github/extension/actions/delete-resource@main
      - uses: radius-project/radius/.github/extension/actions/teardown@main
`;

const AZURE_PATH = workflowPath(AZURE);
const DELETE_PATH = workflowPath(DELETE_AZURE);
const PROTECTED = "gh: Validation Failed (HTTP 422) - refusing to allow an OAuth App to create or update workflow `.github/workflows/x.yml` without `workflow` scope";
const PROTECTED_BRANCH = "HTTP 403: Resource not accessible by integration - protected branch update failed";

function seed(branch, files) {
    h.committed[branch] = { ...files };
    h.heads[branch] = `${branch}head0000000000000000000000000000000000`.slice(0, 40);
}

describe("planWorkflowUpgrade", () => {
    beforeEach(() => {
        h.committed = {};
        h.heads = {};
        h.commits = [];
        h.reads = [];
        h.branchRefs = [];
        h.pulls = [];
        h.defaultBranch = "main";
        h.commitError = null;
        h.branchRefError = null;
        h.pullError = null;
    });

    // The whole point of a cheap pin check: an up-to-date repo must cost
    // nothing and interrupt nobody.
    it("reports current and writes nothing when the pins already match", async () => {
        seed("main", { [AZURE_PATH]: PINNED_AZURE, [workflowPath(DISPATCHER)]: DISPATCHER_BODY });

        const plan = await planWorkflowUpgrade("acme/app", [DISPATCHER, AZURE]);

        expect(plan.status).toBe("current");
        expect(plan.files).toEqual([]);
        expect(h.commits).toEqual([]);
    });

    it("reports the file and reference that would change", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE });

        const plan = await planWorkflowUpgrade("acme/app", [DISPATCHER, AZURE]);

        expect(plan.status).toBe("outdated");
        expect(plan.base).toBe("main");
        expect(plan.files).toHaveLength(1);
        expect(plan.files[0].path).toBe(AZURE_PATH);
        expect(plan.files[0].changes[0]).toMatchObject({
            repo: "radius-project/radius",
            status: "unpinned",
            to: { sha: PINNED_SHA },
        });
        expect(h.commits).toEqual([]);
    });

    it("leaves third-party actions out of the plan", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE });

        const plan = await planWorkflowUpgrade("acme/app", [AZURE]);

        expect(plan.files[0].changes.map((c) => c.repo)).toEqual(["radius-project/radius"]);
    });

    it("checks the deploy ref alongside the default branch", async () => {
        seed("main", { [AZURE_PATH]: PINNED_AZURE });
        seed("feature", { [AZURE_PATH]: STALE_AZURE });

        const plan = await planWorkflowUpgrade("acme/app", [AZURE], { deployRef: "feature" });

        expect(plan.status).toBe("outdated");
        expect(plan.targets.map((t) => t.branch)).toEqual(["feature"]);
    });

    it("does not check the deploy ref twice when it is the default branch", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE });

        const plan = await planWorkflowUpgrade("acme/app", [AZURE], { deployRef: "main" });

        expect(plan.targets).toHaveLength(1);
    });

    // A branch that was never pushed has no readable files. That is not an
    // upgrade — authoring missing workflows belongs to environment creation.
    it("ignores a branch whose files cannot be read", async () => {
        seed("main", { [AZURE_PATH]: PINNED_AZURE });

        const plan = await planWorkflowUpgrade("acme/app", [AZURE], { deployRef: "unpushed" });

        expect(plan.status).toBe("current");
    });

    // The delete workflows must never gate anything (a stale pin must not leave
    // someone unable to tear down cloud resources), so a deploy-time
    // confirmation is the only occasion they are ever repaired.
    it("folds ride-along workflows into a plan that is already outdated", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE, [DELETE_PATH]: STALE_DELETE });

        const plan = await planWorkflowUpgrade("acme/app", [AZURE], { alsoUpgrade: [DELETE_AZURE] });

        expect(plan.files.map((f) => f.path)).toEqual([AZURE_PATH, DELETE_PATH]);
    });

    // The headline property of the pin check: an up-to-date repo pays for the
    // gating files only. Ride-alongs must not add a read to every deploy.
    it("does not read ride-along workflows when the gating files are current", async () => {
        seed("main", { [AZURE_PATH]: PINNED_AZURE, [DELETE_PATH]: STALE_DELETE });

        const plan = await planWorkflowUpgrade("acme/app", [AZURE], { alsoUpgrade: [DELETE_AZURE] });

        expect(plan.status).toBe("current");
        expect(h.reads).not.toContain(DELETE_PATH);
    });

    it("applies a confirmed plan to the ride-along workflow too", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE, [DELETE_PATH]: STALE_DELETE });
        const plan = await planWorkflowUpgrade("acme/app", [AZURE], { alsoUpgrade: [DELETE_AZURE] });

        const result = await applyWorkflowUpgrade("acme/app", plan, "commit");

        expect(result.status).toBe("updated");
        expect(h.commits.map((c) => c.path)).toEqual([AZURE_PATH, DELETE_PATH]);
        expect(h.committed.main[DELETE_PATH]).toBe(pinActionRefs(STALE_DELETE, REPO_RADIUS_PINSET));
    });
});

describe("applyWorkflowUpgrade", () => {
    beforeEach(() => {
        h.committed = {};
        h.heads = {};
        h.commits = [];
        h.branchRefs = [];
        h.pulls = [];
        h.defaultBranch = "main";
        h.commitError = null;
        h.branchRefError = null;
        h.pullError = null;
    });

    it("commits the pinned file to the default branch", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE });
        const plan = await planWorkflowUpgrade("acme/app", [AZURE]);

        const result = await applyWorkflowUpgrade("acme/app", plan, "commit");

        expect(result.status).toBe("updated");
        expect(h.commits).toHaveLength(1);
        expect(h.commits[0].branch).toBe("main");
        expect(h.commits[0].content).toBe(PINNED_AZURE);
        expect(h.commits[0].content).toContain(`@${PINNED_SHA} #`);
    });

    // The diff a reviewer sees must be the reference lines and nothing else.
    it("changes only the reference lines", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE });
        const plan = await planWorkflowUpgrade("acme/app", [AZURE]);

        await applyWorkflowUpgrade("acme/app", plan, "commit");

        const before = STALE_AZURE.split("\n");
        const after = h.commits[0].content.split("\n");
        expect(after).toHaveLength(before.length);
        expect(before.flatMap((l, i) => (l === after[i] ? [] : [i + 1]))).toEqual([6]);
    });

    it("records the change in the commit message", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE });
        const plan = await planWorkflowUpgrade("acme/app", [AZURE]);

        await applyWorkflowUpgrade("acme/app", plan, "commit");

        expect(h.commits[0].message).toContain("Update Radius workflow action pins");
        expect(h.commits[0].message).toContain(AZURE_PATH);
    });

    it("is a no-op the second time", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE });
        const plan = await planWorkflowUpgrade("acme/app", [AZURE]);

        await applyWorkflowUpgrade("acme/app", plan, "commit");
        const again = await applyWorkflowUpgrade("acme/app", plan, "commit");

        expect(again.status).toBe("updated");
        expect(h.commits).toHaveLength(1);
    });

    it("offers a pull request when the branch is protected, without opening one", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE });
        const plan = await planWorkflowUpgrade("acme/app", [AZURE]);
        h.commitError = PROTECTED_BRANCH;

        const result = await applyWorkflowUpgrade("acme/app", plan, "commit");

        expect(result.status).toBe("needs-pull-request");
        expect(h.branchRefs).toEqual([]);
        expect(h.pulls).toEqual([]);
    });

    // A missing `workflow` scope is a client-side auth problem; a pull request
    // cannot fix it, so offering one would send the user down a dead end.
    it("blocks rather than offering a pull request when the token lacks workflow scope", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE });
        const plan = await planWorkflowUpgrade("acme/app", [AZURE]);
        h.commitError = PROTECTED;

        const result = await applyWorkflowUpgrade("acme/app", plan, "commit");

        expect(result).toMatchObject({ status: "blocked", reason: "missing-workflow-scope" });
        expect(h.pulls).toEqual([]);
    });

    it("opens a pull request and blocks the deployment until it merges", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE });
        const plan = await planWorkflowUpgrade("acme/app", [AZURE]);

        const result = await applyWorkflowUpgrade("acme/app", plan, "pull-request");

        expect(result).toMatchObject({
            status: "blocked",
            reason: "pull-request-open",
            url: "https://github.com/acme/app/pull/7",
        });
        expect(h.branchRefs).toHaveLength(1);
        expect(h.branchRefs[0].branch).toMatch(/^radius\/upgrade-workflows-\d+$/);
        expect(h.branchRefs[0].fromSha).toBe(h.heads.main);
        expect(h.pulls[0].base).toBe("main");
        expect(h.commits.every((c) => c.branch !== "main")).toBe(true);
    });

    it("blocks with no commits when the branch cannot be created", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE });
        const plan = await planWorkflowUpgrade("acme/app", [AZURE]);
        h.branchRefError = "HTTP 403: Resource not accessible by integration";

        const result = await applyWorkflowUpgrade("acme/app", plan, "pull-request");

        expect(result).toMatchObject({ status: "blocked", reason: "no-permission" });
        expect(result.detail).toContain("403");
        expect(h.commits).toEqual([]);
        expect(h.pulls).toEqual([]);
    });

    it("blocks when the pull request cannot be opened", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE });
        const plan = await planWorkflowUpgrade("acme/app", [AZURE]);
        h.pullError = "HTTP 403: pull request creation is not allowed";

        const result = await applyWorkflowUpgrade("acme/app", plan, "pull-request");

        expect(result).toMatchObject({ status: "blocked", reason: "no-permission" });
    });

    // The plan the user approved is the plan that gets applied — never a
    // repository state they never saw.
    it("refuses a plan whose branch has moved since it was shown", async () => {
        seed("main", { [AZURE_PATH]: STALE_AZURE });
        const plan = await planWorkflowUpgrade("acme/app", [AZURE]);
        h.heads.main = "9999999999999999999999999999999999999999";

        const result = await applyWorkflowUpgrade("acme/app", plan, "commit");

        expect(result.status).toBe("stale-plan");
        expect(h.commits).toEqual([]);
    });

    it("does nothing for a plan that needs no work", async () => {
        const result = await applyWorkflowUpgrade("acme/app", { status: "current", files: [] }, "commit");

        expect(result.status).toBe("updated");
        expect(h.commits).toEqual([]);
    });
});
