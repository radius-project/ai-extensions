import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The Windows launchers are compiled build output rather than committed files,
// and every Windows test that spawns a managed rad process resolves them from
// disk. Building them once before the package's suites run keeps a clean
// checkout working and guarantees the tests exercise the current Go source
// instead of a stale executable left in the working tree.
const buildScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "build-windows-launcher.mjs"
);

export default function ensureWindowsLaunchers(): void {
  if (process.platform !== "win32") return;
  execFileSync(process.execPath, [buildScript, "--if-needed"], {
    stdio: "inherit"
  });
}
