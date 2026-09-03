import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, it, test } from "vitest";
import {
  REPAIR_ATTEMPT_BUDGET,
  REPAIR_COMPILE_LIMIT,
  REPEATED_FAILURE_MESSAGE,
  STAGING_RUN_RECORD,
  evaluateRepairAttempt,
  fingerprintCompilerOutput,
  isRepeatedFailure,
  parseRepairState
} from "@radius-project/core/modeling";
import {
  githubSourceReferenceUrl,
  srcPathFromRef
} from "../../../src/browser/graph/model.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
);
const checker = path.join(
  root,
  "extensions",
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

// Runs the checker against files that are already in place, for the cases that
// make the directory unwritable: runChecker rewrites app.bicep on every call,
// which the lock would block before the checker ever started.
function rerunChecker(directory: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [checker, path.join(directory, "app.bicep")],
    {
      encoding: "utf8",
      env: { ...process.env, ...env }
    }
  );
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
  return {
    type,
    properties: {
      properties: { codeReference: "src/resource.ts#L1", ...properties }
    }
  };
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

test("fails when a non-application Radius resource has no durable source reference", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    web: {
      type: "Radius.Compute/containers@2025-08-01-preview",
      properties: { properties: {} }
    },
    app: {
      type: "Radius.Core/applications@2025-08-01-preview",
      properties: { properties: {} }
    }
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /source-code-reference/u);
  assert.match(result.stderr, /web\.properties\.codeReference/u);
  assert.doesNotMatch(result.stderr, /app\.properties\.codeReference/u);
});

test("explains how to update a custom type missing source-reference support", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    queue: {
      type: "Radius.Resources/queues@2025-08-01-preview",
      properties: { properties: {} }
    }
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /add the optional codeReference string property/u
  );
  assert.match(result.stderr, /republish custom-types\.tgz/u);
});

test.each([
  "/src/app.ts",
  "src\\app.ts",
  "../src/app.ts",
  "src/app.ts#L0",
  "src/app.ts#not-a-line",
  "http://github.com/acme/app/blob/main/src/app.ts",
  "https://example.com/acme/app/blob/main/src/app.ts",
  "https://github.com/acme/app/tree/main/src",
  "https://github.com/acme/app/blob/main/src/app.ts?plain=1",
  "https://github.com/acme/app/blob/main/src/app.ts#L0",
  "https://github.com/acme/app/blob/main/src/\napp.ts",
  " src/app.ts",
  "src/app.ts\nforged diagnostic",
  "[concat('src/', 'app.ts')]"
])("fails for an unsafe source reference: %s", (codeReference) => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    web: radiusResource("Radius.Compute/containers@2025-08-01-preview", {
      codeReference
    })
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /repo-relative worktree path/u);
  if (codeReference === "src\\app.ts" || codeReference === "/src/app.ts") {
    // Authoring rejects platform-specific separators, while rendering keeps
    // legacy separators and a legacy leading slash readable in persisted graphs.
    assert.equal(srcPathFromRef(codeReference), "src/app.ts");
  } else {
    assert.equal(githubSourceReferenceUrl(codeReference), "");
    assert.equal(srcPathFromRef(codeReference), "");
  }
});

test.each([
  "src/app.ts",
  "src/app.ts#L12",
  "https://github.com/acme/app/blob/main/src/app.ts",
  "https://github.com/acme/app/blob/feature/source-links/src/app.ts#L12"
])("accepts a valid source reference: %s", (codeReference) => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    web: radiusResource("Radius.Compute/containers@2025-08-01-preview", {
      codeReference
    })
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.ok(
    githubSourceReferenceUrl(codeReference) || srcPathFromRef(codeReference)
  );
});

const containersType = "Radius.Compute/containers@2025-08-01-preview";

function containerEnv(env: object, containerKey = "web") {
  return radiusResource(containersType, {
    containers: { [containerKey]: { env } }
  });
}

