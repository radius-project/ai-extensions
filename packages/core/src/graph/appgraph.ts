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
  const icons =
    (
      !Array.isArray(appGraph) &&
      appGraph &&
      appGraph.icons &&
      typeof appGraph.icons === "object" &&
      !Array.isArray(appGraph.icons)
    ) ?
      appGraph.icons
    : {};

  const resolveIcon = (resource: any): string => {
    if (typeof resource?.icon === "string" && resource.icon)
      return resource.icon;
    const hash = resource?.iconHash;
    return typeof hash === "string" && typeof icons[hash] === "string" ?
        icons[hash]
      : "";
  };
  const raw =
    Array.isArray(appGraph) ? appGraph
    : appGraph && Array.isArray(appGraph.resources) ? appGraph.resources
    : [];
  const definitionLines = findResourceDefinitionLines(definitionContent);

  const resources: any[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const id = r.id || "";
    const type = r.type || "";
    if (!id || !type) continue;

    // Keep only outbound edges; inbound edges are rebuilt below and the full
    // connection list is sorted deterministically inside addInboundConnections,
    // so the shape is stable regardless of rad's edge ordering.
    const connections: any[] = [];
    for (const c of Array.isArray(r.connections) ? r.connections : []) {
      if (!c || !c.id) continue;
      if ((c.direction || "Outbound") !== "Outbound") continue;
      connections.push({ id: c.id, direction: "Outbound" });
    }

    resources.push({
      id,
      name: r.name || "",
      type,
      provisioningState: r.provisioningState || "NotSpecified",
      connections,
      outputResources:
        Array.isArray(r.outputResources) ?
          r.outputResources.map((output: any) => ({
            ...output,
            icon: resolveIcon(output)
          }))
        : [],
      diffHash: validateDiffHash(r.diffHash, r.name || id),
      definitionFile,
      definitionLine:
        typeof r.definitionLine === "number" && r.definitionLine > 0 ?
          r.definitionLine
        : (definitionLines.get(definitionKey(type, r.name || "")) ??
          definitionLines.get(r.name) ??
          definitionLines.get(definitionKey(type, id.split("/").pop() || "")) ??
          definitionLines.get(id.split("/").pop() || "") ??
          0),
      // Newer `rad app graph` emits the authored codeReference under the
      // resource's `properties`; older output placed it at the top level. Prefer
      // the new location and fall back to the legacy one — otherwise the canvas
      // source links silently disappear even though app.bicep and app-graph.json
      // carry them.
      codeReference:
        (r.properties &&
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
