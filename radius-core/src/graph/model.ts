// Application-graph model — port of pkg/cli/graph/modeled.go + diffhash.go.
//
// Builds the Radius application graph from a compiled ARM JSON template (the
// output of `bicep build`). Pure logic: deterministic, no GitHub/SDK/DOM
// access. Shared by every UI adapter via radius-core.

import { createHash } from "node:crypto";

export const MODELED_GRAPH_DEFAULTS = {
  plane: "local",
  resourceGroup: "default",
};

const SKIP_RESOURCE_TYPES = new Set([
  "applications.core/applications",
  "applications.core/environments",
  "radius.core/recipepacks",
]);

// Properties excluded from diff hash (runtime-bound, not developer-authored)
const NON_AUTHORABLE_PROPERTIES = new Set(["provisioningState", "status"]);

// Matches [resourceId('TYPE', 'NAME')]
const RESOURCE_ID_EXPR = /^\[resourceId\(([^)]*)\)\]$/;

// Matches [reference('sym').xxx]
const SYMBOLIC_REFERENCE = /^\[reference\('([^']+)'\)\.[^\]]+\]$/;

/**
 * ComputeDiffHash - port of pkg/cli/graph/diffhash.go
 * Returns "sha256:<hex>" over authorable properties + sorted dependsOn.
 */
export function computeDiffHash(properties: any, dependsOn: any[] = []): string {
  const authorable: any = {};
  for (const [k, v] of Object.entries(properties || {})) {
    if (!NON_AUTHORABLE_PROPERTIES.has(k)) authorable[k] = v;
  }
  const sorted = [...dependsOn].sort();
  // Sort keys to match Go's encoding/json behavior (alphabetical map key order)
  const payload = JSON.stringify({ properties: authorable, dependsOn: sorted }, sortedReplacer);
  const hash = createHash("sha256").update(payload).digest("hex");
  return `sha256:${hash}`;
}

/** JSON replacer that sorts object keys alphabetically, matching Go's encoding/json. */
function sortedReplacer(_key: string, value: any): any {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: any = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = value[k];
    }
    return sorted;
  }
  return value;
}

/**
 * BuildModeledGraph - port of pkg/cli/graph/modeled.go
 * Takes an ARM JSON template object and returns ApplicationGraphResponse.
 */
export function buildModeledGraph(template: any): any {
  const rawResources = collectARMResources(template.resources);
  if (!rawResources || rawResources.length === 0) {
    return { resources: [] };
  }

  const graphResources = [];
  for (const entry of rawResources) {
    const resource = buildModeledResource(entry);
    if (resource) graphResources.push(resource);
  }

  const graph = { resources: graphResources };
  addInboundConnections(graph);
  return graph;
}

/**
 * collectARMResources - normalizes the "resources" section.
 * Handles both classic array (languageVersion 1.x) and symbolic-name object
 * (languageVersion 2.0) formats from `bicep build`.
 */
function collectARMResources(raw: any): any[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return raw.filter((item) => item && typeof item === "object");
  }
  if (typeof raw === "object") {
    // Symbolic-name format — object keyed by symbolic name
    const symbols = buildSymbolTable(raw);
    const keys = Object.keys(raw).sort();
    return keys.map((k) => normalizeSymbolicEntry(raw[k], symbols)).filter(Boolean);
  }
  return null;
}

function buildSymbolTable(resources: any): any {
  const table: any = {};
  for (const [symbol, item] of Object.entries<any>(resources)) {
    if (!item || typeof item !== "object") continue;
    const typeWithVersion = item.type || "";
    const wrapper = item.properties || {};
    const name = wrapper.name || "";
    table[symbol] = {
      resourceType: stripAPIVersion(typeWithVersion),
      name,
    };
  }
  return table;
}

