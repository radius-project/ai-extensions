// End-to-end test runner for radius-core.
//
// The product source is UI-agnostic TypeScript/ESM that uses `.js` import
// specifiers resolving to `.ts` files (moduleResolution: "bundler"). Node's
// test runner cannot execute that directly, so — mirroring the canvas build
// pipeline (adapters/canvas/build.mjs) — we reuse esbuild to bundle each test
// into a runnable ESM file, then execute the bundles with Node's built-in test
// runner (`node:test`). No new test framework is introduced.

import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const e2eDir = join(__dirname, "e2e");

// Discover every *.test.ts under test/e2e.
const entryPoints = readdirSync(e2eDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join(e2eDir, f));

if (entryPoints.length === 0) {
  console.error("[test] no *.test.ts files found under test/e2e");
  process.exit(1);
}

const outDir = mkdtempSync(join(tmpdir(), "radius-e2e-"));

try {
  await esbuild.build({
    entryPoints,
    outdir: outDir,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    // Keep node builtins (incl. node:test) external; bundle the workspace core.
    packages: undefined,
    logLevel: "warning",
    // Preserve original file names so test output is readable.
    entryNames: "[name]",
    outExtension: { ".js": ".mjs" },
  });

  const bundles = readdirSync(outDir)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => resolve(outDir, f));

  const result = spawnSync(process.execPath, ["--test", ...bundles], {
    stdio: "inherit",
  });

  process.exit(result.status ?? 1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
