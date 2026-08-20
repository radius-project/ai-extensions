import { errorMessage } from "./util.js";

const GRAPH_DIFF_MARKER = "## 📊 Application Graph Diff";
const PROOF_LIMIT = 20;

interface ToolUseInput {
  toolName?: unknown;
  toolArgs?: unknown;
  workingDirectory?: unknown;
}

interface PostToolUseInput extends ToolUseInput {
  toolResult?: unknown;
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

interface PostToolUseGuidance {
  additionalContext: string;
}

interface GraphDiffProof extends PullRequestIdentity {
  markdown: string;
}

export interface PullRequestGraphDiffGuard {
  activateAtSessionStart(workingDirectory: unknown): Promise<boolean>;
  onPreToolUse(input: ToolUseInput): Promise<DeniedToolUse | undefined>;
  onPostToolUse(
    input: PostToolUseInput
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

function isRadiusToolUse(toolName: unknown, toolArgs: unknown): boolean {
  if (typeof toolName !== "string") return false;
  if (toolName.startsWith("radius_")) return true;
  if (toolName !== "open_canvas") return false;
  return record(toolArgs).canvasId === "radius";
}

function proofKey(identity: PullRequestIdentity): string {
  return `${identity.repo}\n${identity.baseBranch}\n${identity.headBranch}`;
}

function toolResultText(toolResult: unknown): string {
  if (typeof toolResult === "string") return toolResult;
  return rawString(record(toolResult).textResultForLlm);
}

function graphDiffProof(input: PostToolUseInput): GraphDiffProof | null {
  if (input.toolName !== "radius_generate_pr_diff_markdown") return null;
  const args = record(input.toolArgs);
  const markdown = toolResultText(input.toolResult);
  if (!markdown.startsWith(GRAPH_DIFF_MARKER)) return null;
  const repo = firstString(args, ["repo", "repo_full_name", "repository"]);
  const baseBranch = firstString(args, ["baseBranch", "base_branch", "base"]);
  const headBranch = firstString(args, ["headBranch", "head_branch", "head"]);
  if (!repo || !baseBranch || !headBranch) return null;
  return { repo, baseBranch, headBranch, markdown };
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
  let lastWorkingDirectory = "";
  const proofs = new Map<string, GraphDiffProof>();
  const pendingPullRequests = new Set<string>();
  const defaultBranches = new Map<string, string>();

  function workingDirectory(input: ToolUseInput): string {
    const current = optionalString(input.workingDirectory);
    if (current) lastWorkingDirectory = current;
    return current || lastWorkingDirectory;
  }

  async function modelExists(input: ToolUseInput): Promise<boolean> {
    const workspacePath = workingDirectory(input);
    if (!workspacePath) return active;
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
    lastWorkingDirectory = workspacePath;
    active = await deps.hasRadiusApplicationModel(workspacePath);
    return active;
  }

  async function onPreToolUse(
    input: ToolUseInput
  ): Promise<DeniedToolUse | undefined> {
    if (!isPullRequestCreationTool(input.toolName)) return undefined;

    let modeled: boolean;
    try {
      modeled = await modelExists(input);
    } catch (error) {
      if (!active) return undefined;
      return {
        permissionDecision: "deny",
        permissionDecisionReason:
          "Radius could not verify the application model before pull request creation.",
        additionalContext: `The pull request was paused because Radius could not verify the current application model: ${errorMessage(error)}. Resolve the model check failure, then retry the pull request.`
      };
    }
    active = modeled;
    if (!active) return undefined;

    let identity: PullRequestIdentity | null;
    try {
      identity = await resolvePullRequestIdentity(input.toolArgs);
    } catch (error) {
      return {
        permissionDecision: "deny",
        permissionDecisionReason:
          "Radius could not resolve the repository and branches for the application graph diff.",
        additionalContext: `The pull request was paused because Radius could not resolve its repository and branch pair: ${errorMessage(error)}. Resolve the repository context, then retry the pull request.`
      };
    }
    if (!identity) {
      return {
        permissionDecision: "deny",
        permissionDecisionReason:
          "Radius requires the repository, base branch, and head branch before pull request creation.",
        additionalContext:
          "The pull request was paused because Radius could not determine the repository, base branch, and head branch needed for the application graph diff. Restore repository and default-branch access, then retry the pull request."
      };
    }

    const key = proofKey(identity);
    const proof = proofs.get(key);
    if (!proof) {
      return {
        permissionDecision: "deny",
        permissionDecisionReason:
          "Radius requires an application graph diff before pull request creation.",
        additionalContext: `Before retrying this pull request, call radius_generate_pr_diff_markdown with repo \`${identity.repo}\`, baseBranch \`${identity.baseBranch}\`, and headBranch \`${identity.headBranch}\`. Put the returned markdown at the TOP of the pull request body.`
      };
    }

    const body = rawString(record(input.toolArgs).body);
    if (!body.startsWith(proof.markdown)) {
      return {
        permissionDecision: "deny",
        permissionDecisionReason:
          "The pull request body does not start with the generated Radius application graph diff.",
        additionalContext:
          "Put the exact markdown returned by radius_generate_pr_diff_markdown at the TOP of the pull request body, before any other content, then retry."
      };
    }

    rememberBoundedSet(pendingPullRequests, key);
    return undefined;
  }

  async function onPostToolUse(
    input: PostToolUseInput
  ): Promise<PostToolUseGuidance | undefined> {
    const proof = graphDiffProof(input);
    if (proof) {
      active = true;
      rememberBounded(proofs, proofKey(proof), proof);
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
      proofs.delete(key);
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
        active = await modelExists(input);
      } catch (error) {
        return {
          additionalContext: `Radius could not verify whether this explicit Radius operation activated the current session: ${errorMessage(error)}. The operation completed, but automatic application graph diffs will remain inactive until the model can be verified.`
        };
      }
    }
    return undefined;
  }

  return { activateAtSessionStart, onPreToolUse, onPostToolUse };
}
