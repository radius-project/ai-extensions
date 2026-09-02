// Builds the Windows GUI-subsystem launcher that every managed rad invocation
// runs through on Windows.
//
// The executables are build output, not source: they are produced from
// native/windows-launcher/main.go, ignored by git, and assembled into
// plugins/<plugin>/dist by packages/adapter-canvas/build.mjs. Because the plugin
// ships both Windows architectures regardless of the host that built it, both
// are always cross-compiled here.
//
// Go emits a reproducible executable for a given toolchain and source, so the
// flags below stay deterministic: no VCS stamp, no absolute paths, no build ID.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");

export const windowsLauncherSourceDirectory = join(
  repoRoot,
  "packages",
  "adapter-shared",
  "native",
  "windows-launcher"
);
export const windowsLauncherBinDirectory = join(
  windowsLauncherSourceDirectory,
  "bin"
);

// Every input whose change must invalidate an already built executable. The Go
// package is globbed rather than listed so a second source file cannot silently
// ship a stale executable, and the module files are named because a dependency
// or toolchain change alters the output just as much as the source does.
function sourceInputs() {
  const goFiles = readdirSync(windowsLauncherSourceDirectory)
    .filter((entry) => entry.endsWith(".go"))
    .map((entry) => join(windowsLauncherSourceDirectory, entry));
  const moduleFiles = ["go.mod", "go.sum"]
    .map((entry) => join(windowsLauncherSourceDirectory, entry))
    .filter((path) => existsSync(path));
  return [...goFiles, ...moduleFiles];
}

export const windowsLauncherArchitectures = [
  { go: "amd64", node: "x64", machine: 0x8664 },
  { go: "arm64", node: "arm64", machine: 0xaa64 }
];

export function windowsLauncherFilename(architecture) {
  return `windows-radius-launcher-${architecture.node}.exe`;
}

export function windowsLauncherPath(architecture) {
  return join(
    windowsLauncherBinDirectory,
    windowsLauncherFilename(architecture)
  );
}

// A launcher that is not a Windows GUI-subsystem PE for the expected machine
// would reintroduce the console window this mechanism exists to remove, so the
// build refuses to hand one on.
function assertWindowsGuiExecutable(path, machine) {
  const executable = readFileSync(path);
  if (executable.toString("ascii", 0, 2) !== "MZ") {
    throw new Error(`${path} is not a Windows PE executable.`);
  }
  const peOffset = executable.readUInt32LE(0x3c);
  if (executable.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error(`${path} has no PE signature.`);
  }
  const actualMachine = executable.readUInt16LE(peOffset + 4);
  if (actualMachine !== machine) {
    throw new Error(
      `${path} has PE machine 0x${actualMachine.toString(16)}, expected 0x${machine.toString(16)}.`
    );
  }
  const subsystem = executable.readUInt16LE(peOffset + 24 + 68);
  if (subsystem !== 2) {
    throw new Error(
      `${path} has PE subsystem ${subsystem}, expected Windows GUI (2).`
    );
  }
}

function newestSourceTimestamp() {
  const inputs = sourceInputs();
  if (inputs.length === 0) {
    throw new Error(
      `No Go sources found in ${windowsLauncherSourceDirectory}; the Windows launcher cannot be built.`
    );
  }
  return Math.max(...inputs.map((path) => statSync(path).mtimeMs));
}

function isUpToDate(output, sourceTimestamp) {
  if (!existsSync(output)) return false;
  return statSync(output).mtimeMs >= sourceTimestamp;
}

function build(output, architecture) {
  // The launchers are unsigned. Under WDAC/AppLocker an unsigned binary is
  // denied outright, and a small Go executable that spawns a process and
  // creates a Job Object is a common AV false positive. Authenticode signing is
  // tracked in https://github.com/radius-project/ai-extensions/issues/699.
  try {
    execFileSync(
      "go",
      [
        "build",
        "-buildvcs=false",
        "-trimpath",
        "-ldflags=-buildid= -H=windowsgui -s -w",
        "-o",
        output,
        "."
      ],
      {
        cwd: windowsLauncherSourceDirectory,
        env: {
          ...process.env,
          CGO_ENABLED: "0",
          GOARCH: architecture.go,
          GOOS: "windows"
        },
        stdio: "inherit"
      }
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "Building the Windows Radius launcher requires the Go toolchain on PATH. " +
          `Install the version recorded in ${join(windowsLauncherSourceDirectory, "go.mod")} and rebuild.`,
        { cause: error }
      );
    }
    throw error;
  }
  assertWindowsGuiExecutable(output, architecture.machine);
}

/**
 * Produces both Windows launchers, skipping an architecture whose executable is
 * already newer than every build input unless `force` is set.
 *
 * @param {{ force?: boolean }} [options]
 * @returns {string[]} the absolute path of each launcher, built or reused.
 */
export function ensureWindowsLaunchers({ force = false } = {}) {
  const sourceTimestamp = newestSourceTimestamp();
  mkdirSync(windowsLauncherBinDirectory, { recursive: true });
  return windowsLauncherArchitectures.map((architecture) => {
    const output = windowsLauncherPath(architecture);
    if (force || !isUpToDate(output, sourceTimestamp)) {
      build(output, architecture);
    }
    return output;
  });
}

const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  // An explicit build rebuilds by default: it is the command a developer runs
  // after changing the Go source or switching toolchains. `--if-needed` is for
  // callers that only require the executables to exist and be current.
  ensureWindowsLaunchers({ force: !process.argv.includes("--if-needed") });
}
