export interface ResourceIdSegment {
  readonly type: string;
  readonly name: string;
}

export interface ResourceId {
  readonly id: string;
  /** UCP plane; absent for Azure Resource Manager IDs (`/subscriptions/...`). */
  readonly plane?: ResourceIdSegment;
  /** Scope pairs between the plane and `providers`, in order. */
  readonly scopes: readonly ResourceIdSegment[];
  /** Name of the `resourceGroups` scope; absent for scopes without one, such as AWS. */
  readonly resourceGroup?: string;
  readonly provider: string;
  readonly type: string;
  readonly name: string;
  readonly segments: readonly ResourceIdSegment[];
}

/**
 * Parse a resource identity without discarding nested resource types. Accepts
 * the forms the Radius control plane returns: UCP IDs (`/planes/<type>/<name>`
 * followed by scope pairs, such as `resourceGroups/<rg>` or AWS
 * `accounts/<id>/regions/<region>`) and Azure Resource Manager IDs
 * (`/subscriptions/<id>/...`). Scope-only and extension-resource IDs are not
 * resources the graph can render and return `undefined`.
 */
export function parseResourceId(id: string): ResourceId | undefined {
  if (!id.startsWith("/") || /[\s?#\\\u0000-\u001f]/.test(id)) return undefined;
  const parts = id.slice(1).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    return undefined;
  }
  const root = parts[0].toLowerCase();
  let plane: ResourceIdSegment | undefined;
  let index = 0;
  if (root === "planes") {
    if (parts.length < 3) return undefined;
    plane = { type: parts[1], name: parts[2] };
    index = 3;
  } else if (root !== "subscriptions") {
    return undefined;
  }
  const scopes: ResourceIdSegment[] = [];
  while (index < parts.length && parts[index].toLowerCase() !== "providers") {
    if (index + 1 >= parts.length) return undefined;
    scopes.push({ type: parts[index], name: parts[index + 1] });
    index += 2;
  }
  const provider = parts[index + 1];
  const rest = parts.slice(index + 2);
  if (
    provider === undefined ||
    rest.length < 2 ||
    rest.length % 2 !== 0 ||
    rest.some((part) => part.toLowerCase() === "providers")
  ) {
    return undefined;
  }
  const segments: ResourceIdSegment[] = [];
  for (let offset = 0; offset < rest.length; offset += 2) {
    segments.push({ type: rest[offset], name: rest[offset + 1] });
  }
  return {
    id,
    ...(plane ? { plane } : {}),
    scopes,
    ...resourceGroupOf(scopes),
    provider,
    type: [provider, ...segments.map((segment) => segment.type)].join("/"),
    name: rest[rest.length - 1],
    segments
  };
}

function resourceGroupOf(scopes: readonly ResourceIdSegment[]): {
  resourceGroup?: string;
} {
  const group = scopes.find(
    (scope) => scope.type.toLowerCase() === "resourcegroups"
  );
  return group ? { resourceGroup: group.name } : {};
}
