// Canvas adapter — the state-save (exception 5.4) diagnostic transport.
//
// `rad shutdown` persists the control-plane state after a deploy or a delete.
// The teardown composite action retries it with bounded backoff and, when every
// attempt fails, uploads a small run-scoped artifact describing that failure.
// The run itself still concludes on the deploy's own outcome, so without this
// signal a state-save failure is invisible to the canvas: the user sees a green
// deployment while the durable state — and therefore the next run's view of
// what is deployed — is silently out of date.
//
// The diagnostic is scoped to the run ATTEMPT, not just the run id. GitHub keeps
// an artifact uploaded by attempt 1 visible to attempt 2 of the same run, so a
// rerun that saved its state would otherwise still be reported as a state-save
// failure by an artifact its predecessor left behind. The attempt appears in
// both the artifact name and the payload, and both are checked here.
//
// Reads the same workflow-artifact transport as deploy-artifacts.ts, scoped to
// one run, and every I/O call is injectable.

import {
  downloadWorkflowArtifact,
  listWorkflowArtifacts,
  type DownloadArtifact,
  type ListArtifacts
} from "./deploy-artifacts.js";

// The artifact the teardown action uploads when `rad shutdown` never succeeded,
// and the file inside it. Both are a contract with
// `.github/extension/actions/teardown/action.yml`.
export const STATE_SAVE_FAILURE_ARTIFACT = "radius-state-save-failure";
export const STATE_SAVE_FAILURE_FILE = "state-save-failure.json";

/**
 * stateSaveFailureArtifactName - the attempt-scoped artifact name the teardown
 * action uploads under. Attempt 1 is not special-cased: every attempt has its
 * own name, so no two attempts of one run can collide.
 */
export function stateSaveFailureArtifactName(runAttempt: number): string {
  return `${STATE_SAVE_FAILURE_ARTIFACT}-attempt-${runAttempt}`;
}

export interface StateSaveFailure {
  attempts: number;
  runAttempt: number;
  error: string;
}

export interface StateSaveFailureReaderOptions {
  repo: string;
  runId: number | string | null | undefined;
  // The run attempt the caller is reporting on. A diagnostic that does not
  // belong to this attempt is ignored.
  runAttempt: number | string | null | undefined;
  listArtifacts?: ListArtifacts;
  downloadArtifact?: DownloadArtifact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * normalizeRunAttempt - a GitHub run attempt as a positive integer.
 *
 * Returns null for anything that is not one. The attempt gates a warning shown
 * to the user, so an unparseable value is "unknown", never "attempt 1".
 */
export function normalizeRunAttempt(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value)
    : NaN;
  if (!Number.isFinite(parsed)) return null;
  const attempt = Math.trunc(parsed);
  return attempt >= 1 ? attempt : null;
}

/**
 * parseStateSaveFailureArtifact - validate the teardown action's payload.
 *
 * Returns null for anything that is not a positively-identified state-save
 * failure for `expectedAttempt`. Reporting a state-save failure is itself a
 * warning shown to the user, so a malformed payload must not be guessed into
 * one — and neither must a previous attempt's.
 */
export function parseStateSaveFailureArtifact(
  text: string | null | undefined,
  expectedAttempt: number
): StateSaveFailure | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.outcome !== "state_save_failed") return null;
  const runAttempt = normalizeRunAttempt(parsed.runAttempt);
  if (runAttempt === null || runAttempt !== expectedAttempt) return null;
  const attempts =
    typeof parsed.attempts === "number" && Number.isFinite(parsed.attempts) ?
      Math.max(0, Math.trunc(parsed.attempts))
    : 0;
  const error = typeof parsed.error === "string" ? parsed.error.trim() : "";
  return { attempts, runAttempt, error };
}

/**
 * describeStateSaveFailure - the detail block appended to the operator warning:
 * how many `rad shutdown` attempts were made and the last error, when the
 * producer recorded them.
 */
export function describeStateSaveFailure(failure: StateSaveFailure): string {
  const parts: string[] = [];
  if (failure.attempts > 0) {
    parts.push(
      `rad shutdown failed after ${failure.attempts} attempt${
        failure.attempts === 1 ? "" : "s"
      }.`
    );
  }
  if (failure.error) parts.push(failure.error);
  return parts.join("\n");
}

export interface StateSaveFailureReader {
  read(): Promise<StateSaveFailure | null>;
}

/**
 * createStateSaveFailureReader - read one run attempt's state-save failure
 * artifact.
 *
 * The read is best-effort by construction: a run that saved its state publishes
 * no diagnostic — the normal case — and resolves to null, and so does an
 * unreadable, malformed, or previous-attempt one. A missing diagnostic must
 * never be reported as a state-save failure, and it must never fail the outcome
 * path that consults it.
 */
export function createStateSaveFailureReader(
  options: StateSaveFailureReaderOptions
): StateSaveFailureReader {
  const {
    repo,
    runId,
    runAttempt,
    listArtifacts = listWorkflowArtifacts,
    downloadArtifact = downloadWorkflowArtifact
  } = options;
  return {
    async read() {
      const attempt = normalizeRunAttempt(runAttempt);
      if (
        !repo ||
        attempt === null ||
        runId === null ||
        runId === undefined ||
        runId === ""
      ) {
        return null;
      }
      const name = stateSaveFailureArtifactName(attempt);
      let artifacts;
      try {
        artifacts = await listArtifacts(repo, runId, name);
      } catch {
        return null;
      }
      const artifact = (artifacts || []).find(
        (candidate) =>
          candidate && candidate.name === name && candidate.expired !== true
      );
      if (!artifact) return null;
      try {
        const files = await downloadArtifact(repo, artifact);
        return parseStateSaveFailureArtifact(
          files?.[STATE_SAVE_FAILURE_FILE] ?? null,
          attempt
        );
      } catch {
        return null;
      }
    }
  };
}