test("fails when a plain value reads a plain helper that does not sort before it", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    web: containerEnv({
      APP_DATABASE_OPTIONS: {
        value: "host=db;password=$(DB_PASSWORD)"
      },
      DB_PASSWORD: { value: "secret" }
    })
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /runtime-variable/u);
  assert.match(result.stderr, /web\.properties\.containers\.web\.env\./u);
  assert.match(result.stderr, /\$\(DB_PASSWORD\)/u);
  assert.match(result.stderr, /valueFrom\.secretKeyRef/u);
  assert.match(result.stderr, /authored or reused Secret/u);
  assert.match(result.stderr, /compatible Kubernetes Secret connection/u);
  assert.match(
    result.stderr,
    /explicit schema-supported or legacy @secure\(\) env\.value fallback/u
  );
  assert.doesNotMatch(result.stderr, /has to stay a plain value/u);
});

test("accepts a plain helper whose key sorts before its consumer", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    web: containerEnv({
      APP_DATABASE_CREDENTIAL: { value: "secret" },
      APP_DATABASE_OPTIONS: {
        value: "host=db;password=$(APP_DATABASE_CREDENTIAL)"
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

test("accepts a secretKeyRef helper regardless of its key", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    web: containerEnv({
      APP_DATABASE_OPTIONS: {
        value: "host=db;password=$(ZZ_PASSWORD)"
      },
      ZZ_PASSWORD: {
        valueFrom: {
          secretKeyRef: { secretName: "db-secret", key: "password" }
        }
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

test.each([
  ["a dotted name", "DB.PASSWORD"],
  ["a hyphenated name", "DB-PASSWORD"]
])("reports %s that the kubelet would still look up", (_label, helper) => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    web: containerEnv({
      APP_DATABASE_OPTIONS: { value: `password=$(${helper})` },
      [helper]: { value: "secret" }
    })
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /runtime-variable/u);
});

test("reports a repeated reference once", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    web: containerEnv({
      APP_DATABASE_OPTIONS: {
        value: "primary=$(DB_PASSWORD);replica=$(DB_PASSWORD)"
      },
      DB_PASSWORD: { value: "secret" }
    })
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.equal(result.stderr.match(/runtime-variable/gu)?.length, 1);
});

test("ignores a name this container's env does not define", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    web: containerEnv({
      APP_ENDPOINT: { value: "http://$(CONNECTION_DB_HOST):5432" }
    })
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("reports a variable that reads itself", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    web: containerEnv({ APP_PATH: { value: "$(APP_PATH):/extra" } })
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read itself/u);
});

test("treats an escaped $$(NAME) as literal text", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    web: containerEnv({
      APP_TEMPLATE: { value: "literal $$(DB_PASSWORD)" },
      DB_PASSWORD: { value: "secret" }
    })
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("reports an unresolved expansion inside a nested module", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    stack: localModuleResources({
      web: containerEnv({
        APP_DATABASE_OPTIONS: { value: "password=$(DB_PASSWORD)" },
        DB_PASSWORD: { value: "secret" }
      })
    })
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /stack\.web\.properties\.containers\.web\.env\./u
  );
});

test("reports an unresolved expansion in a value supplied by a parameter default", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template(
    {
      web: containerEnv({
        APP_DATABASE_OPTIONS: { value: "[parameters('options')]" },
        DB_PASSWORD: { value: "secret" }
      })
    },
    { options: { type: "string", defaultValue: "password=$(DB_PASSWORD)" } }
  );

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /runtime-variable/u);
});

test("stays silent when letter case decides the ordering", () => {
  const directory = temporaryDirectory();
  // Ordinally APP_credential sorts after APP_OPTIONS ('c' > 'O'), but folded it
  // sorts before ('C' < 'O'). The two answers disagree, so the check says
  // nothing rather than risk failing a model the deployed sort would resolve.
  const compiledOutput = template({
    web: containerEnv({
      APP_OPTIONS: { value: "password=$(APP_credential)" },
      APP_credential: { value: "secret" }
    })
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("reports a lowercase helper that sorts after under every comparison", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    web: containerEnv({
      APP_DATABASE_OPTIONS: { value: "password=$(app_password)" },
      app_password: { value: "secret" }
    })
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /runtime-variable/u);
});

test("resolves a top-level source-reference parameter default", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template(
    {
      web: radiusResource("Radius.Compute/containers@2025-08-01-preview", {
        codeReference: "[parameters('sourceReference')]"
      })
    },
    {
      sourceReference: {
        type: "string",
        defaultValue: "src/app.ts#L12"
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

test("rejects an unresolved top-level source-reference expression", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template(
    {
      web: radiusResource("Radius.Compute/containers@2025-08-01-preview", {
        codeReference: "[parameters('sourceReference')]"
      })
    },
    { sourceReference: { type: "string" } }
  );

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must resolve to a repo-relative worktree path/u);
});

test("resolves source-reference parameters through local module invocations", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    module: localModuleResources(
      {
        queue: radiusResource("Radius.Messaging/rabbitMQ@2025-08-01-preview", {
          codeReference: "[parameters('sourceReference')]"
        })
      },
      { sourceReference: { type: "string" } },
      { sourceReference: { value: "src/queue.ts#L4" } }
    )
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("checks source references inside local modules", () => {
  const directory = temporaryDirectory();
  const compiledOutput = template({
    module: localModuleResources({
      queue: {
        type: "Radius.Messaging/rabbitMQ@2025-08-01-preview",
        properties: { properties: {} }
      }
    })
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /module\.queue\.properties\.codeReference/u);
});

test.each([
  "Dockerfile",
  "services/api/Dockerfile",
  "Dockerfile.prod",
  "api.Dockerfile",
  "docker-compose.yml",
  "docker-compose.override.yaml",
  "compose.yaml",
  "deploy/chart.yaml",
  "deploy/values.yaml",
  "services/api/dockerfile#L3",
  "https://github.com/acme/app/blob/main/services/api/Dockerfile",
  "https://github.com/acme/app/blob/main/Docker%66ile",
  "https://github.com/acme/app/blob/main/services/api/docker-compose%2Eyml",
  "https://github.com/acme/app/blob/main/bad%ZZdir/Dockerfile"
])(
  "rejects a packaging file as a container source reference: %s",
  (codeReference) => {
    const directory = temporaryDirectory();
    const compiledOutput = template({
      web: radiusResource("Radius.Compute/containers@2025-08-01-preview", {
        codeReference
      })
    });

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /is a packaging file/u);
    assert.match(result.stderr, /web\.properties\.codeReference/u);
  }
);

test("accepts the Dockerfile a containerImages resource builds from", () => {
  // The image resource exists to build that file, so it is the definition site.
  // Only the workload that runs the image must point past it at the entrypoint.
  const directory = temporaryDirectory();
  const compiledOutput = template({
    image: radiusResource(containerImageType, {
      build: {
        source: `git::https://github.com/example/app.git?ref=${fullSha}`
      },
      codeReference: "services/api/Dockerfile"
    })
  });

  const result = runChecker(
    directory,
    fakeBicep(directory, sarif([]), 0, compiledOutput)
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test.each([
  "src/server.ts",
  "cmd/api/main.go#L12",
  "src/dockerfile-generator.ts",
  "src/compose-loader.ts"
])(
  "accepts a container entrypoint that is not a packaging file: %s",
  (codeReference) => {
    const directory = temporaryDirectory();
    const compiledOutput = template({
      web: radiusResource("Radius.Compute/containers@2025-08-01-preview", {
        codeReference
      })
    });

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  }
);

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

test("adds custom-type repair guidance to a codeReference BCP037 diagnostic", () => {
  const directory = temporaryDirectory();
  const result = runChecker(
    directory,
    fakeBicep(
      directory,
      sarif([
        {
          ruleId: "BCP037",
          message: {
            text: 'The property "codeReference" is not allowed on objects of type "properties".'
          },
          level: "error"
        }
      ]),
      1
    )
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /add the optional codeReference string property/u
  );
  assert.match(result.stderr, /republish custom-types\.tgz/u);
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

// One SARIF diagnostic, at a given line, so a case can vary the rule, the text,
// and the position independently.
function diagnostic(ruleId: string, text: string, startLine: number) {
  return {
    level: "error",
    ruleId,
    message: { text },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: "file:///tmp/app.bicep" },
          region: { startLine }
        }
      }
    ]
  };
}

// Compiler output holding a single Bicep diagnostic.
function bcp(code: number, text: string, startLine: number): string {
  return sarif([
    diagnostic(`BCP${code.toString().padStart(3, "0")}`, text, startLine)
  ]);
}

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
      attempts: REPAIR_COMPILE_LIMIT - 1,
      fingerprint: null
    });

    const result = runChecker(directory, fakeBicep(directory, failure, 1));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /BCP057/u);
    assert.match(result.stderr, /repair budget is now spent/u);
  });

  it("refuses a compile past the budget without running Bicep at all", () => {
    const directory = temporaryDirectory();
    stagedRun(directory, {
      attempts: REPAIR_COMPILE_LIMIT,
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
    assert.match(
      result.stderr,
      new RegExp(`repair budget of ${REPAIR_ATTEMPT_BUDGET} is spent`, "u")
    );
    assert.match(result.stderr, /no application definition was written/u);
    assert.equal(fs.existsSync(path.join(directory, "spawned")), false);
    assert.deepEqual(readRepair(directory), {
      attempts: REPAIR_COMPILE_LIMIT,
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

  it("recognizes a repeated source-reference validation failure", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    const compiledOutput = template({
      web: {
        type: "Radius.Compute/containers@2025-08-01-preview",
        properties: { properties: {} }
      }
    });

    const first = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );
    const second = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    assert.doesNotMatch(first.stderr, /same compiler failure/u);
    assert.match(second.stderr, /same compiler failure/u);
  });

  it("does not conflate changed source-reference validation failures", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    const missing = template({
      web: {
        type: "Radius.Compute/containers@2025-08-01-preview",
        properties: { properties: {} }
      }
    });
    const unsafe = template({
      web: radiusResource("Radius.Compute/containers@2025-08-01-preview", {
        codeReference: "../src/app.ts"
      })
    });

    runChecker(directory, fakeBicep(directory, sarif([]), 0, missing));
    const second = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, unsafe)
    );

    assert.doesNotMatch(second.stderr, /same compiler failure/u);
  });

  it("stops a stuck run once the budget is spent", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);

    const statuses = Array.from(
      { length: REPAIR_COMPILE_LIMIT },
      () => runChecker(directory, fakeBicep(directory, failure, 1)).status
    );
    assert.deepEqual(statuses, Array(REPAIR_COMPILE_LIMIT).fill(1));

    const refused = runChecker(directory, fakeBicep(directory, failure, 1));
    assert.match(
      refused.stderr,
      new RegExp(`repair budget of ${REPAIR_ATTEMPT_BUDGET} is spent`, "u")
    );
    assert.equal(
      (readRepair(directory) as { attempts: number }).attempts,
      REPAIR_COMPILE_LIMIT
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
  ])("refuses to compile a staged run whose record is %s", (_name, text) => {
    const directory = temporaryDirectory();
    writeRunRecord(directory, text);

    const result = runChecker(directory, fakeBicep(directory, failure, 1));

    // Fail closed: an unreadable counter is indistinguishable from a spent
    // one, so compiling would hand the run an unlimited budget.
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not be recorded/u);
    assert.doesNotMatch(result.stderr, /BCP057/u);
    // The unusable record is left alone rather than overwritten, because it
    // may still hold the baseline the publish check needs.
    assert.equal(
      fs.readFileSync(path.join(directory, STAGING_RUN_RECORD), "utf8"),
      text
    );
  });

  it("starts the count fresh when only the repair field is unusable", () => {
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

  // A read-only file is still writable by root and the mode is not enforced on
  // Windows, so this runs only where the permission genuinely holds.
  const unwritable =
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    process.getuid() !== 0;

  it.runIf(unwritable)(
    "refuses to compile when the attempt cannot be recorded",
    () => {
      const directory = temporaryDirectory();
      stagedRun(directory);
      // The directory is what must be unwritable: the attempt is staged through
      // a temporary file next to the record, so a read-only record alone would
      // still be replaceable by the rename. Everything the run needs is written
      // before the lock goes on.
      const env = fakeBicep(directory, sarif([]), 0);
      fs.writeFileSync(path.join(directory, "app.bicep"), "");
      fs.chmodSync(directory, 0o555);

      try {
        const result = rerunChecker(directory, env);

        // A compile that cannot be counted is refused rather than run: letting
        // it through leaves the budget stuck and the loop unbounded.
        assert.equal(result.status, 1);
        assert.match(result.stderr, /could not be recorded/u);
      } finally {
        fs.chmodSync(directory, 0o755);
      }
    }
  );

  it.runIf(unwritable)(
    "keeps refusing rather than allowing an uncounted loop",
    () => {
      const directory = temporaryDirectory();
      stagedRun(directory);
      const env = fakeBicep(directory, failure, 1);
      fs.writeFileSync(path.join(directory, "app.bicep"), "");
      fs.chmodSync(directory, 0o555);

      try {
        // Before this was fail-closed, a record that could not be updated left
        // the count frozen, so every later compile was allowed forever. Run
        // more times than the budget allows, so a frozen counter would show up
        // as a compile that should have been refused.
        const attempts = REPAIR_COMPILE_LIMIT + 2;
        const statuses = Array.from(
          { length: attempts },
          () => rerunChecker(directory, env).status
        );

        assert.deepEqual(statuses, Array(attempts).fill(1));
      } finally {
        fs.chmodSync(directory, 0o755);
      }
    }
  );

  it("counts a run that never leaves a staging directory separately", () => {
    const first = temporaryDirectory();
    stagedRun(first, { attempts: REPAIR_COMPILE_LIMIT, fingerprint: "abc" });
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
  // The authoring budget and the deploy-failure repair budget answer the same
  // question — how many times we retry a repair on app.bicep — so they are
  // pinned to each other here rather than each carrying its own literal.
  // DEPLOY_HANDOFF_MAX_ATTEMPTS is deliberately not this number: it counts
  // deliveries of the handoff message, not repairs.
  it("uses the same budget as the deploy-failure repair loop", async () => {
    const { DEPLOY_REPAIR_ATTEMPT_CAP } =
      await import("../../../src/runtime/hooks.js");

    assert.equal(REPAIR_ATTEMPT_BUDGET, DEPLOY_REPAIR_ATTEMPT_CAP);
  });

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

  // Each case is driven through the checker, so the script's own copy of the
  // fingerprinting is what produces the recorded value and core only supplies
  // the verdict to compare against. Calling core for both sides would leave the
  // duplicated logic in validate-bicep.mjs untested by the very test that
  // exists to pin it.
  it.each([
    {
      name: "an identical failure",
      first: bcp(57, "missing", 12),
      second: bcp(57, "missing", 12),
      repeated: true
    },
    {
      name: "the same failure at a shifted line",
      first: bcp(57, "missing", 12),
      second: bcp(57, "missing", 48),
      repeated: true
    },
    {
      name: "the same failures in a different order",
      first: sarif([
        diagnostic("BCP057", "first problem", 1),
        diagnostic("BCP062", "second problem", 2)
      ]),
      second: sarif([
        diagnostic("BCP062", "second problem", 9),
        diagnostic("BCP057", "first problem", 3)
      ]),
      repeated: true
    },
    {
      name: "a different failure",
      first: bcp(57, "missing", 12),
      second: bcp(62, "invalid", 12),
      repeated: false
    }
  ])("agrees on whether $name is a repeat", ({ first, second, repeated }) => {
    const directory = temporaryDirectory();
    stagedRun(directory);

    runChecker(directory, fakeBicep(directory, first, 1));
    const afterFirst = parseRepairState(readRepair(directory));
    runChecker(directory, fakeBicep(directory, second, 1));
    const afterSecond = parseRepairState(readRepair(directory));

    // The script recorded both fingerprints; core decides whether they mean
    // the same failure. Agreement is that verdict matching what the script
    // told the agent.
    assert.equal(
      isRepeatedFailure(afterFirst, afterSecond.fingerprint),
      repeated
    );
  });

  // The script's fingerprint of a given compiler output must be the value core
  // would compute from the same text, or the two could agree on every pair
  // above while disagreeing about what a fingerprint is.
  it("records the fingerprint core would compute", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);

    const result = runChecker(
      directory,
      fakeBicep(directory, bcp(57, "missing", 12), 1)
    );
    const recorded = parseRepairState(readRepair(directory));

    assert.equal(
      recorded.fingerprint,
      fingerprintCompilerOutput(result.stderr)
    );
  });

  it("wires the checker's own copy of the rules to core's", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);

    // The compiler is installed once and only its output varies, because
    // reinstalling a currently executing binary raises ETXTBSY.
    const env = fakeBicep(directory, failure, 1);
    runChecker(directory, env);
    const recorded = parseRepairState(readRepair(directory));

    // The same diagnostic at a line that moved: the checker must recognize it
    // through its own fingerprint, exactly as core would.
    const second = runChecker(
      directory,
      fakeBicep(directory, shiftedFailure, 1)
    );
    const after = parseRepairState(readRepair(directory));

    assert.equal(isRepeatedFailure(recorded, after.fingerprint), true);
    assert.match(
      second.stderr,
      new RegExp(escapeRegExp(REPEATED_FAILURE_MESSAGE), "u")
    );
  });

  it("does not call a changed failure a repeat end to end", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);

    const env = fakeBicep(directory, failure, 1);
    runChecker(directory, env);
    const recorded = parseRepairState(readRepair(directory));

    const second = runChecker(directory, fakeBicep(directory, otherFailure, 1));
    const after = parseRepairState(readRepair(directory));

    assert.equal(isRepeatedFailure(recorded, after.fingerprint), false);
    assert.doesNotMatch(second.stderr, /same compiler failure/u);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
// The staged contract show-radius-type.mjs writes for the checker. The name is
// this suite's copy of the literal both scripts declare, and the resolver suite
// proves the writer stages it under exactly this name.
const RESOLVED_TYPES = "resolved-types.json";
const rabbitMqType = "Radius.Messaging/rabbitMQ@2025-08-01-preview";
const mySqlType = "Radius.Data/mySqlDatabases@2025-08-01-preview";
const securePassword = { type: "securestring" };

function stagedResolvedTypes(directory: string, contract: unknown): void {
  fs.writeFileSync(
    path.join(directory, RESOLVED_TYPES),
    typeof contract === "string" ? contract : JSON.stringify(contract, null, 2)
  );
}

function resolvedTypes(types: object): object {
  return { contractVersion: 1, types };
}

// The failing shape the check exists to catch: the raw credential assigned to a
// property that holds a Radius.Security/secrets resource ID.
function rabbitMqWithRawPassword(): string {
  return template(
    {
      rabbitmq: radiusResource(rabbitMqType, {
        queue: "orders",
        password: "[parameters('rabbitmqPassword')]"
      })
    },
    { rabbitmqPassword: securePassword }
  );
}

describe("secure parameter targets", () => {
  it("flags a secure parameter assigned to a property the schema leaves plain", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    stagedResolvedTypes(
      directory,
      resolvedTypes({ [rabbitMqType]: { password: false, queue: false } })
    );

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, rabbitMqWithRawPassword())
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /secure-parameter-target/u);
    assert.match(result.stderr, /rabbitmq\.properties\.password/u);
    assert.match(result.stderr, /does not mark password sensitive/u);
    assert.match(result.stderr, /<secret>\.id/u);
  });

  it("accepts a secure parameter assigned to a property the schema marks sensitive", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    stagedResolvedTypes(
      directory,
      resolvedTypes({ [mySqlType]: { password: true, database: false } })
    );
    const compiledOutput = template(
      {
        mysql: radiusResource(mySqlType, {
          database: "orders",
          password: "[parameters('mysqlPassword')]"
        })
      },
      { mysqlPassword: securePassword }
    );

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  it("separates the two types that name the property the same way", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    stagedResolvedTypes(
      directory,
      resolvedTypes({
        [mySqlType]: { password: true },
        [rabbitMqType]: { password: false }
      })
    );
    const compiledOutput = template(
      {
        mysql: radiusResource(mySqlType, {
          password: "[parameters('credential')]"
        }),
        rabbitmq: radiusResource(rabbitMqType, {
          password: "[parameters('credential')]"
        })
      },
      { credential: securePassword }
    );

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /rabbitmq\.properties\.password/u);
    assert.doesNotMatch(result.stderr, /mysql\.properties\.password/u);
  });

  it("reports a secure parameter the run staged no resolved types for", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, rabbitMqWithRawPassword())
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /staged no resolved type schemas/u);
    assert.match(result.stderr, /show-radius-type\.mjs/u);
  });

  it("passes a staged run with no resolved types and no secure parameter", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    const compiledOutput = template({
      rabbitmq: radiusResource(rabbitMqType, { queue: "orders" })
    });

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  it("does not apply to a compile outside a staged modeling run", () => {
    const directory = temporaryDirectory();

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, rabbitMqWithRawPassword())
    );

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  it("fails closed when the staged resolved types are not valid JSON", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    stagedResolvedTypes(directory, "{not json");
    // No secure parameter anywhere: the refusal comes from the unreadable
    // contract rather than from anything in the model.
    const compiledOutput = template({
      rabbitmq: radiusResource(rabbitMqType, { queue: "orders" })
    });

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not be read: it is not valid JSON/u);
    assert.match(result.stderr, new RegExp(escapeRegExp(RESOLVED_TYPES), "u"));
  });

  it.each([
    {
      name: "a different contract version",
      contract: { contractVersion: 2, types: {} },
      expected: /is not a version 1 resolved-type contract/u
    },
    {
      name: "no type map",
      contract: { contractVersion: 1 },
      expected: /is not a version 1 resolved-type contract/u
    },
    {
      name: "a JSON array",
      contract: [],
      expected: /is not a version 1 resolved-type contract/u
    },
    {
      name: "a type that is not an object",
      contract: { contractVersion: 1, types: { [rabbitMqType]: "password" } },
      expected: /does not map each property to a boolean/u
    },
    {
      name: "a property sensitivity that is not a boolean",
      contract: {
        contractVersion: 1,
        types: { [rabbitMqType]: { password: "false" } }
      },
      expected: /does not map each property to a boolean/u
    }
  ])(
    "fails closed on staged resolved types with $name",
    ({ contract, expected }) => {
      const directory = temporaryDirectory();
      stagedRun(directory);
      stagedResolvedTypes(directory, contract);

      const result = runChecker(
        directory,
        fakeBicep(directory, sarif([]), 0, rabbitMqWithRawPassword())
      );

      assert.equal(result.status, 1);
      assert.match(result.stderr, expected);
    }
  );

  it("fails closed when the staged resolved types cannot be read at all", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    fs.mkdirSync(path.join(directory, RESOLVED_TYPES));

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, rabbitMqWithRawPassword())
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not be read/u);
  });

  it("reports a secure parameter on a type this run never resolved", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    stagedResolvedTypes(
      directory,
      resolvedTypes({ [mySqlType]: { password: true } })
    );

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, rabbitMqWithRawPassword())
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /was not resolved in this modeling run/u);
    assert.match(result.stderr, new RegExp(escapeRegExp(rabbitMqType), "u"));
  });

  it("reports a secure parameter on a property the resolved schema omits", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    stagedResolvedTypes(
      directory,
      resolvedTypes({ [rabbitMqType]: { queue: false } })
    );

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, rabbitMqWithRawPassword())
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not describe password/u);
  });

  it("ignores a generated custom type the resolver cannot resolve", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    stagedResolvedTypes(directory, resolvedTypes({}));
    const compiledOutput = template(
      {
        broker: radiusResource("Radius.Resources/brokers@2025-08-01-preview", {
          password: "[parameters('brokerPassword')]"
        })
      },
      { brokerPassword: securePassword }
    );

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  it("checks secure parameter targets inside a local module", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    stagedResolvedTypes(
      directory,
      resolvedTypes({ [rabbitMqType]: { password: false } })
    );
    const compiledOutput = template(
      {
        messaging: localModuleResources(
          {
            rabbitmq: radiusResource(rabbitMqType, {
              password: "[parameters('modulePassword')]"
            })
          },
          { modulePassword: securePassword },
          { modulePassword: { value: "[parameters('rootPassword')]" } }
        )
      },
      { rootPassword: securePassword }
    );

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /messaging\.rabbitmq\.properties\.password/u);
  });

  it("ignores a module resource without a nested template", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    stagedResolvedTypes(
      directory,
      resolvedTypes({ [rabbitMqType]: { password: false } })
    );
    const compiledOutput = template({
      messaging: {
        type: "Microsoft.Resources/deployments",
        properties: { parameters: {}, template: "not a template" }
      }
    });

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  it.each([
    {
      name: "an interpolated secure parameter",
      value: "[format('{0}', parameters('rabbitmqPassword'))]"
    },
    {
      name: "a secret resource ID",
      value: "[reference('rabbitmqCredentials').id]"
    },
    { name: "a literal", value: "rabbitmq-credentials" },
    { name: "a value that is not a string", value: 42 }
  ])("does not report $name", ({ value }) => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    stagedResolvedTypes(
      directory,
      resolvedTypes({ [rabbitMqType]: { password: false } })
    );
    const compiledOutput = template(
      {
        rabbitmq: radiusResource(rabbitMqType, { password: value })
      },
      { rabbitmqPassword: securePassword }
    );

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  it.each([
    { name: "is not secure", declaration: { type: "string" } },
    // A `@secure()` object legitimately carries a whole Secret data map, whose
    // enclosing property the schema does not mark sensitive.
    { name: "is a secure object", declaration: { type: "secureObject" } }
  ])("does not report a parameter that $name", ({ declaration }) => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    stagedResolvedTypes(
      directory,
      resolvedTypes({ [rabbitMqType]: { password: false } })
    );
    const compiledOutput = template(
      {
        rabbitmq: radiusResource(rabbitMqType, {
          password: "[parameters('secretId')]"
        })
      },
      { secretId: declaration }
    );

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  it("does not report a secure parameter nested inside an object property", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    stagedResolvedTypes(
      directory,
      resolvedTypes({
        "Radius.Security/secrets@2025-08-01-preview": { data: false }
      })
    );
    const compiledOutput = template(
      {
        credentials: radiusResource(
          "Radius.Security/secrets@2025-08-01-preview",
          {
            data: {
              password: { value: "[parameters('rabbitmqPassword')]" }
            }
          }
        )
      },
      { rabbitmqPassword: securePassword }
    );

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  it("ignores a Radius resource with no properties envelope", () => {
    const directory = temporaryDirectory();
    stagedRun(directory);
    stagedResolvedTypes(
      directory,
      resolvedTypes({ [rabbitMqType]: { password: false } })
    );
    const compiledOutput = template({
      rabbitmq: {
        type: rabbitMqType,
        properties: { properties: "[parameters('rabbitmqPassword')]" }
      }
    });

    const result = runChecker(
      directory,
      fakeBicep(directory, sarif([]), 0, compiledOutput)
    );

    // The missing envelope is a source-reference failure, not a credential one.
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /secure-parameter-target/u);
  });
});
