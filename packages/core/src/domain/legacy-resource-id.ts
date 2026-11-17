import { parseResourceId } from "./resource-id.js";

export interface LegacyResourceId {
  plane: string;
  group: string;
  type: string;
  name: string;
}

/** Radius-only navigation contract; never truncate cloud or nested IDs. */
export function parseLegacyResourceId(
  id: string
): LegacyResourceId | undefined {
  const parsed = parseResourceId(id);
  if (
    parsed?.plane?.type.toLowerCase() !== "radius" ||
    parsed.scopes.length !== 1 ||
    parsed.scopes[0].type.toLowerCase() !== "resourcegroups" ||
    !parsed.resourceGroup ||
    parsed.segments.length !== 1
  )
    return undefined;
  return {
    plane: parsed.plane.name,
    group: parsed.resourceGroup,
    type: parsed.type,
    name: parsed.name
  };
}
