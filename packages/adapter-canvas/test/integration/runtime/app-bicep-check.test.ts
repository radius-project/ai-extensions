import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, it, test } from "vitest";
import {
  REPAIR_ATTEMPT_BUDGET,
  REPEATED_FAILURE_MESSAGE,
  STAGING_RUN_RECORD,
  evaluateRepairAttempt,
  fingerprintCompilerOutput,
  isRepeatedFailure,
  parseRepairState
} from "@radius-project/core/modeling";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
);
const checker = path.join(
  root,
  "plugins",
  "radius",
  "skills",
  "radius-app-bicep",
  "scripts",
  "validate-bicep.mjs"
);
const executable = process.platform === "win32" ? "bicep.exe" : "bicep";
const temporaryDirectories = new Set<string>();

// A wrong relative depth here would not fail loudly: every case would spawn Node
// against a missing script, which exits 1 with a message on stderr, and that is
// all `fails closed when the managed Bicep executable is missing` asserts. Check
// the path once rather than letting the suite pass for the wrong reason.
assert.ok(fs.existsSync(checker), `checker script not found: ${checker}`);

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
}, 30_000);

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "app-bicep-check-"));
  temporaryDirectories.add(directory);
  return directory;
}

interface ExecutableHomeFs {
  mkdtemp(prefix: string): string;
  mkdir(directory: string): void;
  copyFile(source: string, destination: string): void;
  chmod(file: string, mode: number): void;
  remove(directory: string): void;
}

interface ExecutableHome {
  path(): string;
  cleanup(): void;
}

