import type { DeploymentResource } from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalStrings(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return keys.every(
    (key) => value[key] === undefined || typeof value[key] === "string"
  );
}

function resource(value: unknown): value is DeploymentResource {
  if (
    !record(value) ||
    !optionalStrings(value, [
      "id",
      "name",
      "type",
      "displayType",
      "diffStatus",
      "codeReference",
      "deployMessage",
      "portalUrl"
    ])
  )
    return false;
  if (
    value.deployStatus !== undefined &&
    value.deployStatus !== "pending" &&
    value.deployStatus !== "in_progress" &&
    value.deployStatus !== "success" &&
    value.deployStatus !== "failed"
  )
    return false;
  if (
    value.connections !== undefined &&
    (!Array.isArray(value.connections) ||
      !value.connections.every(
        (connection: unknown) =>
          record(connection) &&
          optionalStrings(connection, ["id", "name", "direction", "diffStatus"])
      ))
  )
    return false;
  return (
    value.outputResources === undefined ||
    (Array.isArray(value.outputResources) &&
      value.outputResources.every(resource))
  );
}

/** Store the resource list, not the producer's transport envelope. */
export function deployedGraphResources(
  graph: unknown
): DeploymentResource[] | null {
  const resources: unknown = record(graph) ? graph.resources : graph;
  return Array.isArray(resources) && resources.every(resource) ?
      resources
    : null;
}
