// Handoff prompts for authoring and refreshing .radius/app.bicep.
//
// With the recipe-pack refactor, .radius/app.bicep is authored exclusively by
// the radius-app-bicep skill (the agent) — this adapter never fabricates bicep.
// But the application-graph views require that file to exist AND to still
// describe the branch it sits on. This module owns the wording used to ask the
// agent for that work.
//
// It no longer owns the decision. A pre-tool-use hook used to intercept opening
// a graph canvas page and deny the call until a model existed, alongside a
// canvas-open fallback and the graph HTTP routes, so one missing model could
// produce several authoring turns. The routes are the single owner now (see
// runtime/app-model-handoff.ts); this module is prompts only.
//
// Kept as a pure module (no SDK imports, no top-level joinSession) so the
// wording can be unit-tested in isolation from extension.ts.

// Page the canvas lands on when a caller opens it without naming one. Owned here
// so the page vocabulary lives in one pure module.
export const DEFAULT_CANVAS_PAGE = "graph";

import {
  fenceDeployDiagnostic,
  DEPLOY_DIAGNOSTIC_NOTE
} from "../deploy-diagnostics.js";
import {
  infrastructureFailureSummaryList,
  modelFailureSummaryList
} from "../model-failure-policy.js";
import { freshnessIdentity } from "@radius-project/core";
import { RADIUS_CANVAS_INSTANCE_ID } from "./declarations.js";
import type { AppModelStatus } from "./graph-context.js";

