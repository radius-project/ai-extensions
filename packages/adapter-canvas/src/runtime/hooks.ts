// Pre-tool-use hook logic for auto-triggering app.bicep creation and refresh.
//
// With the recipe-pack refactor, .radius/app.bicep is authored exclusively by
// the radius-app-bicep skill (the agent) — this adapter never fabricates bicep.
// But the application-graph views require that file to exist AND to still
// describe the branch it sits on. This module holds the decision logic for a
// pre-tool-use hook that intercepts the tool calls which generate a graph *from*
// app.bicep (opening a graph canvas page, or producing the PR graph diff
// markdown) and denies the call when there is no app.bicep yet, or when the one
// on the workspace branch is stale, instructing the agent to run the
// radius-app-bicep skill to create/refresh and SAVE .radius/app.bicep first,
// then retry. The extension itself never writes bicep; it only triggers the
// skill.
//
// Kept as a pure module (no SDK imports, no top-level joinSession) so the hook
// decision can be unit-tested in isolation from extension.ts.

// Canvas pages that render an application graph built from app.bicep.
export const GRAPH_PAGES = new Set(["graph", "planned", "graph-diff"]);

// Page the canvas lands on when a caller opens it without naming one. Owned here
// (next to GRAPH_PAGES) so the page vocabulary lives in one pure module and the
// hook below cannot drift from what the canvas actually renders.
export const DEFAULT_CANVAS_PAGE = "graph";

import {
  fenceDeployDiagnostic,
  DEPLOY_DIAGNOSTIC_NOTE
} from "../deploy-diagnostics.js";
import {
  infrastructureFailureSummaryList,
  modelFailureSummaryList
} from "../model-failure-policy.js";
import {
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
  unsupportedAppSourceReport
} from "@radius-project/core";
import type { AppSourceEvaluation } from "@radius-project/core";
import type { AppModelStatus } from "./graph-context.js";
import type { CanvasState } from "../shared.js";

interface GraphTriggerTarget {
  repo: string;
  branches: Array<string | undefined>;
  // True for a trigger that compares two explicitly named committed branches
  // (graph-diff). Those branches mean exactly what they say. Every other graph
  // view renders the workspace repository from its checked-out worktree, so a
  // branch named alongside the workspace repo is not the branch that will be
  // rendered — see resolveTargetBranches.
  comparesCommittedBranches: boolean;
}

interface AppBicepHookInput {
  toolName?: unknown;
  toolArgs?: unknown;
}

