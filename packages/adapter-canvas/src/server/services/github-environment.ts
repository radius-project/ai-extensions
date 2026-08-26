import {
  proveGitHubEnvironmentCreated,
  type GitHubEnvironmentCreationProof
} from "./github-environment-provenance.js";
import { providerMutationRecord } from "../../operations.js";
import {
  executeRecoverableMutation,
  providerMutationWillWrite
} from "./provider-mutation-recovery.js";

export interface GitHubEnvironmentCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

// Result of deleting a GitHub Environment. `deleted` removed a live environment;
// `not_found` means it was already gone AND that absence was confirmed against a
// complete environment listing read by the same account (idempotent success);
// `failed` records a best-effort warning without asserting anything was torn
// down — including the case where the DELETE returned 404 but absence could not
// be confirmed, because GitHub also returns 404 when the acting credential
// simply lacks permission to see the environment.
//
// This delete primitive is deliberately shared: both the Delete Environment flow
// (PR #398) and Create-Environment rollback (separate PR) remove a GitHub
// environment with the identical idempotent contract. The design note
// `docs/design/2026-08-environment-deletion-cloud-cleanup.md` calls this out as
// a primitive that must live in one place so the two flows never drift on how a
// "not found" result is classified or when the environment-list cache is
// invalidated. Each flow keeps its own decision layer (which environment, and
// whether it is allowed to delete it) and only calls this primitive to do the
// work.
export interface GitHubEnvDeletionOutcome {
  outcome: "deleted" | "not_found" | "failed";
  detail?: string;
}

// The narrow I/O the delete primitive needs, injected so it can be unit-tested
// with a deterministic fake and reused by any flow regardless of how that flow
// runs `gh` or holds the environment-list cache.
export interface GitHubEnvironmentDeletionPorts {
  // Run a `gh` command. Never throws; a spawn failure surfaces as a non-zero
  // `code` with `stderr`. `stdout` carries the command's output, which the 404
  // absence check reads. The delete and the absence-confirming listing MUST run
  // through this one executor so both act as the same GitHub account.
  runGh(args: string[]): Promise<{
    code: number | string;
    stdout?: string;
    stderr?: string;
  }>;
  // Drop the cached environment list for the repo so the next listing reflects
  // the deletion. Called on every path that converges the environment to "gone"
  // (both `deleted` and confirmed `not_found`), never on a genuine failure.
  invalidateEnvListCache(repo: string): void;
}

export function buildGitHubEnvironmentDeleteArgs(
  repo: string,
  environment: string
): string[] {
  return [
    "api",
    "--method",
    "DELETE",
    "/repos/" + repo + "/environments/" + encodeURIComponent(environment)
  ];
}

// List every environment on the repo, paginated, emitting one name per line.
// `--paginate` walks every page so a large repo cannot hide the environment on a
// page the check never read, and `--jq` extracts names on GitHub's own bundled
// jq so no separate tool is required. Used only to confirm a DELETE's 404 really
// means the environment is gone.
export function buildGitHubEnvironmentListArgs(repo: string): string[] {
  return [
    "api",
    "--paginate",
    "-H",
    "Accept: application/vnd.github+json",
    "/repos/" + repo + "/environments",
    "--jq",
    ".environments[].name"
  ];
}

// Whether the DELETE's stderr looks like a GitHub 404 / "not found". A 404 is
// NOT trusted on its own — GitHub returns it both for a genuinely absent
// environment and for one the acting credential cannot see — so a match here
// only triggers the absence confirmation below.
function looksLikeNotFound(stderr: string | undefined): boolean {
  return /HTTP 404|not found/i.test(stderr || "");
}

// Confirm the environment is absent by reading a COMPLETE environment listing
// through the same executor that ran the delete. An unreadable listing (any
// non-zero exit) or one that still names the environment is treated as "not
// confirmed absent", so a permission-masked 404 can never be recorded as a
// successful idempotent deletion.
async function confirmGitHubEnvironmentAbsent(
  repo: string,
  environment: string,
  ports: GitHubEnvironmentDeletionPorts
): Promise<{ absent: boolean; detail?: string }> {
  const listing = await ports.runGh(buildGitHubEnvironmentListArgs(repo));
  const code = Number(listing.code);
  if (!Number.isFinite(code) || code !== 0) {
    return {
      absent: false,
      detail:
        (listing.stderr || "").trim() ||
        "GitHub returned 404 for the delete, but the repository's environment list could not be read to confirm the environment is gone. The 404 may be masking a permission problem."
    };
  }
  const target = environment.trim().toLowerCase();
  const stillListed = (listing.stdout || "")
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean)
    .some((name) => name.toLowerCase() === target);
  if (stillListed) {
    return {
      absent: false,
      detail:
        `GitHub returned 404 for the delete, but "${environment}" is still present in the repository's environment list, ` +
        "so the 404 reflects a permission problem rather than absence."
    };
  }
  return { absent: true };
}

