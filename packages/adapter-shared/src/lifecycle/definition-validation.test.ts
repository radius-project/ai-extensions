import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEffectiveInputManifest,
  createValidationPolicy,
  portAbsent,
  portSuccess,
  portUnavailable,
  type DefinitionInput,
  type RequestControl,
  type SourceSnapshot
} from "@radius-project/core/lifecycle";
import { RadProcessError, spawnRad } from "../rad.js";
import { nodeSourceFileSystem } from "./source-access.js";
import {
  createDefinitionValidationAdapter,
  type DefinitionValidationDependencies
} from "./definition-validation.js";

const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../extensions/radius/skills/radius-app-bicep/scripts/validate-bicep.mjs"
);
const roots: string[] = [];

async function machine(template: unknown, findings: unknown[] = []) {
  const root = resolve(".artifacts", `validation-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "app.bicep"), "// unchanged\r\n");
  await writeFile(join(root, "run.json"), '{"repair":{"attempts":6}}');
  await writeFile(join(root, "template.json"), JSON.stringify(template));
  await writeFile(
    join(root, "diagnostics.json"),
    JSON.stringify({ runs: [{ results: findings }] })
  );
  const result = await spawnRad(
    process.execPath,
    [
      script,
      "--validate-json",
      join(root, "app.bicep"),
      join(root, "template.json"),
      join(root, "diagnostics.json"),
      "passed"
    ],
    {
      cwd: root,
      inheritEnv: false,
      env: {
        SystemRoot: process.env.SystemRoot,
        NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE
      },
      timeout: 3_000
    }
  ).catch((error: unknown) => {
    if (error instanceof RadProcessError)
      throw new Error(`${error.message}\n${error.stderr}`);
    throw error;
  });
  return { root, result, report: JSON.parse(result.stdout) };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function hash(bytes: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture(
  template: unknown = { resources: {} },
  extras:
    Record<string, string> | ((root: string) => Record<string, string>) = {},
  definition = "// exact source\r\n",
  findings: readonly unknown[] = []
) {
  const root = resolve(".artifacts", `validation-adapter-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  const data = new Map(
    Object.entries({
      ".radius/app.bicep": definition,
      ".radius/build":
        `import fs from 'node:fs';\n` +
        `if (process.env.GH_TOKEN || process.env.AWS_PROFILE || process.env.NODE_OPTIONS) throw Error('Inherited environment');\n` +
        `if (process.argv[3] !== '--diagnostics-format' || process.argv[4] !== 'sarif' || process.argv[5] !== '--stdout') throw Error('Bad argv');\n` +
        `if (fs.readFileSync(process.argv[2], 'utf8') !== ${JSON.stringify(definition)}) throw Error('Wrong bytes');\n` +
        `console.error(${JSON.stringify(JSON.stringify({ runs: [{ results: findings }] }))});\n` +
        `console.log(${JSON.stringify(JSON.stringify(template))});\n`,
      ...(typeof extras === "function" ? extras(root) : extras)
    }).map(([path, text]) => [path, new TextEncoder().encode(text)])
  );
  const inputs: DefinitionInput[] = [...data].map(([path, bytes]) => ({
    path,
    kind: path.endsWith("app.bicep") ? "definition" : "file",
    existed: true,
    contentHash: hash(bytes)
  }));
  for (const path of ["bicepconfig.json", ".radius/bicepconfig.json"])
    if (!data.has(path))
      inputs.push({
        path,
        kind: "configuration",
        existed: false,
        contentHash: null
      });
  const manifest = buildEffectiveInputManifest(
    { definition: ".radius/app.bicep", inputs, closure: "complete" },
    hash
  );
  if (manifest.status !== "ok" || manifest.value.completeness !== "complete")
    throw new Error("Invalid validation fixture manifest");
  const snapshot: SourceSnapshot = {
    snapshotRef: "validation-snapshot",
    selection: {
      repo: "example/app",
      definition: ".radius/app.bicep",
      source: {
        kind: "git",
        ref: "feature/validate",
        expectedCommit: "a".repeat(40)
      }
    },
    provenance: {
      kind: "git",
      repo: "example/app",
      ref: "feature/validate",
      commit: "a".repeat(40),
      fingerprint: manifest.value.fingerprint,
      resolvedAt: "2026-09-16T12:00:00Z"
    },
    manifest: manifest.value
  };
  const controller = new AbortController();
  const control: RequestControl = {
    requestId: "validation-request",
    cancellation: {
      get aborted() {
        return controller.signal.aborted;
      },
      onAbort(listener) {
        controller.signal.addEventListener("abort", listener);
        return () => controller.signal.removeEventListener("abort", listener);
      }
    }
  };
  const runProcess = vi.fn<typeof spawnRad>(spawnRad);
  const deps: DefinitionValidationDependencies = {
    source: {
      readBytes: async (owned, path) => {
        expect(owned).toBe(snapshot);
        const input = snapshot.manifest.inputs.find(
          (item) => item.path === path
        );
        if (!input) throw new Error("Unexpected read");
        const bytes = data.get(path);
        return bytes ?
            portSuccess({ input, bytes: bytes.slice() })
          : portAbsent({
              quality: "current",
              evidence: "source",
              completeness: "complete",
              observedAt: "2026-09-16T12:00:00Z"
            });
      }
    },
    files: { ...nodeSourceFileSystem },
    storageRoot: root,
    ids: { next: () => "validation" },
    acquireBinaries: async () =>
      portSuccess({ radPath: process.execPath, bicepPath: process.execPath }),
    trustedPath: [],
    ...(process.env.SystemRoot ? { systemRoot: process.env.SystemRoot } : {}),
    timeoutMs: 3_000,
    nodePath: process.execPath,
    scriptPath: script,
    runProcess
  };
  const request = {
    snapshot,
    policy: createValidationPolicy("validation"),
    sourceFingerprint: snapshot.manifest.fingerprint
  };
  return {
    root,
    data,
    snapshot,
    controller,
    control,
    deps,
    request,
    runProcess
  };
}

describe("owned no-agent definition validator", () => {
  it.each([
    { schema: true, warning: false, expected: "passed" },
    { schema: false, warning: false, expected: "incomplete" },
    { schema: true, warning: true, expected: "failed" }
  ])(
    "composes actual machine rules for a nonempty application model: $expected",
    async ({ schema, warning, expected }) => {
      const type = "Radius.Core/applications@2025-08-01-preview";
      const definition =
        `resource app '${type}' = {\n` +
        `  name: 'validation-app'\n` +
        `  location: 'global'\n` +
        `  properties: { environment: 'validation' }\n` +
        `}\n`;
      const resolvedTypes = JSON.stringify({
        contractVersion: 1,
        types: { [type]: { environment: false } }
      });
      const f = await fixture(
        {
          resources: {
            app: {
              type,
              properties: {
                name: "validation-app",
                location: "global",
                properties: { environment: "validation" }
              }
            }
          }
        },
        schema ? { ".radius/resolved-types.json": resolvedTypes } : {},
        definition,
        warning ? [{ level: "warning", ruleId: "BCP036" }] : []
      );
      const originalFingerprint = `sha256:${"b".repeat(64)}`;
      const result = await createDefinitionValidationAdapter(f.deps).validate(
        {
          ...f.request,
          sourceFingerprint: originalFingerprint,
          proposalFingerprint: f.snapshot.manifest.fingerprint
        },
        f.control
      );
      expect(result).toMatchObject({
        status: "ok",
        value: {
          status: expected,
          sourceFingerprint: originalFingerprint,
          proposalFingerprint: f.snapshot.manifest.fingerprint
        }
      });
      if (result.status !== "ok") throw new Error("Expected validation report");
      expect(
        result.value.checks.filter(
          (check) => check.classification === "required"
        )
      ).toHaveLength(7);
      expect(
        result.value.checks.filter((check) =>
          [
            "runtime-contract",
            "reference-consistency",
            "recipe-constraints"
          ].includes(check.checkId)
        )
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "runtime-contract",
            status: "passed",
            classification: "required"
          }),
          expect.objectContaining({
            checkId: "reference-consistency",
            status: "passed",
            classification: "required"
          }),
          expect.objectContaining({
            checkId: "recipe-constraints",
            status: "passed",
            classification: "required"
          })
        ])
      );
      expect(f.runProcess).toHaveBeenCalledTimes(2);
      expect(f.runProcess.mock.calls[1][1][1]).toBe("--validate-json");
      expect(await readdir(f.root)).toEqual([]);
      expect(new TextDecoder().decode(f.data.get(".radius/app.bicep"))).toBe(
        definition
      );
    }
  );

  it("runs real compiler and script boundaries with isolated argv/env and unchanged bytes", async () => {
    const f = await fixture();
    vi.stubEnv("GH_TOKEN", "fixture-not-a-credential");
    vi.stubEnv("AWS_PROFILE", "fixture-profile");
    vi.stubEnv("NODE_OPTIONS", "--invalid-fixture-option");
    const result = await createDefinitionValidationAdapter(f.deps).validate(
      f.request,
      f.control
    );
    await f.runProcess.mock.results[0].value.catch((error: RadProcessError) => {
      throw new Error(error.stderr);
    });
    expect(result).toMatchObject({
      status: "ok",
      value: {
        status: "passed",
        sourceFingerprint: f.request.sourceFingerprint,
        warnings: [expect.stringContaining("descriptive-enrichment")]
      }
    });
    expect(f.runProcess).toHaveBeenCalledTimes(2);
    expect(f.runProcess.mock.calls[0][1].slice(2)).toEqual([
      "--diagnostics-format",
      "sarif",
      "--stdout"
    ]);
    expect(f.runProcess.mock.calls[1][1][1]).toBe("--validate-json");
    expect(
      f.runProcess.mock.calls.every(
        ([, , options]) => options?.inheritEnv === false
      )
    ).toBe(true);
    expect(await readdir(f.root)).toEqual([]);
    expect(new TextDecoder().decode(f.data.get(".radius/app.bicep"))).toBe(
      "// exact source\r\n"
    );
  });

  it("reports unavailable schema/runtime/reference/recipe evidence while running existing checks", async () => {
    const f = await fixture({
      resources: {
        api: {
          type: "Radius.Compute/containers@2025-08-01",
          properties: { properties: { codeReference: "src/main.ts" } }
        }
      }
    });
    const result = await createDefinitionValidationAdapter(f.deps).validate(
      f.request,
      f.control
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected validation report");
    expect(result.value.status).toBe("incomplete");
    expect(
      result.value.checks
        .filter((check) => check.status === "unavailable")
        .map((check) => check.checkId)
    ).toEqual([
      "type-compatibility",
      "secret-safety",
      "runtime-contract",
      "reference-consistency",
      "recipe-constraints",
      "descriptive-enrichment"
    ]);
    expect(f.runProcess).toHaveBeenCalledTimes(2);
  });

  it("retains original and exact proposal identities without requiring an agent", async () => {
    const f = await fixture();
    const result = await createDefinitionValidationAdapter(f.deps).validate(
      {
        ...f.request,
        sourceFingerprint: `sha256:${"b".repeat(64)}`,
        proposalFingerprint: f.snapshot.manifest.fingerprint,
        policy: createValidationPolicy("authoring", "azure")
      },
      f.control
    );
    expect(result).toMatchObject({
      status: "ok",
      value: {
        status: "incomplete",
        sourceFingerprint: `sha256:${"b".repeat(64)}`,
        proposalFingerprint: f.snapshot.manifest.fingerprint,
        checks: expect.arrayContaining([
          expect.objectContaining({
            checkId: "modelability",
            status: "unavailable"
          }),
          expect.objectContaining({
            checkId: "staged-artifacts",
            status: "unavailable"
          })
        ])
      }
    });
  });

  it("refuses stale fingerprints and a downgraded required policy before execution", async () => {
    const f = await fixture();
    const adapter = createDefinitionValidationAdapter(f.deps);
    expect(
      await adapter.validate(
        { ...f.request, sourceFingerprint: "wrong" },
        f.control
      )
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
    expect(
      await adapter.validate(
        {
          ...f.request,
          policy: { ...f.request.policy, checks: [] }
        },
        f.control
      )
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
    expect(f.runProcess).not.toHaveBeenCalled();
  });

  it("does not compile changed snapshot bytes or restore registry dependencies", async () => {
    const f = await fixture();
    f.data.set(".radius/app.bicep", new TextEncoder().encode("changed"));
    expect(
      await createDefinitionValidationAdapter(f.deps).validate(
        f.request,
        f.control
      )
    ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
    expect(f.runProcess).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
    const registry = await fixture(
      {},
      {
        ".radius/app.bicep":
          "module x 'br:example.test/modules/x:v1' = { name: 'x' }"
      }
    );
    const result = await createDefinitionValidationAdapter(
      registry.deps
    ).validate(registry.request, registry.control);
    expect(result).toMatchObject({
      status: "ok",
      value: {
        status: "incomplete",
        checks: expect.arrayContaining([
          expect.objectContaining({
            checkId: "path-input-closure",
            status: "unavailable"
          })
        ])
      }
    });
    expect(registry.runProcess).not.toHaveBeenCalled();
  });

  it("discloses unavailable managed tooling without claiming compilation succeeded", async () => {
    const f = await fixture();
    f.deps.acquireBinaries = async () =>
      portUnavailable("CAPABILITY_UNAVAILABLE", {
        quality: "unknown",
        evidence: "radius",
        completeness: "unavailable"
      });
    expect(
      await createDefinitionValidationAdapter(f.deps).validate(
        f.request,
        f.control
      )
    ).toMatchObject({ status: "ok", value: { status: "incomplete" } });
    expect(f.runProcess).not.toHaveBeenCalled();
  });

  it("cancels before execution without creating scratch files", async () => {
    const f = await fixture();
    f.controller.abort();
    expect(
      await createDefinitionValidationAdapter(f.deps).validate(
        f.request,
        f.control
      )
    ).toMatchObject({ status: "cancelled" });
    expect(f.runProcess).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
  });

  it("validates complete authoring artifacts and captured Dockerfile evidence", async () => {
    const f = await fixture({ resources: [] }, (root) => ({
      Dockerfile: "FROM scratch",
      ".radius/app.origin.json": JSON.stringify({
        generatedAt: "2026-09-16T12:00:00Z",
        sourceCommit: "a".repeat(40),
        appBicepHash: hash("// exact source")
      }),
      ".radius/bicepconfig.json": JSON.stringify({
        cacheRootDirectory: join(root, "graph-validation", "home", ".bicep")
      })
    }));
    const result = await createDefinitionValidationAdapter({
      ...f.deps,
      runProcess: undefined
    }).validate(
      {
        ...f.request,
        policy: createValidationPolicy("authoring"),
        proposalFingerprint: f.snapshot.manifest.fingerprint
      },
      f.control
    );
    expect(result).toMatchObject({
      status: "ok",
      value: {
        status: "passed",
        checks: expect.arrayContaining([
          expect.objectContaining({
            checkId: "modelability",
            status: "passed"
          }),
          expect.objectContaining({
            checkId: "staged-artifacts",
            status: "passed"
          })
        ])
      }
    });
    expect(await readdir(f.root)).toEqual([]);
  });

  it("passes captured Recipe paths to the real validator and keeps unknown output mappings incomplete", async () => {
    const f = await fixture(
      {
        resources: {
          service: {
            type: "Radius.Messaging/rabbitMQ@2025-08-01",
            properties: { properties: { codeReference: "src/main.ts" } }
          }
        }
      },
      { ".radius/custom-recipe-pack.bicep": "not a Recipe pack" }
    );
    expect(
      await createDefinitionValidationAdapter(f.deps).validate(
        {
          ...f.request,
          policy: createValidationPolicy("validation", "azure")
        },
        f.control
      )
    ).toMatchObject({
      status: "ok",
      value: {
        status: "failed",
        checks: expect.arrayContaining([
          expect.objectContaining({
            checkId: "recipe-constraints",
            status: "failed"
          })
        ])
      }
    });
    expect(f.runProcess.mock.calls[1][1].at(-1)).toBe(
      join(
        f.root,
        "graph-validation",
        "source",
        ".radius",
        "custom-recipe-pack.bicep"
      )
    );
  });

  it("requires an explicit authoring proposal fingerprint", async () => {
    const f = await fixture();
    expect(
      await createDefinitionValidationAdapter(f.deps).validate(
        {
          ...f.request,
          policy: createValidationPolicy("authoring")
        },
        f.control
      )
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
    expect(f.runProcess).not.toHaveBeenCalled();
  });

  it.each([
    "{}",
    JSON.stringify({
      generatedAt: "2026-09-16T12:00:00Z",
      sourceCommit: "a".repeat(40),
      appBicepHash: `sha256:${"b".repeat(64)}`
    })
  ])(
    "rejects unusable or mismatched staged origins without suppressing compilation: %s",
    async (origin) => {
      const f = await fixture({ resources: [] }, (root) => ({
        Dockerfile: "FROM scratch",
        ".radius/app.origin.json": origin,
        ".radius/bicepconfig.json": JSON.stringify({
          cacheRootDirectory: join(root, "graph-validation", "home", ".bicep")
        })
      }));
      const result = await createDefinitionValidationAdapter(f.deps).validate(
        {
          ...f.request,
          policy: createValidationPolicy("authoring"),
          proposalFingerprint: f.snapshot.manifest.fingerprint
        },
        f.control
      );
      expect(result).toMatchObject({
        status: "ok",
        value: {
          status: "failed",
          checks: expect.arrayContaining([
            expect.objectContaining({
              checkId: "staged-artifacts",
              status: "failed"
            }),
            expect.objectContaining({
              checkId: "bicep-compile",
              status: "passed"
            })
          ])
        }
      });
      expect(f.runProcess).toHaveBeenCalledTimes(2);
    }
  );

  it("preserves native-cache isolation refusal without invoking a compiler", async () => {
    const f = await fixture(
      {},
      { ".radius/bicepconfig.json": '{"cacheRootDirectory":"outside-capture"}' }
    );
    expect(
      await createDefinitionValidationAdapter(f.deps).validate(
        f.request,
        f.control
      )
    ).toMatchObject({
      status: "ok",
      value: { status: "incomplete" }
    });

    expect(f.runProcess).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
  });

  it("keeps a staged origin that disappears from the owned materialization incomplete", async () => {
    const f = await fixture({ resources: [] }, (root) => ({
      ".radius/app.origin.json": "{}",
      ".radius/bicepconfig.json": JSON.stringify({
        cacheRootDirectory: join(root, "graph-validation", "home", ".bicep")
      })
    }));
    f.deps.files.lstat = async (file) => {
      if (file === script)
        await rm(
          join(
            f.root,
            "graph-validation",
            "source",
            ".radius",
            "app.origin.json"
          )
        );
      return nodeSourceFileSystem.lstat(file);
    };
    expect(
      await createDefinitionValidationAdapter(f.deps).validate(
        {
          ...f.request,
          policy: createValidationPolicy("authoring"),
          proposalFingerprint: f.snapshot.manifest.fingerprint
        },
        f.control
      )
    ).toMatchObject({
      status: "ok",
      value: {
        status: "incomplete",
        checks: expect.arrayContaining([
          expect.objectContaining({
            checkId: "staged-artifacts",
            status: "unavailable"
          })
        ])
      }
    });
    expect(await readdir(f.root)).toEqual([]);
  });

  it.each(["nodePath", "scriptPath"] as const)(
    "reports unavailable %s without execution",
    async (key) => {
      const f = await fixture();
      expect(
        await createDefinitionValidationAdapter({
          ...f.deps,
          [key]: f.root
        }).validate(f.request, f.control)
      ).toMatchObject({
        status: "ok",
        value: { status: "incomplete" }
      });
      expect(f.runProcess).not.toHaveBeenCalled();
    }
  );

  it("rejects invalid dependency paths and runners at construction", async () => {
    const f = await fixture();
    expect(() =>
      createDefinitionValidationAdapter({ ...f.deps, nodePath: "node" })
    ).toThrow(TypeError);
    expect(() =>
      createDefinitionValidationAdapter({
        ...f.deps,
        scriptPath: "validate.mjs"
      })
    ).toThrow(TypeError);
    expect(() =>
      // @ts-expect-error A JavaScript composition root can supply an invalid runner.
      createDefinitionValidationAdapter({ ...f.deps, runProcess: "spawn" })
    ).toThrow(TypeError);
  });

  it("retains a compiler failure even when the reporting executable fails", async () => {
    const f = await fixture(
      {},
      {
        ".radius/build": `console.error(JSON.stringify({runs:[{results:[{level:'error'}]}]})); process.exitCode = 1;`
      }
    );
    const broken = join(f.root, "broken.mjs");
    await writeFile(broken, "throw Error('reporter failed');");
    const result = await createDefinitionValidationAdapter({
      ...f.deps,
      scriptPath: broken
    }).validate(f.request, f.control);
    expect(result).toMatchObject({
      status: "ok",
      value: {
        status: "failed",
        checks: expect.arrayContaining([
          expect.objectContaining({
            checkId: "bicep-compile",
            status: "failed"
          })
        ])
      }
    });
    expect(await readdir(f.root)).toEqual(["broken.mjs"]);
  });

  it("reports compiler errors through the executable without losing their required classification", async () => {
    const f = await fixture(
      {},
      {
        ".radius/build": `console.error(JSON.stringify({runs:[{results:[{level:'error'}]}]})); process.exitCode = 1;`
      }
    );
    expect(
      await createDefinitionValidationAdapter(f.deps).validate(
        f.request,
        f.control
      )
    ).toMatchObject({
      status: "ok",
      value: { status: "failed" }
    });
    expect(f.runProcess).toHaveBeenCalledTimes(2);
    expect(await readdir(f.root)).toEqual([]);
  });

  it("surfaces a startup error as unavailable and cleans its materialization", async () => {
    const f = await fixture();
    const runner = vi.fn<typeof spawnRad>(async () => {
      throw new Error("spawn unavailable");
    });
    expect(
      await createDefinitionValidationAdapter({
        ...f.deps,
        runProcess: runner
      }).validate(f.request, f.control)
    ).toMatchObject({
      status: "ok",
      value: { status: "incomplete" }
    });
    expect(await readdir(f.root)).toEqual([]);
  });

  it("retains scratch ownership when process tree cleanup cannot be proven", async () => {
    const f = await fixture();
    const runner = vi.fn<typeof spawnRad>(async () => {
      throw new RadProcessError("cleanup failed", "", "", true);
    });
    expect(
      await createDefinitionValidationAdapter({
        ...f.deps,
        runProcess: runner
      }).validate(f.request, f.control)
    ).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(await readdir(f.root)).toEqual(["graph-validation"]);
  });

  it("surfaces cleanup failure instead of publishing a passed report", async () => {
    const f = await fixture();
    f.deps.files.remove = async () => {
      throw new Error("remove failed");
    };
    expect(
      await createDefinitionValidationAdapter(f.deps).validate(
        f.request,
        f.control
      )
    ).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
  });

  it("cancels a responsive real executable and releases its files after termination", async () => {
    const f = await fixture(
      {},
      {
        ".radius/build": `import fs from 'node:fs'; fs.writeFileSync('ready', 'ready'); setInterval(() => {}, 1000);`
      }
    );
    const watcher = watch(f.root, { recursive: true }, (_event, file) => {
      if (file?.toString().endsWith("ready")) f.controller.abort();
    });
    try {
      expect(
        await createDefinitionValidationAdapter(f.deps).validate(
          f.request,
          f.control
        )
      ).toMatchObject({ status: "cancelled" });
      expect(await readdir(f.root)).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  it("bounds a hung executable and reports incomplete rather than passed", async () => {
    const f = await fixture(
      {},
      { ".radius/build": "setInterval(() => {}, 1000);" }
    );
    expect(
      await createDefinitionValidationAdapter({
        ...f.deps,
        timeoutMs: 40
      }).validate(f.request, f.control)
    ).toMatchObject({
      status: "ok",
      value: { status: "incomplete" }
    });
    expect(await readdir(f.root)).toEqual([]);
  });

  const checkIds = [
    "bicep-compile",
    "type-compatibility",
    "secret-safety",
    "runtime-contract",
    "reference-consistency",
    "recipe-constraints"
  ];
  const validChecks = checkIds.map((checkId) => ({
    checkId,
    status: "passed"
  }));
  it.each([
    null,
    2,
    {},
    { version: 2 },
    { version: 1 },
    { version: 1, checks: {} },
    { version: 1, checks: [] },
    ...[
      null,
      2,
      {},
      { checkId: "other" },
      { checkId: "bicep-compile" },
      { checkId: "bicep-compile", status: "skipped" }
    ].map((check) => ({
      version: 1,
      checks: [check, ...validChecks.slice(1)]
    })),
    "not JSON"
  ])(
    "rejects malformed executable report %# and discloses missing evidence",
    async (report) => {
      const f = await fixture();
      const invalid = join(f.root, "invalid.mjs");
      await writeFile(
        invalid,
        `console.log(${JSON.stringify(typeof report === "string" ? report : JSON.stringify(report))});`
      );
      expect(
        await createDefinitionValidationAdapter({
          ...f.deps,
          scriptPath: invalid
        }).validate(f.request, f.control)
      ).toMatchObject({
        status: "ok",
        value: { status: "incomplete" }
      });
      expect(await readdir(f.root)).toEqual(["invalid.mjs"]);
    }
  );
});

describe("executable standalone validation", () => {
  it("retains the legacy five-repair/six-compile ceiling before starting a compiler", async () => {
    const { root } = await machine({ resources: {} });
    await expect(
      spawnRad(process.execPath, [script, join(root, "app.bicep")], {
        cwd: root,
        inheritEnv: false,
        env: {
          HOME: root,
          USERPROFILE: root,
          SystemRoot: process.env.SystemRoot
        },
        timeout: 3_000
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("repair budget of 5 is spent")
    });
    expect(await readFile(join(root, "run.json"), "utf8")).toBe(
      '{"repair":{"attempts":6}}'
    );
  });

  it("rejects malformed CLI arguments rather than printing a success-shaped report", async () => {
    const { root } = await machine({ resources: {} });
    await expect(
      spawnRad(process.execPath, [script, "--validate-json", "relative"], {
        cwd: root,
        inheritEnv: false,
        env: { SystemRoot: process.env.SystemRoot },
        timeout: 3_000
      })
    ).rejects.toMatchObject({
      stdout: "",
      stderr: expect.stringContaining("explicit owned artifact paths")
    });
  });

  it("returns machine checks without consuming a staged repair or changing source", async () => {
    const { root, report } = await machine({ resources: {} });
    expect(report.version).toBe(1);
    expect(report.checks).toContainEqual({
      checkId: "bicep-compile",
      status: "passed"
    });
    expect(await readFile(join(root, "run.json"), "utf8")).toBe(
      '{"repair":{"attempts":6}}'
    );
    expect(await readFile(join(root, "app.bicep"), "utf8")).toBe(
      "// unchanged\r\n"
    );
    expect(await readdir(root)).not.toContain("app.origin.json");
  });

  it("keeps a blocking compiler warning failed", async () => {
    const { report } = await machine({ resources: {} }, [
      { level: "warning", ruleId: "BCP036", message: { text: "Wrong type" } }
    ]);
    expect(report.checks).toContainEqual({
      checkId: "bicep-compile",
      status: "failed"
    });
  });
});
