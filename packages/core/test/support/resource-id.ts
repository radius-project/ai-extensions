// Builds the UCP resource ids that `rad` stamps on modeled graph resources.
//
// Production code never constructs these — the `rad` CLI is the source of truth
// and core only post-processes what it emits. Graph tests still need realistic
// ids, so the shape lives here as fixture data rather than as a production
// helper nothing calls.

const PLANE = "local";
const RESOURCE_GROUP = "default";

export function buildResourceID(resourceType: string, name: string): string {
  return `/planes/radius/${PLANE}/resourcegroups/${RESOURCE_GROUP}/providers/${resourceType}/${name}`;
}
