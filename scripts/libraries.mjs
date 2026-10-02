import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./plugins.mjs";

// npm libraries are deliberately independent of Copilot plugin discovery. A
// library declares public publish access; it stays `private` until a publish
// workflow exists, so discovery does not depend on the `private` flag.
export function libraryNames(root = repoRoot) {
  const directory = join(root, "packages");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const path = join(directory, entry.name, "package.json");
      if (!existsSync(path)) return [];
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      return manifest.publishConfig?.access === "public" ? [manifest.name] : [];
    })
    .sort();
}
