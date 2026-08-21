import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, it, test } from "vitest";

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
let sharedHomeDirectory: string | undefined;

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

afterAll(() => {
  const directory = sharedHomeDirectory;
  sharedHomeDirectory = undefined;
  if (directory !== undefined) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "app-bicep-check-"));
  temporaryDirectories.add(directory);
  return directory;
}

// The checker resolves the managed Bicep binary from the home directory but
// resolves the driver script from the application's own directory, so one home
// shared by every case still gives each case its own driver. Installing the
// ~78 MB stand-in per case instead made each test copy the Node binary, because
// Windows refuses to hardlink it out of C:\Program Files, and made each cleanup
// delete a file that size.
function sharedBicepHome(): string {
  if (sharedHomeDirectory === undefined) {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "app-bicep-check-home-")
    );
    sharedHomeDirectory = home;
    const bicep = path.join(
      home,
      ".radius",
      "ai-extensions",
      "bin",
      executable
    );
    fs.mkdirSync(path.dirname(bicep), { recursive: true });
    fs.copyFileSync(fs.realpathSync(process.execPath), bicep);
    if (process.platform !== "win32") {
      fs.chmodSync(bicep, 0o755);
    }
  }
  return sharedHomeDirectory;
}

function fakeBicep(
  directory: string,
  compilerOutput: string,
  status: number,
  compiledOutput = "{}"
): NodeJS.ProcessEnv {
  const home = sharedBicepHome();
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
