// hooks.mjs — pre-tool-use hook logic for auto-triggering app.bicep creation.
//
// With the recipe-pack refactor, .radius/app.bicep is authored exclusively by
// the radius-app-bicep skill (the agent) — this adapter never fabricates bicep.
// But the application-graph views require that file to exist. This module holds
// the decision logic for a pre-tool-use hook that intercepts the tool calls
// which generate a graph *from* app.bicep — opening a graph canvas page, or
// producing the PR graph diff markdown — and, when no app.bicep exists yet,
// denies the call and instructs the agent to run the radius-app-bicep skill to
// create and SAVE .radius/app.bicep first, then retry. The extension itself
// never writes bicep; it only triggers the skill.
//
// Kept as a pure module (no SDK imports, no top-level joinSession) so the hook
// decision can be unit-tested in isolation from extension.mjs.

// Canvas pages that render an application graph built from app.bicep.
export const GRAPH_PAGES = new Set(["graph", "planned", "graph-diff"]);

// Instruction fed back to the agent (as additionalContext) when a graph tool is
// denied because app.bicep is missing. It must steer the agent to the skill and
// to SAVE the file — never to fabricate a graph or singleton recipes.
export function appBicepReminder(repo) {
    const where = repo ? ` for ${repo}` : "";
    return [
        `No .radius/app.bicep exists${where}, so the application graph cannot be generated yet.`,
        "",
        "Create it now with the radius-app-bicep skill before retrying:",
        "1. Call the radius_generate_app tool (or follow the radius-app-bicep skill) to analyze the repository and author the model.",
        "2. Use ONLY Radius.* namespaces (e.g. Radius.Compute/containers, Radius.Data/mySqlDatabases, Radius.Security/secrets) — never Applications.*.",
        "3. SAVE the result to .radius/app.bicep in the repository (write the file to disk; commit it if the user wants it persisted).",
        "4. Then retry the original action — the graph renders from the saved app.bicep.",
        "",
        "Do not fabricate singleton recipes for custom types; recipes are supplied by recipe packs registered on the environment at deploy time.",
    ].join("\n");
}

// Given a tool call, return the { repo, branches } to check for app.bicep, or
// null when the tool is not a graph-generating trigger this hook governs.
// `branches` may contain a single `undefined` entry meaning "the default branch
// for the current workspace/state" (resolved by the caller via deps).
export function graphTriggerTargets(toolName, toolArgs) {
    const args = toolArgs && typeof toolArgs === "object" ? toolArgs : {};

    if (toolName === "open_canvas") {
        if (args.canvasId !== "radius") return null;
        const input = args.input && typeof args.input === "object" ? args.input : {};
        if (!GRAPH_PAGES.has(input.page)) return null;
        if (input.page === "graph-diff") {
            const branches = [input.baseBranch, input.headBranch].filter(Boolean);
            return { repo: input.repo || "", branches: branches.length ? branches : [undefined] };
        }
        return { repo: input.repo || "", branches: [input.branch] };
    }

    if (toolName === "radius_generate_pr_diff_markdown") {
        const branches = [args.baseBranch, args.headBranch].filter(Boolean);
        return { repo: args.repo || "", branches: branches.length ? branches : [undefined] };
    }

    return null;
}

// Core pre-tool-use decision. `deps` supplies the I/O so this stays pure:
//   deps.workspaceState(): Promise<state>        — current workspace/repo/branch
//   deps.fetchBicep(repo, branch, state): Promise<string|null>
//   deps.defaultBranchForState(state): string
//
// Returns a PreToolUseHookOutput ({ permissionDecision: "deny", ... }) when the
// graph trigger fires and no app.bicep is found on any target branch; otherwise
// returns undefined (allow). For multi-branch triggers (graph-diff) a graph can
// still render if only one side has bicep, so it denies only when ALL are empty.
export async function evaluateAppBicepHook(input, deps) {
    const targets = graphTriggerTargets(input?.toolName, input?.toolArgs);
    if (!targets) return undefined;

    const state = await deps.workspaceState();
    const repo = targets.repo || state?.workspaceRepo || "";
    if (!repo) return undefined; // no repo context to check against → fail open

    const found = await Promise.all(targets.branches.map(async (candidate) => {
        const branch = candidate || deps.defaultBranchForState(state);
        try {
            return !!(await deps.fetchBicep(repo, branch, state));
        } catch {
            return false;
        }
    }));

    if (found.some(Boolean)) return undefined; // at least one branch has it → allow

    return {
        permissionDecision: "deny",
        permissionDecisionReason:
            "No .radius/app.bicep found — it must be created and saved by the radius-app-bicep skill before the application graph can be generated.",
        additionalContext: appBicepReminder(repo),
    };
}