// Delete the GitHub Environment. Idempotent, but never trusts a bare 404: GitHub
// returns 404 both when the environment is genuinely gone and when the acting
// credential lacks permission to see it. A 404 is therefore only reported as
// `not_found` after a complete environment listing — read by the same account —
// confirms the environment is truly absent. If that listing cannot be read, or
// still shows the environment, the result is `failed` so an auth-masked 404 is
// never recorded as a successful deletion.
export async function deleteGitHubEnvironmentIdempotent(
  repo: string,
  environment: string,
  ports: GitHubEnvironmentDeletionPorts
): Promise<GitHubEnvDeletionOutcome> {
  const result = await ports.runGh(
    buildGitHubEnvironmentDeleteArgs(repo, environment)
  );
  if (result.code === 0 || result.code === "0") {
    ports.invalidateEnvListCache(repo);
    return { outcome: "deleted" };
  }
  if (looksLikeNotFound(result.stderr)) {
    const absence = await confirmGitHubEnvironmentAbsent(
      repo,
      environment,
      ports
    );
    if (absence.absent) {
      ports.invalidateEnvListCache(repo);
      return { outcome: "not_found" };
    }
    return { outcome: "failed", detail: absence.detail };
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
  state: "created" | "created_candidate" | "reused";
  // GitHub's own id for the environment. Names are reused freely, so this is
  // what a later delete has to match before it removes anything.
  providerId: string | null;
  // Proving happens here rather than at the call site because a reconciled
  // mutation proves ownership from the re-read body against the journalled
  // start time, which the caller cannot reconstruct.
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
      providerId?: unknown;
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

export class GitHubEnvironmentEnsureCancelled extends Error {
  constructor() {
    super("GitHub environment creation stopped before the write began.");
    this.name = "GitHubEnvironmentEnsureCancelled";
  }
}

function succeeded(result: GitHubEnvironmentCommandResult): boolean {
  return result.code === 0 || result.code === "0";
}

function responseDetail(result: GitHubEnvironmentCommandResult): string {
  return (result.stderr || result.stdout || "").trim();
}

/** GitHub's immutable id for an environment payload, when it reports one. */
export function parseEnvironmentProviderId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as { id?: unknown; node_id?: unknown };
  if (typeof body.id === "number" && Number.isFinite(body.id)) {
    return String(body.id);
  }
  if (typeof body.id === "string" && body.id.trim()) return body.id.trim();
  return typeof body.node_id === "string" && body.node_id.trim() ?
      body.node_id.trim()
    : null;
}

function parseCommandEnvironmentProviderId(
  result: GitHubEnvironmentCommandResult
): string | null {
  try {
    return parseEnvironmentProviderId(JSON.parse(result.stdout));
  } catch {
    return null;
  }
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
  return {
    name: canonical,
    state: artifact.state,
    providerId:
      typeof artifact.providerId === "string" && artifact.providerId ?
        artifact.providerId
      : null
  };
}

/**
 * Read a GitHub environment back through the account that created it.
 *
 * The cleanup's identity gate compares the id the name answers for now against
 * the one the ledger recorded, and refuses to delete when it cannot read.
 * Reading on ambient `gh` would answer for whichever account the shell happens
 * to hold, so every cleanup path is handed a reader pinned to the executor the
 * operation selected. A refusal stays a refusal: an unreadable environment must
 * never come back as an empty, successful-looking answer that reads as absence.
 */
export function selectedEnvironmentReader(executor: {
  run(args: string[]): Promise<{
    code: string | number;
    stdout?: string;
    stderr?: string;
  }>;
}): (args: string[]) => Promise<GitHubEnvironmentCommandResult> {
  return async (args) => {
    const result = await executor.run(args);
    const code = Number(result.code);
    return {
      // A code that will not parse is not a success. Anything but an exact 0
      // leaves the caller unable to claim the environment is gone.
      code: Number.isFinite(code) ? code : 1,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || "")
    };
  };
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
  /**
   * Consulted immediately before the PUT that creates the environment, and only
   * when that PUT is a forward write rather than a reread of an already
   * journaled attempt. Returning false leaves GitHub untouched.
   */
  beforeCreate?(): Promise<boolean>;
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
  // A rejected attempt wrote nothing, so the next one is a first write and the
  // engine restamps it. Proving creation against the rejected attempt's clock
  // would widen the falsifier's window to however long the customer waited
  // before retrying, and an environment that existed all along would fall
  // inside it. Only an attempt still awaiting an answer dates the write being
  // reconciled.
  const reconcilableMutation =
    (
      pendingMutation?.status === "prepared" ||
      pendingMutation?.status === "outcome_unknown" ||
      pendingMutation?.status === "confirmed"
    ) ?
      pendingMutation
    : null;
  if (lookup.ok) {
    const name = parseEnvironmentName(lookup.json);
    if (!name) {
      throw new GitHubEnvironmentEnsureError(
        `GitHub did not report the canonical name for environment "${input.requestedName}".`,
        "github-environment-name-missing"
      );
    }
    const listedProviderId = parseEnvironmentProviderId(lookup.json);
    if (!pendingMutation) {
      return { name, state: "reused", providerId: listedProviderId };
    }
    if (pendingMutation.status === "confirmed") {
      // The confirmed write recorded the id GitHub made. Ownership is proven by
      // that id still answering for the name — never by a creation timestamp,
      // which a resource deleted and recreated here would also satisfy.
      const confirmedProviderId = pendingMutation.providerId || null;
      const identityMatches = Boolean(
        confirmedProviderId &&
        listedProviderId &&
        confirmedProviderId === listedProviderId
      );
      const creationProof: GitHubEnvironmentCreationProof =
        identityMatches ?
          proveGitHubEnvironmentCreated({
            preflight: "created_candidate",
            putResponseBody: JSON.stringify(lookup.json),
            putStartedAtMs: Date.parse(pendingMutation.preparedAt)
          })
        : {
            proven: false,
            detail:
              confirmedProviderId ?
                `The environment under that name reports id ${listedProviderId || "none"}, not the ${confirmedProviderId} this request created, so it is a different environment.`
              : "The interrupted request was recorded before Radius captured GitHub's own id for the environment, so it cannot tell this one from a replacement created under the same name."
          };
      return {
        name,
        state: "created_candidate",
        providerId: listedProviderId,
        creationProof
      };
    }
    if (pendingMutation.status === "not_applied") {
      return { name, state: "reused", providerId: listedProviderId };
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
    reconcilableMutation ?
      Date.parse(reconcilableMutation.preparedAt)
    : (input.now?.() ?? Date.now());
  const mutationArgs = ["api", "--method", "PUT", path];
  // Only a forward PUT is stoppable. A journaled attempt that reaches here to be
  // reconciled is a read, and stopping before it would strand the provenance of
  // a write nobody saw answered.
  const willWriteEnvironment =
    !input.mutationRecovery ||
    providerMutationWillWrite(
      input.mutationRecovery.operation,
      mutationKind,
      mutationTarget
    );
  if (
    willWriteEnvironment &&
    input.beforeCreate &&
    !(await input.beforeCreate())
  ) {
    throw new GitHubEnvironmentEnsureCancelled();
  }
  let created: GitHubEnvironmentCommandResult;
  if (input.mutationRecovery) {
    const recovered =
      await executeRecoverableMutation<GitHubEnvironmentCommandResult>({
        operation: input.mutationRecovery.operation,
        kind: mutationKind,
        target: mutationTarget,
        persist: input.mutationRecovery.persist,
        beforeMutation: input.beforeCreate,
        mutate: () => input.runGh(mutationArgs),
        accept: (result) => result,
        providerIdOf: (result) => parseCommandEnvironmentProviderId(result),
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
          // Nobody saw GitHub answer this PUT, so no id was ever recorded for
          // it. What sits under the name now may be what the interrupted
          // request made or what somebody made afterwards, and a creation
          // timestamp cannot tell those apart — a replacement made inside the
          // tolerance window fits it exactly as well. The read is evidence for
          // a person, never a claim of ownership.
          const observed = parseEnvironmentProviderId(reread.json);
          return {
            state: "manual_required" as const,
            guidance:
              `GitHub environment "${input.repo}:${canonical}"${observed ? ` (id ${observed})` : ""} exists after the interrupted request, ` +
              "but Radius never recorded an id for the environment that request created, so it cannot tell this one from an environment created since. " +
              "Radius left it unchanged and will not retry or delete it. Review it and remove it yourself if it is unwanted."
          };
        }
      });
    if (recovered.state === "cancelled") {
      throw new GitHubEnvironmentEnsureCancelled();
    }
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
  const creationProof = proveGitHubEnvironmentCreated({
    preflight: "created_candidate",
    putResponseBody: created.stdout,
    putStartedAtMs
  });
  return {
    name,
    state: "created_candidate",
    // Captured from the write GitHub acknowledged, or from the read that
    // reconciled it, so the delete has an id to match rather than a name.
    providerId: parseCommandEnvironmentProviderId(created),
    creationProof
  };
}
