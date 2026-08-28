import { errorMessage } from "./util.js";
import {
  graphDiffOutcome,
  graphDiffResultText,
  type PullRequestGraphDiffOutcome
} from "./pr-graph-diff-result.js";

const PROOF_LIMIT = 20;

interface ToolUseInput {
  toolName?: unknown;
  toolArgs?: unknown;
  workingDirectory?: unknown;
}

interface PostToolUseInput extends ToolUseInput {
  toolResult?: unknown;
}

interface PostToolUseFailureInput extends ToolUseInput {
  error?: unknown;
}

interface PullRequestIdentity {
  repo: string;
  baseBranch: string;
  headBranch: string;
}

interface PullRequestGraphDiffGuardDependencies {
  hasRadiusApplicationModel(workspacePath: string): Promise<boolean>;
  workspaceContext(): Promise<{ repo: string; branch: string }>;
  getDefaultBranch(repo: string): Promise<string>;
  openGraphDiff(identity: PullRequestIdentity): Promise<unknown>;
}

interface DeniedToolUse {
  permissionDecision: "deny";
  permissionDecisionReason: string;
  additionalContext: string;
}

interface ToolUseGuidance {
  permissionDecision?: undefined;
  permissionDecisionReason?: undefined;
  additionalContext: string;
}

interface PostToolUseGuidance {
  additionalContext: string;
}

interface GraphDiffAttempt extends PullRequestIdentity {
  outcome: PullRequestGraphDiffOutcome | "failure";
  text: string;
}

export interface PullRequestGraphDiffGuard {
  activateAtSessionStart(workingDirectory: unknown): Promise<boolean>;
  onPreToolUse(
    input: ToolUseInput
  ): Promise<DeniedToolUse | ToolUseGuidance | undefined>;
  onPostToolUse(
    input: PostToolUseInput
  ): Promise<PostToolUseGuidance | undefined>;
  onPostToolUseFailure(
    input: PostToolUseFailureInput
  ): Promise<PostToolUseGuidance | undefined>;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rawString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstString(
  input: Record<string, unknown>,
  names: readonly string[]
): string {
  for (const name of names) {
    const value = optionalString(input[name]);
    if (value) return value;
  }
  return "";
}

function isPullRequestCreationTool(toolName: unknown): boolean {
  if (typeof toolName !== "string") return false;
  const normalized = toolName.toLowerCase().replaceAll(/[.:/-]+/g, "_");
  return (
    normalized === "create_pull_request" ||
    normalized.endsWith("_create_pull_request")
  );
}

function isGraphDiffTool(toolName: unknown): boolean {
  return toolName === "radius_generate_pr_diff_markdown";
}

function isRadiusToolUse(toolName: unknown, toolArgs: unknown): boolean {
  if (typeof toolName !== "string") return false;
  if (toolName.startsWith("radius_")) return true;
  if (toolName !== "open_canvas") return false;
  return record(toolArgs).canvasId === "radius";
}

function proofKey(identity: PullRequestIdentity): string {
  return `${identity.repo}\n${identity.baseBranch}\n${identity.headBranch}`;
}

function graphDiffIdentity(toolArgs: unknown): PullRequestIdentity | null {
  const args = record(toolArgs);
  const repo = firstString(args, ["repo", "repo_full_name", "repository"]);
  const baseBranch = firstString(args, ["baseBranch", "base_branch", "base"]);
  const headBranch = firstString(args, ["headBranch", "head_branch", "head"]);
  if (!repo || !baseBranch || !headBranch) return null;
  return { repo, baseBranch, headBranch };
}

function graphDiffAttempt(input: PostToolUseInput): GraphDiffAttempt | null {
  if (!isGraphDiffTool(input.toolName)) return null;
  const identity = graphDiffIdentity(input.toolArgs);
  const outcome = graphDiffOutcome(input.toolResult);
  if (!identity || !outcome) return null;
  return {
    ...identity,
    outcome,
    text: graphDiffResultText(input.toolResult)
  };
}

function unavailableGuidance(reason: string): ToolUseGuidance {
  return {
    additionalContext: `Create the pull request without a graph diff section. Do not add an explanation about the missing graph to the pull request body. Report this reason in chat instead, and do not open the graph-diff Canvas: ${reason}`
  };
}

function failedGraphDiffAttempt(
  toolArgs: unknown,
  reason: string
): GraphDiffAttempt | null {
  const identity = graphDiffIdentity(toolArgs);
  if (!identity) return null;
  return { ...identity, outcome: "failure", text: reason };
}

function rememberBounded<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size <= PROOF_LIMIT) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

