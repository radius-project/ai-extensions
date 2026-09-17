import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

const scripts = resolve("extensions/radius/skills/radius-app-bicep/scripts");
const bundleRoot = resolve(".artifacts", `cli-bundle-${randomUUID()}`);
const roots: string[] = [];
const nativeTools = process.env.RADIUS_NATIVE_GRAPH_TEST_TOOLS;
const model = "output fixture string = loadTextContent('./build')\n";
const compiler = [
  "import fs from 'node:fs';",
  `if (fs.readFileSync(process.argv[2], 'utf8') !== ${JSON.stringify(model)}) throw Error('Unexpected fixture source');`,
  "if (process.argv.slice(3).join(' ') !== '--diagnostics-format sarif --stdout') throw Error('Unexpected compiler arguments');",
  "console.log(JSON.stringify({resources:{},outputs:{fixture:{type:'string',value:'fixture'}}}));",
  "console.error(JSON.stringify({runs:[{results:[]}]}));"
].join("\n");

beforeAll(async () => {
  mkdirSync(bundleRoot, { recursive: true });
  for (const name of readdirSync(scripts).filter((name) =>
    name.endsWith(".mjs")
  ))
    copyFileSync(join(scripts, name), join(bundleRoot, name));
});
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }));
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function command(root: string, script: string, args: string[], home = root) {
  const result = spawnSync(
    process.execPath,
    [join(bundleRoot, script), ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: home,
        USERPROFILE: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(root, "no-global-config"),
        ...(process.env.RADIUS_COLLECT_CLI_COVERAGE === "1" ?
          { NODE_V8_COVERAGE: resolve(".artifacts", "us3-cli-v8") }
        : {})
      },
      timeout: 5_000
    }
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}
function git(root: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, "no-global-config")
    }
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function fixture(native = false, duringVerification = "") {
  const root = resolve(".artifacts", `cli-${randomUUID().slice(0, 8)}`);
  roots.push(root);
  const radius = join(root, ".radius");
  mkdirSync(radius, { recursive: true });
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
  let definition = model;
  let bicep = process.execPath;
  let rad = process.execPath;
  const compilerSource =
    compiler +
    "\nimport path from 'node:path';\n" +
    "if (process.cwd().includes('verification-')) {\n" +
    "const staging = path.resolve(process.cwd(), '../..');\n" +
    duringVerification +
    "\n}\n";
  if (native) {
    if (!nativeTools) throw new Error("Owned native tools were not supplied.");
    bicep = join(nativeTools, "bicep");
    rad = join(nativeTools, "rad");
    const applicationType = "Radius.Core/applications@2025-08-01-preview";
    definition =
      "extension './radius-types.tgz' as radius\n" +
      `resource application '${applicationType}' = {\n` +
      " name: 'cli-fixture'\n properties: { environment: 'fixture' }\n}\n" +
      "output schemaEvidence object = loadJsonContent('./resolved-types.json')\n";
    writeFileSync(
      join(radius, "radius-types.tgz"),
      Buffer.from(
        readFileSync(
          resolve(
            "packages/adapter-shared/test/fixtures/lifecycle-registry-inputs/custom-types.tgz.base64"
          ),
          "utf8"
        ),
        "base64"
      )
    );
    writeFileSync(
      join(radius, "resolved-types.json"),
      JSON.stringify({
        contractVersion: 1,
        types: { [applicationType]: { environment: false } }
      })
    );
  } else writeFileSync(join(radius, "build"), compilerSource);
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture"
  ]);
  const begin = command(root, "promote-app-model.mjs", [
    "--begin",
    "--run-id",
    "cli"
  ]);
  expect(begin.status, begin.stderr).toBe(0);
  const staging = begin.stdout;
  writeFileSync(join(staging, "app.bicep"), definition);
  writeFileSync(join(staging, "bicepconfig.json"), "{}");
  if (native) {
    for (const name of ["radius-types.tgz", "resolved-types.json"])
      copyFileSync(join(radius, name), join(staging, name));
  } else writeFileSync(join(staging, "build"), compilerSource);
  const binaries = ["--bicep", bicep, "--rad", rad];
  const validate = () =>
    command(root, "validate-bicep.mjs", [
      join(staging, "app.bicep"),
      "--bicep",
      bicep
    ]);
  const origin = () =>
    command(root, "write-app-origin.mjs", [
      join(staging, "app.bicep"),
      "--skill-version",
      "fixture"
    ]);
  const seal = () =>
    command(root, "promote-app-model.mjs", [
      "--seal",
      "--staging",
      staging,
      ...binaries
    ]);
  const promote = () =>
    command(root, "promote-app-model.mjs", ["--staging", staging, ...binaries]);
  const prepare = () => {
    for (const step of [validate, origin, seal]) {
      const result = step();
      expect(result.status, result.stderr).toBe(0);
    }
  };
  return {
    root,
    radius,
    staging,
    validate,
    origin,
    seal,
    promote,
    prepare,
    definition
  };
}

