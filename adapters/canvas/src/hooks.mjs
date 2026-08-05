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

// Page the canvas lands on when a caller opens it without naming one. Owned here
// (next to GRAPH_PAGES) so the page vocabulary lives in one pure module and the
// hook below cannot drift from what the canvas actually renders.
export const DEFAULT_CANVAS_PAGE = "graph";

import { fenceDeployDiagnostic, DEPLOY_DIAGNOSTIC_NOTE } from "./deploy-diagnostics.mjs";

// Shared instruction lines for the two handoff prompts below. The radius-app-bicep
// skill owns the full authoring workflow (namespaces, types, structure, and
// writing the file to the working tree), so these hooks only point the agent at that
// skill and state the graph's data source. They never restate the skill's steps,
// so they cannot drift from it or short-circuit it (for example, stopping before
// the model is written).
const SKILL_HANDOFF =
    "Author the application model with the radius-app-bicep skill by calling the radius_generate_app tool, and follow that skill through to the end; it writes and stages .radius/app.bicep in the working tree.";
const RECIPE_PACK_NOTE =
    "Recipes are supplied by recipe packs, not by inline per-type recipes fabricated in app.bicep or in the graph. When no built-in type fits, the radius-app-bicep skill generates a custom resource type together with a recipe pack for it; follow the skill rather than inventing a singleton recipe here.";

// Turns a branches array (which may contain undefined/empty entries meaning
// "the default branch for the current state") into a human-readable phrase
// for the prompts below, e.g. "branch `main`" or "branches `main`, `feat`".
// Returns "" when there is nothing usable to name.
function branchPhrase(branches) {
    const names = (branches || []).filter(Boolean);
    if (!names.length) return "";
    const quoted = names.map((b) => `\`${b}\``);
    return names.length === 1 ? `branch ${quoted[0]}` : `branches ${quoted.join(", ")}`;
}

// Branch-aware guidance on where the app.bicep must live for the graph to
// render. Explains the two cases: the selected branch is the current
// workspace branch (write to the working tree, no push needed) vs. a
// different branch (model that branch's code, commit + push there, prefer a
// PR, never silently push to a protected branch like main).
function graphSourceNote(page, repo, branches) {
    const phrase = branchPhrase(branches);
    const where = repo ? ` for ${repo}` : "";
    const onPhrase = phrase ? ` on ${phrase}` : "";
    return [
        `To render the ${page} view${where}${onPhrase}, .radius/app.bicep must exist on that branch.`,
        "If the selected branch is your current workspace branch, writing it to the working tree is enough (the graph renders from the on-disk tree; modeling does not push).",
        "If the selected branch is a DIFFERENT branch, model it against that branch's code and commit + push .radius/app.bicep to that branch — prefer opening a pull request into it, and do not push generated files directly to a protected branch such as main without the user's confirmation.",
        "Once the file is committed on that branch, reopen the view; nodes then deep-link to https://github.com/<owner>/<repo>/blob/<branch>/<file>.",
    ].join(" ");
}

