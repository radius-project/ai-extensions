import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  portSuccess,
  type RequestControl,
  type SourceSelection
} from "@radius-project/core/lifecycle";
import { runRadAppGraph } from "../rad.js";
import { createGraphCompilationAdapter } from "./graph-execution.js";
import {
  createSourceReadAdapter,
  nodeSourceFileSystem,
  type SourceReadAdapter
} from "./source-access.js";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
  "lifecycle-registry-inputs"
);
const ownedTools = process.env.RADIUS_NATIVE_GRAPH_TEST_TOOLS;
const commit = "a".repeat(40);
const control: RequestControl = {
  requestId: "native-fixture-request",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
const selection: SourceSelection = {
  repo: "example/registry-data",
  definition: "app.bicep",
  source: { kind: "git", ref: "fixture-branch", expectedCommit: commit }
};

async function fixtureBytes(): Promise<Map<string, Buffer>> {
  // Exact local publish-extension output from the existing Radius schema fixture.
  // Base64 keeps the archive trackable without changing the repository *.tgz ignore.
  return new Map(
    await Promise.all(
      (await readdir(fixtureRoot)).map(async (name) => {
        const bytes = await readFile(join(fixtureRoot, name));
        return name.endsWith(".base64") ?
            ([
              name.slice(0, -7),
              Buffer.from(bytes.toString("utf8"), "base64")
            ] as const)
          : ([name, bytes] as const);
      })
    )
  );
}

describe("authored registry-data fixture through real source capture", () => {
  let root: string;
  let source: SourceReadAdapter;
  beforeEach(async () => {
    root = resolve(".artifacts", `n-${randomUUID().slice(0, 8)}`);
    await mkdir(join(root, "snapshots"), { recursive: true });
    await mkdir(join(root, "graphs"));
    source = createSourceReadAdapter({
      storageRoot: join(root, "snapshots"),
      files: nodeSourceFileSystem,
      clock: { now: () => "2026-09-16T12:00:00Z" },
      ids: { next: () => randomUUID() },
      limits: {
        maxFiles: 30,
        maxFileBytes: 1_000_000,
        maxTotalBytes: 3_000_000
      },
      authority: {
        resolve: async () =>
          portSuccess({
            kind: "git",
            repo: selection.repo,
            accessRef: "fixture-access"
          })
      },
      git: {
        resolveCommit: async () => portSuccess(commit),
        materializeCommit: async (_location, _commit, destination) => {
          for (const [name, bytes] of await fixtureBytes())
            await writeFile(join(destination, name), bytes);
          return portSuccess(undefined);
        },
        readCommit: async () => portSuccess(commit),
        workspaceState: async () => {
          throw new Error("Unexpected workspace access");
        }
      }
    });
  });
  afterEach(async () => {
    await source.close();
    await rm(root, { recursive: true, force: true });
  });

  async function compile(native: boolean) {
    const originals = await fixtureBytes();
    const archive = originals.get("custom-types.tgz");
    if (!archive) throw new Error("Missing native archive fixture");
    expect(createHash("sha256").update(archive).digest("hex")).toBe(
      "2456583fbd7dc7e006107e34c496cee7f912d2d2b4e9b11e2efa5cce9b1fb175"
    );
    const captured = await source.capture(
      {
        operation: "graph.get",
        target: selection,
        authorizationRef: "fixture-authorization",
        principalRef: "fixture-principal"
      },
      selection,
      control
    );
    expect(captured).toMatchObject({
      status: "ok",
      value: { status: "captured" }
    });
    if (captured.status !== "ok" || captured.value.status !== "captured")
      throw new Error("Expected real captured fixture");
    const { snapshot } = captured.value;
    expect(snapshot.manifest.inputs.map(({ path }) => path).sort()).toEqual([
      "app.bicep",
      "bicepconfig.json",
      "custom-recipe-pack.bicep",
      "custom-types.tgz",
      "custom-types.yaml",
      "ordinary.bicep"
    ]);
    const injected = vi.fn<typeof runRadAppGraph>(async () => ({
      resources: []
    }));
    let radPath = process.execPath;
    let bicepPath = process.execPath;
    if (native) {
      // Qualification accepts only the explicitly owned worktree tool folder,
      // never PATH discovery, personal rad, or production binary acquisition.
      expect(ownedTools).toBe(
        resolve(".artifacts", "t038-registry-native", "tools")
      );
      if (!ownedTools) throw new Error("Missing owned native test binaries");
      radPath = join(ownedTools, "rad.exe");
      bicepPath = join(ownedTools, "bicep.exe");
    }
    const result = await createGraphCompilationAdapter({
      source,
      files: nodeSourceFileSystem,
      storageRoot: join(root, "graphs"),
      ids: { next: () => "native" },
      acquireBinaries: async () => portSuccess({ radPath, bicepPath }),
      runGraph:
        native ?
          async (file, options) => {
            try {
              return await runRadAppGraph(file, options);
            } catch (error) {
              console.error(
                "Owned credential-free native fixture failed:",
                error
              );
              throw error;
            }
          }
        : injected,
      trustedPath: [],
      ...(process.env.SystemRoot ? { systemRoot: process.env.SystemRoot } : {}),
      timeoutMs: 10_000
    }).compile({ kind: "authored", snapshot }, control);
    expect(result).toMatchObject({ status: "ok" });
    if (native) {
      expect(result).toMatchObject({
        value: {
          graph: {
            resources: [
              {
                name: "api",
                type: "Radius.Compute/containers",
                diffHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
              }
            ]
          }
        }
      });
      console.log(
        JSON.stringify({
          nativeRegistryQualification: true,
          result,
          fingerprint: snapshot.manifest.fingerprint,
          archiveHash: createHash("sha256").update(archive).digest("hex"),
          inputs: snapshot.manifest.inputs,
          radPath,
          bicepPath
        })
      );
    } else expect(injected).toHaveBeenCalledOnce();
    for (const [name, bytes] of originals) {
      const read = await source.readBytes(snapshot, name, control);
      expect(read).toMatchObject({
        status: "ok",
        value: { bytes: new Uint8Array(bytes) }
      });
    }
    expect(await fixtureBytes()).toEqual(originals);
    expect(await readdir(join(root, "graphs"))).toEqual([]);
    expect(await source.releaseSnapshot(snapshot)).toMatchObject({
      status: "ok"
    });
    await source.close();
    expect(await readdir(join(root, "snapshots"))).toEqual([]);
    await expect(
      readFile(join(fixtureRoot, "bicepconfig.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  }

  it("passes the captured archive and inert companion to an injected compiler without claiming native evidence", async () => {
    await compile(false);
  });
  it.runIf(process.platform === "win32" && ownedTools !== undefined)(
    "compiles the checked-in archive and inert companion with explicitly owned native tools",
    async () => {
      await compile(true);
    },
    15_000
  );
});