interface AppBicepHookDependencies {
  workspaceState(): Promise<CanvasState>;
  defaultBranchForState(state: CanvasState): string;
  appModelStatus(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<AppModelStatus>;
  // What a branch's source listing says about whether the repository can be
  // modeled at all. Consulted only when no model exists, since a model that is
  // already there answers the question by existing.
  appSource(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<AppSourceEvaluation>;
  // True the first time this exact staleness evidence is seen, false afterwards.
  // Owned by the caller so the memo lives with the extension instance.
  shouldRequestRefresh(key: string): boolean;
}

export interface AppBicepHookOutput {
  permissionDecision: "deny";
  permissionDecisionReason: string;
  additionalContext: string;
}

interface DeployRepairDetails {
  error?: string;
  deployRunUrl?: string;
  attemptId?: string;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

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
function branchPhrase(branches: ReadonlyArray<string | undefined>): string {
  const names = branches.filter((branch): branch is string => Boolean(branch));
  if (!names.length) return "";
  const quoted = names.map((b) => `\`${b}\``);
  return names.length === 1 ?
      `branch ${quoted[0]}`
    : `branches ${quoted.join(", ")}`;
}

// Branch-aware guidance on where the app.bicep must live for the graph to
// render. Explains the two cases: the selected branch is the current
// workspace branch (write to the working tree, no push needed) vs. a
// different branch (model that branch's code, commit + push there, prefer a
// PR, never silently push to a protected branch like main).
function graphSourceNote(
  page: string,
  repo: string,
  branches: ReadonlyArray<string | undefined>
): string {
  const phrase = branchPhrase(branches);
  const where = repo ? ` for ${repo}` : "";
  const onPhrase = phrase ? ` on ${phrase}` : "";
  return [
    `To render the ${page} view${where}${onPhrase}, .radius/app.bicep must exist on that branch.`,
    "If the selected branch is your current workspace branch, writing it to the working tree is enough (the graph renders from the on-disk tree; modeling does not push).",
    "If the selected branch is a DIFFERENT branch, model it against that branch's code and commit + push .radius/app.bicep to that branch — prefer opening a pull request into it, and do not push generated files directly to a protected branch such as main without the user's confirmation.",
    "Once the file is committed on that branch, reopen the view; nodes then deep-link to https://github.com/<owner>/<repo>/blob/<branch>/<file>."
  ].join(" ");
}

// Instruction fed back to the agent (as additionalContext) when a graph tool is
// denied because app.bicep is missing. It must steer the agent to the skill and
// to write the file, never to fabricate a graph or singleton recipes.
export function appBicepReminder(
  repo: string,
  branches: Array<string | undefined> = []
): string {
  const where = repo ? ` for ${repo}` : "";
  return [
    `No .radius/app.bicep exists${where}, so the application graph cannot be generated yet.`,
    "",
    `Create it now before retrying. ${SKILL_HANDOFF}`,
    graphSourceNote("graph", repo, branches),
    "After the file is written, retry the original action.",
    "",
    RECIPE_PACK_NOTE
  ].join("\n");
}

// Given a tool call, return the { repo, branches } to check for app.bicep, or
// null when the tool is not a graph-generating trigger this hook governs.
// `branches` may contain a single `undefined` entry meaning "the default branch
// for the current workspace/state" (resolved by the caller via deps).
export function graphTriggerTargets(
  toolName: unknown,
  toolArgs: unknown
): GraphTriggerTarget | null {
  const args = record(toolArgs);

  if (toolName === "open_canvas") {
    if (args.canvasId !== "radius") return null;
    const input = record(args.input);
    // A page-less open lands on the canvas's default page, so resolve it the
    // same way the canvas does before deciding whether this is a graph trigger.
    const page = optionalString(input.page) || DEFAULT_CANVAS_PAGE;
    if (!GRAPH_PAGES.has(page)) return null;
    if (page === "graph-diff") {
      const branches = [
        optionalString(input.baseBranch),
        optionalString(input.headBranch)
      ].filter((branch): branch is string => Boolean(branch));
      return {
        repo: optionalString(input.repo) || "",
        branches: branches.length ? branches : [undefined],
        comparesCommittedBranches: true
      };
    }
    return {
      repo: optionalString(input.repo) || "",
      branches: [optionalString(input.branch)],
      comparesCommittedBranches: false
    };
  }

  if (toolName === "radius_generate_pr_diff_markdown") {
    const branches = [
      optionalString(args.baseBranch),
      optionalString(args.headBranch)
    ].filter((branch): branch is string => Boolean(branch));
    return {
      repo: optionalString(args.repo) || "",
      branches: branches.length ? branches : [undefined],
      comparesCommittedBranches: true
    };
  }

  return null;
}

// The branches this trigger will actually be judged against.
//
// The canvas ignores a caller-supplied branch for the workspace repository and
// renders the checked-out worktree instead (see createRadiusCanvas). This hook
// has to resolve the target the same way, or it decides against a branch the
// user will never see: asked for the workspace repo on `main` while a feature
// branch is checked out, it would read `main` from GitHub and could deny — or
// call the repository unsupported — on evidence from a branch the canvas was
// never going to render. A graph diff is the exception, since its two branches
// are explicitly named committed refs and mean exactly what they say.
function resolveTargetBranches(
  targets: GraphTriggerTarget,
  repo: string,
  state: CanvasState,
  defaultBranchForState: (state: CanvasState) => string
): string[] {
  const workspaceBranch = optionalString(state?.workspaceBranch);
  if (
    !targets.comparesCommittedBranches &&
    workspaceBranch &&
    repo === optionalString(state?.workspaceRepo)
  ) {
    return [workspaceBranch];
  }
  return targets.branches.map(
    (candidate) => candidate || defaultBranchForState(state)
  );
}

// Core pre-tool-use decision. `deps` supplies the I/O so this stays pure:
//   deps.workspaceState(): Promise<state>        — current workspace/repo/branch
//   deps.defaultBranchForState(state): string
//   deps.appModelStatus(repo, branch, state): Promise<AppModelStatus>
//
// Returns a PreToolUseHookOutput ({ permissionDecision: "deny", ... }) when the
// graph trigger fires and either no app.bicep exists on any target branch, or
// the one on the workspace branch is provably out of date. Otherwise returns
// undefined (allow). For multi-branch triggers (graph-diff) a graph can still
// render if only one side has bicep, so it denies only when ALL are empty.
//
// Two stale cases deliberately do NOT deny:
//   • A model on a branch that is not the workspace's. Refreshing it would need
//     a commit and a push, so blocking the view would strand the user with no
//     action the skill is allowed to take.
//   • A model whose content this extension cannot prove it generated (edited or
//     unrecorded). Overwriting it destroys the user's own work, so it needs their
//     agreement. The canvas raises that conversation while the graph renders,
//     rather than blocking the view on it here.
export async function evaluateAppBicepHook(
  input: AppBicepHookInput,
  deps: AppBicepHookDependencies
): Promise<AppBicepHookOutput | undefined> {
  const targets = graphTriggerTargets(input.toolName, input.toolArgs);
  if (!targets) return undefined;

  const state = await deps.workspaceState();
  const repo = targets.repo || state?.contextRepo || "";
  if (!repo) return undefined; // no repo context to check against → fail open

  const branches = resolveTargetBranches(
    targets,
    repo,
    state,
    deps.defaultBranchForState
  );

  const statuses = await Promise.all(
    branches.map(async (branch) => {
      try {
        return await deps.appModelStatus(repo, branch, state);
      } catch {
        return null;
      }
    })
  );

  const present = statuses.filter(
    (status): status is AppModelStatus =>
      !!status && status.freshness.status !== "missing"
  );

  if (!present.length) {
    // This is the path most users reach modeling through, so it is also where an
    // unmodelable repository has to be caught: telling the agent to create a
    // model it cannot create is what turned this exception into a late,
    // ambiguous failure. Only a branch whose listing was actually established
    // and actually lacks a Dockerfile counts, and every candidate branch has to
    // agree — one modelable branch means there is still real work to hand off.
    const sources = await Promise.all(
      branches.map(async (branch) => {
        try {
          return await deps.appSource(repo, branch, state);
        } catch {
          return null;
        }
      })
    );
    if (sources.every((source) => source?.status === "none")) {
      return {
        permissionDecision: "deny",
        // The reason is what the user is shown, so it carries only the
        // statement about their repository. The agent-facing half — what not to
        // author, and that nothing was written — belongs in additionalContext.
        permissionDecisionReason: UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
        additionalContext: unsupportedAppSourceReport(repo)
      };
    }
    return {
      permissionDecision: "deny",
      permissionDecisionReason:
        "No .radius/app.bicep found. It must be created and saved by the radius-app-bicep skill before the application graph can be generated.",
      additionalContext: appBicepReminder(repo, branches)
    };
  }

  const outdated = present.find(
    (status) =>
      status.refreshable &&
      status.freshness.stale &&
      !status.freshness.requiresConfirmation
  );
  if (!outdated) return undefined;

  // Ask for a refresh once per distinct staleness signal. A regeneration that
  // does not clear the drift (the branch head moves again when the refreshed
  // model is committed, say) would otherwise deny every later graph open, so
  // the second look at identical evidence renders the model instead of blocking
  // the user on a fix that already ran.
  if (!deps.shouldRequestRefresh(refreshRequestKey(outdated))) {
    return undefined;
  }

  return {
    permissionDecision: "deny",
    permissionDecisionReason: `The .radius/app.bicep on \`${outdated.branch}\` is out of date. It must be regenerated by the radius-app-bicep skill before the application graph can be trusted.`,
    additionalContext: appModelRefreshReminder(outdated)
  };
}

// Identifies one staleness signal: the same branch, classification, and recorded
// origin describe the same request to regenerate. A regeneration changes the
// record, so genuinely new drift produces a new key.
export function refreshRequestKey(status: AppModelStatus): string {
  const origin = status.freshness.origin;
  return [
    status.repo,
    status.branch,
    status.freshness.status,
    origin?.sourceCommit ?? "",
    origin?.skillVersion ?? ""
  ].join("::");
}

// Instruction fed back to the agent when a graph tool is denied because the
// model on the workspace branch no longer describes its source. Distinct from
// appBicepReminder: the file exists, so the agent must be told what changed and
// that the fix is a regeneration rather than a first-time authoring.
export function appModelRefreshReminder(status: AppModelStatus): string {
  const where = status.repo ? ` for ${status.repo}` : "";
  return [
    `The application model${where} on branch \`${status.branch}\` is out of date, so the application graph would not reflect the current source.`,
    "",
    status.freshness.reason,
    "",
    `Refresh it now before retrying. ${SKILL_HANDOFF}`,
    "Regenerate from the current source rather than editing the existing file: the model is stale as a whole, not broken in one place.",
    "The model is on your current workspace branch, so writing the working tree is enough. Do not commit or push it as part of the refresh.",
    "After the model is rewritten, retry the original action.",
    "",
    RECIPE_PACK_NOTE
  ].join("\n");
}

// The two halves of an automated handoff turn. `prompt` is what the agent
// receives and acts on; `displayPrompt` is what the chat timeline shows in its
// place (MessageOptions.displayPrompt). The turn still occupies the user lane —
// session.send is the only channel that can actually drive agent work, and
// session.log cannot — so the display half exists to keep a long, pre-written
// internal instruction from masquerading as something the user typed (#209).
export interface HandoffMessage {
  prompt: string;
  displayPrompt: string;
}

// Prompt sent to the agent when a Radius graph canvas is opened but no
// .radius/app.bicep exists on the branch. This half is agent-facing: it names
// the skill and the graph's data source so recovery needs no extra round trip.
// It is not what the timeline shows — always send it through
// appBicepHandoffMessage() so a display prompt travels with it.
export function appBicepHandoffPrompt(
  repo: string,
  page = "graph",
  branches: Array<string | undefined> = []
): string {
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
    RECIPE_PACK_NOTE
  ].join("\n");
}

// Timeline stand-in for appBicepHandoffPrompt. Names the same repo, view, and
// branch(es) the agent was pointed at — graph-diff spans two branches, and a
// user who cannot see which ones cannot tell what is being modeled or where a
// commit will land — but carries none of the internal tool/skill mechanics.
export function appBicepHandoffDisplayPrompt(
  repo: string,
  page = "graph",
  branches: ReadonlyArray<string | undefined> = []
): string {
  const where = repo ? ` for ${repo}` : "";
  const phrase = branchPhrase(branches);
  const onPhrase = phrase ? ` (${phrase})` : "";
  return `Generating the application model${where}${onPhrase} so the Radius ${page} view can render.`;
}

// Pairs the agent-facing prompt with its timeline stand-in. Callers send this
// object straight to session.send so the two halves cannot drift apart or be
// swapped.
export function appBicepHandoffMessage(
  repo: string,
  page = "graph",
  branches: Array<string | undefined> = []
): HandoffMessage {
  return {
    prompt: appBicepHandoffPrompt(repo, page, branches),
    displayPrompt: appBicepHandoffDisplayPrompt(repo, page, branches)
  };
}

// Prompt sent when a graph view rendered a model whose source has moved on, on
// a branch the skill can rewrite. The pre-tool-use hook normally catches this
// first and denies the open so the model is refreshed before anything renders.
// But the canvas also opens on paths the hook never sees (a programmatic reload
// after source refs are attached, or the user opening the panel), and on those
// the stale model would otherwise be shown with no signal at all.
export function appModelRefreshPrompt(status: AppModelStatus): string {
  const where = status.repo ? ` for ${status.repo}` : "";
  return [
    `The Radius graph${where} on branch \`${status.branch}\` just rendered from an application model that no longer describes the current source.`,
    "",
    status.freshness.reason,
    "",
    `Refresh it. ${SKILL_HANDOFF}`,
    "Regenerate from the current source rather than editing the existing file, and tell the user the graph they are looking at predates the refresh so they know to reopen it.",
    "The model is on the current workspace branch, so writing the working tree is enough. Do not commit or push it as part of the refresh.",
    "",
    RECIPE_PACK_NOTE
  ].join("\n");
}

// Timeline stand-in for appModelRefreshPrompt.
export function appModelRefreshDisplayPrompt(status: AppModelStatus): string {
  const where = status.repo ? ` for ${status.repo}` : "";
  return `Refreshing the application model${where} (branch \`${status.branch}\`), which no longer matches the current source.`;
}

export function appModelRefreshMessage(status: AppModelStatus): HandoffMessage {
  return {
    prompt: appModelRefreshPrompt(status),
    displayPrompt: appModelRefreshDisplayPrompt(status)
  };
}

// Prompt sent when a graph canvas renders a model this extension cannot prove it
// generated: hand-edited since generation, or carrying no usable origin record.
// The view is NOT blocked for these: the file on disk is what would deploy, so it
// is the honest thing to render. But regenerating would destroy content the user
// may have written deliberately, so the refresh is offered rather than taken.
export function appModelUnverifiedPrompt(status: AppModelStatus): string {
  const where = status.repo ? ` for ${status.repo}` : "";
  return [
    `The Radius graph${where} rendered from the existing .radius/app.bicep on branch \`${status.branch}\`, but that model could not be verified against the current source.`,
    "",
    status.freshness.reason,
    "",
    "Tell the user what this means for the graph they are looking at, and ask whether they want the model regenerated from current source.",
    "Regenerating overwrites .radius/app.bicep, so any changes they made by hand (tuned properties, custom types, recipe pack references) would be lost. Say that plainly and wait for their answer. Do not regenerate first and report afterwards.",
    `If they agree: ${SKILL_HANDOFF}`,
    "If they would rather keep their edits, leave the file alone. Repairing one specific problem in place is the alternative that preserves them.",
    "",
    RECIPE_PACK_NOTE
  ].join("\n");
}

// Timeline stand-in for appModelUnverifiedPrompt.
export function appModelUnverifiedDisplayPrompt(
  status: AppModelStatus
): string {
  const where = status.repo ? ` for ${status.repo}` : "";
  return `Checking whether the application model${where} (branch \`${status.branch}\`) still matches the current source.`;
}

export function appModelUnverifiedMessage(
  status: AppModelStatus
): HandoffMessage {
  return {
    prompt: appModelUnverifiedPrompt(status),
    displayPrompt: appModelUnverifiedDisplayPrompt(status)
  };
}

// Log line for a stale model on a branch that is not the workspace's. Modeling
// only writes the working tree, so there is no action to hand off here: the
// refresh would require committing and pushing to someone else's branch. State
// the drift so the graph is not read as current, and stop there.
export function appModelStaleNotice(status: AppModelStatus): string {
  const where = status.repo ? ` for ${status.repo}` : "";
  return `Radius: the application model${where} on branch \`${status.branch}\` may be out of date. ${status.freshness.reason} Refreshing it would require regenerating and pushing to that branch.`;
}

// Maximum automatic repair-and-redeploy attempts before handing back to the user.
export const DEPLOY_REPAIR_ATTEMPT_CAP = 5;

export { DEPLOY_DIAGNOSTIC_CHAR_CAP as DEPLOY_ERROR_CHAR_CAP } from "../deploy-diagnostics.js";

// Prompt sent to the agent when a deploy started from the canvas Deploy button
// fails. That path dispatches the workflow directly, so nothing carries the
// failure back to the agent; this is the bridge. Deliberately self-contained —
// it names the tools that repair the model and redeploy, so the loop does not
// depend on another skill being consulted. Agent-facing only: send it through
// deployRepairHandoffMessage() so a display prompt travels with it.
export function deployRepairHandoffPrompt(
  repo: string,
  branch: string,
  { error = "", deployRunUrl = "", attemptId = "" }: DeployRepairDetails = {}
): string {
  const where = repo ? ` of ${repo}` : "";
  const onPhrase = branch ? ` (branch \`${branch}\`)` : "";
  const fenced = fenceDeployDiagnostic(error);
  const branchName = branch ? `\`${branch}\`` : "the deployed branch";
  const lines = [
    `The Radius deploy${where}${onPhrase} failed. Diagnose it, and repair and redeploy if the app model caused it.`,
    "",
    fenced ?
      `${DEPLOY_DIAGNOSTIC_NOTE}\n\n${fenced}`
    : "The deploy workflow reported a failure with no error text."
  ];
  if (deployRunUrl) lines.push("", `Workflow run (full logs): ${deployRunUrl}`);
  lines.push(
    "",
    "First decide what kind of failure this is:",
    `- A modeling or schema failure points at .radius/app.bicep — ${modelFailureSummaryList()}. Repair these.`,
    `- An infrastructure or environment failure (${infrastructureFailureSummaryList()}) is not caused by the app model. Do not repair the model for these: report the failure and the workflow run URL to the user, and do not redeploy.`,
    "",
    `For a modeling or schema failure: ${SKILL_HANDOFF}`,
    `Then commit the repaired .radius/app.bicep and push it to ${branchName} before redeploying. The deploy runs on GitHub Actions against that branch as it exists on GitHub, so a fix left only in the local worktree is not deployed — the workflow would check out and redeploy the unchanged file. If you cannot push to that branch (for example it is protected), stop and tell the user, or open a pull request; do not redeploy an unchanged branch.`,
    "Once the fix is pushed, redeploy by calling the radius_deploy tool, and poll the radius_deploy_status tool until the deploy reaches a terminal state.",
    attemptId ?
      `Pass attemptId "${attemptId}" to both tools. It identifies this deploy attempt, so the call is rejected rather than acting on a different deploy if the user starts another one. Do not pass repo, environment, branch, provider, or appFile: the attempt already fixes those.`
    : "",
    `Repeat that repair-and-redeploy cycle at most ${DEPLOY_REPAIR_ATTEMPT_CAP} times, stopping early once the deploy succeeds or there is no different fix left to try. The canvas enforces that limit and refuses a further redeploy on this attempt, and each radius_deploy call reports which attempt it is. After that, report the result to the user and only try again if they ask.`,
    "",
    RECIPE_PACK_NOTE
  );
  return lines
    .filter((line, i) => line !== "" || lines[i - 1] !== "")
    .join("\n");
}

// Timeline stand-in for deployRepairHandoffPrompt. States what is happening and
// to which repo/branch, without the diagnostic dump, tool names, or the repair
// decision tree the agent needs.
export function deployRepairHandoffDisplayPrompt(
  repo: string,
  branch: string
): string {
  const where = repo ? ` of ${repo}` : "";
  const onPhrase = branch ? ` (branch \`${branch}\`)` : "";
  return `Diagnosing the failed Radius deploy${where}${onPhrase} and repairing it if the app model caused it.`;
}

// Pairs the agent-facing prompt with its timeline stand-in, so the two halves
// cannot drift apart or be swapped at the call site.
export function deployRepairHandoffMessage(
  repo: string,
  branch: string,
  details: DeployRepairDetails = {}
): HandoffMessage {
  return {
    prompt: deployRepairHandoffPrompt(repo, branch, details),
    displayPrompt: deployRepairHandoffDisplayPrompt(repo, branch)
  };
}

interface DeployFailureNoticeDetails {
  error?: string;
  deployRunUrl?: string;
}

// Prompt sent to the agent when a canvas deploy failed WITHOUT confirming what
// happened to its workflow run (no run surfaced after dispatch, monitoring timed
// out, the monitor crashed, or the dispatch itself was rejected). Unlike the
// repair handoff, this must NOT drive an automatic repair-and-redeploy: a run may
// still be in flight, so redeploying could start a second run against the same
// target. The agent's job here is only to relay the failure to the user. Kept
// self-contained and agent-facing; send it through deployFailureNoticeMessage()
// so a display prompt travels with it.
export function deployFailureNoticePrompt(
  repo: string,
  branch: string,
  { error = "", deployRunUrl = "" }: DeployFailureNoticeDetails = {}
): string {
  const where = repo ? ` of ${repo}` : "";
  const onPhrase = branch ? ` (branch \`${branch}\`)` : "";
  const fenced = fenceDeployDiagnostic(error);
  const lines = [
    `The Radius deploy${where}${onPhrase} failed, and its workflow run could not be confirmed. Report this to the user; do not automatically redeploy.`,
    "",
    fenced ?
      `${DEPLOY_DIAGNOSTIC_NOTE}\n\n${fenced}`
    : "The deploy failed before a workflow run could be confirmed, and no error text was captured."
  ];
  if (deployRunUrl) lines.push("", `Workflow run (full logs): ${deployRunUrl}`);
  lines.push(
    "",
    "A workflow run may or may not still be in progress, so do NOT call radius_deploy to retry this on the agent's own initiative: a second run could race the first against the same target. Instead:",
    deployRunUrl ?
      `- Tell the user the deploy failed and point them at the run: ${deployRunUrl}. Ask them to check the Actions tab for its real outcome.`
    : "- Tell the user the deploy failed to start (for example a missing `workflow` token scope, disabled Actions, or an unpushed branch) and ask them to check the repository's Actions tab.",
    "- Only deploy again if the user explicitly asks, and start a fresh deploy from the canvas or with radius_deploy (no attemptId) once the previous run is known to be over."
  );
  return lines
    .filter((line, i) => line !== "" || lines[i - 1] !== "")
    .join("\n");
}

// Timeline stand-in for deployFailureNoticePrompt: names the repo/branch and
// that the failure is being reported, without the diagnostic dump or guidance.
export function deployFailureNoticeDisplayPrompt(
  repo: string,
  branch: string
): string {
  const where = repo ? ` of ${repo}` : "";
  const onPhrase = branch ? ` (branch \`${branch}\`)` : "";
  return `Reporting the failed Radius deploy${where}${onPhrase} (its workflow run could not be confirmed).`;
}

// Pairs the agent-facing notice with its timeline stand-in so the two halves
// cannot drift apart or be swapped at the call site.
export function deployFailureNoticeMessage(
  repo: string,
  branch: string,
  details: DeployFailureNoticeDetails = {}
): HandoffMessage {
  return {
    prompt: deployFailureNoticePrompt(repo, branch, details),
    displayPrompt: deployFailureNoticeDisplayPrompt(repo, branch)
  };
}
