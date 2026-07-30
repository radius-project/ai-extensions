import { describe, it, expect, beforeEach, vi } from "vitest";
import { REPO_RADIUS_PINSET, comparePins } from "@radius-project/core";

// Shared mock state for the ./gh.mjs stub. `vi.hoisted` runs before the module
// factory below so the mock can close over it. `committed` is keyed by branch:
// `{ [branch]: { [path]: body } }`, mirroring that each branch has its own copy
// of the committed workflow files (and an unpushed branch has none).
const h = vi.hoisted(() => ({
    committed: {}, // branch -> { path -> committed body } (absent = file missing)
    commits: [], // recorded commitFileToRepo calls
    upstream: {
        // Minimal stand-ins for radius-project/radius/.github/extension templates.
        "verify-azure.yml": "name: verify\njobs:\n  v:\n    default: '{{ENV}}'\n    run: echo ${{ vars.AZURE_CLIENT_ID }}\n",
        "verify-aws.yml": "name: verify\njobs:\n  v:\n    default: '{{ENV}}'\n    run: echo ${{ vars.AWS_ROLE_ARN }}\n",
        "run-rad-commands.yml": "name: deploy\non:\n  workflow_dispatch:\n    inputs:\n      environment:\n        default: '{{ENV}}'\njobs:\n  detect:\n    run: echo hi\n",
        "run-rad-commands-azure.yml": "name: deploy-azure\nenv:\n  APP_FILE: '{{APP_FILE}}'\njobs:\n  a:\n    uses: radius-project/radius/.github/extension/actions/run-rad-commands@{{RADIUS_REF}}\n",
        "delete-application.yml": "name: delete\non:\n  workflow_dispatch:\n    inputs:\n      environment:\n        default: '{{ENV}}'\njobs:\n  detect:\n    run: echo hi\n",
        "delete-azure.yml": "name: delete-azure\njobs:\n  a:\n    uses: radius-project/radius/.github/extension/actions/delete-resource@{{RADIUS_REF}}\n",
    },
}));

vi.mock("./gh.mjs", () => ({
    cliExec: () => {},
    fetchFileFromRepoResult: async (_repo, path) => {
        const file = path.split("/").pop();
        const body = h.upstream[file];
        return body == null ? { content: null, error: `no template ${file}` } : { content: body, error: null };
    },
    getDefaultBranch: async () => "main",
    fetchFileFromRepo: async (_repo, path, branch = "main") => {
        const files = h.committed[branch];
        return files && path in files ? files[path] : null;
    },
    commitFileToRepo: async (_repo, path, content, branch, message) => {
        h.commits.push({ path, content, branch, message });
        (h.committed[branch] ||= {})[path] = content;
        return true;
    },
}));

const { syncRepoWorkflows, generateVerifyWorkflow, generateDeployWorkflow, generateDeleteWorkflow } =
    await import("./infra.mjs");

const VERIFY_PATH = ".github/workflows/radius-verify-credentials.yml";

// Build the full expected committed-file map the extension would produce for one
// environment, so tests can seed an "in sync" branch.
async function expectedFilesFor(env, provider) {
    const files = {};
    files[VERIFY_PATH] = await generateVerifyWorkflow(env, provider);
    for (const [name, body] of Object.entries(await generateDeployWorkflow(env, ".radius/app.bicep"))) {
        files[`.github/workflows/${name}`] = body;
    }
    for (const [name, body] of Object.entries(await generateDeleteWorkflow(env))) {
        files[`.github/workflows/${name}`] = body;
    }
    return files;
}

const STALE_AZURE_VERIFY = "name: verify\njobs:\n  v:\n    run: echo STALE ${{ vars.AZURE_CLIENT_ID }}\n";
const STALE_AWS_VERIFY = "name: verify\njobs:\n  v:\n    run: echo STALE ${{ vars.AWS_ROLE_ARN }}\n";