it("runs the installed command sequence with recorded compiler protocol and retained static checks", () => {
  const target = fixture();
  target.prepare();
  const record = JSON.parse(
    readFileSync(join(target.staging, "run.json"), "utf8")
  );
  expect(record.repair.attempts).toBe(1);
  expect(record.validatedOutputs).toBeUndefined();
  const result = target.promote();
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(target.radius, "app.bicep"), "utf8")).toBe(model);
  expect(readdirSync(target.radius)).not.toContain(".staging-cli");
  expect(
    git(target.root, ["diff", "--cached", "--name-only"]).split("\n")
  ).toEqual([
    ".radius/.gitignore",
    ".radius/app.bicep",
    ".radius/app.origin.json",
    ".radius/bicepconfig.json"
  ]);
});

it.each([
  "origin",
  "output",
  "record",
  "missing-record",
  "missing-seal",
  "input",
  "new-definition",
  "new-config"
])("refuses %s changes after sealing without publishing", (change) => {
  const target = fixture();
  target.prepare();
  if (change === "origin")
    writeFileSync(join(target.staging, "app.origin.json"), "{}");
  if (change === "output")
    writeFileSync(join(target.staging, "bicepconfig.json"), "{ }\n");
  if (change === "record")
    writeFileSync(join(target.staging, "run.json"), "{}");
  if (change === "missing-record") rmSync(join(target.staging, "run.json"));
  if (change === "missing-seal")
    rmSync(join(target.staging, "validation-seal.json"));
  if (change === "input")
    writeFileSync(join(target.root, "Dockerfile"), "FROM changed\n");
  if (change === "new-definition")
    writeFileSync(join(target.radius, "app.bicep"), "// user's definition\n");
  if (change === "new-config")
    writeFileSync(join(target.root, "bicepconfig.json"), "{}");
  const result = target.promote();
  expect(result.status, result.stdout).toBe(1);
  expect(result.stderr).toMatch(/origin|record|changed|--seal|input/i);
  expect(readdirSync(target.radius)).not.toContain("app.origin.json");
  expect(git(target.root, ["diff", "--cached", "--name-only"])).toBe("");
});

it.skipIf(!nativeTools || process.platform === "win32")(
  "qualifies the full CLI sequence with native Bicep and a supported Radius application",
  () => {
    const target = fixture(true);
    target.prepare();
    const result = target.promote();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(target.radius, "app.bicep"), "utf8")).toBe(
      target.definition
    );
    expect(
      JSON.parse(readFileSync(join(target.radius, "app.origin.json"), "utf8"))
        .appBicepHash
    ).toMatch(/^sha256:/);
  }
);

it("refuses origin-only and caller-generated hash evidence", () => {
  const target = fixture();
  expect(target.origin().status).toBe(0);
  const result = target.promote();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("successful agent compile");
});

it("preserves begin, validate, origin and promote without requiring a new command", () => {
  const target = fixture();
  expect(target.validate().status).toBe(0);
  expect(target.origin().status).toBe(0);
  const result = target.promote();
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(target.radius, "app.bicep"), "utf8")).toBe(model);
});

it("resolves the default managed compiler from an isolated home", () => {
  const target = fixture();
  const home = resolve(".artifacts", `cli-home-${randomUUID()}`);
  roots.push(home);
  const bin = join(home, ".radius", "ai-extensions", "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(
    process.execPath,
    join(bin, process.platform === "win32" ? "bicep.exe" : "bicep")
  );
  expect(target.validate().status).toBe(0);
  expect(target.origin().status).toBe(0);
  const result = command(
    target.root,
    "promote-app-model.mjs",
    ["--staging", target.staging],
    home
  );
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(target.radius, "app.bicep"), "utf8")).toBe(model);
});

it("requires origin and rejects a proposal that fails independent compiler verification", () => {
  const target = fixture();
  expect(target.validate().status).toBe(0);
  expect(target.seal().status).toBe(1);
  expect(target.origin().status).toBe(0);
  writeFileSync(
    join(target.staging, "app.bicep"),
    "module missing './missing.bicep' = {}\n"
  );
  expect(target.origin().status).toBe(0);
  const result = target.seal();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Legacy compiler/static validation failed");
  expect(readdirSync(target.staging)).not.toContain("validation-seal.json");
});

it("does not treat an origin record as a successful bounded agent compile", () => {
  const target = fixture();
  expect(target.origin().status).toBe(0);
  expect(target.seal().stderr).toContain("successful agent compile");
  expect(readdirSync(target.staging)).not.toContain("validation-seal.json");
});

it("independently verifies without granting additional repair attempts", () => {
  const target = fixture();
  for (let attempt = 0; attempt < 6; attempt++)
    expect(target.validate().status).toBe(0);
  expect(target.origin().status).toBe(0);
  expect(target.seal().status).toBe(0);
  expect(target.seal().status).toBe(0);
  expect(
    JSON.parse(readFileSync(join(target.staging, "run.json"), "utf8")).repair
      .attempts
  ).toBe(6);
  expect(target.promote().status).toBe(0);
});

