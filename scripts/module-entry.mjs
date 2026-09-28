// Shared entry-point detection for the scripts in this directory.
//
// Every script here is both an importable module and a CLI. It tells the two
// apart by comparing the path Node was invoked with, `process.argv[1]`, against
// its own module path.
//
// A lexical comparison is wrong because the two can name the same file through
// different prefixes. macOS reports temporary files under `/var/folders/...`
// while ESM resolves their module URL through the canonical
// `/private/var/folders/...`, so a script copied into a temp directory and
// spawned there never recognizes itself, runs nothing, and exits 0. Compare
// canonical paths instead.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Report whether `moduleUrl` is the module Node was asked to run.
 *
 * @param {string | undefined} argvPath `process.argv[1]`, absent when Node ran
 *   inline source such as `node -e`.
 * @param {string} moduleUrl The caller's `import.meta.url`.
 * @param {(path: string) => string} [canonicalize] Path canonicalizer, injected
 *   so tests can exercise prefix aliasing on hosts that do not alias.
 * @returns {boolean}
 */
export function isMainModule(argvPath, moduleUrl, canonicalize = realpathSync) {
  if (argvPath === undefined || argvPath === "") return false;
  // A path that cannot be canonicalized (`realpathSync` throws `ENOENT` for one
  // that does not exist) falls back to its literal value. Comparing the literal
  // is what this check did before it canonicalized, so an unresolvable
  // `argv[1]` reports "not the entry point" rather than throwing at import time
  // for every module that pulls this in.
  const canonical = (candidate) => {
    try {
      return canonicalize(candidate);
    } catch {
      return candidate;
    }
  };
  return canonical(argvPath) === canonical(fileURLToPath(moduleUrl));
}
