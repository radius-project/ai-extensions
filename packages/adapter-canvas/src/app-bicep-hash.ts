// SHA-256 fingerprint of an application model.
//
// This lives in the adapter rather than in `@radius-project/core` because core
// is compiled into the browser bundle through its package barrel, so it cannot
// import `node:crypto`. Core owns the normalization (which text differences are
// meaningful) and injects this function to do the hashing.
//
// The algorithm and output format must stay byte-compatible with the plugin's
// `write-app-origin.mjs`, which re-implements them because it ships inside the
// installed plugin where the workspace packages do not exist. A collocated
// contract test asserts the two agree.

import { createHash } from "node:crypto";
import { normalizeAppBicep } from "@radius-project/core";

export const APP_BICEP_HASH_ALGORITHM = "sha256";

export function hashAppBicep(content: string): string {
  const digest = createHash(APP_BICEP_HASH_ALGORITHM)
    .update(normalizeAppBicep(content), "utf8")
    .digest("hex");
  return `${APP_BICEP_HASH_ALGORITHM}:${digest}`;
}