const nodeExecutableHomeFs: ExecutableHomeFs = {
  mkdtemp: (prefix) => fs.mkdtempSync(prefix),
  mkdir: (directory) => {
    fs.mkdirSync(directory, { recursive: true });
  },
  copyFile: (source, destination) => {
    fs.copyFileSync(source, destination);
  },
  chmod: (file, mode) => {
    // Windows has no mode bits, so the port models "make this executable" and
    // this adapter is where that becomes a no-op.
    if (process.platform === "win32") {
      return;
    }
    fs.chmodSync(file, mode);
  },
  remove: (directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

// The checker resolves the managed Bicep binary from the home directory but
// resolves the driver script from the application's own directory, so one home
// shared by every case still gives each case its own driver. Installing the
// ~78 MB stand-in per case instead made each test copy the Node binary, because
// Windows refuses to hardlink it out of C:\Program Files, and made each cleanup
// delete a file that size.
function executableHome(
  source: string,
  io: ExecutableHomeFs = nodeExecutableHomeFs
): ExecutableHome {
  // The directory is tracked separately from the installed binary so a failed
  // installation is still cleaned up, while only a home that actually holds the
  // binary is ever handed to a case. Both a failure and a cleanup latch: the
  // first because retrying the ~78 MB copy for each of the remaining cases would
  // spend the rest of the run on the I/O this shared home exists to avoid, and
  // would report the same low-level error 60-odd times instead of once; the
  // second because a home minted after `afterAll` would have nothing left to
  // remove it.
  let created: string | undefined;
  let installed: string | undefined;
  let failure: Error | undefined;
  let closed = false;

  function install(): string {
    const home = io.mkdtemp(path.join(os.tmpdir(), "app-bicep-check-home-"));
    created = home;
    const bicep = path.join(
      home,
      ".radius",
      "ai-extensions",
      "bin",
      executable
    );
    io.mkdir(path.dirname(bicep));
    io.copyFile(source, bicep);
    // `copyFile` gives the destination the source's mode, but that mode is still
    // filtered through the umask, so ask for the execute bit explicitly.
    io.chmod(bicep, 0o755);
    return home;
  }

  return {
    path() {
      if (closed) {
        throw new Error("the shared stand-in home has already been removed");
      }
      if (failure !== undefined) {
        throw failure;
      }
      if (installed === undefined) {
        try {
          installed = install();
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          throw failure;
        }
      }
      return installed;
    },
    cleanup() {
      closed = true;
      const directory = created;
      created = undefined;
      installed = undefined;
      if (directory !== undefined) {
        io.remove(directory);
      }
    }
  };
}

const sharedHome = executableHome(fs.realpathSync(process.execPath));

afterAll(() => {
  sharedHome.cleanup();
});

// The cases below drive `executableHome` through a fake filesystem, so unlike
// the rest of the file they spawn nothing. They live here rather than in `src/`
// because the thing they cover is this suite's own fixture, which exists only to
// serve the child-process cases it sits next to.
function recordedHomeFs(failures: { mkdir?: number; copyFile?: number } = {}) {
  const created: string[] = [];
  const attempted: string[] = [];
  const installed: string[] = [];
  const executables: string[] = [];
  const removed: string[] = [];
  let directories = 0;
  let mkdirs = 0;
  let copies = 0;
  const io: ExecutableHomeFs = {
    mkdtemp(prefix) {
      directories += 1;
      const directory = `${prefix}${directories}`;
      created.push(directory);
      return directory;
    },
    mkdir() {
      mkdirs += 1;
      if (mkdirs <= (failures.mkdir ?? 0)) {
        throw new Error("mkdir failed");
      }
    },
    copyFile(_source, destination) {
      copies += 1;
      attempted.push(destination);
      if (copies <= (failures.copyFile ?? 0)) {
        throw new Error("copy failed");
      }
      installed.push(destination);
    },
    chmod(file) {
      executables.push(file);
    },
    remove(directory) {
      removed.push(directory);
    }
  };
  return { io, created, attempted, installed, executables, removed };
}

function captureError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected the call to throw");
}

test("installs the shared stand-in binary once for repeated use", () => {
  const { io, created, installed, executables } = recordedHomeFs();
  const home = executableHome("node", io);

  const first = home.path();

  assert.equal(home.path(), first);
  assert.deepEqual(created, [first]);
  assert.deepEqual(installed, [
    path.join(first, ".radius", "ai-extensions", "bin", executable)
  ]);
  assert.deepEqual(executables, installed);
});

test("removes a stand-in home left behind by a failed copy", () => {
  const { io, created, removed } = recordedHomeFs({ copyFile: 1 });
  const home = executableHome("node", io);

  assert.throws(() => home.path(), /copy failed/u);
  home.cleanup();

  assert.equal(created.length, 1);
  assert.deepEqual(removed, created);
});

test("removes a stand-in home left behind by a failed directory creation", () => {
  const { io, created, attempted, removed } = recordedHomeFs({ mkdir: 1 });
  const home = executableHome("node", io);

  assert.throws(() => home.path(), /mkdir failed/u);
  home.cleanup();

  assert.equal(created.length, 1);
  assert.deepEqual(attempted, []);
  assert.deepEqual(removed, created);
});

test("reuses the first installation failure instead of copying again", () => {
  const { io, created, attempted, installed } = recordedHomeFs({ copyFile: 1 });
  const home = executableHome("node", io);
  const first = captureError(() => home.path());

  const second = captureError(() => home.path());

  assert.equal(second, first);
  assert.match(first.message, /copy failed/u);
  assert.equal(created.length, 1);
  assert.equal(attempted.length, 1);
  assert.deepEqual(installed, []);
});

test("removes the shared stand-in home only once", () => {
  const { io, created, removed } = recordedHomeFs();
  const home = executableHome("node", io);
  home.path();

  home.cleanup();
  home.cleanup();

  assert.deepEqual(removed, created);
});

test("refuses to hand out a stand-in home after cleanup", () => {
  const { io, created, removed } = recordedHomeFs();
  const home = executableHome("node", io);
  home.path();
  home.cleanup();

  assert.throws(() => home.path(), /already been removed/u);
  assert.equal(created.length, 1);
  assert.deepEqual(removed, created);
});

test("removes nothing when no stand-in home was created", () => {
  const { io, removed } = recordedHomeFs();

  executableHome("node", io).cleanup();

  assert.deepEqual(removed, []);
});

function fakeBicep(
  directory: string,
  compilerOutput: string,
  status: number,
  compiledOutput = "{}"
): NodeJS.ProcessEnv {
  const home = sharedHome.path();
  const driver = path.join(directory, "build");
  fs.writeFileSync(
    driver,
    [
      "if (!process.argv.includes('--diagnostics-format') || !process.argv.includes('sarif')) process.exit(2);",
      `process.stdout.write(${JSON.stringify(compiledOutput)});`,
      `process.stderr.write(${JSON.stringify(compilerOutput)});`,
      `process.exit(${status});`,
      ""
    ].join("\n")
  );
  return { HOME: home, USERPROFILE: home };
}

function runChecker(directory: string, env: NodeJS.ProcessEnv, appSource = "") {
  const app = path.join(directory, "app.bicep");
  fs.writeFileSync(app, appSource);
  return spawnSync(process.execPath, [checker, app], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

function sarif(results: unknown[]): string {
  return JSON.stringify({ runs: [{ results }] });
}

function compiledBicepFixture(name: string): string {
  return fs.readFileSync(
    path.join(
      root,
      "packages",
      "adapter-canvas",
      "test",
      "fixtures",
      "app-bicep-check",
      name,
      "compiled.json"
    ),
    "utf8"
  );
}

const containerImageType = "Radius.Compute/containerImages@2025-08-01-preview";
const fullSha = "a".repeat(40);
const interpolatedGitRef =
  "[format('git::https://github.com/example/app.git?ref={0}', parameters('gitRef'))]";

function radiusResource<T extends object>(type: string, properties: T) {
  return { type, properties: { properties } };
}

function imageResource(source: unknown) {
  return radiusResource(containerImageType, {
    build: { source }
  });
}

function localModule(
  source: string,
  parameters: object = {},
  parameterValues: object = {}
) {
  return localModuleResources(
    { image: imageResource(source) },
    parameters,
    parameterValues
  );
}

function localModuleResources(
  resources: object,
  parameters: object = {},
  parameterValues: object = {}
) {
  return {
    type: "Microsoft.Resources/deployments",
    properties: {
      parameters: parameterValues,
      template: {
        resources,
        parameters
      }
    }
  };
}

function template(resources: object, parameters: object = {}): string {
  return JSON.stringify({ resources, parameters });
}

test("passes a warning-free Bicep compilation", () => {
  const directory = temporaryDirectory();
  const result = runChecker(directory, fakeBicep(directory, sarif([]), 0));

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("fails and surfaces a Bicep warning even when Bicep exits successfully", () => {
  const directory = temporaryDirectory();
  const result = runChecker(
    directory,
    fakeBicep(
      directory,
      sarif([
        {
          ruleId: "use-secure-value-for-secure-inputs",
          message: { text: "Property 'password' expects a secure value." },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "file:///tmp/app.bicep" },
                region: { startLine: 12 }
              }
            }
          ]
        }
      ]),
      0
    )
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /app\.bicep:12: warning use-secure-value-for-secure-inputs: Property 'password' expects a secure value\./u
  );
});

test("surfaces informational diagnostics without failing", () => {
  const directory = temporaryDirectory();
  const result = runChecker(
    directory,
    fakeBicep(
      directory,
      sarif([
        {
          level: "note",
          ruleId: "no-unused-vars",
          message: { text: "Variable 'unused' is declared but never used." }
        }
      ]),
      0
    )
  );

  assert.equal(result.status, 0);
  assert.match(result.stderr, /note no-unused-vars/u);
});

test("preserves a Bicep compiler failure", () => {
  const directory = temporaryDirectory();
  const result = runChecker(
    directory,
    fakeBicep(
      directory,
      sarif([
        {
          level: "error",
          ruleId: "BCP007",
          message: { text: "This declaration type is not recognized." }
        }
      ]),
      1
    )
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /error BCP007: This declaration type is not recognized\./u
  );
});

test("fails closed when Bicep diagnostics are not valid SARIF", () => {
  const directory = temporaryDirectory();
  const result = runChecker(
    directory,
    fakeBicep(directory, "warning: boom", 0)
  );

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "warning: boom\n");
});

