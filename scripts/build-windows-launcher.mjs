import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const sourceDirectory = join(
  repoRoot,
  "packages",
  "adapter-shared",
  "native",
  "windows-launcher"
);
const outputDirectory = join(sourceDirectory, "bin");
const check = process.argv.includes("--check");
const architectures = [
  { go: "amd64", node: "x64", machine: 0x8664 },
  { go: "arm64", node: "arm64", machine: 0xaa64 }
];

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

function build(output, architecture) {
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
      cwd: sourceDirectory,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOARCH: architecture.go,
        GOOS: "windows"
      },
      stdio: "inherit"
    }
  );
  assertWindowsGuiExecutable(output, architecture.machine);
}

if (check) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "windows-radius-launcher-")
  );
  try {
    for (const architecture of architectures) {
      const name = `windows-radius-launcher-${architecture.node}.exe`;
      const expected = join(outputDirectory, name);
      if (!existsSync(expected)) {
        throw new Error(`Missing committed launcher: ${expected}`);
      }
      const rebuilt = join(temporaryDirectory, name);
      build(rebuilt, architecture);
      if (!readFileSync(expected).equals(readFileSync(rebuilt))) {
        throw new Error(
          `${name} is stale. Run "pnpm run build:windows-launcher" with the pinned Go version.`
        );
      }
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
} else {
  mkdirSync(outputDirectory, { recursive: true });
  for (const architecture of architectures) {
    const name = `windows-radius-launcher-${architecture.node}.exe`;
    build(join(outputDirectory, name), architecture);
  }
}