interface DeployRepairDetails {
  error?: string;
  deployRunUrl?: string;
  attemptId?: string;
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

// A handoff occupies the user lane, and the host cannot start a user turn while
// one is already running, so a handoff raised by a render that happened inside
// an agent turn is queued and delivered after that turn ends. By then the model
// may already exist — most often because the same agent turn generated it — and
// the classification the prompt was written from is stale. Restate the missing
// model as evidence rather than fact and make the work conditional on a
// re-check, so a queued handoff cannot redo generation and overwrite a model
// that was just written.
function staleHandoffGuard(
  page: string,
  branches: ReadonlyArray<string | undefined>,
  canvasInstanceId: string,
  rendersInPlace: boolean
): string {
  const phrase = branchPhrase(branches);
  const onPhrase = phrase ? ` on ${phrase}` : " on the selected branch";
  return [
    `This handoff may have queued behind another turn. Recheck .radius/app.bicep${onPhrase} before acting.`,
    rendersInPlace ?
      `If it exists, do not regenerate it; the view at instanceId \`${canvasInstanceId}\` picks it up automatically.`
    : `If it exists, do not regenerate it; reopen the ${page} view so it loads.`,
    "Generate only while the model is still missing."
  ].join(" ");
}

// Branch-aware guidance on where the app.bicep must live for the graph to
// render. Explains the two cases: the selected branch is the current
// workspace branch (write to the working tree, no push needed) vs. a
// different branch (model that branch's code, commit + push there, prefer a
// PR, never silently push to a protected branch like main).
function graphSourceNote(
  page: string,
  repo: string,
  branches: ReadonlyArray<string | undefined>,
  canvasInstanceId: string,
  // False for a view that keeps polling while it waits, so telling the agent to
  // reopen it would be wrong: the model appearing is enough.
  reopenAfterModel = true
): string {
  const phrase = branchPhrase(branches);
  const where = repo ? ` for ${repo}` : "";
  const onPhrase = phrase ? ` on ${phrase}` : "";
  return [
    `To render the ${page} view${where}${onPhrase}, .radius/app.bicep must exist on that branch.`,
    "If the selected branch is your current workspace branch, writing it to the working tree is enough (the graph renders from the on-disk tree; modeling does not push).",
    "The selected branch name is immutable for this request. If the host renames the worktree branch before you edit files, publish the completed model to the originally selected branch before reopening the view.",
    "If the selected branch is a DIFFERENT branch, model it against that branch's code and commit + push .radius/app.bicep to that branch — prefer opening a pull request into it, and do not push generated files directly to a protected branch such as main without the user's confirmation.",
    reopenAfterModel ?
      `Once the model is available on that branch, reopen the view with instanceId \`${canvasInstanceId}\`; never create another Radius canvas instance. Reopening that exact instance refreshes its server and client connections. Nodes then deep-link to https://github.com/<owner>/<repo>/blob/<branch>/<file>.`
    : `Once the model is available on that branch, the view at instanceId \`${canvasInstanceId}\` detects it automatically; never create another Radius canvas instance. Nodes then deep-link to https://github.com/<owner>/<repo>/blob/<branch>/<file>.`
  ].join(" ");
}

// Identifies one staleness signal: the same branch, classification, and evidence
// describe the same request to regenerate. A regeneration changes the evidence,
// so genuinely new drift produces a new key. freshnessIdentity supplies the
// evidence half, including the part that keeps an unrecorded model that is safe
// to replace from being confused with one that is not.
export function refreshRequestKey(status: AppModelStatus): string {
  return [
    status.repo,
    status.branch,
    status.freshness.status,
    freshnessIdentity(status.freshness)
  ].join("::");
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
  branches: Array<string | undefined> = [],
  canvasInstanceId = RADIUS_CANVAS_INSTANCE_ID
): string {
  const where = repo ? ` for ${repo}` : "";
  const phrase = branchPhrase(branches);
  const onPhrase = phrase ? ` (${phrase})` : "";
  const rendersInPlace = page === "graph";
  return [
    rendersInPlace ?
      `The Radius ${page} view${where}${onPhrase} could not render because its application model had not been generated when the view loaded. Generate it if it is still missing, and keep the current view open.`
    : `The Radius ${page} view${where}${onPhrase} could not render because its application model had not been generated when the view loaded. Generate it if it is still missing, then open the ${page} view again.`,
    "",
    staleHandoffGuard(page, branches, canvasInstanceId, rendersInPlace),
    "",
    SKILL_HANDOFF,
    graphSourceNote(page, repo, branches, canvasInstanceId, !rendersInPlace),
    rendersInPlace ?
      `Do not open another Radius canvas. The view at instanceId \`${canvasInstanceId}\` is already waiting and renders the model in place once it is available.`
    : `Once the model is available on the selected repo and branch, open the Radius ${page} view again so it loads.`,
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
  branches: Array<string | undefined> = [],
  canvasInstanceId = RADIUS_CANVAS_INSTANCE_ID
): HandoffMessage {
  return {
    prompt: appBicepHandoffPrompt(repo, page, branches, canvasInstanceId),
    displayPrompt: appBicepHandoffDisplayPrompt(repo, page, branches)
  };
}

// Prompt sent when a graph view rendered a model whose source has moved on, on
// a branch the skill can rewrite. The graph routes reconcile freshness on every
// render — tool-driven opens, direct panel opens, programmatic reloads after
// source refs are attached, and refreshes alike — so a stale model is never
// shown with no signal at all.
export function appModelRefreshPrompt(status: AppModelStatus): string {
  const where = status.repo ? ` for ${status.repo}` : "";
  return [
    `The Radius graph${where} on branch \`${status.branch}\` just rendered from an application model that needs to be regenerated.`,
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
  return `Regenerating the application model${where} (branch \`${status.branch}\`) before showing the graph.`;
}

export function appModelRefreshMessage(status: AppModelStatus): HandoffMessage {
  return {
    prompt: appModelRefreshPrompt(status),
    displayPrompt: appModelRefreshDisplayPrompt(status)
  };
}

// Prompt sent when a graph canvas renders a model that needs regenerating and
// whose content the refresh would take with it. Two cases reach here: a model
// edited after it was generated, and a model with no origin record that git
// cannot give back because it is untracked or already modified.
// The view is NOT blocked for these: the file on disk is what would deploy, so it
// is the honest thing to render. But regenerating would destroy content that
// exists nowhere else, so the refresh is offered rather than taken. A hand edit
// on a model that needs no refresh never reaches here, and a model with no record
// that IS committed and clean does not either: git has that one.
export function appModelUnverifiedPrompt(status: AppModelStatus): string {
  const where = status.repo ? ` for ${status.repo}` : "";
  return [
    `The Radius graph${where} rendered from the existing .radius/app.bicep on branch \`${status.branch}\`, but that model needs to be regenerated and doing so would discard content that exists nowhere else.`,
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
  return `Asking before regenerating the application model${where} (branch \`${status.branch}\`).`;
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
