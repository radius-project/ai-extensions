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

// ---------------------------------------------------------------------------
// Multiple candidates: the facts, not the verdict.
//
// `ambiguous` reports several Dockerfiles, which is NOT by itself a problem to
// raise with the user. The product deliberately models a microservices
// repository — many Dockerfiles, many services — into ONE application: the skill
// requires exactly one `Radius.Core/applications`, names it after the
// repository, and has explicit inter-service addressing rules. So a Dockerfile
// count can never be the trigger for asking where the application lives.
//
// The real trigger is one of: the repository holds more than one INDEPENDENT
// application, which a single definition cannot represent; or nothing in it
// looks like an application at all, for example Dockerfiles that build only
// tooling or CI images. Neither is decidable from a file listing. Any rule that
// tried would be a heuristic that is wrong much of the time, and being wrong
// here is expensive in both directions: a spurious question interrupts a
// perfectly ordinary monorepo, and a missed one silently models two unrelated
// applications as one.
//
// So the decision is split. This module owns the mechanical half — which
// directories are candidates, which workspace manifests are present, and the
// single copy of the user-facing question — and the agent, which has read the
// source, owns the judgment. That split is a deliberate, agreed exception to
// this package owning the whole rule.
// ---------------------------------------------------------------------------

// The single user-facing question asked when no application can be identified.
// It lives beside UNSUPPORTED_NO_DOCKERFILE_MESSAGE so the two things we say
// about an unmodelable repository cannot drift apart.
export const UNIDENTIFIED_APPLICATION_MESSAGE =
  "I looked through the repository but could not identify an application or " +
  "application resources. Which directory contains your application source " +
  "code and Dockerfile?";

// Root-level files that declare a multi-project workspace. Their presence is
// evidence FOR one coordinated repository, not against it — a pnpm workspace or
// a Go workspace is the normal shape of a microservices application whose
// services ship together. It is offered to the agent as a signal to weigh, never
// as a rule that decides.
//
// Deliberately path-only. A Cargo workspace is declared by a `[workspace]` table
// inside a root `Cargo.toml`, which cannot be established from a listing, so it
// is not claimed here rather than being guessed at from the filename.
export const WORKSPACE_MANIFEST_FILES: readonly string[] = [
  "pnpm-workspace.yaml",
  "go.work",
  "lerna.json",
  "nx.json",
  "rush.json",
  "turbo.json"
];

// Candidate directories come from repository filenames, and they are
// interpolated into instructions the agent reads. A path is caller-controlled
// data, not trusted prose: backticks would break out of the inline code span,
// and newlines or control characters would let a crafted directory name forge
// its own instruction lines. Reduce each to a single inert, bounded token, the
// same way the skill intro treats its repo path.
function sanitizeForPrompt(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// A crafted or generated repository can hold an unbounded number of Dockerfile
// directories, and the brief is appended to an already-large prompt. Listing
// every one could crowd out the skill itself, so the list is bounded and the
// remainder reported as a count.
const MAX_LISTED_CANDIDATES = 25;

// The directory that owns a Dockerfile, as a repo-relative path; the repository
// root is reported as ".".
function directoryOf(dockerfile: string): string {
  const slash = normalizePath(dockerfile).lastIndexOf("/");
  return slash === -1 ? "." : normalizePath(dockerfile).slice(0, slash);
}

// Candidate application-source directories, derived from Dockerfile paths and
// deduplicated, preserving findDockerfiles' root-first order. Two Dockerfiles in
// one directory describe one candidate location, not two.
export function dockerfileDirectories(
  dockerfiles: ReadonlyArray<unknown> | null | undefined
): string[] {
  if (!Array.isArray(dockerfiles)) return [];
  const directories = dockerfiles
    .filter((path): path is string => typeof path === "string")
    .map(directoryOf);
  return [...new Set(directories)];
}

// Root-level workspace manifests present in a listing, in WORKSPACE_MANIFEST_FILES
// order. Root-level only: a manifest nested inside one package describes that
// package, not the repository.
export function findWorkspaceManifests(
  paths: ReadonlyArray<unknown> | null | undefined
): string[] {
  if (!Array.isArray(paths)) return [];
  const present = new Set(
    paths
      .filter((path): path is string => typeof path === "string")
      .map(normalizePath)
  );
  return WORKSPACE_MANIFEST_FILES.filter((file) => present.has(file));
}

// The agent-facing brief for a repository with several Dockerfiles.
//
// Returns null for every other status, so a caller can hand the result straight
// to the modeling instructions: there is nothing to say when the source location
// is unambiguous, and 2.1 already owns the no-Dockerfile case.
//
// The text leads with the default — model this as ONE application — because that
// is the correct outcome for the common case, and an agent handed a list of
// candidates with no framing will read the list itself as a problem. Asking is
// the exception, and the question is quoted verbatim so it reaches the user in
// the words this product specified.
export function ambiguousAppSourceBrief(
  evaluation: AppSourceEvaluation | null | undefined,
  paths?: ReadonlyArray<unknown> | null
): string | null {
  if (evaluation?.status !== "ambiguous") return null;
  const directories = dockerfileDirectories(evaluation.dockerfiles);
  const manifests = findWorkspaceManifests(paths);
  const shown = directories.slice(0, MAX_LISTED_CANDIDATES);
  const lines = [
    "## Where the application lives",
    "",
    `This repository has ${directories.length} Dockerfile candidate ${directories.length === 1 ? "directory" : "directories"}:`,
    "",
    ...shown.map((dir) => `- \`${sanitizeForPrompt(dir)}\``)
  ];
  if (directories.length > shown.length) {
    lines.push(`- …and ${directories.length - shown.length} more`);
  }
  if (manifests.length > 0) {
    lines.push(
      "",
      `It also declares a multi-project workspace (${manifests.map((file) => `\`${file}\``).join(", ")}). That describes how the repository is ORGANIZED, not that its projects form one application — independent applications share these tools too. Weigh it against the source, do not conclude from it.`
    );
  }
  lines.push(
    "",
    "A Dockerfile count is never decisive. Several Dockerfiles are normal and are NOT by themselves a reason to ask the user anything: a microservices repository builds many images and is still ONE application. Nor does this list establish what to model — a Dockerfile may build a CI image, a migration or tooling image, an unused example, or an alternative to another one.",
    "",
    "So read the source and establish which of these directories hold application services that share a runtime and deploy together. Model every service you establish that way into a single `Radius.Core/applications` named after the repository, wired together with the skill's addressing rules. For an ordinary multi-service repository that is the expected outcome.",
    "",
    "Ask the user only if, after reading the source, you cannot identify an application at all — because the repository holds more than one INDEPENDENT application that a single definition cannot represent, or because nothing here is an application and the Dockerfiles only build tooling or CI images. In that case ask exactly:",
    "",
    `> ${UNIDENTIFIED_APPLICATION_MESSAGE}`,
    "",
    "Then stop: write no `.radius` files, author no model, and do not guess a directory on the user's behalf. They will answer with a directory and ask for analysis again, which scopes the next run to it. A directory you picked yourself is not an answer."
  );
  return lines.join("\n");
}
