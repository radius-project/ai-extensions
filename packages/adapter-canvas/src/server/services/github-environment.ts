export interface GitHubEnvironmentCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

// Result of deleting a GitHub Environment. `deleted` removed a live environment;
// `not_found` means it was already gone (idempotent success); `failed` records a
// best-effort warning without asserting anything was torn down.
//
// This delete primitive is deliberately shared: both the Delete Environment flow
// (PR #398) and Create-Environment rollback (separate PR) remove a GitHub
// environment with the identical idempotent contract. The design note
// `docs/design/2026-08-shared-cleanup-rollback-delete.md`
// (§ Compatibility → Rollback compatibility) calls this out as a primitive that
// must live in one place so the two flows never drift on how a "not found"
// result is classified or when the environment-list cache is invalidated. Each
// flow keeps its own decision layer (which environment, and whether it is
// allowed to delete it) and only calls this primitive to do the work.
export interface GitHubEnvDeletionOutcome {
  outcome: "deleted" | "not_found" | "failed";
  detail?: string;
}

// The narrow I/O the delete primitive needs, injected so it can be unit-tested
// with a deterministic fake and reused by any flow regardless of how that flow
// runs `gh` or holds the environment-list cache.
export interface GitHubEnvironmentDeletionPorts {
  // Run a `gh` command. Never throws; a spawn failure surfaces as a non-zero
  // `code` with `stderr`.
  runGh(args: string[]): Promise<{ code: number | string; stderr?: string }>;
  // Drop the cached environment list for the repo so the next listing reflects
  // the deletion. Called on every path that converges the environment to "gone"
  // (both `deleted` and `not_found`), never on a genuine failure.
  invalidateEnvListCache(repo: string): void;
}

// Delete the GitHub Environment. Idempotent: a 404 (already gone) is reported as
// `not_found`, not a failure, so a re-run after a partial deletion converges.
export async function deleteGitHubEnvironmentIdempotent(
  repo: string,
  environment: string,
  ports: GitHubEnvironmentDeletionPorts
): Promise<GitHubEnvDeletionOutcome> {
  const result = await ports.runGh([
    "api",
    "--method",
    "DELETE",
    "/repos/" + repo + "/environments/" + encodeURIComponent(environment)
  ]);
  if (result.code === 0 || result.code === "0") {
    ports.invalidateEnvListCache(repo);
    return { outcome: "deleted" };
  }
  if (/HTTP 404|not found/i.test(result.stderr || "")) {
    ports.invalidateEnvListCache(repo);
    return { outcome: "not_found" };
  }
  return {
    outcome: "failed",
    detail:
      (result.stderr || "").trim() || "Deleting the GitHub environment failed."
  };
}

export interface GitHubEnvironmentReadResult {
  ok: boolean;
  status?: number | null;
  json?: unknown;
  stderr?: string;
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

function responseDetail(result: GitHubEnvironmentCommandResult): string {
  return (result.stderr || result.stdout || "").trim();
}

function parseEnvironmentName(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    value.name.trim()
  ) {
    return value.name.trim();
  }
  return null;
}

function parseCommandEnvironmentName(
  result: GitHubEnvironmentCommandResult
): string | null {
  try {
    return parseEnvironmentName(JSON.parse(result.stdout));
  } catch {
    return null;
  }
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
  readGitHubJson(apiPath: string): Promise<GitHubEnvironmentReadResult>;
  runGh(args: string[]): Promise<GitHubEnvironmentCommandResult>;
}): Promise<EnsuredGitHubEnvironment> {
  const path =
    `/repos/${input.repo}/environments/` +
    encodeURIComponent(input.requestedName);
  const lookup = await input.readGitHubJson(path);
  if (lookup.ok) {
    const name = parseEnvironmentName(lookup.json);
    if (!name) {
      throw new GitHubEnvironmentEnsureError(
        `GitHub did not report the canonical name for environment "${input.requestedName}".`,
        "github-environment-name-missing"
      );
    }
    return { name, state: "reused" };
  }
  if (lookup.status !== 404) {
    const detail = lookup.stderr?.trim() || "The GitHub API lookup failed.";
    throw new GitHubEnvironmentEnsureError(
      `Could not resolve GitHub environment "${input.requestedName}". ${detail}`,
      "github-environment-lookup-failed"
    );
  }

  const repository = await input.readGitHubJson(`/repos/${input.repo}`);
  if (!repository.ok) {
    const detail =
      repository.stderr?.trim() ||
      "The repository is missing or inaccessible to the selected GitHub account.";
    throw new GitHubEnvironmentEnsureError(
      `Could not confirm repository "${input.repo}" before creating GitHub environment "${input.requestedName}". ${detail}`,
      "github-environment-repository-unavailable"
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
  const name = parseCommandEnvironmentName(created);
  if (!name) {
    throw new GitHubEnvironmentEnsureError(
      `GitHub created environment "${input.requestedName}" but did not report its canonical name. The environment was left in place because Radius cannot prove this request created it.`,
      "github-environment-name-missing",
      createdCandidate
    );
  }
  return { name, state: "created_candidate" };
}