it.each([
  { name: "missing runs", output: JSON.stringify({}) },
  { name: "an empty runs array", output: JSON.stringify({ runs: [] }) },
  { name: "a null run", output: JSON.stringify({ runs: [null] }) },
  {
    name: "non-array results",
    output: JSON.stringify({ runs: [{ results: {} }] })
  },
  {
    name: "a null result",
    output: JSON.stringify({ runs: [{ results: [null] }] })
  }
])("fails closed for SARIF with $name", ({ output }) => {
  const directory = temporaryDirectory();
  const result = runChecker(directory, fakeBicep(directory, output, 0));

  assert.equal(result.status, 1);
  assert.notEqual(result.stderr, "");
});

test("reports the fallback when Bicep returns no diagnostics output", () => {
  const directory = temporaryDirectory();
  const result = runChecker(directory, fakeBicep(directory, "", 0));

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "Bicep did not return valid SARIF diagnostics.\n"
  );
});

test("combines diagnostics from every SARIF run", () => {
  const directory = temporaryDirectory();
  const result = runChecker(
    directory,
    fakeBicep(
      directory,
      JSON.stringify({
        runs: [
          {
            results: [
              {
                level: "note",
                ruleId: "first-run",
                message: { text: "First run note." }
              }
            ]
          },
          {
            results: [
              {
                level: "error",
                ruleId: "second-run",
                message: { text: "Second run error." }
              }
            ]
          }
        ]
      }),
      0
    )
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /note first-run: First run note\./u);
  assert.match(result.stderr, /error second-run: Second run error\./u);
});

