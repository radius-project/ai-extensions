import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { toSafeRepoRelPath } from "./workspace.js";

function isUnder(root: string, p: string): boolean {
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return p === root || p.startsWith(rootWithSep);
}

// Walk up from `p` until an existing directory is found, so a path that does not
// exist yet (a new write target) can still be canonicalized against its nearest
// real ancestor.
function nearestExistingParent(p: string): string {
  let dir = p;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return dir; // filesystem root
    dir = parent;
  }
  return dir;
}

// Lexical confinement of a tool-supplied path under the workspace `.radius/`:
// rejects absolute paths, `..` traversal, null bytes (via toSafeRepoRelPath),
// and any result that escapes `.radius/`. Returns { radiusRoot, resolved, raw }.
function lexicalRadiusPath(
  workspacePath: string | null | undefined,
  value: unknown,
  fallback: string | null | undefined
): { radiusRoot: string; resolved: string; raw: string } {
  if (!workspacePath) {
    throw new Error(
      "No repository workspace is open; cannot resolve a .radius artifact path."
    );
  }
  const raw = value && String(value).trim() ? String(value).trim() : fallback;
  if (!raw) throw new Error("A file path is required.");
  if (isAbsolute(raw)) {
    throw new Error(
      `Path must be relative to the workspace .radius directory, not absolute: ${raw}`
    );
  }
  const rel = toSafeRepoRelPath(raw).replace(/^\.radius\//, "");
  const radiusRoot = resolve(workspacePath, ".radius");
  const resolved = resolve(radiusRoot, rel);
  if (!isUnder(radiusRoot, resolved)) {
    throw new Error(`Path escapes the workspace .radius directory: ${raw}`);
  }
  return { radiusRoot, resolved, raw };
}

// Canonical (symlink-aware) confinement on top of the lexical check. Lexical
// checks alone miss a symlink inside `.radius/` that points outside the
// workspace (e.g. `.radius/link` -> /etc), which would let the recipe tool read
// an outside file or the extension tool's `--force` target write outside
// `.radius/`. So this canonicalizes the real `.radius/` root and the deepest
// existing part of the path (the path itself if it exists, else its nearest
// existing parent) and verifies the canonical path stays under the canonical
// root. Returns the canonical path for an existing file, or the intended path
// under the verified-real parent for a new target.
function confineUnderRadius(
  workspacePath: string | null | undefined,
  value: unknown,
  fallback: string | null | undefined
): string {
  const { radiusRoot, resolved, raw } = lexicalRadiusPath(
    workspacePath,
    value,
    fallback
  );
  // No `.radius/` yet: nothing to canonicalize against; the lexical check
  // already confined the path and the caller reports a missing source.
  if (!existsSync(radiusRoot)) return resolved;
  const realRoot = realpathSync(radiusRoot);
  const probe =
    existsSync(resolved) ? resolved : nearestExistingParent(resolved);
  const realProbe = realpathSync(probe);
  if (!isUnder(realRoot, realProbe)) {
    throw new Error(
      `Path escapes the workspace .radius directory via a symlink: ${raw}`
    );
  }
  return existsSync(resolved) ? realProbe : resolved;
}

// Resolve a source path that the tool reads or compiles (a recipe .bicep or a
// manifest). Symlink escapes are rejected; existence is left to the caller.
export function resolveExistingRadiusArtifact(
  workspacePath: string | null | undefined,
  value: unknown,
  fallback: string | null | undefined
): string {
  return confineUnderRadius(workspacePath, value, fallback);
}

// Resolve a path the tool writes, possibly creating it (the extension `.tgz`,
// published with `--force`). The final file may not exist yet, so the nearest
// existing ancestor is canonicalized to catch a symlinked intermediate
// directory pointing outside the workspace.
export function resolveRadiusArtifactTarget(
  workspacePath: string | null | undefined,
  value: unknown,
  fallback: string | null | undefined
): string {
  return confineUnderRadius(workspacePath, value, fallback);
}

// Validate that a GHCR recipe target publishes under the repository being
// modeled with an immutable tag. Requires the form
// br:ghcr.io/<owner>/<repo>[/<path>]:<tag> where <owner>/<repo> matches the
// workspace repo (GHCR image paths are lowercase). Rejects arbitrary
// registries/paths so a model-supplied string cannot publish somewhere
// unrelated to the repo, and rejects the mutable `latest` tag (and
// missing/malformed tags). Returns null when valid, else an error string.
export function validateGhcrTargetForRepo(
  target: unknown,
  workspaceRepo: string | null | undefined
): string | null {
  if (!workspaceRepo) {
    return "Cannot determine the repository being modeled; open the repository workspace before publishing a recipe.";
  }
  const match = String(target || "")
    .trim()
    .toLowerCase()
    .match(/^br:ghcr\.io\/([^:]+):([^:/]+)$/);
  if (!match) {
    return `The recipe target must be br:ghcr.io/<owner>/<repo>[/<path>]:<tag>. Received: ${target ?? "(none)"}.`;
  }
  const repoLower = workspaceRepo.toLowerCase();
  const pathPart = match[1];
  if (pathPart !== repoLower && !pathPart.startsWith(repoLower + "/")) {
    return `The recipe target must publish under the repository being modeled (br:ghcr.io/${workspaceRepo}/...). Received: ${target}.`;
  }
  if (match[2] === "latest") {
    return `The recipe target must use an immutable tag, not ':latest'. Received: ${target}.`;
  }
  return null;
}
