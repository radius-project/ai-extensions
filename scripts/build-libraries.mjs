import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { repoRoot } from "./plugins.mjs";
import {
  validateBuildBoundary,
  libraryExternalImports,
  validateStylesheetBoundary
} from "./library-artifacts.mjs";

const require = createRequire(import.meta.url);
const compiler = join(
  dirname(require.resolve("typescript/package.json")),
  "bin",
  "tsc"
);
const packages = [
  { directory: "core", entries: ["graph/index", "domain/index"] },
  { directory: "graph-react", entries: ["index", "brand"] }
];

for (const { directory, entries } of packages) {
  const root = join(repoRoot, "packages", directory);
  const outdir = join(root, "dist");
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [compiler, "-p", "tsconfig.build.json"],
    { cwd: root, stdio: "inherit" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${directory} declarations failed (${result.status}).`);
  }
  const built = await build({
    absWorkingDir: root,
    entryPoints: entries.map((entry) => `src/${entry}.ts`),
    outbase: "src",
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    external: libraryExternalImports(directory),
    target: "es2022",
    metafile: true
  });
  const bundledRoots = validateBuildBoundary(built.metafile, directory);
  if (bundledRoots.size > 0) {
    const notices = await Promise.all(
      [...bundledRoots].sort().map(async (dependency) => {
        const directory = join(root, dependency);
        const manifest = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8")
        );
        return `${manifest.name}@${manifest.version}\n\n${await readFile(join(directory, "LICENSE"), "utf8")}`;
      })
    );
    await writeFile(
      join(outdir, "THIRD_PARTY_NOTICES.txt"),
      notices.join("\n\n")
    );
  }
  // Keep the boundary audit beside the candidate, not in its public package.
  await mkdir(join(repoRoot, ".artifacts", "libraries"), { recursive: true });
  await writeFile(
    join(repoRoot, ".artifacts", "libraries", `${directory}-build.json`),
    `${JSON.stringify(built.metafile, null, 2)}\n`
  );
  await copyFile(join(repoRoot, "LICENSE"), join(outdir, "LICENSE"));
  if (directory === "graph-react") {
    for (const entry of ["base.css", "styles.css"]) {
      const stylesheet = await build({
        absWorkingDir: root,
        entryPoints: [`src/${entry}`],
        outfile: join(outdir, entry),
        bundle: true,
        target: "es2022",
        metafile: true
      });
      validateStylesheetBoundary(stylesheet.metafile, entry);
      await writeFile(
        join(
          repoRoot,
          ".artifacts",
          "libraries",
          entry === "base.css" ?
            "graph-react-base-css-build.json"
          : "graph-react-css-build.json"
        ),
        `${JSON.stringify(stylesheet.metafile, null, 2)}\n`
      );
    }
  }
}
