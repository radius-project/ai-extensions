// Removes GitHub credentials from text before the job writes it to an
// artifact or a log. The run uploads CLI logs and session events, and any of
// them can echo a token.

import fs from "node:fs/promises";
import path from "node:path";

const TOKEN_PATTERN = /\b(gh[opsur]_|github_pat_)[A-Za-z0-9_]{8,}/g;
const MIN_SECRET_LENGTH = 8;

/**
 * @param secrets Exact values to remove as well, such as the token the run
 *   seeded. Values shorter than 8 characters are ignored so that an empty or
 *   trivial value cannot erase ordinary text.
 */
export function redactSecrets(text, secrets = []) {
  let result = text.replace(TOKEN_PATTERN, "$1[REDACTED]");

  for (const secret of secrets)
    if (secret.length >= MIN_SECRET_LENGTH)
      result = result.split(secret).join("[REDACTED]");

  return result;
}

/** Copies a text file with secrets removed. */
export async function copyRedacted(from, to, secrets) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.writeFile(
    to,
    redactSecrets(await fs.readFile(from, "utf8"), secrets)
  );
}

/**
 * Copies the regular files under `from` with secrets removed. It skips
 * symbolic links, so a link cannot copy a file from outside `from`.
 */
export async function copyRedactedDirectory(from, to, secrets) {
  for (const entry of await fs.readdir(from, {
    recursive: true,
    withFileTypes: true
  }))
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      await copyRedacted(
        file,
        path.join(to, path.relative(from, file)),
        secrets
      );
    }
}
