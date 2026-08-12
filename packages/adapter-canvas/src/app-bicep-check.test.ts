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
  "validate-bicep.mjs"
);
const executable = process.platform === "win32" ? "bicep.exe" : "bicep";
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
): NodeJS.ProcessEnv {
  const bicep = path.join(
    directory,
    ".radius",
    "ai-extensions",
    "bin",
    executable
  );
  const driver = path.join(directory, "build");
  fs.mkdirSync(path.dirname(bicep), { recursive: true });
  try {
    fs.linkSync(fs.realpathSync(process.execPath), bicep);
  } catch {
    fs.copyFileSync(process.execPath, bicep);
  }
  if (process.platform !== "win32") {
    fs.chmodSync(bicep, 0o755);
  }
  fs.writeFileSync(
    driver,
    [
      "if (!process.argv.includes('--diagnostics-format') || !process.argv.includes('sarif')) process.exit(2);",
      `process.stderr.write(${JSON.stringify(compilerOutput)});`,
      `process.exit(${status});`,
      ""
    ].join("\n")
  );
  return { HOME: directory, USERPROFILE: directory };
}

function runChecker(directory: string, env: NodeJS.ProcessEnv) {
  const app = path.join(directory, "app.bicep");
  fs.writeFileSync(app, "");
  return spawnSync(process.execPath, [checker, app], {
    encoding: "utf8",
    env: { ...process.env, ...env }
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

function hasInstalledBicep(): boolean {
  const candidate = path.join(
    os.homedir(),
    ".radius",
    "ai-extensions",
    "bin",
    executable
  );
  const version = spawnSync(candidate, ["--version"], { stdio: "ignore" });
  return !version.error && version.status === 0;
}

const hasBicep = hasInstalledBicep();

test.skipIf(!hasBicep)(
  "accepts a secure value and rejects an insecure sensitive input",
  () => {
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
      encoding: "utf8"
    });
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stderr, "");

    fs.writeFileSync(app, model(false));
    const insecure = spawnSync(process.execPath, [checker, app], {
      encoding: "utf8"
    });
    assert.equal(insecure.status, 1);
    assert.match(insecure.stderr, /use-secure-value-for-secure-inputs/u);
  },
  30_000
);
