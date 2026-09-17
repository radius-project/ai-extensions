import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEffectiveInputManifest,
  portAbsent,
  portCancelled,
  portForbidden,
  portSuccess,
  portUnavailable,
  type DefinitionInput,
  type RecipeRegistrationEvidence,
  type RequestControl,
  type SourceSnapshot
} from "@radius-project/core/lifecycle";
import { RadProcessError, runRadAppGraph } from "../rad.js";
import { nodeSourceFileSystem } from "./source-access.js";
import {
  acquireManagedGraphBinaries,
  createGraphCompilationAdapter,
  type GraphCompilationDependencies
} from "./graph-execution.js";

const definition = ".radius/app.bicep";
const content =
  "extension radius\nvar binary = loadFileAsBase64('./extension.tgz')\r\n";
const config =
  '{"extensions":{"radius":"./extension.tgz"},"analyzers":{"core":{"enabled":false}}}\r\n';
const payloads = new Map<string, Uint8Array>([
  [definition, new TextEncoder().encode(content)],
  [".radius/extension.tgz", new Uint8Array([31, 139, 8, 0, 255, 128, 13, 10])],
  [".radius/bicepconfig.json", new TextEncoder().encode(config)]
]);
const rawGraph = {
  resources: [
    {
      id: "/planes/radius/local/resourceGroups/default/providers/Radius.Compute/containers/api",
      name: "api",
      type: "Radius.Compute/containers",
      diffHash: `sha256:${"b".repeat(64)}`,
      connections: [],
      outputResources: []
    }
  ]
};

