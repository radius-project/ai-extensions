// Staged modeling runs. A Radius modeling skill writes each run into
// `.radius/.staging-<id>/` and moves the files into `.radius/` only when the
// run's check passes, so a run that stops partway leaves `.radius/` as it was.
// The skills' scripts own that move (see `beginRun` and `publishRun` in
// extensions/radius/skills/radius-app-*/scripts/common.mjs). The canvas only
// reads a staging directory as a sign that a run is in progress.

// Prefix of a staging directory directly under `.radius/`. The skills' scripts
// use the same prefix.
export const STAGING_DIR_PREFIX = ".staging-";

// Files that every published model holds.
export const REQUIRED_STAGED_FILES: readonly string[] = [
  "app.bicep",
  "bicepconfig.json",
  "app.origin.json"
];

// Recognizes a staging name, not whether the entry is active or safe to remove.
export function isStagingDirName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    name.startsWith(STAGING_DIR_PREFIX) &&
    name.length > STAGING_DIR_PREFIX.length
  );
}