test("ignores Bicep overrides and PATH", () => {
  const directory = temporaryDirectory();
  const result = runChecker(directory, {
    ...fakeBicep(directory, sarif([]), 0),
    BICEP_BINARY: path.join(directory, "other-bicep"),
    PATH: ""
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("fails closed when compiled output is not valid JSON", () => {
  const directory = temporaryDirectory();
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, "not json")
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Bicep did not return valid compiled JSON/u);
});

it.each([
  { name: "null", output: "null" },
  { name: "an array", output: "[]" },
  { name: "a number", output: "42" },
  { name: "a string", output: JSON.stringify("template") }
])("fails closed when compiled output is $name", ({ output }) => {
  const directory = temporaryDirectory();
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, output)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Bicep did not return valid compiled JSON/u);
});

test("fails closed when the managed Bicep executable is missing", () => {
  const directory = temporaryDirectory();
  const missingHome = path.join(directory, "missing-home");
  const result = runChecker(directory, {
    HOME: missingHome,
    USERPROFILE: missingHome
  });

  assert.equal(result.status, 1);
  assert.notEqual(result.stderr, "");
});

it.each([
  {
    name: "an abbreviated SHA",
    source: "git::https://github.com/example/app.git?ref=eb33f12",
    ref: "eb33f12"
  },
  {
    name: "a numeric seven-character SHA",
    source: "git::https://github.com/example/app.git?ref=5568077",
    ref: "5568077"
  },
  {
    name: "an uppercase abbreviated SHA",
    source: "git::https://github.com/example/app.git?ref=EB33F12",
    ref: "EB33F12"
  },
  {
    name: "an eight-character hexadecimal SHA",
    source: "git::https://github.com/example/app.git?ref=deadbeef",
    ref: "deadbeef"
  },
  {
    name: "an ambiguous seven-character hexadecimal ref",
    source: "git::https://github.com/example/app.git?ref=deadbee",
    ref: "deadbee"
  },
  {
    name: "an abbreviated SHA after another query parameter",
    source: "git::https://github.com/example/app.git?context=src&ref=eb33f12",
    ref: "eb33f12"
  },
  {
    name: "an abbreviated SHA before a URL fragment",
    source: "git::https://github.com/example/app.git?ref=eb33f12#readme",
    ref: "eb33f12"
  },
  {
    name: "a percent-encoded abbreviated SHA",
    source: "git::https://github.com/example/app.git?ref=%65b33f12",
    ref: "eb33f12"
  },
  {
    name: "the first of two refs when it is an abbreviated SHA",
    source: `git::https://github.com/example/app.git?ref=eb33f12&ref=${fullSha}`,
    ref: "eb33f12"
  },
  {
    name: "a 39-character SHA",
    source: `git::https://github.com/example/app.git?ref=${"a".repeat(39)}`,
    ref: "a".repeat(39)
  }
])("rejects a container image build source with $name", ({ source, ref }) => {
  const directory = temporaryDirectory();
  const compiledOutput = template({ image: imageResource(source) });
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /container-image-build-source/u);
  assert.ok(result.stderr.includes(ref));
});