function rememberBoundedSet(set: Set<string>, key: string): void {
  set.delete(key);
  set.add(key);
  if (set.size <= PROOF_LIMIT) return;
  const oldest = set.values().next().value;
  if (oldest !== undefined) set.delete(oldest);
}

export function createPullRequestGraphDiffGuard(
  deps: PullRequestGraphDiffGuardDependencies
): PullRequestGraphDiffGuard {
  let active = false;
  const attempts = new Map<string, GraphDiffAttempt>();
  const requestedDiffs = new Set<string>();
  const pendingPullRequests = new Set<string>();
  const defaultBranches = new Map<string, string>();

  async function modelExists(input: ToolUseInput): Promise<boolean | null> {
    const workspacePath = optionalString(input.workingDirectory);
    if (!workspacePath) return null;
    return deps.hasRadiusApplicationModel(workspacePath);
  }

  async function resolvePullRequestIdentity(
    toolArgs: unknown
  ): Promise<PullRequestIdentity | null> {
    const args = record(toolArgs);
    const workspace = await deps.workspaceContext();
    const repo =
      firstString(args, ["repo", "repo_full_name", "repository"]) ||
      workspace.repo;
    const headBranch =
      firstString(args, ["headBranch", "head_branch", "head"]) ||
      workspace.branch;
    let baseBranch = firstString(args, ["baseBranch", "base_branch", "base"]);
    if (!baseBranch && repo) {
      baseBranch = defaultBranches.get(repo) || "";
      if (!baseBranch) {
        baseBranch = await deps.getDefaultBranch(repo);
        if (baseBranch) defaultBranches.set(repo, baseBranch);
      }
    }
    if (!repo || !baseBranch || !headBranch) return null;
    return { repo, baseBranch, headBranch };
  }

  async function activateAtSessionStart(
    workingDirectoryInput: unknown
  ): Promise<boolean> {
    const workspacePath = optionalString(workingDirectoryInput);
    if (!workspacePath) return false;
    active = await deps.hasRadiusApplicationModel(workspacePath);
    return active;
  }

  async function onPreToolUse(
    input: ToolUseInput
  ): Promise<DeniedToolUse | ToolUseGuidance | undefined> {
    if (isGraphDiffTool(input.toolName)) {
      const identity = graphDiffIdentity(input.toolArgs);
      if (identity) rememberBoundedSet(requestedDiffs, proofKey(identity));
      return undefined;
    }

    // This hook can enforce known PR tools. Shell commands such as
    // `gh pr create` are opaque to extensions and require a host-level PR hook.
    if (!isPullRequestCreationTool(input.toolName)) return undefined;

    let modeled: boolean | null;
    try {
      modeled = await modelExists(input);
    } catch (error) {
      if (!active) return undefined;
      return unavailableGuidance(
        `Radius could not verify the current application model: ${errorMessage(error)}`
      );
    }
    if (modeled === null) return undefined;
    active = modeled;
    if (!active) return undefined;

    let identity: PullRequestIdentity | null;
    try {
      identity = await resolvePullRequestIdentity(input.toolArgs);
    } catch (error) {
      return unavailableGuidance(
        `Radius could not resolve the repository and branches: ${errorMessage(error)}`
      );
    }
    if (!identity) {
      return unavailableGuidance(
        "Radius could not determine the repository, base branch, and head branch."
      );
    }

    const key = proofKey(identity);
    const attempt = attempts.get(key);
    if (!attempt) {
      if (requestedDiffs.has(key)) {
        return unavailableGuidance(
          "The graph-diff tool did not produce an observable result. It may have been rejected, denied, or timed out."
        );
      }
      return {
        permissionDecision: "deny",
        permissionDecisionReason:
          "Radius requires an application graph diff before pull request creation.",
        additionalContext: `Before retrying this pull request, call radius_generate_pr_diff_markdown with repo \`${identity.repo}\`, baseBranch \`${identity.baseBranch}\`, and headBranch \`${identity.headBranch}\`. Put the returned markdown at the TOP of the pull request body.`
      };
    }
    if (attempt.outcome !== "diff") {
      return unavailableGuidance(attempt.text);
    }

    const body = rawString(record(input.toolArgs).body);
    if (!body.startsWith(attempt.text)) {
      return {
        permissionDecision: "deny",
        permissionDecisionReason:
          "The pull request body does not start with the generated Radius application graph diff.",
        additionalContext:
          "Put the byte-exact markdown returned by radius_generate_pr_diff_markdown at the TOP of the pull request body, before the repository template or any summary text. The generated section was changed or is not first; restore it, then retry."
      };
    }

    rememberBoundedSet(pendingPullRequests, key);
    return undefined;
  }

  async function onPostToolUse(
    input: PostToolUseInput
  ): Promise<PostToolUseGuidance | undefined> {
    const attempt = graphDiffAttempt(input);
    if (attempt) {
      active = true;
      rememberBounded(attempts, proofKey(attempt), attempt);
      requestedDiffs.delete(proofKey(attempt));
      return undefined;
    }

    if (isPullRequestCreationTool(input.toolName)) {
      if (!active) return undefined;
      let identity: PullRequestIdentity | null;
      try {
        identity = await resolvePullRequestIdentity(input.toolArgs);
      } catch (error) {
        return {
          additionalContext: `The pull request was created, but Radius could not resolve the repository and branches needed to open the interactive graph diff: ${errorMessage(error)}. Open the Radius Canvas manually on the graph-diff page with instanceId \`radius-panel\`.`
        };
      }
      if (!identity) return undefined;
      const key = proofKey(identity);
      if (!pendingPullRequests.delete(key)) return undefined;
      attempts.delete(key);
      requestedDiffs.delete(key);
      try {
        await deps.openGraphDiff(identity);
        return undefined;
      } catch (error) {
        return {
          additionalContext: `The pull request was created, but Radius could not open the interactive graph diff: ${errorMessage(error)}. Open the Radius Canvas with canvasId \`radius\`, instanceId \`radius-panel\`, page \`graph-diff\`, repo \`${identity.repo}\`, baseBranch \`${identity.baseBranch}\`, and headBranch \`${identity.headBranch}\`.`
        };
      }
    }

    if (isRadiusToolUse(input.toolName, input.toolArgs)) {
      try {
        const modeled = await modelExists(input);
        if (modeled !== null) active = modeled;
      } catch (error) {
        return {
          additionalContext: `Radius could not verify whether this explicit Radius operation activated the current session: ${errorMessage(error)}. The operation completed, but automatic application graph diffs will remain inactive until the model can be verified.`
        };
      }
    }
    return undefined;
  }

  async function onPostToolUseFailure(
    input: PostToolUseFailureInput
  ): Promise<PostToolUseGuidance | undefined> {
    if (!isGraphDiffTool(input.toolName)) return undefined;
    const attempt = failedGraphDiffAttempt(
      input.toolArgs,
      optionalString(input.error) || "The graph-diff tool failed."
    );
    if (attempt) {
      active = true;
      rememberBounded(attempts, proofKey(attempt), attempt);
      requestedDiffs.delete(proofKey(attempt));
    }
    return undefined;
  }

  return {
    activateAtSessionStart,
    onPreToolUse,
    onPostToolUse,
    onPostToolUseFailure
  };
}
