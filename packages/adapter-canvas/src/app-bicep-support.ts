// Whether the Radius app-bicep modeling skill can model a repository at all.
//
// The skill builds the application's own container image from a Dockerfile and
// refuses, before writing anything, any repository that does not have one. That
// refusal is delivered to the user in the Copilot conversation and never
// reaches this extension, so handing off regardless leaves a graph view waiting
// for a file that is never going to be written. Both handoff paths — the canvas
// open hook and the graph routes — check here first.

// Matches `Dockerfile`, `Dockerfile.*` and `*.Dockerfile` case-insensitively,
// anywhere in the repository.
export function isDockerfilePath(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return /^dockerfile(\..+)?$/i.test(name) || /^.+\.dockerfile$/i.test(name);
}

export function appBicepNoDockerfileMessage(
  repo: string,
  branch: string
): string {
  return `${repo} has no Dockerfile on ${branch}, so the Radius app-bicep skill cannot model it: it builds the application image from one. Add a Dockerfile for the application service, then try again.`;
}

// The reason the skill would refuse this branch, or null when it would proceed.
//
// Fails open: an unreadable tree resolves empty, which is not evidence that the
// repository lacks a Dockerfile. Treating it as absence would let one transient
// listing failure permanently refuse a repository the skill can model.
export function appBicepRefusalReason(
  paths: readonly string[],
  repo: string,
  branch: string
): string | null {
  if (paths.length === 0) return null;
  if (paths.some(isDockerfilePath)) return null;
  return appBicepNoDockerfileMessage(repo, branch);
}