it.each([
  {
    mutation: "fs.appendFileSync(path.join(staging, 'run.json'), ' ');",
    message: "run record changed during validation"
  },
  {
    mutation:
      "fs.appendFileSync(path.join(staging, 'app.bicep'), '\\n// changed');",
    message: "Validated output app.bicep changed"
  },
  {
    mutation:
      "fs.appendFileSync(path.join(staging, 'resolved-types.json'), ' ');",
    message: "Validation input .radius/resolved-types.json changed"
  },
  {
    mutation:
      "fs.writeFileSync(path.resolve(staging, '../..', 'Dockerfile'), 'FROM changed\\n');",
    message: "Original input Dockerfile changed"
  },
  {
    mutation:
      "fs.writeFileSync(path.join(staging, 'surprise-recipe.bicep'), 'output name string = \\'new\\'\\n');",
    message: "staged output set changed"
  }
])(
  "fences changes made during verification: $message",
  ({ mutation, message }) => {
    const target = fixture(false, mutation);
    writeFileSync(
      join(target.staging, "resolved-types.json"),
      JSON.stringify({ contractVersion: 1, types: {} })
    );
    expect(target.validate().status).toBe(0);
    expect(target.origin().status).toBe(0);
    const result = target.seal();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain(message);
    expect(readdirSync(target.staging)).not.toContain("validation-seal.json");
    expect(
      readdirSync(target.staging).some((name) =>
        name.startsWith("verification-")
      )
    ).toBe(false);
    expect(readdirSync(target.radius)).not.toContain("app.bicep");
  }
);

it.each(["run", "seal", "schema"] as const)(
  "rejects replaced %s evidence after a successful seal",
  (change) => {
    const target = fixture();
    target.prepare();
    const name =
      change === "run" ? "run.json"
      : change === "seal" ? "validation-seal.json"
      : "resolved-types.json";
    const file = join(target.staging, name);
    if (change === "schema")
      writeFileSync(file, JSON.stringify({ contractVersion: 1, types: {} }));
    else {
      const record = JSON.parse(readFileSync(file, "utf8"));
      if (change === "run") record.changed = true;
      else record.version = 2;
      writeFileSync(file, JSON.stringify(record));
    }
    const result = target.promote();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/record.*changed|inputs changed/);
    expect(readdirSync(target.radius)).not.toContain("app.bicep");
  }
);

it.each(["run-id", "source-path", "staged-dependency"] as const)(
  "rejects invalid pre-seal evidence: %s",
  (change) => {
    const target = fixture();
    expect(target.validate().status).toBe(0);
    expect(target.origin().status).toBe(0);
    if (change === "staged-dependency")
      writeFileSync(
        join(target.staging, "build"),
        "// replaced compiler input\n"
      );
    else {
      const file = join(target.staging, "run.json");
      const record = JSON.parse(readFileSync(file, "utf8"));
      if (change === "run-id") record.runId = "different";
      else record.sourceBaseline["../escape"] = null;
      writeFileSync(file, JSON.stringify(record));
    }
    const result = target.seal();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /original run record|Unsafe effective input|changed since --begin/
    );
    expect(readdirSync(target.staging)).not.toContain("validation-seal.json");
  }
);

it("refuses a source change between its fingerprint read and byte capture", () => {
  const target = fixture();
  expect(target.validate().status).toBe(0);
  expect(target.origin().status).toBe(0);
  writeFileSync(
    join(bundleRoot, "capture-race.mjs"),
    [
      "import fs from 'node:fs';",
      "import {runPromotionCommand} from './promote-app-model.mjs';",
      "let changed = false;",
      "process.exitCode = await runPromotionCommand(process.argv.slice(3), console, {",
      "readFileSync(...args) {",
      "const value = fs.readFileSync(...args);",
      "if (!changed && args[0] === process.argv[2]) {",
      "changed = true; fs.appendFileSync(args[0], '\\n// concurrent edit');",
      "}",
      "return value;",
      "}",
      "});"
    ].join("\n")
  );
  const result = command(target.root, "capture-race.mjs", [
    join(target.staging, "build"),
    "--seal",
    "--staging",
    target.staging,
    "--bicep",
    process.execPath
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("changed during capture");
  expect(readdirSync(target.staging)).not.toContain("validation-seal.json");
});

it("refuses validation outside the run's Radius directory", () => {
  const target = fixture();
  const result = command(target.root, "promote-app-model.mjs", [
    "--seal",
    "--staging",
    target.root
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Invalid staged validation location");
});

it.each([
  ["relative.bicep", process.execPath],
  [resolve(".artifacts", "unused.bicep"), "relative-compiler"]
])("requires absolute verification paths: %s and %s", (app, bicep) => {
  const target = fixture();
  writeFileSync(
    join(bundleRoot, "invalid-verification.mjs"),
    "import {verifyLegacyDefinition} from './validate-bicep.mjs';\n" +
      "verifyLegacyDefinition(process.argv[2], process.argv[3]);\n"
  );
  const result = command(target.root, "invalid-verification.mjs", [app, bicep]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("absolute artifact and compiler paths");
});
