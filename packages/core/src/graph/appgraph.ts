// app-graph.json → canvas resources.
//
// `rad app graph <app.bicep>` writes an ApplicationGraphResponse
// (`{ resources: [...] }`) with the full graph and diff hashes.
// `applicationGraphToResources` adapts that payload into the resource-node
// array the canvas UI and the diff algorithm expect: it normalizes
// connections, enriches each node with the `definitionFile` (rad does not
// know the repo layout), and preserves the stable `diffHash` rad already
// computed. Pure: no shell/HTTP/DOM.

import { addInboundConnections } from "./model.js";

const DIFF_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DEFINITION_KEY_SEPARATOR = "\u0000";
const SECRET_RESOURCE_TYPE = "radius.security/secrets";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyString(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string
): void {
  if (typeof source[key] === "string") target[key] = source[key];
}

function copyNumber(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string
): void {
  if (typeof source[key] === "number") target[key] = source[key];
}

function containsGraphVisibleSecretData(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(containsGraphVisibleSecretData);
  if (isRecord(value)) {
    return Object.values(value).some(containsGraphVisibleSecretData);
  }
  return true;
}

function assertSecretDataIsRedacted(resource: Record<string, unknown>): void {
  const type =
    typeof resource.type === "string" ?
      resource.type.split("@")[0].toLowerCase()
    : "";
  if (type !== SECRET_RESOURCE_TYPE) return;
  const properties = isRecord(resource.properties) ? resource.properties : null;
  if (!properties || !containsGraphVisibleSecretData(properties.data)) return;
  const name =
    typeof resource.name === "string" && resource.name ?
      ` "${resource.name}"`
    : "";
  throw new Error(
    `Canvas refused to save or render Secret resource${name} because its graph data was not redacted. Supply Secret data through secure inputs or schema-supported references; do not place plaintext values in the application model.`
  );
}

export function projectGraphOutputMetadata(
  value: unknown
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  assertSecretDataIsRedacted(value);
  const projected: Record<string, unknown> = {};
  for (const key of [
    "id",
    "name",
    "type",
    "displayType",
    "provider",
    "apiVersion",
    "deployStatus",
    "portalUrl",
    "iconHash",
    "icon"
  ]) {
    copyString(projected, value, key);
  }
  return projected;
}

export function projectGraphConnectionMetadata(
  value: unknown
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const projected: Record<string, unknown> = {};
  for (const key of ["id", "name", "direction", "kind", "diffStatus"]) {
    copyString(projected, value, key);
  }
  return projected;
}

export function projectGraphResourceMetadata(
  value: unknown
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  assertSecretDataIsRedacted(value);
  const projected: Record<string, unknown> = {};
  for (const key of [
    "id",
    "name",
    "type",
    "displayType",
    "provisioningState",
    "diffHash",
    "diffStatus",
    "deployStatus",
    "deployMessage",
    "portalUrl",
    "codeReference",
    "definitionFile",
    "iconHash",
    "icon"
  ]) {
    copyString(projected, value, key);
  }
  copyNumber(projected, value, "definitionLine");

  const properties = isRecord(value.properties) ? value.properties : null;
  if (properties && typeof properties.codeReference === "string") {
    projected.properties = { codeReference: properties.codeReference };
  }
  projected.connections =
    Array.isArray(value.connections) ?
      value.connections
        .map(projectGraphConnectionMetadata)
        .filter((entry) => entry !== null)
    : [];
  projected.outputResources =
    Array.isArray(value.outputResources) ?
      value.outputResources
        .map(projectGraphOutputMetadata)
        .filter((entry) => entry !== null)
    : [];
  return projected;
}

export interface SafeApplicationGraph {
  resources: Record<string, unknown>[];
  icons?: Record<string, string>;
}

