import { describe, it, expect, vi } from "vitest";
import {
    GRAPH_PAGES,
    appBicepReminder,
    graphTriggerTargets,
    evaluateAppBicepHook,
} from "./hooks.mjs";

describe("GRAPH_PAGES", () => {
    it("covers the graph-generating canvas pages", () => {
        expect([...GRAPH_PAGES].sort()).toEqual(["graph", "graph-diff", "planned"]);
    });
});

describe("appBicepReminder", () => {
    it("names the file, the skill/tool, Radius namespaces, and the repo", () => {
        const msg = appBicepReminder("acme/widgets");
        expect(msg).toContain(".radius/app.bicep");
        expect(msg).toContain("radius-app-bicep");
        expect(msg).toContain("radius_generate_app");
        expect(msg).toContain("Radius.");
        expect(msg).toContain("acme/widgets");
        expect(msg).toContain("SAVE");
    });

    it("omits the repo suffix when repo is empty", () => {
        expect(appBicepReminder("")).toContain("No .radius/app.bicep exists,");
    });
});

describe("graphTriggerTargets", () => {
    it("returns null for a non-graph tool", () => {
        expect(graphTriggerTargets("some_other_tool", { repo: "a/b" })).toBeNull();
    });

    it("returns null for open_canvas on a non-radius canvas", () => {
        expect(graphTriggerTargets("open_canvas", { canvasId: "editor", input: { page: "graph" } })).toBeNull();
    });

    it("returns null for a radius canvas non-graph page", () => {
        expect(graphTriggerTargets("open_canvas", { canvasId: "radius", input: { page: "environment" } })).toBeNull();
    });

    it("returns repo + single branch for a graph page", () => {
        expect(
            graphTriggerTargets("open_canvas", { canvasId: "radius", input: { page: "graph", repo: "a/b", branch: "feat" } }),
        ).toEqual({ repo: "a/b", branches: ["feat"] });
    });

    it("returns [undefined] branch when a graph page omits the branch", () => {
        expect(
            graphTriggerTargets("open_canvas", { canvasId: "radius", input: { page: "planned", repo: "a/b" } }),
        ).toEqual({ repo: "a/b", branches: [undefined] });
    });

    it("returns both branches for a graph-diff page", () => {
        expect(
            graphTriggerTargets("open_canvas", {
                canvasId: "radius",
                input: { page: "graph-diff", repo: "a/b", baseBranch: "main", headBranch: "feat" },
            }),
        ).toEqual({ repo: "a/b", branches: ["main", "feat"] });
    });

    it("falls back to [undefined] when a graph-diff page omits both branches", () => {
        expect(
            graphTriggerTargets("open_canvas", { canvasId: "radius", input: { page: "graph-diff", repo: "a/b" } }),
        ).toEqual({ repo: "a/b", branches: [undefined] });
    });

    it("defaults repo to empty string when a graph-diff page omits repo", () => {
        expect(
            graphTriggerTargets("open_canvas", {
                canvasId: "radius",
                input: { page: "graph-diff", baseBranch: "main", headBranch: "feat" },
            }),
        ).toEqual({ repo: "", branches: ["main", "feat"] });
    });

    it("handles open_canvas with a missing input object", () => {
        expect(graphTriggerTargets("open_canvas", { canvasId: "radius" })).toBeNull();
    });

    it("maps radius_generate_pr_diff_markdown to its repo + branches", () => {
        expect(
            graphTriggerTargets("radius_generate_pr_diff_markdown", { repo: "a/b", baseBranch: "main", headBranch: "feat" }),
        ).toEqual({ repo: "a/b", branches: ["main", "feat"] });
    });

    it("falls back to [undefined] when the pr-diff tool omits branches", () => {
        expect(graphTriggerTargets("radius_generate_pr_diff_markdown", { repo: "a/b" })).toEqual({
            repo: "a/b",
            branches: [undefined],
        });
    });

    it("tolerates missing/invalid toolArgs", () => {
        expect(graphTriggerTargets("open_canvas", undefined)).toBeNull();
        expect(graphTriggerTargets("radius_generate_pr_diff_markdown", null)).toEqual({
            repo: "",
            branches: [undefined],
        });
    });
});

function makeDeps({ state = { workspaceRepo: "" }, fetchBicep = vi.fn(), defaultBranch = "main" } = {}) {
    return {
        workspaceState: vi.fn(async () => state),
        fetchBicep,
        defaultBranchForState: vi.fn(() => defaultBranch),
    };
}

