// Version of the bundled model generator (the radius-app-bicep skill).
//
// The skill records this in `.radius/app.origin.json` when it generates a model,
// and the canvas compares it against the installed version before rendering a
// graph: a model produced by a different generator is refreshed rather than
// shown as-is. The skill ships inside this extension, so the extension's own
// plugin manifest version IS the generator version. A release build carries the
// released version and CI stamps an edge build (e.g. 0.1.0-edge-20260811053232).
//
// Resolution is best-effort by design. An unresolvable version is reported as ""
// and makes the freshness check ignore generator drift entirely, because
// regenerating overwrites the user's model and must never be triggered by our
// own inability to read a manifest.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface GeneratorVersionOptions {
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

// Manifests to consult, in order: the installed plugin's package.json sits
// beside the bundle, and the workspace source manifest covers a dev run loaded
// straight from packages/adapter-canvas/src.
export function generatorVersionCandidates(moduleDir: string): string[] {
  return [
    path.join(moduleDir, "package.json"),
    path.resolve(moduleDir, "../../../plugins/radius/package.json")
  ];
}

export function resolveGeneratorVersion(
  options: GeneratorVersionOptions = {}
): string {
  const moduleDir =
    options.moduleDir || path.dirname(fileURLToPath(import.meta.url));
  const readFile = options.readFile || defaultReadFile;
  for (const candidate of generatorVersionCandidates(moduleDir)) {
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

// Memoizing wrapper. The manifest cannot change under a loaded bundle and this
// is read on every graph open, but the memo is handed to the composition root to
// own rather than kept at module scope, so nothing mutable outlives an instance.
export function createGeneratorVersionReader(
  options: GeneratorVersionOptions = {}
): () => string {
  let cached: string | null = null;
  return () => {
    if (cached === null) cached = resolveGeneratorVersion(options);
    return cached;
  };
}