export function projectSafeApplicationGraph(
  appGraph: unknown
): SafeApplicationGraph {
  const sourceResources =
    Array.isArray(appGraph) ? appGraph
    : isRecord(appGraph) && Array.isArray(appGraph.resources) ?
      appGraph.resources
    : [];
  const resources = sourceResources
    .map(projectGraphResourceMetadata)
    .filter((entry) => entry !== null);
  if (!isRecord(appGraph) || !isRecord(appGraph.icons)) return { resources };
  const icons = Object.fromEntries(
    Object.entries(appGraph.icons).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
  return { resources, icons };
}

function definitionKey(type: string, name: string): string {
  return `${type}${DEFINITION_KEY_SEPARATOR}${name}`;
}

/**
 * applicationGraphToResources - convert a rad `app-graph.json` payload into the
 * canvas resources array.
 *
 * Accepts either an `ApplicationGraphResponse` (`{ resources: [...] }`) or a
 * bare resources array. Keeps only outbound connections from the input and
 * rebuilds the reciprocal inbound edges via `addInboundConnections`, which also
 * sorts every resource's connections deterministically, so rad edge ordering
 * does not affect diffs.
 */
export function applicationGraphToResources(
  appGraph: any,
  definitionFile = ".radius/app.bicep",
  definitionContent = ""
): any[] {
  const safeGraph = projectSafeApplicationGraph(appGraph);
  const icons = safeGraph.icons ?? {};

  const resolveIcon = (resource: any): string => {
    if (typeof resource?.icon === "string" && resource.icon)
      return resource.icon;
    const hash = resource?.iconHash;
    return typeof hash === "string" && typeof icons[hash] === "string" ?
        icons[hash]
      : "";
  };
  const raw = safeGraph.resources;
  const definitionLines = findResourceDefinitionLines(definitionContent);

  const resources: any[] = [];
  for (const r of raw) {
    const id = typeof r.id === "string" ? r.id : "";
    const name = typeof r.name === "string" ? r.name : "";
    const type = typeof r.type === "string" ? r.type : "";
    if (!id || !type) continue;

    // Keep only outbound edges; inbound edges are rebuilt below and the full
    // connection list is sorted deterministically inside addInboundConnections,
    // so the shape is stable regardless of rad's edge ordering.
    const connections: any[] = [];
    for (const c of r.connections as Record<string, unknown>[]) {
      if (!c || !c.id) continue;
      if ((c.direction || "Outbound") !== "Outbound") continue;
      connections.push({
        id: c.id,
        direction: "Outbound",
        ...(typeof c.kind === "string" ? { kind: c.kind } : {})
      });
    }

    resources.push({
      id,
      name,
      type,
      provisioningState: r.provisioningState || "NotSpecified",
      connections,
      outputResources: (r.outputResources as Record<string, unknown>[]).map(
        (output) => ({
          ...output,
          icon: resolveIcon(output)
        })
      ),
      diffHash: validateDiffHash(r.diffHash, name || id),
      definitionFile,
      definitionLine:
        typeof r.definitionLine === "number" && r.definitionLine > 0 ?
          r.definitionLine
        : (definitionLines.get(definitionKey(type, name)) ??
          definitionLines.get(name) ??
          definitionLines.get(definitionKey(type, id.split("/").pop() || "")) ??
          definitionLines.get(id.split("/").pop() || "") ??
          0),
      // Newer `rad app graph` emits the authored codeReference under the
      // resource's `properties`; older output placed it at the top level. Prefer
      // the new location and fall back to the legacy one — otherwise the canvas
      // source links silently disappear even though app.bicep and app-graph.json
      // carry them.
      codeReference:
        (isRecord(r.properties) &&
          typeof r.properties.codeReference === "string" &&
          r.properties.codeReference) ||
        (typeof r.codeReference === "string" && r.codeReference) ||
        "",
      iconHash: r.iconHash || "",
      icon: resolveIcon(r)
    });
  }

  addInboundConnections({ resources });
  return resources;
}

/**
 * Find authored Bicep resource declaration lines by both symbolic name and a
 * literal top-level `name` property. `rad app graph` does not consistently emit
 * source locations, so this keeps app-definition links anchored to the resource
 * declaration without coupling the graph model to a Bicep parser.
 */
export function findResourceDefinitionLines(
  content: string
): Map<string, number> {
  const result = new Map<string, number>();
  if (!content) return result;

  const lines = content.split(/\r?\n/);
  const declarations: Array<{ index: number; symbol: string; type: string }> =
    [];
  const declarationPattern =
    /^\s*resource\s+([A-Za-z_][A-Za-z0-9_]*)\s+['"]([^@'"]+)(?:@[^'"]+)?['"](?:\s+existing)?\s*=/;

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(declarationPattern);
    if (match) declarations.push({ index, symbol: match[1], type: match[2] });
  }

  for (let i = 0; i < declarations.length; i++) {
    const declaration = declarations[i];
    const lineNumber = declaration.index + 1;
    result.set(declaration.symbol, lineNumber);

    let depth = 0;
    let foundBody = false;
    for (let index = declaration.index; index < lines.length; index++) {
      const structuralLine = lines[index]
        .replace(/'[^']*'|"[^"]*"/g, "")
        .replace(/\/\/.*$/, "");
      const depthBeforeLine = depth;
      depth += (structuralLine.match(/{/g) || []).length;
      depth -= (structuralLine.match(/}/g) || []).length;
      foundBody ||= depth > 0 || structuralLine.includes("{");

      const nameMatch =
        depthBeforeLine === 1 ?
          lines[index].match(/^\s*name\s*:\s*['"]([^'"]+)['"]/)
        : depthBeforeLine === 0 ?
          lines[index]
            .replace(/\/\/.*$/, "")
            .match(/\{[^}]*\bname\s*:\s*['"]([^'"]+)['"]/)
        : null;
      if (nameMatch && !result.has(nameMatch[1])) {
        result.set(nameMatch[1], lineNumber);
      }
      if (nameMatch) {
        const typedKey = definitionKey(declaration.type, nameMatch[1]);
        if (!result.has(typedKey)) result.set(typedKey, lineNumber);
      }
      if (foundBody && depth === 0) break;
    }
  }

  return result;
}

/**
 * Validate that a diffHash from rad output is present and well-formed.
 * The rad CLI is the single source of truth for diff hashes — if one is
 * missing, the caller is likely using an incompatible rad version or
 * hand-constructing resources without a hash, which would silently break
 * property-change detection in computeGraphDiff.
 */
function validateDiffHash(hash: unknown, resourceName: string): string {
  if (typeof hash === "string" && DIFF_HASH_PATTERN.test(hash)) {
    return hash;
  }
  throw new Error(
    `Resource "${resourceName}" is missing a valid diffHash (expected "sha256:" followed by 64 lowercase hexadecimal characters from rad CLI output). ` +
      `Ensure you are using a compatible version of the rad CLI that includes diff hashes in its graph output.`
  );
}