describe("evaluateAppBicepHook", () => {
    it("allows (undefined) when the tool is not a graph trigger", async () => {
        const deps = makeDeps();
        const out = await evaluateAppBicepHook({ toolName: "other", toolArgs: {} }, deps);
        expect(out).toBeUndefined();
        expect(deps.workspaceState).not.toHaveBeenCalled();
    });

    it("fails open when no repo can be resolved", async () => {
        const deps = makeDeps({ state: { workspaceRepo: "" }, fetchBicep: vi.fn(async () => "x") });
        const out = await evaluateAppBicepHook(
            { toolName: "open_canvas", toolArgs: { canvasId: "radius", input: { page: "graph" } } },
            deps,
        );
        expect(out).toBeUndefined();
        expect(deps.fetchBicep).not.toHaveBeenCalled();
    });

    it("falls back to the workspace repo when the tool arg omits it", async () => {
        const fetchBicep = vi.fn(async () => "content");
        const deps = makeDeps({ state: { workspaceRepo: "ws/repo" }, fetchBicep });
        const out = await evaluateAppBicepHook(
            { toolName: "open_canvas", toolArgs: { canvasId: "radius", input: { page: "graph", branch: "feat" } } },
            deps,
        );
        expect(out).toBeUndefined();
        expect(fetchBicep).toHaveBeenCalledWith("ws/repo", "feat", { workspaceRepo: "ws/repo" });
    });

    it("uses the default branch when the graph page omits the branch", async () => {
        const fetchBicep = vi.fn(async () => "content");
        const deps = makeDeps({ state: { workspaceRepo: "ws/repo" }, fetchBicep, defaultBranch: "trunk" });
        await evaluateAppBicepHook(
            { toolName: "open_canvas", toolArgs: { canvasId: "radius", input: { page: "graph", repo: "a/b" } } },
            deps,
        );
        expect(fetchBicep).toHaveBeenCalledWith("a/b", "trunk", { workspaceRepo: "ws/repo" });
    });

    it("allows when app.bicep exists on the branch", async () => {
        const deps = makeDeps({ state: { workspaceRepo: "a/b" }, fetchBicep: vi.fn(async () => "resource ...") });
        const out = await evaluateAppBicepHook(
            { toolName: "open_canvas", toolArgs: { canvasId: "radius", input: { page: "graph", repo: "a/b", branch: "feat" } } },
            deps,
        );
        expect(out).toBeUndefined();
    });

    it("denies with skill guidance when app.bicep is missing", async () => {
        const deps = makeDeps({ state: { workspaceRepo: "a/b" }, fetchBicep: vi.fn(async () => null) });
        const out = await evaluateAppBicepHook(
            { toolName: "open_canvas", toolArgs: { canvasId: "radius", input: { page: "graph", repo: "a/b", branch: "feat" } } },
            deps,
        );
        expect(out?.permissionDecision).toBe("deny");
        expect(out?.permissionDecisionReason).toContain("radius-app-bicep");
        expect(out?.additionalContext).toContain(".radius/app.bicep");
        expect(out?.additionalContext).toContain("a/b");
    });

    it("treats a fetch error as a missing file (deny)", async () => {
        const deps = makeDeps({
            state: { workspaceRepo: "a/b" },
            fetchBicep: vi.fn(async () => {
                throw new Error("boom");
            }),
        });
        const out = await evaluateAppBicepHook(
            { toolName: "open_canvas", toolArgs: { canvasId: "radius", input: { page: "graph", repo: "a/b", branch: "feat" } } },
            deps,
        );
        expect(out?.permissionDecision).toBe("deny");
    });

    it("allows a graph-diff when only one branch has app.bicep", async () => {
        const fetchBicep = vi.fn(async (_repo, branch) => (branch === "main" ? "content" : null));
        const deps = makeDeps({ state: { workspaceRepo: "a/b" }, fetchBicep });
        const out = await evaluateAppBicepHook(
            {
                toolName: "radius_generate_pr_diff_markdown",
                toolArgs: { repo: "a/b", baseBranch: "main", headBranch: "feat" },
            },
            deps,
        );
        expect(out).toBeUndefined();
    });

    it("denies a graph-diff when both branches are missing app.bicep", async () => {
        const deps = makeDeps({ state: { workspaceRepo: "a/b" }, fetchBicep: vi.fn(async () => null) });
        const out = await evaluateAppBicepHook(
            {
                toolName: "radius_generate_pr_diff_markdown",
                toolArgs: { repo: "a/b", baseBranch: "main", headBranch: "feat" },
            },
            deps,
        );
        expect(out?.permissionDecision).toBe("deny");
    });
});
