import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./plugins.mjs";

// npm libraries are deliberately independent of Copilot plugin discovery. A
// library declares public publish access, so discovery does not depend on the
// `private` flag or include internal adapters.
export function libraryPackages(root = repoRoot) {
  const directory = join(root, "packages");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const path = join(directory, entry.name, "package.json");
      if (!existsSync(path)) return [];
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      return manifest.publishConfig?.access === "public" ?
          [{ directory: join(directory, entry.name), manifest }]
        : [];
    });
}

export function libraryNames(root = repoRoot) {
  return libraryPackages(root)
    .map(({ manifest }) => manifest.name)
    .sort();
}
