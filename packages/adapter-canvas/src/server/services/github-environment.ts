export interface GitHubEnvironmentCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

export interface EnsuredGitHubEnvironment {
  name: string;
  state: "created_candidate" | "reused";
}

export interface GitHubEnvironmentCreatedCandidate {
  repo: string;
  name: string;
}

export interface GitHubEnvironmentResolutionRecord {
  environment?: unknown;
  context?: Record<string, unknown>;
  setupArtifacts?: {
    githubEnvironment?: {
      state?: unknown;
      repo?: unknown;
      name?: unknown;
    };
  };
}

export class GitHubEnvironmentEnsureError extends Error {
  readonly code: string;
  readonly createdCandidate: GitHubEnvironmentCreatedCandidate | null;

  constructor(
    message: string,
    code: string,
    createdCandidate: GitHubEnvironmentCreatedCandidate | null = null
  ) {
    super(message);
    this.name = "GitHubEnvironmentEnsureError";
    this.code = code;
    this.createdCandidate = createdCandidate;
  }
}

function succeeded(result: GitHubEnvironmentCommandResult): boolean {
  return result.code === 0 || result.code === "0";
}

function isNotFound(result: GitHubEnvironmentCommandResult): boolean {
  return /\bHTTP\s+404\b/i.test(`${result.stderr}\n${result.stdout}`);
}

function responseDetail(result: GitHubEnvironmentCommandResult): string {
  return (result.stderr || result.stdout || "").trim();
}

function parseEnvironmentName(
  result: GitHubEnvironmentCommandResult
): string | null {
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "name" in parsed &&
      typeof parsed.name === "string" &&
      parsed.name.trim()
    ) {
      return parsed.name.trim();
    }
  } catch {
    return null;
  }
  return null;
}

export function readEnsuredGitHubEnvironment(
  operation: GitHubEnvironmentResolutionRecord,
  repo: string,
  environment: string
): EnsuredGitHubEnvironment | null {
  const canonical = operation.context?.canonicalEnvironment;
  const requested = operation.context?.requestedEnvironment;
  const artifact = operation.setupArtifacts?.githubEnvironment;
  if (
    typeof canonical !== "string" ||
    !canonical ||
    typeof requested !== "string" ||
    !requested ||
    operation.environment !== requested ||
    environment !== canonical ||
    artifact?.repo !== repo ||
    artifact.name !== canonical ||
    (artifact.state !== "created_candidate" && artifact.state !== "reused")
  ) {
    return null;
  }
  return { name: canonical, state: artifact.state };
}

export async function ensureGitHubEnvironment(input: {
  repo: string;
  requestedName: string;
  runGh(args: string[]): Promise<GitHubEnvironmentCommandResult>;
}): Promise<EnsuredGitHubEnvironment> {
  const path =
    `/repos/${input.repo}/environments/` +
    encodeURIComponent(input.requestedName);
  const lookup = await input.runGh(["api", path]);
  if (succeeded(lookup)) {
    const name = parseEnvironmentName(lookup);
    if (!name) {
      throw new GitHubEnvironmentEnsureError(
        `GitHub did not report the canonical name for environment "${input.requestedName}".`,
        "github-environment-name-missing"
      );
    }
    return { name, state: "reused" };
  }
  if (!isNotFound(lookup)) {
    const detail = responseDetail(lookup) || "The GitHub API lookup failed.";
    throw new GitHubEnvironmentEnsureError(
      `Could not resolve GitHub environment "${input.requestedName}". ${detail}`,
      "github-environment-lookup-failed"
    );
  }

  const created = await input.runGh(["api", "--method", "PUT", path]);
  if (!succeeded(created)) {
    const detail = responseDetail(created) || "The GitHub API request failed.";
    throw new GitHubEnvironmentEnsureError(
      `Failed to create GitHub environment "${input.requestedName}". ${detail}`,
      "github-environment-create-failed"
    );
  }
  const createdCandidate = {
    repo: input.repo,
    name: input.requestedName
  };
  const name = parseEnvironmentName(created);
  if (!name) {
    throw new GitHubEnvironmentEnsureError(
      `GitHub created environment "${input.requestedName}" but did not report its canonical name. The environment was left in place because Radius cannot prove this request created it.`,
      "github-environment-name-missing",
      createdCandidate
    );
  }
  return { name, state: "created_candidate" };
}