it.each([
  {
    name: "a source without a ref",
    source: "git::https://github.com/example/app.git"
  },
  {
    name: "a source with other query parameters but no ref",
    source: "git::https://github.com/example/app.git?context=src"
  },
  {
    name: "an empty ref",
    source: "git::https://github.com/example/app.git?ref="
  },
  {
    name: "a branch",
    source: "git::https://github.com/example/app.git?ref=main"
  },
  {
    name: "a bare release tag",
    source: "git::https://github.com/example/app.git?ref=v1.2.3"
  },
  {
    name: "an explicit release tag with a hexadecimal name",
    source: "git::https://github.com/example/app.git?ref=refs/tags/deadbee"
  },
  {
    name: "an explicit branch with a hexadecimal name",
    source: "git::https://github.com/example/app.git?ref=refs/heads/deadbee"
  },
  {
    name: "a percent-encoded explicit tag",
    source: "git::https://github.com/example/app.git?ref=refs%2Ftags%2Fdeadbee"
  },
  {
    name: "an eight-digit date tag",
    source: "git::https://github.com/example/app.git?ref=20240817"
  },
  {
    name: "a nine-digit numeric tag",
    source: "git::https://github.com/example/app.git?ref=123456789"
  },
  {
    name: "a six-character hexadecimal ref",
    source: "git::https://github.com/example/app.git?ref=abc123"
  },
  {
    name: "the hexadecimal ref cafe",
    source: "git::https://github.com/example/app.git?ref=cafe"
  },
  {
    name: "the hexadecimal ref beef",
    source: "git::https://github.com/example/app.git?ref=beef"
  },
  {
    name: "the hexadecimal ref added",
    source: "git::https://github.com/example/app.git?ref=added"
  },
  {
    name: "the hexadecimal ref facade",
    source: "git::https://github.com/example/app.git?ref=facade"
  },
  {
    name: "a full 40-character SHA",
    source: `git::https://github.com/example/app.git?ref=${fullSha}`
  }
])("accepts $name", ({ source }) => {
  const directory = temporaryDirectory();
  const compiledOutput = template({ image: imageResource(source) });
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("checks every container image build source", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    goodImage: imageResource(
      "git::https://github.com/example/good.git?ref=refs/tags/v1.2.3"
    ),
    badImage: imageResource(
      "git::https://github.com/example/bad.git?ref=eb33f12"
    )
  });
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /badImage\.properties\.build\.source/u);
  assert.doesNotMatch(result.stderr, /goodImage\.properties\.build\.source/u);
  assert.match(result.stderr, /refs\/tags\/v1\.2\.3/u);
});

test("reports every invalid container image build source", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    firstImage: imageResource(
      "git::https://github.com/example/first.git?ref=eb33f12"
    ),
    secondImage: imageResource(
      "git::https://github.com/example/second.git?ref=abc1234"
    )
  });
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /firstImage\.properties\.build\.source/u);
  assert.match(result.stderr, /secondImage\.properties\.build\.source/u);
  assert.match(result.stderr, /eb33f12/u);
  assert.match(result.stderr, /abc1234/u);
});

test("allows an abbreviated image tag with a full build ref", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    image: radiusResource(containerImageType, {
      tag: "eb33f12",
      build: {
        source: `git::https://github.com/example/app.git?ref=${fullSha}`
      }
    })
  });
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

it.each([
  { name: "missing", source: undefined },
  { name: "null", source: null },
  { name: "numeric", source: 7 },
  { name: "object", source: { ref: "eb33f12" } }
])("ignores a $name build source", ({ source }) => {
  const directory = temporaryDirectory();
  const compiledOutput = template({ image: imageResource(source) });
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("checks container image build sources in local modules", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    module: localModule("git::https://github.com/example/app.git?ref=eb33f12")
  });
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /module\.image\.properties\.build\.source/u);
});

test("uses each local module's parameter defaults", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template(
    {
      module: localModule("[parameters('buildSource')]", {
        buildSource: {
          type: "string",
          defaultValue: "git::https://github.com/example/app.git?ref=eb33f12"
        }
      })
    },
    {
      buildSource: {
        type: "string",
        defaultValue: `git::https://github.com/example/app.git?ref=${fullSha}`
      }
    }
  );
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /eb33f12/u);
});

test("resolves local module parameters in the parent scope", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template(
    {
      module: localModule(
        interpolatedGitRef,
        { gitRef: { type: "string" } },
        { gitRef: { value: "[parameters('gitRef')]" } }
      )
    },
    {
      gitRef: {
        type: "string",
        defaultValue: "eb33f12"
      }
    }
  );
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /eb33f12/u);
});

test("rejects a literal ref supplied by a local module invocation", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    module: localModule(
      interpolatedGitRef,
      { gitRef: { type: "string" } },
      { gitRef: { value: "eb33f12" } }
    )
  });
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /module\.image\.properties\.build\.source/u);
  assert.match(result.stderr, /eb33f12/u);
});

