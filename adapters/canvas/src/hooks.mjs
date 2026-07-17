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

// Shared instruction lines for the two handoff prompts below. The radius-app-bicep
// skill owns the full authoring workflow (namespaces, types, structure, and
// committing + pushing the file), so these hooks only point the agent at that
// skill and state the graph's data source. They never restate the skill's steps,
// so they cannot drift from it or short-circuit it (for example, stopping at a
// local save before the push).
const SKILL_HANDOFF =
    "Author the application model with the radius-app-bicep skill by calling the radius_generate_app tool, and follow that skill through to the end; it commits and pushes .radius/app.bicep, setting the upstream when the branch has none.";
const GRAPH_SOURCE_NOTE =
    "The application graph reads .radius/app.bicep from the pushed branch on the remote, so the file must be committed and pushed; a local save is not enough.";
const RECIPE_PACK_NOTE =
    "Do not fabricate singleton recipes for custom types; recipes are supplied by recipe packs registered on the environment at deploy time.";

// Instruction fed back to the agent (as additionalContext) when a graph tool is
// denied because app.bicep is missing. It must steer the agent to the skill and
// to push the file, never to fabricate a graph or singleton recipes.
export function appBicepReminder(repo) {
    const where = repo ? ` for ${repo}` : "";
    return [
        `No .radius/app.bicep exists${where}, so the application graph cannot be generated yet.`,
        "",
        `Create it now before retrying. ${SKILL_HANDOFF}`,
        GRAPH_SOURCE_NOTE,
        "After the push succeeds, retry the original action.",
        "",
        RECIPE_PACK_NOTE,
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
    const repo = targets.repo || state?.contextRepo || "";
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

// Prompt injected as a new user turn (via session.send) when a Radius graph
// canvas is opened but no .radius/app.bicep exists on the branch. Because it is
// surfaced as a visible turn, keep it free of internal tool mechanics and
// agent-only meta-instructions; it points the agent at the skill and states the
// graph's data source, nothing more.
export function appBicepHandoffPrompt(repo, page = "graph") {
    const where = repo ? ` for ${repo}` : "";
    return [
        `The Radius ${page} view${where} can't render yet because its application model hasn't been generated. Generate it now, then open the ${page} view again.`,
        "",
        SKILL_HANDOFF,
        GRAPH_SOURCE_NOTE,
        `Once the push succeeds, open the Radius ${page} view again so it loads the pushed model.`,
        "",
        RECIPE_PACK_NOTE,
    ].join("\n");
}
