import {
  proveGitHubEnvironmentCreated,
  type GitHubEnvironmentCreationProof
} from "./github-environment-provenance.js";
import { providerMutationRecord } from "../../operations.js";
import { executeRecoverableMutation } from "./provider-mutation-recovery.js";

export interface GitHubEnvironmentCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface GitHubEnvironmentReadResult {
  ok: boolean;
  status?: number | null;
  json?: unknown;
  stderr?: string;
}

export interface EnsuredGitHubEnvironment {
  name: string;
  state: "created" | "created_candidate" | "reused";
  creationEvidence?: {
    putResponseBody: string;
    putStartedAtMs: number;
  };
  // Recovery establishes ownership from the mutation journal, so it reports a
  // settled proof instead of raw evidence the caller would have to re-derive.
  creationProof?: GitHubEnvironmentCreationProof;
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
    (artifact.state !== "created" &&
      artifact.state !== "created_candidate" &&
      artifact.state !== "reused")
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
  mutationRecovery?: {
    operation: object & { operationId: string };
    persist(): Promise<void>;
  };
  now?: () => number;
}): Promise<EnsuredGitHubEnvironment> {
  const path =
    `/repos/${input.repo}/environments/` +
    encodeURIComponent(input.requestedName);
  const lookup = await input.readGitHubJson(path);
  const mutationKind = "github_environment.put";
  const mutationTarget = `${input.repo}:${input.requestedName}`;
  const pendingMutation =
    input.mutationRecovery ?
      providerMutationRecord(
        input.mutationRecovery.operation,
        mutationKind,
        mutationTarget
      )
    : null;
  if (lookup.ok) {
    const name = parseEnvironmentName(lookup.json);
    if (!name) {
      throw new GitHubEnvironmentEnsureError(
        `GitHub did not report the canonical name for environment "${input.requestedName}".`,
        "github-environment-name-missing"
      );
    }
    if (!pendingMutation) return { name, state: "reused" };
    if (pendingMutation.status === "confirmed") {
      return {
        name,
        state: "created_candidate",
        creationProof: { proven: true, detail: null }
      };
    }
    if (pendingMutation.status === "not_applied") {
      return { name, state: "reused" };
    }
    if (pendingMutation.status === "manual_required") {
      throw new GitHubEnvironmentEnsureError(
        pendingMutation.evidence ||
          `Radius cannot prove who created GitHub environment "${input.repo}:${name}".`,
        "provider-mutation-manual-required"
      );
    }
  }
  if (!lookup.ok && lookup.status !== 404) {
    const detail = lookup.stderr?.trim() || "The GitHub API lookup failed.";
    throw new GitHubEnvironmentEnsureError(
      `Could not resolve GitHub environment "${input.requestedName}". ${detail}`,
      "github-environment-lookup-failed"
    );
  }

  const repository =
    lookup.ok ?
      { ok: true }
    : await input.readGitHubJson(`/repos/${input.repo}`);
  if (!repository.ok) {
    const detail =
      repository.stderr?.trim() ||
      "The repository is missing or inaccessible to the selected GitHub account.";
    throw new GitHubEnvironmentEnsureError(
      `Could not confirm repository "${input.repo}" before creating GitHub environment "${input.requestedName}". ${detail}`,
      "github-environment-repository-unavailable"
    );
  }

  const putStartedAtMs =
    pendingMutation ?
      Date.parse(pendingMutation.preparedAt)
    : (input.now?.() ?? Date.now());
  const mutationArgs = ["api", "--method", "PUT", path];
  let created: GitHubEnvironmentCommandResult;
  if (input.mutationRecovery) {
    const recovered =
      await executeRecoverableMutation<GitHubEnvironmentCommandResult>({
        operation: input.mutationRecovery.operation,
        kind: mutationKind,
        target: mutationTarget,
        persist: input.mutationRecovery.persist,
        mutate: () => input.runGh(mutationArgs),
        accept: (result) => result,
        reconcile: async () => {
          const reread = await input.readGitHubJson(path);
          if (!reread.ok) {
            if (reread.status === 404) {
              return {
                state: "not_applied" as const,
                evidence: "GitHub confirmed the environment is absent."
              };
            }
            throw new Error(
              reread.stderr || "GitHub environment state could not be read."
            );
          }
          const canonical = parseEnvironmentName(reread.json);
          if (!canonical) {
            return {
              state: "manual_required" as const,
              guidance:
                `GitHub reports an environment at "${mutationTarget}", but not its canonical identity. ` +
                "Radius left it in place and will not retry or delete it."
            };
          }
          const proof = proveGitHubEnvironmentCreated({
            preflight: "created_candidate",
            putResponseBody: JSON.stringify(reread.json),
            putStartedAtMs
          });
          if (!proof.proven) {
            return {
              state: "manual_required" as const,
              guidance:
                `GitHub environment "${input.repo}:${canonical}" exists after the interrupted request, ` +
                "but GitHub did not provide enough creation provenance to prove this operation owns it. " +
                "Radius left it unchanged and will not retry or delete it."
            };
          }
          return {
            state: "applied" as const,
            value: {
              code: 0,
              stdout: JSON.stringify(reread.json),
              stderr: ""
            },
            evidence:
              "The exact environment identity and creation timestamp matched the interrupted operation."
          };
        }
      });
    if (recovered.state === "not_applied") {
      const detail =
        recovered.result ?
          responseDetail(recovered.result)
        : "GitHub confirmed that the environment was not created.";
      throw new GitHubEnvironmentEnsureError(
        `Failed to create GitHub environment "${input.requestedName}". ${detail}`,
        "github-environment-create-failed"
      );
    }
    created = recovered.value;
  } else {
    created = await input.runGh(mutationArgs);
  }
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
  return {
    name,
    state: "created_candidate",
    creationEvidence: {
      putResponseBody: created.stdout,
      putStartedAtMs
    }
  };
}
