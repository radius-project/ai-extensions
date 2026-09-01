// Canvas adapter — telling a stranded-resource delete failure apart from every
// other one.
//
// The delete workflow runs on an ephemeral control plane that restores state
// from the OCI archive. A resource left in a non-terminal `provisioningState`
// by an interrupted earlier run comes back exactly as it was, and because no
// async operation is running to finish it, `rad app delete` answers
// `409 Conflict — The target resource is in progress state: Updating` forever
// (radius-project/ai-extensions#283). `rad app delete --force` is the escape,
// but forcing can orphan the external resources those records own, so the
// canvas only offers it once it can *prove* this is the failure it is looking
// at.
//
// The proof is the `rad-delete-result` artifact the `delete-resource` composite
// action uploads, which carries the raw `rad` output alongside the outcome.
// Anything less than a readable artifact from the failed run — an unresolvable
// run, an expired or missing artifact, an unreadable or malformed payload, a
// refused download — is reported as `unknown` and never unlocks the force path.
// This probe fails closed: it is the gate in front of a destructive operation.

import type {
  ArtifactFiles,
  DownloadArtifact,
  ListArtifacts,
  WorkflowArtifact
} from "../../deploy-artifacts.js";
import type { DeploymentRow } from "./deployment-resolver.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Artifact the `delete-resource` composite action uploads, and its file. */
export const DELETE_RESULT_ARTIFACT = "rad-delete-result";
export const DELETE_RESULT_FILE = "rad-delete-result.json";

/** The deployment status a failed delete run is reported under. */
export const DELETE_FAILED_STATUS = "delete-failed";

// The control plane's 409 gate (pkg/armrpc/frontend/controller/operation.go)
// refuses any operation on a resource whose state is not terminal, and names
// that state in the message. Matching the phrase rather than the status code
// keeps this working through the CLI's own error wrapping, which reports the
// message but not always a parseable status line.
const IN_PROGRESS_STATE = /in progress state:\s*"?([A-Za-z]+)"?/i;

/**
 * The non-terminal provisioning state a delete failure names, or `""` when the
 * output is not that failure.
 */
export function readNonTerminalState(output: string): string {
  const match = IN_PROGRESS_STATE.exec(output);
  return match ? match[1] : "";
}

export type DeleteConflictProbe =
  | { state: "conflict"; resourceState: string; forced: boolean }
  | { state: "clear" }
  | { state: "unknown"; detail: string };

export interface DeleteConflictDependencies {
  resolveEnvDeployment(
    repo: string,
    environment: string,
    application: string
  ): Promise<DeploymentRow | null>;
  listArtifacts: ListArtifacts;
  downloadArtifact: DownloadArtifact;
}

export interface DeleteConflictRequest {
  repo: string;
  environment: string;
  application: string;
}

function errorDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.trim() || "the request was refused";
}

function readRunId(runUrl: string): string {
  const match = /actions\/runs\/(\d+)/.exec(runUrl);
  return match ? match[1] : "";
}

function findResultArtifact(
  artifacts: readonly WorkflowArtifact[]
): WorkflowArtifact | null {
  return (
    artifacts.find(
      (artifact) =>
        artifact.name === DELETE_RESULT_ARTIFACT && artifact.expired !== true
    ) ?? null
  );
}

function readResultPayload(files: ArtifactFiles): unknown {
  const body = files[DELETE_RESULT_FILE];
  if (typeof body !== "string" || body.trim() === "") return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Decide whether the most recent delete of `application` in `environment`
 * failed with the stranded-resource conflict, and may therefore be retried with
 * `--force`.
 *
 * Reports `clear` only when the deployment state itself says there is nothing
 * to force — no tracked deployment, a deployment that is not in the failed
 * state, or a failure whose recorded output is a different failure. Every other
 * way of not knowing is `unknown`, which leaves the ordinary delete path in
 * place.
 */
export async function probeDeleteConflict(
  request: DeleteConflictRequest,
  dependencies: DeleteConflictDependencies
): Promise<DeleteConflictProbe> {
  let current: DeploymentRow | null;
  try {
    current = await dependencies.resolveEnvDeployment(
      request.repo,
      request.environment,
      request.application
    );
  } catch (error) {
    return {
      state: "unknown",
      detail: `The current deployment state could not be read: ${errorDetail(error)}.`
    };
  }
  if (!current || current.status !== DELETE_FAILED_STATUS) {
    return { state: "clear" };
  }

  const runId = readRunId(current.runUrl);
  if (!runId) {
    return {
      state: "unknown",
      detail:
        "The failed delete has no workflow run Radius can read its result from."
    };
  }

  let artifacts: readonly WorkflowArtifact[];
  try {
    artifacts = await dependencies.listArtifacts(request.repo, runId);
  } catch (error) {
    return {
      state: "unknown",
      detail: `The failed delete run's artifacts could not be listed: ${errorDetail(error)}.`
    };
  }
  const artifact = findResultArtifact(artifacts);
  if (!artifact) {
    return {
      state: "unknown",
      detail: `The failed delete run no longer has a ${DELETE_RESULT_ARTIFACT} artifact, so why it failed cannot be established.`
    };
  }

  let files: ArtifactFiles | null;
  try {
    files = await dependencies.downloadArtifact(request.repo, artifact);
  } catch (error) {
    return {
      state: "unknown",
      detail: `The failed delete run's result could not be downloaded: ${errorDetail(error)}.`
    };
  }
  if (!files) {
    return {
      state: "unknown",
      detail: `The ${DELETE_RESULT_ARTIFACT} artifact could not be downloaded from the failed delete run.`
    };
  }

  const payload = readResultPayload(files);
  if (!isRecord(payload)) {
    return {
      state: "unknown",
      detail: `The ${DELETE_RESULT_FILE} written by the failed delete run could not be read.`
    };
  }
  if (payload.outcome !== "failed") return { state: "clear" };
  const output = typeof payload.output === "string" ? payload.output : "";
  const resourceState = readNonTerminalState(output);
  if (!resourceState) return { state: "clear" };
  return {
    state: "conflict",
    resourceState,
    forced: payload.forced === true
  };
}
