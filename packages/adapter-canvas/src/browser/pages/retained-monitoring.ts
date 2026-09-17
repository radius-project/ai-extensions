import { parseGraphResources } from "../graph/model.js";
import { isRecord, readArray, readString } from "../json.js";

export function readRetainedMonitoring(
  payload: unknown,
  repo: string,
  application: string,
  environment: string
) {
  if (
    !isRecord(payload) ||
    payload.unavailable !== true ||
    payload.reason !== "RESULT_UNAVAILABLE" ||
    payload.stale === true
  )
    return null;
  const value = payload.retainedMonitoring;
  if (
    !isRecord(value) ||
    typeof value.runId !== "number" ||
    !Number.isSafeInteger(value.runId) ||
    value.runId <= 0 ||
    !repo ||
    !application ||
    !environment ||
    readString(value, "repo").toLowerCase() !== repo.toLowerCase() ||
    readString(value, "application").toLowerCase() !==
      application.toLowerCase() ||
    readString(value, "environment").toLowerCase() !== environment.toLowerCase()
  )
    return null;
  const resources = parseGraphResources(readArray(value, "resources"));
  if (
    !resources.length ||
    resources.some(
      (resource) =>
        !resource.id ||
        (resource.deployStatus !== "failed" &&
          resource.deployStatus !== "success")
    )
  )
    return null;
  return { resources, runId: value.runId };
}
