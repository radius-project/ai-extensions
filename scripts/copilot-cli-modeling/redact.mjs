// Removes GitHub credentials from text before the job writes it to an
// artifact or a log. The run uploads CLI logs and session events, and any of
// them can echo a token.

import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const TOKEN_PATTERN = /\b(gh[opsur]_|github_pat_)[A-Za-z0-9_]{8,}/g;
const MIN_SECRET_LENGTH = 8;
const MAX_GUNZIP_BYTES = 64 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Why the copy skipped a file. */
export const BINARY_WITH_SECRET = "binary, and it may hold a secret";

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

/**
 * Whether binary data may hold a secret. Latin-1 maps each byte to one
 * character, so the check finds the secrets' UTF-8 bytes. It also checks the
 * data in a gzip file, such as a `.tgz` package. Gzip data that it cannot
 * read may hold a secret.
 */
function binaryMayHoldSecret(bytes, secrets) {
  const latin1 = secrets.map((secret) =>
    Buffer.from(secret, "utf8").toString("latin1")
  );

  const found = (data) => {
    const text = data.toString("latin1");

    return redactSecrets(text, latin1) !== text;
  };

  if (found(bytes)) return true;

  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return false;

  try {
    return found(gunzipSync(bytes, { maxOutputLength: MAX_GUNZIP_BYTES }));
  } catch {
    return true;
  }
}

/**
 * Copies a file with secrets removed. It copies a file that is not UTF-8
 * text byte for byte, unless the file may hold a secret.
 *
 * @returns Whether it copied the file.
 */
export async function copyRedacted(from, to, secrets) {
  const bytes = await fs.readFile(from);
  let content;

  try {
    content = redactSecrets(UTF8.decode(bytes), secrets);
  } catch {
    if (binaryMayHoldSecret(bytes, secrets)) return false;
    content = bytes;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.writeFile(to, content);

  return true;
}

/**
 * Copies the regular files under `from` with secrets removed. It skips
 * symbolic links, so a link cannot copy a file from outside `from`.
 *
 * @returns Each file that it skipped, relative to `from`, with the reason.
 */
export async function copyRedactedDirectory(from, to, secrets) {
  const skipped = [];

  for (const entry of await fs.readdir(from, {
    recursive: true,
    withFileTypes: true
  })) {
    if (entry.isDirectory()) continue;
    const name = path.relative(from, path.join(entry.parentPath, entry.name));

    if (!entry.isFile()) skipped.push(`${name}: not a regular file`);
    else if (
      !(await copyRedacted(path.join(from, name), path.join(to, name), secrets))
    )
      skipped.push(`${name}: ${BINARY_WITH_SECRET}`);
  }

  return skipped;
}