test("resolves parameters through nested local module invocations", () => {
  const directory = temporaryDirectory();
  const innerModule = localModule(
    interpolatedGitRef,
    { gitRef: { type: "string" } },
    { gitRef: { value: "[parameters('gitRef')]" } }
  );
  const outerModule = localModuleResources(
    { inner: innerModule },
    { gitRef: { type: "string" } },
    { gitRef: { value: "eb33f12" } }
  );
  const compiledOutput = template({ outer: outerModule });
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /outer\.inner\.image\.properties\.build\.source/u
  );
  assert.match(result.stderr, /eb33f12/u);
});

test("module invocation parameters override nested defaults", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    module: localModule(
      interpolatedGitRef,
      {
        gitRef: {
          type: "string",
          defaultValue: "eb33f12"
        }
      },
      { gitRef: { value: fullSha } }
    )
  });
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("does not use a nested default when its invocation value is unresolved", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    module: localModule(
      interpolatedGitRef,
      {
        gitRef: {
          type: "string",
          defaultValue: "eb33f12"
        }
      },
      { gitRef: { value: "[variables('gitRef')]" } }
    )
  });
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("unwraps and rejects a short buildSource parameter default", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template(
    { image: imageResource("[parameters('buildSource')]") },
    {
      buildSource: {
        type: "string",
        defaultValue: "git::https://github.com/example/app.git?ref=abc1234"
      }
    }
  );
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /abc1234/u);
});

test("resolves an interpolated ref parameter default", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template(
    {
      image: imageResource(interpolatedGitRef)
    },
    {
      gitRef: {
        type: "string",
        defaultValue: "eb33f12"
      }
    }
  );
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /eb33f12/u);
});

test("accepts literal and parameter-default full or tagged build refs", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template(
    {
      literal: imageResource(
        `git::https://github.com/example/app.git?ref=${fullSha}`
      ),
      parameter: imageResource("[parameters('buildSource')]"),
      tagParameter: imageResource("[parameters('tagSource')]")
    },
    {
      buildSource: {
        type: "string",
        defaultValue: `git::https://github.com/example/app.git?ref=${fullSha}`
      },
      tagSource: {
        type: "string",
        defaultValue:
          "git::https://github.com/example/app.git?ref=refs/tags/v1.91.0"
      }
    }
  );
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("ignores build sources that do not resolve to literal refs", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    variable: imageResource("[variables('source')]"),
    formatted: imageResource(
      "[format('git::https://github.com/example/app.git?ref={0}', variables('sha'))]"
    ),
    formattedParameter: imageResource(interpolatedGitRef),
    parameter: imageResource("[parameters('buildSource')]"),
    build: radiusResource(containerImageType, {
      build: "[parameters('build')]"
    })
  });
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("ignores Git refs outside container image resources", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    other: radiusResource("Example/other@2025-01-01", {
      source: "git::https://github.com/example/app.git?ref=eb33f12"
    })
  });
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("rejects an interpolated ref from captured Bicep output", () => {
  const directory = temporaryDirectory();
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledBicepFixture("interpolated-ref"))
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /containerImage\.properties\.build\.source/u);
  assert.match(result.stderr, /eb33f12/u);
});

test("rejects a local module argument from captured Bicep output", () => {
  const directory = temporaryDirectory();
  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledBicepFixture("local-module-ref"))
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /child\.containerImage\.properties\.build\.source/u
  );
  assert.match(result.stderr, /eb33f12/u);
});

// --- Repair budget ---------------------------------------------------------
//
// The checker bounds the authoring repair loop when the model it is compiling
// sits in a staged modeling run. It re-implements the rules that
// packages/core/src/modeling/app-staging.ts owns, because it ships inside the
// installed plugin where the workspace packages do not exist, so these tests
// also assert the two copies agree.

const failure = sarif([
  {
    level: "error",
    ruleId: "BCP057",
    message: {
      text: "The name 'missing' does not exist in the current context."
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: "file:///tmp/app.bicep" },
          region: { startLine: 12 }
        }
      }
    ]
  }
]);

const otherFailure = sarif([
  {
    level: "error",
    ruleId: "BCP062",
    message: { text: "The referenced declaration is not valid." }
  }
]);

// The same diagnostic reported at a line that moved because the model was
// edited above it.
const shiftedFailure = sarif([
  {
    level: "error",
    ruleId: "BCP057",
    message: {
      text: "The name 'missing' does not exist in the current context."
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: "file:///tmp/app.bicep" },
          region: { startLine: 48 }
        }
      }
    ]
  }
]);

