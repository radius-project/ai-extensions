// Version of the installed Radius plugin, from its manifest. Operation
// diagnostics report it as the product version. A release build carries the
// released version and CI stamps an edge build (e.g. 0.1.0-edge-0b33186).
// Resolution is best-effort: an unresolvable version is reported as "".

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePluginRoot } from "./plugin-root.js";

export interface PluginVersionOptions {
  // Directory holding the loaded extension bundle. Defaults to this module's.
  moduleDir?: string;
  readFile?: (filePath: string) => string;
}

function defaultReadFile(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function versionFromManifest(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const version = (parsed as Record<string, unknown>).version;
  return typeof version === "string" ? version.trim() : "";
}

// Manifests to consult, in order: the installed plugin's package.json is
// resolved from the bundle location, and the workspace source manifest covers
// a dev run loaded straight from packages/adapter-canvas/src.
export function pluginVersionCandidates(moduleDir: string): string[] {
  return [
    path.join(resolvePluginRoot(moduleDir), "package.json"),
    path.resolve(moduleDir, "../../../extensions/radius/package.json")
  ];
}

export function resolvePluginVersion(
  options: PluginVersionOptions = {}
): string {
  const moduleDir =
    options.moduleDir || path.dirname(fileURLToPath(import.meta.url));
  const readFile = options.readFile || defaultReadFile;
  for (const candidate of pluginVersionCandidates(moduleDir)) {
    let text: string;
    try {
      text = readFile(candidate);
    } catch {
      continue;
    }
    const version = versionFromManifest(text);
    if (version) return version;
  }
  return "";
}
