import { isAbsolute, resolve, sep } from "node:path";
import { toSafeRepoRelPath } from "./workspace.mjs";

// Resolve a tool-supplied artifact path and confine it to the workspace's
// `.radius/` directory. Model-callable publish tools use this so a generated
// value can never read or overwrite files outside the repo's `.radius`
// artifacts: absolute paths, parent-directory traversal, and anything that
// escapes `.radius/` are rejected. Returns an absolute path inside `.radius/`.
export function resolveRadiusArtifactPath(workspacePath, value, fallback) {
    if (!workspacePath) {
        throw new Error("No repository workspace is open; cannot resolve a .radius artifact path.");
    }
    const raw = value && String(value).trim() ? String(value).trim() : fallback;
    if (!raw) throw new Error("A file path is required.");
    if (isAbsolute(raw)) {
        throw new Error(`Path must be relative to the workspace .radius directory, not absolute: ${raw}`);
    }
    // Reuse the shared repo-path guard: rejects Windows-absolute paths, `..`
    // traversal, and null bytes. Then confine the result under `.radius/`.
    const rel = toSafeRepoRelPath(raw).replace(/^\.radius\//, "");
    const radiusRoot = resolve(workspacePath, ".radius");
    const resolved = resolve(radiusRoot, rel);
    const rootWithSep = radiusRoot.endsWith(sep) ? radiusRoot : radiusRoot + sep;
    if (resolved !== radiusRoot && !resolved.startsWith(rootWithSep)) {
        throw new Error(`Path escapes the workspace .radius directory: ${raw}`);
    }
    return resolved;
}

// Validate that a GHCR recipe target publishes under the repository being
// modeled with an immutable tag. Requires the form
// br:ghcr.io/<owner>/<repo>[/<path>]:<tag> where <owner>/<repo> matches the
// workspace repo (GHCR image paths are lowercase). Rejects arbitrary
// registries/paths so a model-supplied string cannot publish somewhere
// unrelated to the repo, and rejects the mutable `latest` tag (and
// missing/malformed tags). Returns null when valid, else an error string.
export function validateGhcrTargetForRepo(target, workspaceRepo) {
    if (!workspaceRepo) {
        return "Cannot determine the repository being modeled; open the repository workspace before publishing a recipe.";
    }
    const match = String(target || "").trim().toLowerCase().match(/^br:ghcr\.io\/([^:]+):([^:/]+)$/);
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