function writeRunRecord(directory: string, record: unknown): void {
  fs.writeFileSync(
    path.join(directory, STAGING_RUN_RECORD),
    typeof record === "string" ? record : JSON.stringify(record, null, 2)
  );
}

function readRepair(directory: string): unknown {
  return (
    JSON.parse(
      fs.readFileSync(path.join(directory, STAGING_RUN_RECORD), "utf8")
    ) as { repair?: unknown }
  ).repair;
}

function stagedRun(directory: string, repair?: unknown): void {
  writeRunRecord(directory, {
    version: 1,
    runId: "test-run",
    baseline: { "app.bicep": null },
    ...(repair === undefined ? {} : { repair })
  });
}

describe("repair budget", () => {
  it("compiles and counts the first attempt of a staged run", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);

    const result = runChecker(directory, fakeBicep(directory, failure, 1));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /BCP057/u);
    assert.equal((readRepair(directory) as { attempts: number }).attempts, 1);
  });

  it("clears the fingerprint when the compile passes", () => {
    const directory = temporaryDirectory();
    stagedRun(directory, { attempts: 1, fingerprint: "stale" });

    const result = runChecker(directory, fakeBicep(directory, sarif([]), 0));

    assert.equal(result.status, 0);
    assert.deepEqual(readRepair(directory), {
      attempts: 2,
      fingerprint: null
    });
  });

  it("warns on the boundary attempt that the budget is now spent", () => {
    const directory = temporaryDirectory();
    stagedRun(directory, {
      attempts: REPAIR_ATTEMPT_BUDGET - 1,
      fingerprint: null
    });

    const result = runChecker(directory, fakeBicep(directory, failure, 1));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /BCP057/u);
    assert.match(result.stderr, /repair budget is now spent/u);
  });

  it("refuses a fourth compile without running Bicep at all", () => {
    const directory = temporaryDirectory();
    stagedRun(directory, {
      attempts: REPAIR_ATTEMPT_BUDGET,
      fingerprint: "abc"
    });
    // A compiler that would pass, so a status of 1 can only come from the
    // refusal rather than from the compile.
    const env = fakeBicep(directory, sarif([]), 0);
    const before = fs.readFileSync(path.join(directory, "build"), "utf8");
    fs.writeFileSync(
      path.join(directory, "build"),
      `require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, "spawned"))}, 'yes');\n${before}`
    );

    const result = runChecker(directory, env);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /repair budget of 3 is spent/u);
    assert.match(result.stderr, /no application definition was written/u);
    assert.equal(fs.existsSync(path.join(directory, "spawned")), false);
    assert.deepEqual(readRepair(directory), {
      attempts: REPAIR_ATTEMPT_BUDGET,
      fingerprint: "abc"
    });
  });

  it("reports a repeated failure as the same one", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);

    const first = runChecker(directory, fakeBicep(directory, failure, 1));
    assert.doesNotMatch(first.stderr, /same compiler failure/u);

    // Same diagnostic, reported at a line that moved.
    const second = runChecker(
      directory,
      fakeBicep(directory, shiftedFailure, 1)
    );

    assert.equal(second.status, 1);
    assert.match(second.stderr, /same compiler failure/u);
    assert.match(second.stderr, /materially different fix/u);
  });

  it("does not report a changed failure as repeated", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);

    runChecker(directory, fakeBicep(directory, failure, 1));
    const second = runChecker(directory, fakeBicep(directory, otherFailure, 1));

    assert.equal(second.status, 1);
    assert.doesNotMatch(second.stderr, /same compiler failure/u);
    assert.equal((readRepair(directory) as { attempts: number }).attempts, 2);
  });

  it("stops a stuck run after exactly three compiles", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);

    const statuses = [1, 2, 3, 4].map(
      () => runChecker(directory, fakeBicep(directory, failure, 1)).status
    );
    assert.deepEqual(statuses, [1, 1, 1, 1]);

    const refused = runChecker(directory, fakeBicep(directory, failure, 1));
    assert.match(refused.stderr, /repair budget of 3 is spent/u);
    assert.equal(
      (readRepair(directory) as { attempts: number }).attempts,
      REPAIR_ATTEMPT_BUDGET
    );
  });

  it("counts nothing and enforces no budget without a run record", () => {
    const directory = temporaryDirectory();

    const result = runChecker(directory, fakeBicep(directory, failure, 1));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /BCP057/u);
    assert.doesNotMatch(result.stderr, /repair budget/u);
    assert.equal(
      fs.existsSync(path.join(directory, STAGING_RUN_RECORD)),
      false
    );
  });

  it.each([
    ["malformed JSON", "{ not json"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"run"']
  ])("compiles without a budget when the run record is %s", (_name, text) => {
    const directory = temporaryDirectory();
    writeRunRecord(directory, text);

    const result = runChecker(directory, fakeBicep(directory, failure, 1));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /BCP057/u);
    assert.doesNotMatch(result.stderr, /repair budget/u);
    // The unusable record is left alone rather than overwritten, because it may
    // still hold the baseline the publish check needs.
    assert.equal(
      fs.readFileSync(path.join(directory, STAGING_RUN_RECORD), "utf8"),
      text
    );
  });

  it("ignores an unusable repair field and starts the count fresh", () => {
    const directory = temporaryDirectory();
    stagedRun(directory, { attempts: "many", fingerprint: 7 });

    const result = runChecker(directory, fakeBicep(directory, failure, 1));

    assert.equal(result.status, 1);
    assert.equal((readRepair(directory) as { attempts: number }).attempts, 1);
  });

  it("preserves the rest of the run record", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);

    runChecker(directory, fakeBicep(directory, sarif([]), 0));

    const record = JSON.parse(
      fs.readFileSync(path.join(directory, STAGING_RUN_RECORD), "utf8")
    ) as { runId: string; baseline: Record<string, string | null> };
    assert.equal(record.runId, "test-run");
    assert.deepEqual(record.baseline, { "app.bicep": null });
  });

  it("does not fail a passing compile when the attempt cannot be recorded", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    fs.chmodSync(path.join(directory, STAGING_RUN_RECORD), 0o444);

    const result = runChecker(directory, fakeBicep(directory, sarif([]), 0));

    assert.equal(result.status, 0);
    assert.match(result.stderr, /repair budget is not being counted/u);
  });

  it("counts a run that never leaves a staging directory separately", () => {
    const first = temporaryDirectory();
    stagedRun(first, { attempts: REPAIR_ATTEMPT_BUDGET, fingerprint: "abc" });
    assert.equal(runChecker(first, fakeBicep(first, failure, 1)).status, 1);

    // A different run, with its own record: the previous run's spent budget
    // must not refuse it.
    const second = temporaryDirectory();
    stagedRun(second);
    const result = runChecker(second, fakeBicep(second, sarif([]), 0));

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stderr, /repair budget/u);
  });
});

