import { graphContextKey, normalizeLiveResources } from "./live.js";
import { parseResourceId } from "../domain/resource-id.js";
import type { GraphContext, LegacyLiveGraph, LiveGraph } from "./contracts.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Legacy UCP graph payloads reverse ordinary connections. Only the exact
 * gateway/route types parsed from connection IDs use the other orientation.
 * The default live normalizer keeps its source -> target contract unchanged.
 */
export function normalizeLegacyLiveGraph(value: unknown): LegacyLiveGraph;
export function normalizeLegacyLiveGraph(
  value: unknown,
  context: GraphContext
): LiveGraph;
export function normalizeLegacyLiveGraph(
  value: unknown,
  context?: GraphContext
): LiveGraph | LegacyLiveGraph {
  if (context) graphContextKey(context);
  if (!record(value) || !Array.isArray(value.resources)) {
    throw new TypeError("Legacy live graph resources must be an array.");
  }
  const resources = value.resources.map((resource: unknown) => {
    if (!record(resource) || !Array.isArray(resource.connections))
      return resource;
    return {
      ...resource,
      connections: resource.connections.map((connection: unknown) => {
        if (!record(connection)) return connection;
        const type =
          typeof connection.id === "string" ?
            parseResourceId(connection.id)?.type.toLowerCase()
          : undefined;
        const special =
          type === "applications.core/gateways" ||
          type === "radius.compute/routes";
        const direction = connection.direction;
        return {
          ...connection,
          direction:
            direction === "Outbound" ? "Inbound"
            : direction === "Inbound" ?
              special ? "Inbound"
              : "Outbound"
            : direction
        };
      })
    };
  });
  const normalized = normalizeLiveResources({ resources });
  return context ?
      {
        kind: "live",
        context: { ...context, plane: { ...context.plane } },
        ...normalized
      }
    : { kind: "legacy-live", ...normalized };
}