function normalizeSymbolicEntry(entry: any, symbols: any): any {
  if (!entry || typeof entry !== "object") return null;
  const resourceType = stripAPIVersion(entry.type || "");
  const wrapper = entry.properties || {};
  const name = wrapper.name || "";
  const innerProps = wrapper.properties || {};
  rewriteSymbolicConnections(innerProps, symbols);

  const rawDeps = entry.dependsOn || [];
  const newDeps = rawDeps.map((d: any) => {
    if (typeof d !== "string") return d;
    const sym = symbols[d];
    if (sym && sym.resourceType && sym.name) {
      return `[resourceId('${sym.resourceType}', '${sym.name}')]`;
    }
    return d;
  });

  return { type: resourceType, name, properties: innerProps, dependsOn: newDeps };
}

function rewriteSymbolicConnections(properties: any, symbols: any): void {
  if (!properties) return;
  const connections = properties.connections;
  if (!connections || typeof connections !== "object") return;
  for (const raw of Object.values<any>(connections)) {
    if (!raw || typeof raw !== "object") continue;
    const source = raw.source;
    if (typeof source !== "string") continue;
    const matches = SYMBOLIC_REFERENCE.exec(source);
    if (!matches) continue;
    const sym = symbols[matches[1]];
    if (!sym || !sym.resourceType || !sym.name) continue;
    raw.source = `[resourceId('${sym.resourceType}', '${sym.name}')]`;
  }
}

export function stripAPIVersion(t: string): string {
  const i = t.indexOf("@");
  return i >= 0 ? t.slice(0, i) : t;
}

function buildModeledResource(entry: any): any {
  const resourceType = entry.type || "";
  const name = entry.name || "";
  if (!resourceType || !name) return null;
  if (SKIP_RESOURCE_TYPES.has(resourceType.toLowerCase())) return null;

  const properties = entry.properties || {};
  const rawDeps = entry.dependsOn || [];
  const dependsOn = resolveDependsOn(rawDeps);
  const hash = computeDiffHash(properties, dependsOn);

  return {
    id: buildResourceID(resourceType, name),
    name,
    type: resourceType,
    provisioningState: "NotSpecified",
    connections: resolveOutboundConnections(properties),
    outputResources: [],
    diffHash: hash,
  };
}

function resolveOutboundConnections(properties: any): any[] {
  if (!properties) return [];
  const connections = properties.connections;
  if (!connections || typeof connections !== "object") return [];

  const result = [];
  for (const raw of Object.values<any>(connections)) {
    if (!raw || typeof raw !== "object") continue;
    const source = raw.source || "";
    const resolved = resolveResourceIDExpression(source);
    if (resolved) {
      result.push({ id: resolved, direction: "Outbound" });
    }
  }
  return result;
}

export function addInboundConnections(graph: any): void {
  const byID: any = {};
  for (const r of graph.resources) {
    if (r && r.id) byID[r.id] = r;
  }
  for (const src of graph.resources) {
    if (!src || !src.id) continue;
    for (const conn of src.connections || []) {
      if (!conn || !conn.id || conn.direction !== "Outbound") continue;
      const dest = byID[conn.id];
      if (!dest) continue;
      dest.connections = dest.connections || [];
      dest.connections.push({ id: src.id, direction: "Inbound" });
    }
  }
}

function resolveDependsOn(deps: any[]): string[] {
  const out = [];
  for (const v of deps) {
    if (typeof v !== "string") continue;
    const resolved = resolveResourceIDExpression(v);
    if (resolved) out.push(resolved);
  }
  return out;
}

function resolveResourceIDExpression(expr: string): string {
  if (!expr) return "";
  const matches = RESOURCE_ID_EXPR.exec(expr);
  if (!matches) return "";
  const args = splitResourceIDArgs(matches[1]);
  if (args.length < 2) return "";
  const resourceType = args[0].replace(/'/g, "").trim();
  const name = args[1].replace(/'/g, "").trim();
  if (!resourceType || !name) return "";
  return buildResourceID(resourceType, name);
}

function splitResourceIDArgs(s: string): string[] {
  const parts = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      inQuote = !inQuote;
      current += c;
      continue;
    }
    if (c === "," && !inQuote) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current) parts.push(current);
  return parts;
}

export function buildResourceID(resourceType: string, name: string): string {
  return `/planes/radius/${MODELED_GRAPH_DEFAULTS.plane}/resourcegroups/${MODELED_GRAPH_DEFAULTS.resourceGroup}/providers/${resourceType}/${name}`;
}
