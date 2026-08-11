import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const checker = path.join(
  root,
  "plugins",
  "radius",
  "skills",
  "radius-app-bicep",
  "scripts",
  "check.mjs"
);
const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "app-bicep-check-"));
  temporaryDirectories.add(directory);
  return directory;
}

function fakeBicep(
  directory: string,
  compilerOutput: string,
  status: number
): string {
  const driver = path.join(directory, "build");
  fs.writeFileSync(
    driver,
    [
      "if (!process.argv.includes('--diagnostics-format') || !process.argv.includes('sarif')) process.exit(2);",
      `process.stderr.write(${JSON.stringify(compilerOutput)});`,
      `process.exit(${status});`,
      ""
    ].join("\n")
  );
  return process.execPath;
}

function runChecker(directory: string, bicep: string) {
  const app = path.join(directory, "app.bicep");
  fs.writeFileSync(app, "");
  return spawnSync(process.execPath, [checker, app], {
    encoding: "utf8",
    env: { ...process.env, BICEP_BINARY: bicep }
  });
}

function sarif(results: unknown[]): string {
  return JSON.stringify({ runs: [{ results }] });
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

function installedBicep(): string | null {
  const executable = process.platform === "win32" ? "bicep.exe" : "bicep";
  for (const candidate of [
    process.env.BICEP_BINARY,
    path.join(os.homedir(), ".radius", "ai-extensions", "bin", executable),
    path.join(os.homedir(), ".rad", "bin", executable),
    executable
  ]) {
    if (!candidate) {
      continue;
    }
    const version = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!version.error && version.status === 0) {
      return candidate;
    }
  }
  return null;
}

const bicep = installedBicep();

test.skipIf(bicep === null)(
  "accepts a secure value and rejects an insecure sensitive input",
  () => {
    assert.ok(bicep);
    const directory = temporaryDirectory();
    const app = path.join(directory, "app.bicep");

    const model = (secure: boolean) => {
      const annotation = secure ? "@secure()\n" : "";
      return `${annotation}param secret string

resource script 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: 'test'
  location: 'westus'
  kind: 'AzureCLI'
  properties: {
    azCliVersion: '2.52.0'
    retentionInterval: 'P1D'
    scriptContent: 'echo test'
    environmentVariables: [
      {
        name: 'SECRET'
        secureValue: secret
      }
    ]
  }
}
`;
    };

    fs.writeFileSync(app, model(true));
    const clean = spawnSync(process.execPath, [checker, app], {
      encoding: "utf8",
      env: { ...process.env, BICEP_BINARY: bicep }
    });
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stderr, "");

    fs.writeFileSync(app, model(false));
    const insecure = spawnSync(process.execPath, [checker, app], {
      encoding: "utf8",
      env: { ...process.env, BICEP_BINARY: bicep }
    });
    assert.equal(insecure.status, 1);
    assert.match(insecure.stderr, /use-secure-value-for-secure-inputs/u);
  },
  30_000
);