function hash(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function sourceSnapshot(files = payloads): SourceSnapshot {
  const inputs: DefinitionInput[] = [...files].map(([path, bytes]) => ({
    path,
    kind:
      path === definition ? "definition"
      : path.endsWith(".json") ? "configuration"
      : "file",
    existed: true,
    contentHash: hash(bytes)
  }));
  for (const path of ["bicepconfig.json", ".radius/bicepconfig.json"]) {
    if (!files.has(path))
      inputs.push({
        path,
        kind: "configuration",
        existed: false,
        contentHash: null
      });
  }
  const result = buildEffectiveInputManifest(
    { definition, inputs, closure: "complete" },
    hash
  );
  if (result.status !== "ok" || result.value.completeness !== "complete")
    throw new Error("Expected complete graph fixture");
  return {
    snapshotRef: "snapshot-1",
    selection: {
      repo: "fork/shop",
      definition,
      source: {
        kind: "git",
        ref: "feature/graph",
        expectedCommit: "a".repeat(40)
      }
    },
    provenance: {
      kind: "git",
      repo: "fork/shop",
      ref: "feature/graph",
      commit: "a".repeat(40),
      fingerprint: result.value.fingerprint,
      resolvedAt: "2026-09-15T22:00:00Z"
    },
    manifest: result.value
  };
}
function request() {
  const controller = new AbortController();
  const control: RequestControl = {
    requestId: "graph-request",
    cancellation: {
      get aborted() {
        return controller.signal.aborted;
      },
      onAbort(listener) {
        if (controller.signal.aborted) listener();
        else controller.signal.addEventListener("abort", listener);
        return () => controller.signal.removeEventListener("abort", listener);
      }
    }
  };
  return { control, abort: () => controller.abort() };
}

let storageRoot: string;
beforeEach(async () => {
  storageRoot = join(
    process.cwd(),
    ".artifacts",
    `graph-isolation-${randomUUID()}`
  );
  await mkdir(storageRoot, { recursive: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(storageRoot, { recursive: true, force: true });
});

function fixture(snapshot = sourceSnapshot(), files = payloads) {
  const events: string[] = [];
  const runGraph = vi.fn<typeof runRadAppGraph>(async () => {
    events.push("compile");
    return structuredClone(rawGraph);
  });
  const deps: GraphCompilationDependencies = {
    storageRoot,
    files: { ...nodeSourceFileSystem },
    ids: { next: () => randomUUID() },
    source: {
      readBytes: async (selected, path) => {
        events.push(`read:${path}`);
        if (selected !== snapshot)
          throw new Error("Unexpected source identity");
        const input = snapshot.manifest.inputs.find(
          (entry) => entry.path === path
        );
        if (!input) throw new Error("Unexpected source path");
        const bytes = files.get(path);
        if (!bytes)
          return portAbsent({
            quality: "current",
            evidence: "source",
            completeness: "complete",
            observedAt: "2026-09-15T22:00:00Z"
          });
        return portSuccess({ input, bytes: bytes.slice() });
      }
    },
    acquireBinaries: async () => {
      events.push("acquire");
      return portSuccess({
        radPath: process.execPath,
        bicepPath: process.execPath
      });
    },
    runGraph,
    trustedPath: [join(storageRoot, "trusted-bin")],
    ...(process.env.SystemRoot ? { systemRoot: process.env.SystemRoot } : {}),
    timeoutMs: 2_000
  };
  return { deps, snapshot, events, runGraph };
}

describe("isolated canonical graph compilation", () => {
  it.each(["open", "readdir"])(
    "requires the %s filesystem boundary for dependency discovery",
    (method) => {
      const { deps } = fixture();
      Reflect.deleteProperty(deps.files, method);
      expect(() => createGraphCompilationAdapter(deps)).toThrow(TypeError);
    }
  );
  it.each([
    "// extension 'br:registry.invalid/types:1'",
    "/* module remote 'ts:subscription/group/template:1' = {} */",
    "var recipe = 'br:registry.invalid/recipes/cache:1'",
    "var recipe = '''\nbr:registry.invalid/recipes/cache:1\n'''",
    "var recipe = 'br:registry.invalid/recipes/${name}:1'",
    "var data = { extension: 'br:registry.invalid/types:1', module: 'ts:unused' }"
  ])(
    "compiles inert registry text using syntax evidence: %s",
    async (inert) => {
      const files = new Map(payloads);
      files.set(definition, new TextEncoder().encode(`${content}\n${inert}`));
      const { deps, snapshot, runGraph } = fixture(
        sourceSnapshot(files),
        files
      );
      expect(
        await createGraphCompilationAdapter(deps).compile(
          { kind: "authored", snapshot },
          request().control
        )
      ).toMatchObject({ status: "ok" });
      expect(runGraph).toHaveBeenCalledOnce();
      expect(await readdir(storageRoot)).toEqual([]);
    }
  );

  it("does not restore registry references in captured recipe companions or loaded ordinary data", async () => {
    const files = new Map(payloads);
    files.set(
      definition,
      new TextEncoder().encode(
        `${content}\nvar data = loadTextContent('./ordinary.bicep')`
      )
    );
    files.set(
      ".radius/ordinary.bicep",
      new TextEncoder().encode(
        "module ignored 'br:registry.invalid/not-compiled:1' = {}"
      )
    );
    files.set(
      ".radius/custom-recipe-pack.bicep",
      new TextEncoder().encode(
        "var recipe = 'br:registry.invalid/recipes/cache:1'"
      )
    );
    const { deps, snapshot, runGraph } = fixture(sourceSnapshot(files), files);
    expect(
      await createGraphCompilationAdapter(deps).compile(
        { kind: "authored", snapshot },
        request().control
      )
    ).toMatchObject({ status: "ok" });
    expect(runGraph).toHaveBeenCalledOnce();
  });

  it.each([
    "extension 'br:registry.invalid/types:1'",
    "extension 'br\\u{3a}registry.invalid/types:1'",
    "extension 'br/alias:types:1'",
    "module remote 'br:registry.invalid/module:1' = {}",
    "module remote 'br/alias:module:1' = {}",
    "module remote 'ts:subscription/group/template:1' = {}",
    "module remote 'ts/alias:template:1' = {}",
    "module remote modulePath = {}",
    "module remote '${modulePath}' = {}",
    "module remote '''./module.bicep''' = {}",
    "var text = '${loadTextContent(filePath)}'",
    "var text = '${loadTextContent('./missing.txt')}'",
    "import { T } from './types.bicep'"
  ])(
    "refuses an unowned compilation dependency before execution: %s",
    async (dependency) => {
      const files = new Map(payloads);
      files.set(
        definition,
        new TextEncoder().encode(`${content}\n${dependency}`)
      );
      const { deps, snapshot, runGraph } = fixture(
        sourceSnapshot(files),
        files
      );
      expect(
        await createGraphCompilationAdapter(deps).compile(
          { kind: "authored", snapshot },
          request().control
        )
      ).toMatchObject({
        status: "unavailable",
        error: { code: "CAPABILITY_UNAVAILABLE" }
      });
      expect(runGraph).not.toHaveBeenCalled();
      expect(await readdir(storageRoot)).toEqual([]);
    }
  );

  it.each([false, true])(
    "checks a transitive module's nearest extension alias (registry=%s)",
    async (registry) => {
      const files = new Map(payloads);
      files.set(
        definition,
        new TextEncoder().encode(
          `${content}\nmodule child './modules/child.bicep' = {}`
        )
      );
      files.set(
        ".radius/modules/child.bicep",
        new TextEncoder().encode("extension childTypes")
      );
      files.set(
        ".radius/modules/bicepconfig.json",
        new TextEncoder().encode(
          JSON.stringify({
            extensions: {
              childTypes:
                registry ? "br:registry.invalid/child:1" : "../extension.tgz"
            }
          })
        )
      );
      const { deps, snapshot, runGraph } = fixture(
        sourceSnapshot(files),
        files
      );
      expect(
        await createGraphCompilationAdapter(deps).compile(
          { kind: "authored", snapshot },
          request().control
        )
      ).toMatchObject(
        registry ?
          {
            status: "unavailable",
            error: { code: "CAPABILITY_UNAVAILABLE" }
          }
        : { status: "ok" }
      );
      expect(runGraph).toHaveBeenCalledTimes(registry ? 0 : 1);
      expect(await readdir(storageRoot)).toEqual([]);
    }
  );

  it.each([false, true])(
    "resolves only used registry aliases in the nearest configuration (used=%s)",
    async (used) => {
      const files = new Map(payloads);
      files.set(
        ".radius/bicepconfig.json",
        new TextEncoder().encode(
          JSON.stringify({
            extensions: {
              radius: "./extension.tgz",
              remote: "br:registry.invalid/types:1"
            },
            moduleAliases: {
              br: {
                unused: { registry: "registry.invalid", modulePath: "unused" }
              }
            },
            analyzers: {
              core: { rules: { unused: { message: "br:ordinary-data" } } }
            }
          })
        )
      );
      files.set(
        "bicepconfig.json",
        new TextEncoder().encode(
          '{"extensions":{"radius":"br:registry.invalid/overridden:1"}}'
        )
      );
      if (used)
        files.set(
          definition,
          new TextEncoder().encode(`${content}\nextension remote`)
        );
      const { deps, snapshot, runGraph } = fixture(
        sourceSnapshot(files),
        files
      );
      expect(
        await createGraphCompilationAdapter(deps).compile(
          { kind: "authored", snapshot },
          request().control
        )
      ).toMatchObject(
        used ?
          {
            status: "unavailable",
            error: { code: "CAPABILITY_UNAVAILABLE" }
          }
        : { status: "ok" }
      );
      expect(runGraph).toHaveBeenCalledTimes(used ? 0 : 1);
    }
  );

  it("does not start real managed acquisition for an already cancelled request", async () => {
    const pending = request();
    pending.abort();
    expect(await acquireManagedGraphBinaries(pending.control)).toEqual(
      portCancelled("request_cancelled")
    );
  });
  it("acquires the actual resolved rad and its managed Bicep before returning exact paths", async () => {
    const resolve = vi.fn(async () => join(storageRoot, "rad"));
    const ensureBicep = vi.fn(async () => join(storageRoot, "bicep"));
    expect(
      await acquireManagedGraphBinaries(request().control, {
        resolve,
        ensureBicep
      })
    ).toEqual(
      portSuccess({
        radPath: join(storageRoot, "rad"),
        bicepPath: join(storageRoot, "bicep")
      })
    );
    expect(resolve).toHaveBeenCalledExactlyOnceWith();
    expect(ensureBicep).toHaveBeenCalledExactlyOnceWith(
      join(storageRoot, "rad")
    );
  });

  it.each(["before", "resolve", "bicep", "failure"])(
    "cancels managed binary acquisition during %s without compiling",
    async (phase) => {
      const pending = request();
      const binaries = {
        resolve: vi.fn(async () => {
          if (phase === "resolve") pending.abort();
          return process.execPath;
        }),
        ensureBicep: vi.fn(async () => {
          pending.abort();
          if (phase === "failure")
            throw new Error("private acquisition diagnostic");
          return process.execPath;
        })
      };
      if (phase === "before") pending.abort();
      expect(
        await acquireManagedGraphBinaries(pending.control, binaries)
      ).toEqual(portCancelled("request_cancelled"));
      if (phase === "before") expect(binaries.resolve).not.toHaveBeenCalled();
      if (["before", "resolve"].includes(phase))
        expect(binaries.ensureBicep).not.toHaveBeenCalled();
    }
  );

  it("redacts acquisition failures and reports missing capability", async () => {
    expect(
      await acquireManagedGraphBinaries(request().control, {
        resolve: async () => {
          throw new Error("private acquisition diagnostic");
        },
        ensureBicep: async () => {
          throw new Error("unexpected Bicep install");
        }
      })
    ).toEqual(
      portUnavailable("CAPABILITY_UNAVAILABLE", {
        quality: "unknown",
        evidence: "radius",
        completeness: "unavailable"
      })
    );
  });

  it("refuses inconsistent snapshot identity before acquiring tooling", async () => {
    const { deps, snapshot, events } = fixture();
    const compiler = createGraphCompilationAdapter(deps);
    expect(
      await compiler.compile(
        {
          kind: "authored",
          snapshot: {
            ...snapshot,
            selection: { ...snapshot.selection, definition: "other.bicep" }
          }
        },
        request().control
      )
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
    expect(events).toEqual([]);
  });

  it.each(["path", "fingerprint", "provenance", "missing-definition"])(
    "rejects invalid %s evidence before reading or materializing source",
    async (kind) => {
      const { deps, snapshot, events } = fixture();
      const candidate: SourceSnapshot = {
        ...snapshot,
        provenance: {
          ...snapshot.provenance,
          fingerprint:
            kind === "provenance" ?
              hash("other")
            : snapshot.provenance.fingerprint
        },
        manifest: {
          ...snapshot.manifest,
          fingerprint:
            kind === "fingerprint" ?
              hash("other")
            : snapshot.manifest.fingerprint,
          inputs:
            kind === "missing-definition" ? []
            : kind === "path" ?
              snapshot.manifest.inputs.map((input) => ({
                ...input,
                path: "../outside"
              }))
            : snapshot.manifest.inputs
        }
      };
      expect(
        await createGraphCompilationAdapter(deps).compile(
          { kind: "authored", snapshot: candidate },
          request().control
        )
      ).toMatchObject({
        status: "failed",
        error: { code: "EVIDENCE_MISMATCH" }
      });
      expect(events).toEqual([]);
      expect(await readdir(storageRoot)).toEqual([]);
    }
  );

  it("blocks ancestor configuration without inventing captured source config", async () => {
    await writeFile(
      join(storageRoot, "bicepconfig.json"),
      '{"extensions":{"radius":"host-only"}}'
    );
    const files = new Map(payloads);
    files.delete(".radius/bicepconfig.json");
    files.set(
      definition,
      new TextEncoder().encode("extension './extension.tgz' as radius")
    );
    const { deps, snapshot, runGraph } = fixture(sourceSnapshot(files), files);
    runGraph.mockImplementation(async (_file, options) => {
      const cwd = options?.isolation?.cwd;
      if (!cwd) throw new Error("Expected isolated cwd");
      expect(
        JSON.parse(
          await readFile(join(dirname(cwd), "bicepconfig.json"), "utf8")
        )
      ).toEqual({ cacheRootDirectory: join(dirname(cwd), "home", ".bicep") });
      await expect(
        readFile(join(cwd, "bicepconfig.json"))
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(cwd, ".radius", "bicepconfig.json"))
      ).rejects.toMatchObject({ code: "ENOENT" });
      return rawGraph;
    });
    expect(
      await createGraphCompilationAdapter(deps).compile(
        { kind: "authored", snapshot },
        request().control
      )
    ).toMatchObject({ status: "ok" });
    expect(await readdir(storageRoot)).toEqual(["bicepconfig.json"]);
    expect(await readFile(join(storageRoot, "bicepconfig.json"), "utf8")).toBe(
      '{"extensions":{"radius":"host-only"}}'
    );
  });

  it.each([
    [
      ".radius/bicepconfig.json",
      '{"extensions":{"radius":"br:registry.invalid/radius:1"}}'
    ],
    [
      ".radius/bicepconfig.json",
      '{"extensions":{"radius":"br\\u003aregistry.invalid/radius:1"}}'
    ],
    [definition, "extension 'br:registry.invalid/radius:1'\n"]
  ])(
    "returns typed unavailable for uncaptured registry restoration in %s",
    async (path, text) => {
      const files = new Map(payloads);
      files.set(path, new TextEncoder().encode(text));
      const { deps, snapshot, runGraph } = fixture(
        sourceSnapshot(files),
        files
      );
      expect(
        await createGraphCompilationAdapter(deps).compile(
          { kind: "authored", snapshot },
          request().control
        )
      ).toMatchObject({
        status: "unavailable",
        error: { code: "CAPABILITY_UNAVAILABLE" }
      });
      expect(runGraph).not.toHaveBeenCalled();
      expect(await readdir(storageRoot)).toEqual([]);
    }
  );

  it.each(["relative", "directory", "absent"])(
    "refuses a %s managed binary",
    async (kind) => {
      const { deps, snapshot, runGraph } = fixture();
      deps.acquireBinaries = async () =>
        portSuccess({
          radPath:
            kind === "relative" ? "rad"
            : kind === "directory" ? storageRoot
            : join(storageRoot, "missing"),
          bicepPath: process.execPath
        });
      expect(
        await createGraphCompilationAdapter(deps).compile(
          { kind: "authored", snapshot },
          request().control
        )
      ).not.toMatchObject({ status: "ok" });
      expect(runGraph).not.toHaveBeenCalled();
      expect(await readdir(storageRoot)).toEqual([]);
    }
  );

  it("does not delete pre-existing storage when an invocation ID collides", async () => {
    const { deps, snapshot, runGraph } = fixture();
    deps.ids.next = () => "collision";
    const existing = join(storageRoot, "graph-collision");
    await mkdir(existing);
    await writeFile(join(existing, "owned-by-other"), "retained");
    expect(
      await createGraphCompilationAdapter(deps).compile(
        { kind: "authored", snapshot },
        request().control
      )
    ).not.toMatchObject({ status: "ok" });
    expect(await readFile(join(existing, "owned-by-other"), "utf8")).toBe(
      "retained"
    );
    expect(runGraph).not.toHaveBeenCalled();
  });

  it("rejects an unsafe invocation ID without materialization", async () => {
    const { deps, snapshot, runGraph } = fixture();
    deps.ids.next = () => "../escape";
    expect(
      await createGraphCompilationAdapter(deps).compile(
        { kind: "authored", snapshot },
        request().control
      )
    ).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(runGraph).not.toHaveBeenCalled();
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("suppresses a late successful compiler result after timeout and waits before cleanup", async () => {
    const { deps, snapshot, runGraph } = fixture();
    deps.timeoutMs = 1;
    runGraph.mockImplementation(async (file, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error("Expected cancellation signal");
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      expect(await readFile(file, "utf8")).toBe(content);
      return rawGraph;
    });
    expect(
      await createGraphCompilationAdapter(deps).compile(
        { kind: "authored", snapshot },
        request().control
      )
    ).toMatchObject({
      status: "unavailable",
      error: { code: "RESULT_UNAVAILABLE" }
    });
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it.each(["source", "files", "ids", "acquireBinaries", "runGraph"])(
    "rejects missing %s dependencies at construction",
    (key) => {
      const { deps } = fixture();
      Reflect.deleteProperty(deps, key);
      expect(() => createGraphCompilationAdapter(deps)).toThrow(TypeError);
    }
  );

  it.each([0, -1, Number.NaN, Infinity, 1.5, 2_147_483_648])(
    "rejects invalid timeout %s",
    (timeoutMs) => {
      const { deps } = fixture();
      expect(() =>
        createGraphCompilationAdapter({ ...deps, timeoutMs })
      ).toThrow(TypeError);
    }
  );

  it("rejects relative storage and untrusted PATH locations before acquiring resources", () => {
    const { deps } = fixture();
    expect(() =>
      createGraphCompilationAdapter({
        ...deps,
        storageRoot: "relative-storage"
      })
    ).toThrow(TypeError);
    expect(() =>
      createGraphCompilationAdapter({ ...deps, trustedPath: ["."] })
    ).toThrow(TypeError);
    expect(() =>
      createGraphCompilationAdapter({ ...deps, systemRoot: "relative-system" })
    ).toThrow(TypeError);
  });

  it("acquires binaries first and compiles exact captured bytes with no ambient credentials", async () => {
    vi.stubEnv("GH_TOKEN", "fixture-only");
    vi.stubEnv("GITHUB_TOKEN", "fixture-only");
    vi.stubEnv("AZURE_CLIENT_SECRET", "fixture-only");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-only");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("RADIUS_AMBIENT_MARKER", "fixture-only");
    const { deps, snapshot, runGraph, events } = fixture();
    deps.systemRoot = process.env.SystemRoot ?? storageRoot;
    let compileRoot = "";
    runGraph.mockImplementation(async (file, options) => {
      events.push("compile");
      const isolation = options?.isolation;
      if (!isolation) throw new Error("Expected explicit isolated compilation");
      compileRoot = isolation.cwd;
      expect(isAbsolute(compileRoot)).toBe(true);
      expect(relative(storageRoot, compileRoot)).not.toMatch(/^\.\./);
      expect(compileRoot).not.toBe(storageRoot);
      expect(file).toBe(join(compileRoot, definition));
      for (const [path, bytes] of payloads)
        expect(new Uint8Array(await readFile(join(compileRoot, path)))).toEqual(
          bytes
        );
      await expect(
        readFile(join(compileRoot, "bicepconfig.json"))
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(isolation.bicepPath).toBe(process.execPath);
      expect(options?.radPath).toBe(process.execPath);
      expect(options?.saveGraphJsonTo).toBeUndefined();
      expect(options?.timeout).toBe(2_000);
      expect(options?.signal?.aborted).toBe(false);
      const env = isolation.env;
      expect(env.SystemRoot).toBe(deps.systemRoot);
      expect(env.GITHUB_ACTIONS).toBe("");
      expect(env.PATH).toBe(deps.trustedPath.join(delimiter));
      for (const key of [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "AZURE_CLIENT_SECRET",
        "AWS_ACCESS_KEY_ID",
        "RADIUS_AMBIENT_MARKER",
        "NODE_OPTIONS"
      ])
        expect(env[key]).toBeUndefined();
      for (const key of [
        "HOME",
        "USERPROFILE",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "GH_CONFIG_DIR",
        "AZURE_CONFIG_DIR",
        "AWS_CONFIG_FILE",
        "AWS_SHARED_CREDENTIALS_FILE"
      ]) {
        const path = env[key];
        if (!path) throw new Error(`Missing isolated ${key}`);
        expect(isAbsolute(path)).toBe(true);
        expect(relative(storageRoot, path)).not.toMatch(/^\.\./);
      }
      expect(env.HOME).toBe(env.USERPROFILE);
      if (!env.HOME) throw new Error("Expected isolated home");
      expect(await readdir(env.HOME)).not.toContain(".git-credentials");
      return structuredClone(rawGraph);
    });
    const result = await createGraphCompilationAdapter(deps).compile(
      { kind: "authored", snapshot },
      request().control
    );
    expect(result).toMatchObject({
      status: "ok",
      value: {
        graph: {
          resources: [
            {
              id: rawGraph.resources[0]?.id,
              diffHash: rawGraph.resources[0]?.diffHash
            }
          ]
        },
        diagnostics: []
      }
    });
    expect(events[0]).toBe("acquire");
    expect(events.at(-1)).toBe("compile");
    expect(runGraph).toHaveBeenCalledOnce();
    expect(await readdir(storageRoot)).toEqual([]);
    await expect(readFile(join(compileRoot, definition))).rejects.toMatchObject(
      { code: "ENOENT" }
    );
  });

  it("returns a genuine empty canonical graph for an empty successful compiler result", async () => {
    const { deps, snapshot, runGraph } = fixture();
    runGraph.mockResolvedValue({ resources: [] });
    expect(
      await createGraphCompilationAdapter(deps).compile(
        { kind: "authored", snapshot },
        request().control
      )
    ).toMatchObject({ status: "ok", value: { graph: { resources: [] } } });
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it.each([
    null,
    {},
    { resources: "invalid" },
    { resources: [{ ...rawGraph.resources[0], diffHash: "invalid" }] }
  ])(
    "rejects malformed compiler evidence without success-shaped fallback: %j",
    async (raw) => {
      const { deps, snapshot, runGraph } = fixture();
      runGraph.mockResolvedValue(raw);
      expect(
        await createGraphCompilationAdapter(deps).compile(
          { kind: "authored", snapshot },
          request().control
        )
      ).toMatchObject({
        status: "failed",
        error: { code: "EVIDENCE_MISMATCH" }
      });
      expect(await readdir(storageRoot)).toEqual([]);
    }
  );

  it("does not acquire source bytes or launch compilation when managed binaries are unavailable", async () => {
    const { deps, snapshot, runGraph, events } = fixture();
    deps.acquireBinaries = async () =>
      portUnavailable("CAPABILITY_UNAVAILABLE", {
        quality: "unknown",
        evidence: "radius",
        completeness: "unavailable"
      });
    expect(
      await createGraphCompilationAdapter(deps).compile(
        { kind: "authored", snapshot },
        request().control
      )
    ).toMatchObject({
      status: "unavailable",
      error: { code: "CAPABILITY_UNAVAILABLE" }
    });
    expect(events).toEqual([]);
    expect(runGraph).not.toHaveBeenCalled();
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it.runIf(process.platform === "win32")(
    "fails closed without an explicit Windows system root",
    async () => {
      const files = new Map(payloads);
      files.delete(".radius/bicepconfig.json");
      files.set(
        definition,
        new TextEncoder().encode("extension './extension.tgz' as radius")
      );
      const { deps, snapshot } = fixture(sourceSnapshot(files), files);
      delete deps.systemRoot;
      deps.runGraph = runRadAppGraph;
      expect(
        await createGraphCompilationAdapter(deps).compile(
          { kind: "authored", snapshot },
          request().control
        )
      ).toMatchObject({
        status: "unavailable",
        error: { code: "RESULT_UNAVAILABLE" }
      });
      expect(await readdir(storageRoot)).toEqual([]);
    }
  );

  it.runIf(process.platform === "win32")(
    "reports native Bicep cache isolation as unavailable without rewriting captured configuration",
    async () => {
      const { deps, snapshot } = fixture();
      deps.runGraph = runRadAppGraph;
      const result = await createGraphCompilationAdapter(deps).compile(
        { kind: "authored", snapshot },
        request().control
      );
      expect(result).toMatchObject({
        status: "unavailable",
        error: { code: "CAPABILITY_UNAVAILABLE" }
      });
      expect(JSON.stringify(result)).not.toContain(storageRoot);
      expect(await readdir(storageRoot)).toEqual([]);
    }
  );

  it("propagates source authorization failure without compiling", async () => {
    const { deps, snapshot, runGraph } = fixture();
    deps.source.readBytes = async () => portForbidden();
    expect(
      await createGraphCompilationAdapter(deps).compile(
        { kind: "authored", snapshot },
        request().control
      )
    ).toEqual(portForbidden());
    expect(runGraph).not.toHaveBeenCalled();
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("refuses unexpected absence of an input attested as present", async () => {
    const { deps, snapshot, runGraph } = fixture();
    deps.source.readBytes = async () =>
      portAbsent({
        quality: "current",
        evidence: "source",
        completeness: "complete",
        observedAt: "2026-09-15T22:00:00Z"
      });
    expect(
      await createGraphCompilationAdapter(deps).compile(
        { kind: "authored", snapshot },
        request().control
      )
    ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
    expect(runGraph).not.toHaveBeenCalled();
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("enriches planned output using actual registrations and preserves the compiler hash", async () => {
    const { deps, snapshot, runGraph } = fixture();
    const resource = {
      ...rawGraph.resources[0],
      id: "cache",
      name: "cache",
      type: "Radius.Data/redisCaches"
    };
    runGraph.mockResolvedValue({ resources: [resource] });
    const registrations: RecipeRegistrationEvidence = {
      target: { repo: "fork/shop", environment: "azure-test" },
      provider: "azure",
      recipes: [
        {
          resourceType: "Radius.Data/redisCaches",
          kind: "bicep",
          source:
            "br:mcr.microsoft.com/bicep/avm/res/cache/redis-enterprise:0.5.1"
        }
      ],
      observation: {
        quality: "current",
        evidence: "radius",
        completeness: "complete",
        observedAt: "2026-09-15T22:00:00Z"
      }
    };
    const compiler = createGraphCompilationAdapter(deps);
    expect(
      await compiler.compile(
        { kind: "planned", snapshot, registrations },
        request().control
      )
    ).toMatchObject({
      status: "ok",
      value: {
        graph: {
          resources: [
            {
              diffHash: resource.diffHash,
              outputResources: [
                { type: "Microsoft.Cache/redisEnterprise", provider: "azure" }
              ]
            }
          ]
        }
      }
    });
    expect(
      await compiler.compile(
        {
          kind: "planned",
          snapshot,
          registrations: { ...registrations, recipes: [] }
        },
        request().control
      )
    ).toMatchObject({
      status: "failed",
      error: { code: "RECIPE_PACK_REQUIRED" }
    });
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("cleans partial materializations when a captured file cannot be written", async () => {
    const { deps, snapshot, runGraph } = fixture();
    const write = deps.files.write;
    let written = 0;
    deps.files.write = async (path, bytes) => {
      if (++written === 2) throw new Error("fixture-private-write");
      await write(path, bytes);
    };
    const result = await createGraphCompilationAdapter(deps).compile(
      { kind: "authored", snapshot },
      request().control
    );
    expect(result).not.toMatchObject({ status: "ok" });
    expect(JSON.stringify(result)).not.toContain("fixture-private-write");
    expect(runGraph).not.toHaveBeenCalled();
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("isolates repeated concurrent compilations and never removes another invocation's files", async () => {
    const { deps, snapshot, runGraph } = fixture();
    const directories: string[] = [];
    let unblock: () => void = () => {
      throw new Error("Uninitialized fixture");
    };
    const ready = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    runGraph.mockImplementation(async (file, options) => {
      const cwd = options?.isolation?.cwd;
      if (!cwd) throw new Error("Expected isolated cwd");
      directories.push(cwd);
      if (directories.length === 2) unblock();
      await ready;
      expect(await readFile(file, "utf8")).toBe(content);
      return rawGraph;
    });
    const compiler = createGraphCompilationAdapter(deps);
    const results = await Promise.all([
      compiler.compile({ kind: "authored", snapshot }, request().control),
      compiler.compile({ kind: "authored", snapshot }, request().control)
    ]);
    expect(results.map((result) => result.status)).toEqual(["ok", "ok"]);
    expect(new Set(directories).size).toBe(2);
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it.each(["hash", "input"])(
    "rejects a mismatched captured %s before spawning",
    async (mismatch) => {
      const { deps, snapshot, runGraph } = fixture();
      const read = deps.source.readBytes;
      deps.source.readBytes = async (...args) => {
        const result = await read(...args);
        if (result.status !== "ok") return result;
        return portSuccess({
          input:
            mismatch === "input" ?
              { ...result.value.input, path: "other.bicep" }
            : result.value.input,
          bytes: mismatch === "hash" ? new Uint8Array([42]) : result.value.bytes
        });
      };
      expect(
        await createGraphCompilationAdapter(deps).compile(
          { kind: "authored", snapshot },
          request().control
        )
      ).toMatchObject({ status: "failed" });
      expect(runGraph).not.toHaveBeenCalled();
      expect(await readdir(storageRoot)).toEqual([]);
    }
  );

  it.each([
    new Error(`compiler diagnostic: ${content} fixture-private-message`),
    new SyntaxError("Invalid JSON: fixture-private-message"),
    new RadProcessError(
      "rad app graph timed out",
      content,
      "fixture-private-message"
    )
  ])(
    "suppresses compiler errors and cleans all materializations: %s",
    async (error) => {
      const { deps, snapshot, runGraph } = fixture();
      runGraph.mockRejectedValue(error);
      const result = await createGraphCompilationAdapter(deps).compile(
        { kind: "authored", snapshot },
        request().control
      );
      expect(result).toMatchObject({
        status: "unavailable",
        error: { code: "RESULT_UNAVAILABLE" }
      });
      expect(JSON.stringify(result)).not.toContain("fixture-private-message");
      expect(JSON.stringify(result)).not.toContain("loadFileAsBase64");
      expect(JSON.stringify(result)).not.toContain(storageRoot);
      expect(await readdir(storageRoot)).toEqual([]);
    }
  );

  it.each(["before", "acquire", "read", "dependencies", "compile", "cleanup"])(
    "returns cancellation and cleans resources when cancelled during %s",
    async (phase) => {
      const { deps, snapshot, runGraph } = fixture();
      const pending = request();
      if (phase === "before") pending.abort();
      if (phase === "acquire") {
        const acquire = deps.acquireBinaries;
        deps.acquireBinaries = async (control) => {
          const result = await acquire(control);
          pending.abort();
          return result;
        };
      }
      if (phase === "read") {
        const read = deps.source.readBytes;
        deps.source.readBytes = async (...args) => {
          const result = await read(...args);
          pending.abort();
          return result;
        };
      }
      if (phase === "dependencies") {
        const open = deps.files.open;
        deps.files.open = async (path) => {
          const handle = await open(path);
          pending.abort();
          return handle;
        };
      }
      if (phase === "compile")
        runGraph.mockImplementation(async (_file, options) => {
          pending.abort();
          expect(options?.signal?.aborted).toBe(true);
          return rawGraph;
        });
      if (phase === "cleanup")
        deps.files.remove = async (path) => {
          await nodeSourceFileSystem.remove(path);
          pending.abort();
        };
      expect(
        await createGraphCompilationAdapter(deps).compile(
          { kind: "authored", snapshot },
          pending.control
        )
      ).toEqual(portCancelled("request_cancelled"));
      if (["before", "acquire", "read", "dependencies"].includes(phase))
        expect(runGraph).not.toHaveBeenCalled();
      expect(await readdir(storageRoot)).toEqual([]);
    }
  );

  it("does not claim success when owned materialization cleanup fails", async () => {
    const { deps, snapshot } = fixture();
    deps.files.remove = async () => {
      throw new Error("fixture-private-cleanup");
    };
    const result = await createGraphCompilationAdapter(deps).compile(
      { kind: "authored", snapshot },
      request().control
    );
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(JSON.stringify(result)).not.toContain("fixture-private-cleanup");
  });

  it("retains compiler-owned files when process termination cannot be proven", async () => {
    const { deps, snapshot, runGraph } = fixture();
    const remove = vi.fn(deps.files.remove);
    deps.files.remove = remove;
    runGraph.mockRejectedValue(
      new RadProcessError("private process cleanup diagnostic", "", "", true)
    );
    const result = await createGraphCompilationAdapter(deps).compile(
      { kind: "authored", snapshot },
      request().control
    );
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(remove).not.toHaveBeenCalled();
    expect(await readdir(storageRoot)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(
      "private process cleanup diagnostic"
    );
  });

  it("reports cleanup failure even if the caller also cancels", async () => {
    const { deps, snapshot } = fixture();
    const pending = request();
    deps.files.remove = async () => {
      pending.abort();
      throw new Error("private cleanup diagnostic");
    };
    expect(
      await createGraphCompilationAdapter(deps).compile(
        { kind: "authored", snapshot },
        pending.control
      )
    ).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
  });
});
