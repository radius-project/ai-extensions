// Proof that the GitHub environment this setup PUT is the environment this
// setup created.
//
// `PUT /repos/{owner}/{repo}/environments/{name}` is idempotent: it answers 200
// whether it created the environment or found one already there. A success is
// therefore not evidence of creation, which is why the write is first recorded
// as `created_candidate` — "there is an environment, and Radius may or may not
// own it".
//
// Leaving it there permanently is its own defect. An environment this operation
// created is reported to the customer as one they have to inspect and delete by
// hand, it is excluded from the rollback that exists to remove it, and
// `ambiguousSetupOwnership` refuses to continue the setup at all. So the
// candidate needs a way to become proven — but only from evidence, never from
// optimism.
//
// The evidence is threefold and the caller must have all three before it
// promotes anything: this operation read the environment first and GitHub
// answered "not found", the PUT that followed succeeded, and the exact identity
// was durably checkpointed. This module owns the first leg and the falsifier;
// the ledger owns the last.
//
// What this deliberately does NOT claim: an environment created by someone else
// in the milliseconds between the read and the write is indistinguishable from
// one this request created, and no field in the response separates them. That
// window is unclosable from here, so it is stated rather than papered over. The
// falsifier below catches the case that is detectable and matters far more in
// practice — a preflight that reported "not found" for an environment that had
// in fact existed for hours, which is what a permissions quirk, a propagation
// delay, or a misdirected lookup produces.

/** What the pre-create lookup proved, in the vocabulary the route already uses. */
export type GitHubEnvironmentPreflight = "created_candidate" | "reused" | null;

export interface GitHubEnvironmentCreationEvidence {
  /** The classification of the GET that ran before the PUT. */
  preflight: GitHubEnvironmentPreflight;
  /** The body the PUT answered with. Empty when GitHub returned none. */
  putResponseBody: string;
  /** The clock reading taken immediately before the PUT was issued. */
  putStartedAtMs: number;
  /**
   * How far `created_at` may predate the PUT before it is treated as proof the
   * environment is older than this request. It absorbs clock skew between this
   * machine and GitHub, and nothing else: a genuinely pre-existing environment
   * is older than any plausible skew.
   */
  toleranceMs?: number;
}

export type GitHubEnvironmentCreationProof =
  { proven: true; detail: null } | { proven: false; detail: string };

const DEFAULT_TOLERANCE_MS = 120_000;

function readCreatedAtMs(body: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const createdAt = (parsed as Record<string, unknown>)["created_at"];
  if (typeof createdAt !== "string") return null;
  const millis = Date.parse(createdAt);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Whether the successful PUT can be said to have created the environment.
 *
 * Returns a refusal sentence rather than a bare false, because every caller
 * that declines to promote has to be able to say why in the narration the
 * customer reads.
 */
export function proveGitHubEnvironmentCreated(
  evidence: GitHubEnvironmentCreationEvidence
): GitHubEnvironmentCreationProof {
  if (evidence.preflight === "reused") {
    return {
      proven: false,
      detail:
        "GitHub answered the pre-create lookup with the environment, so it existed before this setup ran."
    };
  }
  if (evidence.preflight !== "created_candidate") {
    return {
      proven: false,
      detail:
        "Radius could not read whether the environment existed before it was written, so it cannot claim to have created it."
    };
  }
  const createdAtMs = readCreatedAtMs(evidence.putResponseBody);
  if (createdAtMs === null) {
    return {
      proven: false,
      detail:
        "GitHub did not report when the environment was created, so Radius cannot prove this request created it."
    };
  }
  const tolerance =
    Number.isFinite(evidence.toleranceMs) ?
      Math.max(0, Number(evidence.toleranceMs))
    : DEFAULT_TOLERANCE_MS;
  if (createdAtMs < evidence.putStartedAtMs - tolerance) {
    return {
      proven: false,
      detail: `GitHub reports the environment was created at ${new Date(
        createdAtMs
      ).toISOString()}, before this setup wrote to it, so Radius did not create it.`
    };
  }
  return { proven: true, detail: null };
}
