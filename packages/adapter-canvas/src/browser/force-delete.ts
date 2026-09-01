// Canvas adapter — deciding whether a delete button may offer the forced
// delete, shared by both pages that own a delete control.
//
// A delete can fail because the control plane still holds the resource in a
// non-terminal state, and no ordinary retry will ever clear it
// (radius-project/ai-extensions#283). Forcing is the only way out, but it drops
// records whose external resources may still exist, so it is offered only when
// the server can prove that specific failure. Every other answer — a refused
// probe, an inconclusive one, a transport failure — leaves the ordinary delete
// confirmation in place.

import { isRecord, readBoolean, readString } from "./json.js";
import type { BrowserContext } from "./ports.js";

export const DELETE_CONFLICT_PATH = "/api/delete-conflict";

/** The status a deployment carries once one of its deletes has failed. */
export const DELETE_FAILED_STATUS = "delete-failed";

/** Told to the user once a forced delete finishes, because it may orphan. */
export const FORCE_DELETE_ORPHAN_NOTICE =
  "This delete was forced. Resources in non-terminal states may leave orphaned external resources in your cloud provider that require manual cleanup.";

export interface DeleteConflictRequest {
  readonly repo: string;
  readonly environment: string;
  readonly application: string;
}

export interface DeleteConflictResult {
  readonly conflict: boolean;
  readonly resourceState: string;
  readonly forced: boolean;
  readonly detail: string;
}

const NO_CONFLICT: DeleteConflictResult = {
  conflict: false,
  resourceState: "",
  forced: false,
  detail: ""
};

export function deleteConflictUrl(request: DeleteConflictRequest): string {
  const query = [
    `repo=${encodeURIComponent(request.repo)}`,
    `environment=${encodeURIComponent(request.environment)}`,
    `application=${encodeURIComponent(request.application)}`
  ].join("&");
  return `${DELETE_CONFLICT_PATH}?${query}`;
}

export function parseDeleteConflict(payload: unknown): DeleteConflictResult {
  if (!isRecord(payload)) return NO_CONFLICT;
  const conflict = readBoolean(payload, "conflict");
  const resourceState = readString(payload, "resourceState");
  // A conflict without the state that caused it is not the proof this gate
  // needs, so it is treated as no conflict rather than as a nameless one.
  if (!conflict || resourceState === "") {
    return { ...NO_CONFLICT, detail: readString(payload, "detail") };
  }
  return {
    conflict: true,
    resourceState,
    forced: readBoolean(payload, "forced"),
    detail: readString(payload, "detail")
  };
}

/**
 * Ask the server whether the last delete of this deployment failed with the
 * stranded-resource conflict. Never rejects: an unavailable or refused probe
 * reports no conflict, which keeps the ordinary delete path in place.
 */
export function probeDeleteConflict(
  context: BrowserContext,
  request: DeleteConflictRequest
): Promise<DeleteConflictResult> {
  if (
    request.repo === "" ||
    request.environment === "" ||
    request.application === ""
  ) {
    return Promise.resolve(NO_CONFLICT);
  }
  return context.net
    .fetch(deleteConflictUrl(request))
    .then((response) =>
      response.ok ? response.json() : Promise.resolve(undefined)
    )
    .then((payload) => parseDeleteConflict(payload))
    .catch(() => NO_CONFLICT);
}