describe("syncRepoWorkflows", () => {
    beforeEach(() => {
        h.committed = {};
        h.commits = [];
    });

    it("no-ops when there are no managed environments", async () => {
        const res = await syncRepoWorkflows("acme/app", []);
        expect(res.skipped).toBe(true);
        expect(h.commits).toEqual([]);
    });

    it("reports nothing when every committed file already matches upstream", async () => {
        h.committed.main = await expectedFilesFor("dev", "azure");
        const res = await syncRepoWorkflows("acme/app", [{ name: "dev", provider: "azure" }]);
        expect(res.drifted).toEqual([]);
        expect(h.commits).toEqual([]);
    });

    // The guarantee this whole pass rests on: rewriting a user's workflows
    // changes what runs with their cloud credentials, so detection must never
    // turn into a write. Upgrades go through the confirmed workflow-pins path.
    it("reports a drifted file without committing anything", async () => {
        h.committed.main = await expectedFilesFor("dev", "azure");
        h.committed.main[VERIFY_PATH] = STALE_AZURE_VERIFY;
        const res = await syncRepoWorkflows("acme/app", [{ name: "dev", provider: "azure" }]);
        expect(res.drifted).toEqual([VERIFY_PATH]);
        expect(h.commits).toEqual([]);
    });

    it("skips files the extension never committed (missing on the repo)", async () => {
        // Repo has none of the workflow files yet.
        const res = await syncRepoWorkflows("acme/app", [{ name: "dev", provider: "azure" }]);
        expect(res.drifted).toEqual([]);
        expect(h.commits).toEqual([]);
    });

    it("treats a file matching ANY managed environment as in sync (no ping-pong)", async () => {
        // File carries the second environment's baked-in default; still in sync.
        h.committed.main = { [VERIFY_PATH]: await generateVerifyWorkflow("prod", "azure") };
        const res = await syncRepoWorkflows("acme/app", [
            { name: "dev", provider: "azure" },
            { name: "prod", provider: "azure" },
        ]);
        expect(res.drifted).toEqual([]);
        expect(h.commits).toEqual([]);
    });

    it("keeps an AWS verify file in sync when the env provider is unknown", async () => {
        // server.mjs passes provider "" when it can't infer one. A committed AWS
        // verify file that already matches upstream must NOT be reported as
        // drifted — the unknown provider generates BOTH candidates.
        h.committed.main = { [VERIFY_PATH]: await generateVerifyWorkflow("dev", "aws") };
        const res = await syncRepoWorkflows("acme/app", [{ name: "dev", provider: "" }]);
        expect(res.drifted).toEqual([]);
        expect(h.commits).toEqual([]);
    });

    it("reports a drifted AWS verify file when the provider is unknown", async () => {
        h.committed.main = { [VERIFY_PATH]: STALE_AWS_VERIFY };
        const res = await syncRepoWorkflows("acme/app", [{ name: "dev", provider: "" }]);
        expect(res.drifted).toEqual([VERIFY_PATH]);
        expect(h.commits).toEqual([]);
    });

    it("also checks the working branch", async () => {
        h.committed.main = await expectedFilesFor("dev", "azure");
        h.committed.feature = await expectedFilesFor("dev", "azure");
        h.committed.feature[VERIFY_PATH] = STALE_AZURE_VERIFY;

        const res = await syncRepoWorkflows("acme/app", [{ name: "dev", provider: "azure" }], {
            workingBranch: "feature",
        });

        expect(res.branches).toEqual(["main", "feature"]);
        expect(res.drifted).toEqual([VERIFY_PATH]);
    });

    it("de-duplicates a path that drifted on both branches", async () => {
        h.committed.main = await expectedFilesFor("dev", "azure");
        h.committed.feature = await expectedFilesFor("dev", "azure");
        h.committed.main[VERIFY_PATH] = STALE_AZURE_VERIFY;
        h.committed.feature[VERIFY_PATH] = STALE_AZURE_VERIFY;

        const res = await syncRepoWorkflows("acme/app", [{ name: "dev", provider: "azure" }], {
            workingBranch: "feature",
        });

        expect(res.drifted).toEqual([VERIFY_PATH]);
    });

    it("does not scan the same branch twice when the working branch IS the default", async () => {
        h.committed.main = await expectedFilesFor("dev", "azure");
        h.committed.main[VERIFY_PATH] = STALE_AZURE_VERIFY;
        const res = await syncRepoWorkflows("acme/app", [{ name: "dev", provider: "azure" }], {
            workingBranch: "main",
        });
        expect(res.branches).toEqual(["main"]);
        expect(res.drifted).toEqual([VERIFY_PATH]);
    });

    it("silently skips an unpushed working branch (no committed files to read)", async () => {
        h.committed.main = await expectedFilesFor("dev", "azure"); // in sync
        // No `h.committed.feature` at all — branch not pushed, files unreadable.
        const res = await syncRepoWorkflows("acme/app", [{ name: "dev", provider: "azure" }], {
            workingBranch: "feature",
        });
        expect(res.drifted).toEqual([]);
        expect(h.commits).toEqual([]);
    });

    it("with `only`, checks just the targeted workflow files and ignores drift in others", async () => {
        // Both the delete workflow and the verify workflow have drifted, but a
        // delete-scoped pass should only look at the delete files.
        h.committed.main = await expectedFilesFor("dev", "azure");
        h.committed.main[VERIFY_PATH] = STALE_AZURE_VERIFY;
        h.committed.main[".github/workflows/delete-application.yml"] = "name: stale-delete\n";

        const res = await syncRepoWorkflows("acme/app", [{ name: "dev", provider: "azure" }], {
            only: ["delete-application.yml", "delete-azure.yml"],
        });

        expect(res.drifted).toEqual([".github/workflows/delete-application.yml"]);
    });

    it("accepts full paths in `only` and matches on the bare filename", async () => {
        h.committed.main = await expectedFilesFor("dev", "azure");
        h.committed.main[".github/workflows/run-rad-commands.yml"] = "name: stale-deploy\n";

        const res = await syncRepoWorkflows("acme/app", [{ name: "dev", provider: "azure" }], {
            only: [".github/workflows/run-rad-commands.yml", ".github/workflows/run-rad-commands-azure.yml"],
        });

        expect(res.drifted).toEqual([".github/workflows/run-rad-commands.yml"]);
    });
});

describe("workflow generation pins action refs", () => {
    it("rewrites every governed `uses:` to the pinned commit SHA", async () => {
        const files = await generateDeployWorkflow("dev", ".radius/app.bicep");
        const azure = files["run-rad-commands-azure.yml"];

        expect(azure).toContain(
            `uses: radius-project/radius/.github/extension/actions/run-rad-commands@${REPO_RADIUS_PINSET.templateSource.sha}`,
        );
        expect(azure).not.toContain("@{{RADIUS_REF}}");
        expect(azure).not.toMatch(/uses: radius-project\/radius\S*@main\b/);
    });

    it("leaves nothing for the pin check to do", async () => {
        const files = {
            ".github/workflows/run-rad-commands-azure.yml": (
                await generateDeployWorkflow("dev", ".radius/app.bicep")
            )["run-rad-commands-azure.yml"],
            ".github/workflows/delete-azure.yml": (await generateDeleteWorkflow("dev"))["delete-azure.yml"],
        };

        expect(comparePins(files, REPO_RADIUS_PINSET).status).toBe("current");
    });
});