// Instruction fed back to the agent (as additionalContext) when a graph tool is
// denied because app.bicep is missing. It must steer the agent to the skill and
// to write the file, never to fabricate a graph or singleton recipes.
export function appBicepReminder(repo, branches = []) {
    const where = repo ? ` for ${repo}` : "";
    return [
        `No .radius/app.bicep exists${where}, so the application graph cannot be generated yet.`,
        "",
        `Create it now before retrying. ${SKILL_HANDOFF}`,
        graphSourceNote("graph", repo, branches),
        "After the file is written, retry the original action.",
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
        // A page-less open lands on the canvas's default page, so resolve it the
        // same way the canvas does before deciding whether this is a graph trigger.
        const page = input.page || DEFAULT_CANVAS_PAGE;
        if (!GRAPH_PAGES.has(page)) return null;
        if (page === "graph-diff") {
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
        additionalContext: appBicepReminder(repo, targets.branches),
    };
}

// Prompt injected as a new user turn (via session.send) when a Radius graph
// canvas is opened but no .radius/app.bicep exists on the branch. Because it is
// surfaced as a visible turn, keep it free of internal tool mechanics and
// agent-only meta-instructions; it points the agent at the skill and states the
// graph's data source, nothing more.
export function appBicepHandoffPrompt(repo, page = "graph", branches = []) {
    const where = repo ? ` for ${repo}` : "";
    const phrase = branchPhrase(branches);
    const onPhrase = phrase ? ` (${phrase})` : "";
    return [
        `The Radius ${page} view${where}${onPhrase} can't render yet because its application model hasn't been generated. Generate it now, then open the ${page} view again.`,
        "",
        SKILL_HANDOFF,
        graphSourceNote(page, repo, branches),
        `Once the model is available on the selected repo and branch, open the Radius ${page} view again so it loads.`,
        "",
        RECIPE_PACK_NOTE,
    ].join("\n");
}

// Maximum automatic repair-and-redeploy attempts before handing back to the user.
export const DEPLOY_REPAIR_ATTEMPT_CAP = 5;

export { DEPLOY_DIAGNOSTIC_CHAR_CAP as DEPLOY_ERROR_CHAR_CAP } from "./deploy-diagnostics.mjs";

// Prompt injected as a new user turn (via session.send) when a deploy started
// from the canvas Deploy button fails. That path dispatches the workflow
// directly, so nothing carries the failure back to the agent; this is the
// bridge. Deliberately self-contained — it names the tools that repair the model
// and redeploy, so the loop does not depend on another skill being consulted.
export function deployRepairHandoffPrompt(repo, branch, { error = "", deployRunUrl = "", attemptId = "" } = {}) {
    const where = repo ? ` of ${repo}` : "";
    const onPhrase = branch ? ` (branch \`${branch}\`)` : "";
    const fenced = fenceDeployDiagnostic(error);
    const branchName = branch ? `\`${branch}\`` : "the deployed branch";
    const lines = [
        `The Radius deploy${where}${onPhrase} failed. Diagnose it, and repair and redeploy if the app model caused it.`,
        "",
        fenced
            ? `${DEPLOY_DIAGNOSTIC_NOTE}\n\n${fenced}`
            : "The deploy workflow reported a failure with no error text.",
    ];
    if (deployRunUrl) lines.push("", `Workflow run (full logs): ${deployRunUrl}`);
    lines.push(
        "",
        "First decide what kind of failure this is:",
        "- A modeling or schema failure points at .radius/app.bicep — unknown resource type or API version, unknown or missing property, an invalid reference between resources, a wrong credential shape, or a Bicep parse or compile error. Repair these.",
        "- An infrastructure or environment failure (recipe download or execution, provider mismatch, cluster, credential, or connectivity problems) is not caused by the app model. Do not repair the model for these: report the failure and the workflow run URL to the user, and do not redeploy.",
        "",
        `For a modeling or schema failure: ${SKILL_HANDOFF}`,
        `Then commit the repaired .radius/app.bicep and push it to ${branchName} before redeploying. The deploy runs on GitHub Actions against that branch as it exists on GitHub, so a fix left only in the local worktree is not deployed — the workflow would check out and redeploy the unchanged file. If you cannot push to that branch (for example it is protected), stop and tell the user, or open a pull request; do not redeploy an unchanged branch.`,
        "Once the fix is pushed, redeploy by calling the radius_deploy tool, and poll the radius_deploy_status tool until the deploy reaches a terminal state.",
        attemptId
            ? `Pass attemptId "${attemptId}" to both tools. It identifies this deploy attempt, so the call is rejected rather than acting on a different deploy if the user starts another one. Do not pass repo, environment, branch, provider, or appFile: the attempt already fixes those.`
            : "",
        `Repeat that repair-and-redeploy cycle at most ${DEPLOY_REPAIR_ATTEMPT_CAP} times, stopping early once the deploy succeeds or there is no different fix left to try. After that, report the result to the user and only try again if they ask.`,
        "",
        RECIPE_PACK_NOTE,
    );
    return lines.filter((line, i) => line !== "" || lines[i - 1] !== "").join("\n");
}
