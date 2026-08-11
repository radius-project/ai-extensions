// Bundle-and-run the progress UX demo.
//
// `dev/progress-demo.mjs` imports the canvas server, which imports the
// TypeScript `radius-core`. Node cannot resolve that on its own, so this
// bundles the demo with the same esbuild settings the extension build uses and
// runs the result. Keeping it separate from `build.mjs` means the demo can
// never end up inside the shipped extension.
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = mkdtempSync(join(tmpdir(), "radius-demo-"));
const outfile = join(outdir, "progress-demo.mjs");
const buildOnly = process.argv.includes("--build-only");

await esbuild.build({
  entryPoints: [join(__dirname, "progress-demo.mjs")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  external: ["@github/copilot-sdk", "@github/copilot-sdk/extension"],
  loader: { ".md": "text" },
  legalComments: "none",
  logLevel: "warning"
});

if (buildOnly) {
  cleanup();
  process.exit(0);
}

const child = spawn(process.execPath, [outfile], { stdio: "inherit" });

function cleanup() {
  try {
    rmSync(outdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
child.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  });
}