// The checker re-implements core's repair rules. These cases assert both reach
// the same verdict, which is the contract that keeps them from drifting.
describe("agreement with the core repair rules", () => {
  const attemptCases = [0, 1, 2, 3, 4];

  it.each(attemptCases)(
    "agrees on whether a compile is allowed after %i attempts",
    (attempts) => {
      const directory = temporaryDirectory();
      stagedRun(directory, { attempts, fingerprint: null });
      const core = evaluateRepairAttempt(
        parseRepairState({ attempts, fingerprint: null })
      );

      // A compiler that passes, so the only way the checker can fail is by
      // refusing before it runs.
      const result = runChecker(directory, fakeBicep(directory, sarif([]), 0));

      assert.equal(result.status === 0, core.allowed);
      if (!core.allowed) {
        assert.equal(result.stderr.trim(), core.reason);
      }
    }
  );

  it.each([
    {
      name: "an identical failure",
      first: failure,
      second: failure,
      repeated: true
    },
    {
      name: "the same failure at a shifted line",
      first: failure,
      second: shiftedFailure,
      repeated: true
    },
    {
      name: "a different failure",
      first: failure,
      second: otherFailure,
      repeated: false
    }
  ])(
    "agrees on whether $name is a repeat",
    ({ first: firstOutput, second: secondOutput, repeated }) => {
      const directory = temporaryDirectory();
      stagedRun(directory);

      runChecker(directory, fakeBicep(directory, firstOutput, 1));
      const recorded = parseRepairState(readRepair(directory));
      const second = runChecker(
        directory,
        fakeBicep(directory, secondOutput, 1)
      );

      const after = parseRepairState(readRepair(directory));
      assert.equal(isRepeatedFailure(recorded, after.fingerprint), repeated);
      assert.equal(/same compiler failure/u.test(second.stderr), repeated);
      if (repeated) {
        assert.match(
          second.stderr,
          new RegExp(escapeRegExp(REPEATED_FAILURE_MESSAGE), "u")
        );
      }
    }
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
