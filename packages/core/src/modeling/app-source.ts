// What a repository's source listing says about whether it can be modeled.
//
// The MVP models containerized workloads only: every application workload is
// built from a Dockerfile via `Radius.Compute/containerImages`. A repository
// with no Dockerfile therefore has nothing this product can model, and modeling
// it anyway produces an ambiguous failure late, after the agent has already been
// handed the authoring instructions.
//
// The rule used to live only in the skill's prose, which made it a request the
// agent could miss rather than something the product enforced. This module makes
// it a decision: it owns the Dockerfile naming rule, the directories that are not
// application source, the classification of a listing, and the single copy of the
// user-facing message. Callers supply a file listing and nothing else, so the
// same rule applies whether the listing came from the local worktree or from a
// branch on GitHub.
//
// Pure by construction — no filesystem, no network, no node built-ins — because
// `packages/core` is compiled into the browser bundle through its barrel.

// Directories that are never application source. A vendored or generated tree
// can easily contain a Dockerfile that says nothing about the repository being
// modeled, so it must not count as evidence.
//
// This list is shared deliberately: the local worktree walker prunes these while
// descending, and a remote git-tree listing prunes nothing at all, so without one
// shared list a vendored `node_modules/**/Dockerfile` would be a false positive
// on exactly one of the two paths.
export const IGNORED_SOURCE_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "venv"
]);

// The single user-facing statement that a repository cannot be modeled because
// it has no Dockerfile. Exactly one copy exists so the tool that refuses to hand
// over the authoring instructions and the hook that denies a graph view cannot
// drift into telling the user two different things.
export const UNSUPPORTED_NO_DOCKERFILE_MESSAGE =
  "I could not find a Dockerfile in this repository. I can only create " +
  "application definitions for containerized applications. Add a Dockerfile " +
  "first, then I can create an application definition.";

// How a repository's source listing classifies for modeling purposes.
export type AppSourceStatus =
  // The listing could not be established, so nothing can be concluded. A tree
  // listing that fails returns no paths, which is indistinguishable from a
  // repository that genuinely has none — so absence of evidence is reported as
  // its own state rather than collapsed into `none`. Callers must not treat this
  // as an unsupported repository.
  | "unknown"
  // The listing is real and contains no Dockerfile: the repository is not
  // modelable by this product.
  | "none"
  // Exactly one Dockerfile, so the application source location is unambiguous.
  | "single"
  // Several Dockerfiles. This is a faithful report of multiple candidates, NOT a
  // verdict that the repository is confusing: a microservices repository builds
  // many images and is modeled into one application. Nothing consumes this state
  // yet; it exists for the "which directory holds the app source" flow.
  | "ambiguous";

export interface AppSourceEvaluation {
  status: AppSourceStatus;
  // Matching paths in root-first order, empty for `unknown` and `none`.
  dockerfiles: string[];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

// The repository's Dockerfile naming rule: `Dockerfile`, `Dockerfile.<suffix>`,
// or `<prefix>.Dockerfile`, compared case-insensitively against the BASENAME
// only. Matching the basename is what keeps a prose file such as
// `docs/my-Dockerfile-notes.md` from being read as a build file.
export function isDockerfilePath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  const name = basename(normalizePath(path)).toLowerCase();
  if (name === "dockerfile") return true;
  if (name.startsWith("dockerfile.")) return name.length > "dockerfile.".length;
  if (name.endsWith(".dockerfile")) return name.length > ".dockerfile".length;
  return false;
}

// Dot-directories the local worktree walker descends into anyway, because they
// carry repository configuration a listing is expected to include.
const SOURCE_DOT_DIRS: ReadonlySet<string> = new Set([".radius", ".github"]);

// True when any DIRECTORY segment of the path is one that never holds
// application source. The basename is excluded, so a file that happens to be
// named like an ignored directory is still considered.
//
// Dot-directories are excluded as a class, which is what the local worktree
// walker has always done while descending. Applying it here too is what keeps a
// remote listing — which prunes nothing of its own — from reaching a different
// verdict than the worktree on the same repository. It also keeps a tooling
// image such as `.devcontainer/Dockerfile` from being read as evidence that the
// application itself is containerized.
export function isIgnoredSourcePath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  const segments = normalizePath(path).split("/");
  return segments
    .slice(0, -1)
    .some(
      (segment) =>
        IGNORED_SOURCE_DIRS.has(segment) ||
        (segment.startsWith(".") && !SOURCE_DOT_DIRS.has(segment))
    );
}

// Dockerfiles in a listing, shallowest first so the repository root — the most
// likely home of the application's own build — leads, with ties broken
// alphabetically for a stable order.
export function findDockerfiles(
  paths: ReadonlyArray<unknown> | null | undefined
): string[] {
  if (!Array.isArray(paths)) return [];
  const matches = paths
    .filter((path): path is string => typeof path === "string")
    .map(normalizePath)
    .filter((path) => !isIgnoredSourcePath(path) && isDockerfilePath(path));
  const unique = [...new Set(matches)];
  return unique.sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    return depth !== 0 ? depth : a.localeCompare(b);
  });
}

// Classifies a repository source listing.
//
// A missing listing and an EMPTY listing are both `unknown`. The remote lister
// yields an empty array on any failure, so an empty result carries no
// information about the repository — and a repository with no files at all has
// no application to model either way. Reporting `unknown` keeps a failed lookup
// from being announced to the user as an unsupported repository.
export function evaluateAppSource(
  paths: ReadonlyArray<unknown> | null | undefined
): AppSourceEvaluation {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { status: "unknown", dockerfiles: [] };
  }
  const dockerfiles = findDockerfiles(paths);
  if (dockerfiles.length === 0) return { status: "none", dockerfiles: [] };
  return {
    status: dockerfiles.length === 1 ? "single" : "ambiguous",
    dockerfiles
  };
}

// The agent-facing form of {@link UNSUPPORTED_NO_DOCKERFILE_MESSAGE}. Built here
// so no caller has to restate the reason, the recovery, or the fact that nothing
// was written; a caller only decides WHEN to say it.
export function unsupportedAppSourceReport(repo?: string | null): string {
  const where = repo ? ` for ${repo}` : "";
  return [
    UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
    "",
    `Application modeling${where} stopped before it began, so no .radius files were written and none should be.`,
    "Report the statement above to the user as the outcome, and do not author, guess at, or hand-write an application model. The repository becomes modelable once it contains a Dockerfile for the application."
  ].join("\n");
}
