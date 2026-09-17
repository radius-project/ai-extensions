import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEffectiveInputManifest,
  portAbsent,
  portCancelled,
  portForbidden,
  portSuccess,
  portUnavailable,
  type AuthorizedScope,
  type DefinitionInput,
  type RequestControl,
  type SourceOperation,
  type SourceSelection,
  type SourceSnapshot
} from "@radius-project/core/lifecycle";
import {
  createSourceReadAdapter,
  nodeSourceFileSystem,
  type SourceReadDependencies,
  type SourceReadAdapter
} from "./source-access.js";
import { collectSourceInputs } from "./source-access-closure.js";

const commit = "a".repeat(40);
const now = "2026-09-15T22:00:00Z";
const contents = {
  "app.bicep":
    "module api './modules/api.bicep' = {}\nvar data = loadTextContent('./data.txt')",
  "modules/api.bicep": "var settings = loadJsonContent('../settings.json')",
  "data.txt": "uncommitted\r\nbytes",
  "settings.json": '{"replicas":1}',
  "bicepconfig.json":
    '{"extensions":{"radius":"br:biceptypes.azurecr.io/radius:1"}}'
};
function hash(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function fingerprint(files = contents): string {
  const kinds: Record<keyof typeof contents, DefinitionInput["kind"]> = {
    "app.bicep": "definition",
    "modules/api.bicep": "module",
    "data.txt": "file",
    "settings.json": "file",
    "bicepconfig.json": "configuration"
  };
  const inputs: DefinitionInput[] = (
    Object.keys(kinds) as (keyof typeof contents)[]
  ).map((path) => ({
    path,
    kind: kinds[path],
    existed: true,
    contentHash: hash(files[path])
  }));
  inputs.push({
    path: "modules/bicepconfig.json",
    kind: "configuration",
    existed: false,
    contentHash: null
  });
  const result = buildEffectiveInputManifest(
    { definition: "app.bicep", inputs, closure: "complete" },
    hash
  );
  if (result.status !== "ok" || result.value.completeness !== "complete")
    throw new Error("Expected complete fixture");
  return result.value.fingerprint;
}
function workspaceSelection(): SourceSelection {
  return {
    repo: "example/shop",
    definition: "app.bicep",
    source: {
      kind: "workspace",
      workspaceRef: "workspace-1",
      branch: "feature/model",
      expectedFingerprint: fingerprint()
    }
  };
}
function gitSelection(): SourceSelection {
  return {
    repo: "example/shop",
    definition: "app.bicep",
    source: { kind: "git", ref: "feature/model", expectedCommit: commit }
  };
}
function scope(selection: SourceSelection): AuthorizedScope<SourceOperation> {
  return {
    operation: "definition.validate",
    target: selection,
    authorizationRef: "authorization-1",
    principalRef: "caller-1"
  };
}
function control() {
  const listeners = new Set<() => void>();
  let aborted = false;
  const request: RequestControl = {
    requestId: "request-1",
    cancellation: {
      get aborted() {
        return aborted;
      },
      onAbort(listener) {
        if (aborted) listener();
        else listeners.add(listener);
        return () => listeners.delete(listener);
      }
    }
  };
  return {
    request,
    abort: () => {
      aborted = true;
      for (const listener of listeners) listener();
    },
    listeners
  };
}

function deferred() {
  let resolve: () => void = () => {
    throw new Error("Deferred boundary was not initialized.");
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let fixture: string;
let workspaceRoot: string;
let storageRoot: string;
let adapters: SourceReadAdapter[];
beforeEach(async () => {
  fixture = join(process.cwd(), ".artifacts", `source-access-${randomUUID()}`);
  workspaceRoot = join(fixture, "workspace");
  storageRoot = join(fixture, "snapshots");
  await mkdir(join(workspaceRoot, "modules"), { recursive: true });
  await mkdir(storageRoot);
  for (const [path, text] of Object.entries(contents))
    await writeFile(join(workspaceRoot, path), text);
  adapters = [];
});
afterEach(async () => {
  for (const adapter of adapters) await adapter.close();
  await rm(fixture, { recursive: true, force: true });
});

function dependencies(): SourceReadDependencies {
  let sequence = 0;
  const prefix = randomUUID();
  return {
    storageRoot,
    files: { ...nodeSourceFileSystem },
    clock: { now: () => now },
    ids: { next: () => `${prefix}-${sequence++}` },
    limits: {
      maxFiles: 100,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 4_000_000
    },
    authority: {
      resolve: async (_scope, selection) =>
        portSuccess(
          selection.source.kind === "workspace" ?
            {
              kind: "workspace",
              repo: selection.repo,
              workspaceRef: selection.source.workspaceRef,
              rootPath: workspaceRoot
            }
          : { kind: "git", repo: selection.repo, accessRef: "fetch-identity-1" }
        )
    },
    git: {
      workspaceState: async () =>
        portSuccess({ branch: "feature/model", commit }),
      resolveCommit: async () => portSuccess(commit),
      materializeCommit: async (_grant, _commit, destination) => {
        await mkdir(join(destination, "modules"));
        for (const [path, text] of Object.entries(contents))
          await writeFile(join(destination, path), text);
        await mkdir(join(destination, ".git"));
        await writeFile(
          join(destination, ".git", "config"),
          "fixture fetch metadata"
        );
        return portSuccess(undefined);
      },
      readCommit: async () => portSuccess(commit)
    }
  };
}
function adapter(deps = dependencies()) {
  const value = createSourceReadAdapter(deps);
  adapters.push(value);
  return value;
}
async function captured(
  value: SourceReadAdapter,
  selection = workspaceSelection()
): Promise<SourceSnapshot> {
  const result = await value.capture(
    scope(selection),
    selection,
    control().request
  );
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "ok",
    value: { status: "captured" }
  });
  if (result.status !== "ok" || result.value.status !== "captured")
    throw new Error("Capture failed");
  return result.value.snapshot;
}

describe("authorized context-owned source snapshots", () => {
  it("retains standalone extension ownership, binary hashes and immutable reads without generator files", async () => {
    const archive = new Uint8Array([31, 139, 8, 0, 255, 128, 13, 10]);
    const deps = dependencies();
    const materialize = deps.git.materializeCommit;
    deps.git.materializeCommit = async (...args) => {
      const result = await materialize(...args);
      await writeFile(
        join(args[2], "app.bicep"),
        "extension './extension.tgz' as radius"
      );
      await writeFile(join(args[2], "extension.tgz"), archive);
      await rm(join(args[2], "bicepconfig.json"));
      return result;
    };
    let ownedArchive = "";
    deps.files.write = async (path, bytes) => {
      await nodeSourceFileSystem.write(path, bytes);
      if (path.endsWith("extension.tgz")) ownedArchive = path;
    };
    const value = adapter(deps);
    const snapshot = await captured(value, gitSelection());
    expect(snapshot.manifest.completeness).toBe("complete");
    expect(snapshot.manifest.inputs.map(({ path }) => path).sort()).toEqual([
      "app.bicep",
      "bicepconfig.json",
      "extension.tgz"
    ]);
    const first = await value.readBytes(
      snapshot,
      "extension.tgz",
      control().request
    );
    expect(first).toMatchObject({
      status: "ok",
      value: {
        input: { kind: "custom-type", contentHash: hash(archive) },
        bytes: archive
      }
    });
    if (first.status !== "ok") throw new Error("Expected owned archive");
    first.value.bytes.fill(42);
    expect(
      await value.readBytes(snapshot, "extension.tgz", control().request)
    ).toMatchObject({ status: "ok", value: { bytes: archive } });
    expect(
      await adapter().readBytes(snapshot, "extension.tgz", control().request)
    ).toMatchObject({ status: "unavailable" });
    expect(
      await value.readBytes(
        structuredClone(snapshot),
        "extension.tgz",
        control().request
      )
    ).toMatchObject({ status: "unavailable" });
    expect(
      await value.readBytes(snapshot, "uncaptured.tgz", control().request)
    ).toMatchObject({ status: "forbidden" });
    await writeFile(
      ownedArchive,
      new Uint8Array([31, 139, 8, 0, 254, 128, 13, 10])
    );
    expect(
      await value.readBytes(snapshot, "extension.tgz", control().request)
    ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
    await value.releaseSnapshot(snapshot);
    expect(
      await value.readBytes(snapshot, "extension.tgz", control().request)
    ).toMatchObject({ status: "unavailable" });
  });

  it("returns independent exact binary copies without exposing source paths", async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 31, 139, 8]);
    const deps = dependencies();
    const materialize = deps.git.materializeCommit;
    deps.git.materializeCommit = async (...args) => {
      const result = await materialize(...args);
      await writeFile(join(args[2], "data.txt"), bytes);
      return result;
    };
    const value = adapter(deps);
    const snapshot = await captured(value, gitSelection());
    const first = await value.readBytes(
      snapshot,
      "data.txt",
      control().request
    );
    expect(first).toEqual({
      status: "ok",
      value: {
        input: {
          path: "data.txt",
          kind: "file",
          existed: true,
          contentHash: hash(bytes)
        },
        bytes
      }
    });
    if (first.status !== "ok") throw new Error("Expected captured bytes");
    first.value.bytes.fill(42);
    const second = await value.readBytes(
      snapshot,
      "data.txt",
      control().request
    );
    expect(second).toMatchObject({ status: "ok", value: { bytes } });
    expect(JSON.stringify(snapshot)).not.toContain(storageRoot);
    expect(JSON.stringify(snapshot)).not.toContain(workspaceRoot);
  });

  it("retains absent manifest entries and forbids uncaptured byte reads", async () => {
    const value = adapter();
    const snapshot = await captured(value);
    expect(
      await value.readBytes(
        snapshot,
        "modules/bicepconfig.json",
        control().request
      )
    ).toMatchObject({ status: "absent" });
    expect(
      await value.readBytes(snapshot, "uncaptured.bin", control().request)
    ).toMatchObject({ status: "forbidden" });
    expect(
      await value.readBytes(snapshot, "../outside.bin", control().request)
    ).not.toMatchObject({ status: "ok" });
  });

  it("rejects forged or released snapshot ownership on byte reads", async () => {
    const value = adapter();
    const snapshot = await captured(value);
    expect(
      await value.readBytes(
        structuredClone(snapshot),
        "data.txt",
        control().request
      )
    ).toMatchObject({ status: "unavailable" });
    await value.releaseSnapshot(snapshot);
    expect(
      await value.readBytes(snapshot, "data.txt", control().request)
    ).toMatchObject({ status: "unavailable" });
  });

  it("checks byte hashes and authorization again before returning captured data", async () => {
    const deps = dependencies();
    let capturedData = "";
    deps.files.write = async (path, bytes) => {
      await nodeSourceFileSystem.write(path, bytes);
      if (path.endsWith("data.txt")) capturedData = path;
    };
    const value = adapter(deps);
    const snapshot = await captured(value);
    await writeFile(capturedData, new Uint8Array([255]));
    expect(
      await value.readBytes(snapshot, "data.txt", control().request)
    ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
    deps.authority.resolve = async () => portForbidden();
    expect(
      await value.readBytes(snapshot, "data.txt", control().request)
    ).toMatchObject({ status: "forbidden" });
  });

  it("cancels byte reads and still releases snapshot ownership", async () => {
    const value = adapter();
    const snapshot = await captured(value);
    const request = control();
    request.abort();
    expect(
      await value.readBytes(snapshot, "data.txt", request.request)
    ).toEqual(portCancelled("request_cancelled"));
    expect(await value.readText(snapshot, "data.txt", request.request)).toEqual(
      portCancelled("request_cancelled")
    );
    expect(await value.releaseSnapshot(snapshot)).toEqual(
      portSuccess({ status: "released" })
    );
    expect(await value.releaseSnapshot(snapshot)).toEqual(
      portSuccess({ status: "already_released" })
    );
  });

  it.each(["", "invalid/handle", "x".repeat(257)])(
    "rejects invalid generated identity %j",
    (id) => {
      const deps = dependencies();
      deps.ids.next = () => id;
      expect(() => createSourceReadAdapter(deps)).toThrow();
    }
  );

  it.each(["repo", "workspace", "kind"])(
    "rejects mismatched authority %s",
    async (mismatch) => {
      const deps = dependencies();
      deps.authority.resolve = async () =>
        portSuccess(
          mismatch === "kind" ?
            {
              kind: "git",
              repo: "example/shop",
              accessRef: "remote"
            }
          : {
              kind: "workspace",
              repo: mismatch === "repo" ? "other/repo" : "example/shop",
              workspaceRef:
                mismatch === "workspace" ? "another-workspace" : "workspace-1",
              rootPath: workspaceRoot
            }
        );
      const selection = workspaceSelection();
      expect(
        await adapter(deps).capture(
          scope(selection),
          selection,
          control().request
        )
      ).toMatchObject({
        status: "failed",
        error: { code: "EVIDENCE_MISMATCH" }
      });
    }
  );

  it("reports unexpected authority failure and malformed remote evidence explicitly", async () => {
    const deps = dependencies();
    deps.authority.resolve = async () => {
      throw new Error("provider details");
    };
    const selection = workspaceSelection();
    expect(
      await adapter(deps).capture(
        scope(selection),
        selection,
        control().request
      )
    ).toMatchObject({
      status: "unavailable",
      error: { code: "SOURCE_UNAVAILABLE" }
    });
    const remote = dependencies();
    remote.git.resolveCommit = async () => portSuccess("not-a-commit");
    const git = gitSelection();
    expect(
      await adapter(remote).capture(scope(git), git, control().request)
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  });

  it.each(["inside", "parent"])(
    "rejects storage %s the workspace",
    async (position) => {
      const deps = dependencies();
      deps.storageRoot =
        position === "inside" ? join(workspaceRoot, "modules") : fixture;
      const selection = workspaceSelection();
      expect(
        await adapter(deps).capture(
          scope(selection),
          selection,
          control().request
        )
      ).toMatchObject({
        status: "failed",
        error: { code: "PRECONDITION_FAILED" }
      });
    }
  );

  it.each(["capture", "read"])(
    "rejects a relocated authorization during %s",
    async (phase) => {
      const moved = join(fixture, "moved");
      await mkdir(moved);
      const deps = dependencies();
      const original = deps.authority.resolve;
      let calls = 0;
      deps.authority.resolve = async (...args) => {
        const grant = await original(...args);
        if (++calls >= (phase === "capture" ? 2 : 3))
          return portSuccess({
            kind: "workspace",
            repo: "example/shop",
            workspaceRef: "workspace-1",
            rootPath: moved
          });
        return grant;
      };
      const value = adapter(deps);
      const selection = workspaceSelection();
      if (phase === "capture") {
        expect(
          await value.capture(scope(selection), selection, control().request)
        ).toMatchObject({
          status: "failed",
          error: { code: "SOURCE_CHANGED" }
        });
      } else {
        const snapshot = await captured(value);
        expect(
          await value.readText(snapshot, "data.txt", control().request)
        ).toMatchObject({
          status: "failed",
          error: { code: "EVIDENCE_MISMATCH" }
        });
      }
    }
  );

  it("retains absence and refuses binary text projection", async () => {
    const deps = dependencies();
    const materialize = deps.git.materializeCommit;
    deps.git.materializeCommit = async (...args) => {
      const result = await materialize(...args);
      await writeFile(join(args[2], "data.txt"), Buffer.from([255]));
      return result;
    };
    const value = adapter(deps);
    const snapshot = await captured(value, gitSelection());
    expect(
      await value.readText(
        snapshot,
        "modules/bicepconfig.json",
        control().request
      )
    ).toMatchObject({ status: "absent" });
    expect(
      await value.readText(snapshot, "data.txt", control().request)
    ).toMatchObject({
      status: "unavailable",
      error: { code: "CAPABILITY_UNAVAILABLE" }
    });
  });

  it.each(["removed", "edited"])(
    "refuses captured bytes %s after capture",
    async (change) => {
      const deps = dependencies();
      let dataPath = "";
      deps.files.write = async (path, bytes) => {
        await nodeSourceFileSystem.write(path, bytes);
        if (path.endsWith("data.txt")) dataPath = path;
      };
      const value = adapter(deps);
      const snapshot = await captured(value);
      if (change === "removed") await rm(dataPath);
      else await writeFile(dataPath, "changed");
      expect(
        await value.readText(snapshot, "data.txt", control().request)
      ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
    }
  );

  it("does not accept a copy whose dependency closure became incomplete", async () => {
    const deps = dependencies();
    deps.files.write = async (path, bytes) =>
      nodeSourceFileSystem.write(
        path,
        path.endsWith("app.bicep") ?
          Buffer.from("var x = loadTextContent(dynamicPath)")
        : bytes
      );
    const selection = workspaceSelection();
    expect(
      await adapter(deps).capture(
        scope(selection),
        selection,
        control().request
      )
    ).toMatchObject({
      status: "unavailable",
      error: { code: "VALIDATION_INCOMPLETE" }
    });
  });

  it.each([false, true])(
    "reports cleanup failure while preserving a primary failure: %s",
    async (primary) => {
      const deps = dependencies();
      if (!primary)
        await writeFile(
          join(workspaceRoot, "app.bicep"),
          "var x = loadTextContent(dynamicPath)"
        );
      else
        deps.files.write = async () => {
          throw new Error("copy failed");
        };
      deps.files.remove = async () => {
        throw new Error("cleanup failed");
      };
      const value = adapter(deps);
      const selection = workspaceSelection();
      const result = await value.capture(
        scope(selection),
        selection,
        control().request
      );
      expect(result).toMatchObject({
        status: primary ? "unavailable" : "failed",
        error: {
          details: expect.arrayContaining([
            expect.objectContaining({
              message: "Source cleanup did not complete."
            })
          ])
        }
      });
      deps.files.remove = nodeSourceFileSystem.remove;
    }
  );

  it("allows release and context cleanup to be retried after failures", async () => {
    const deps = dependencies();
    const value = adapter(deps);
    const snapshot = await captured(value);
    deps.files.remove = async () => {
      throw new Error("remove failed");
    };
    expect(await value.releaseSnapshot(snapshot)).toMatchObject({
      status: "failed"
    });
    deps.files.remove = nodeSourceFileSystem.remove;
    expect(await value.releaseSnapshot(snapshot)).toMatchObject({
      status: "ok"
    });
    deps.files.remove = async () => {
      throw new Error("context remove failed");
    };
    expect(await value.close()).toMatchObject({ status: "failed" });
    deps.files.remove = nodeSourceFileSystem.remove;
    expect(await value.close()).toMatchObject({ status: "ok" });
  });

  it("joins concurrent release and shutdown without deleting a record twice", async () => {
    const deps = dependencies();
    const value = adapter(deps);
    const snapshot = await captured(value);
    const entered = deferred();
    const proceed = deferred();
    let removals = 0;
    deps.files.remove = async (path) => {
      removals++;
      entered.resolve();
      await proceed.promise;
      await nodeSourceFileSystem.remove(path);
    };
    const first = value.releaseSnapshot(snapshot);
    await entered.promise;
    const second = value.releaseSnapshot(snapshot);
    const close = value.close();
    const duplicateClose = value.close();
    proceed.resolve();
    for (const result of await Promise.all([
      first,
      second,
      close,
      duplicateClose
    ])) {
      expect(result.status).toBe("ok");
    }
    expect(removals).toBe(2);
  });

  it("delivers cancellation to an external listener registered after abort", async () => {
    const deps = dependencies();
    const request = control();
    let notified = false;
    deps.git.materializeCommit = async (
      _source,
      _commit,
      _destination,
      current
    ) => {
      request.abort();
      const unsubscribe = current.cancellation.onAbort(() => {
        notified = true;
      });
      unsubscribe();
      return portCancelled("request_cancelled");
    };
    const selection = gitSelection();
    expect(
      await adapter(deps).capture(scope(selection), selection, request.request)
    ).toMatchObject({ status: "cancelled" });
    expect(notified).toBe(true);
  });

  it("establishes the fixture's effective local closure before provenance comparison", async () => {
    const deps = dependencies();
    const collected = await collectSourceInputs(
      deps.files,
      workspaceRoot,
      "app.bicep",
      deps.limits,
      control().request.cancellation
    );
    expect(collected.complete).toBe(true);
    expect(
      buildEffectiveInputManifest(
        {
          definition: "app.bicep",
          inputs: collected.inputs,
          closure: "complete"
        },
        hash
      )
    ).toMatchObject({
      status: "ok",
      value: { completeness: "complete", fingerprint: fingerprint() }
    });
  });
  it("captures all local inputs and uncommitted bytes without mutating or exposing the workspace", async () => {
    await writeFile(
      join(workspaceRoot, "generated-output.json"),
      "not an input"
    );
    const deps = dependencies();
    const writes: string[] = [];
    deps.files = {
      ...deps.files,
      write: async (path, bytes) => {
        writes.push(path);
        await nodeSourceFileSystem.write(path, bytes);
      }
    };
    const value = adapter(deps);
    const snapshot = await captured(value);
    expect(snapshot.manifest.fingerprint).toBe(fingerprint());
    expect(snapshot.manifest.inputs.map((entry) => entry.path)).toEqual([
      "app.bicep",
      "bicepconfig.json",
      "data.txt",
      "modules/api.bicep",
      "modules/bicepconfig.json",
      "settings.json"
    ]);
    expect(snapshot.provenance).toMatchObject({
      kind: "workspace",
      branch: "feature/model",
      baseCommit: commit,
      fingerprint: fingerprint(),
      resolvedAt: now
    });
    expect(JSON.stringify(snapshot)).not.toContain(workspaceRoot);
    expect(writes.every((path) => path.startsWith(storageRoot))).toBe(true);
    expect(
      await value.readText(snapshot, "data.txt", control().request)
    ).toMatchObject({ status: "ok", value: { text: contents["data.txt"] } });
    for (const [path, text] of Object.entries(contents))
      expect(await readFile(join(workspaceRoot, path), "utf8")).toBe(text);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.manifest.inputs)).toBe(true);
    expect(await value.releaseSnapshot(snapshot)).toEqual({
      status: "ok",
      value: { status: "released" }
    });
    expect(await value.releaseSnapshot(snapshot)).toEqual({
      status: "ok",
      value: { status: "already_released" }
    });
    expect(
      (await value.readText(snapshot, "data.txt", control().request)).status
    ).toBe("unavailable");
    expect(await value.close()).toEqual({
      status: "ok",
      value: { status: "released" }
    });
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("holds immutable snapshots across later source edits but does not overwrite stale expectations", async () => {
    const value = adapter();
    const snapshot = await captured(value);
    await writeFile(join(workspaceRoot, "data.txt"), "changed by user");
    expect(
      await value.readText(snapshot, "data.txt", control().request)
    ).toMatchObject({ status: "ok", value: { text: contents["data.txt"] } });
    const selection = workspaceSelection();
    const before = structuredClone(selection);
    expect(
      await value.capture(scope(selection), selection, control().request)
    ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
    expect(selection).toEqual(before);
  });

  it("materializes the resolved exact remote commit, never a later moving ref or fetch metadata", async () => {
    const deps = dependencies();
    const materialize = vi.fn(deps.git.materializeCommit);
    deps.git = { ...deps.git, materializeCommit: materialize };
    const value = adapter(deps);
    const selection = gitSelection();
    const snapshot = await captured(value, selection);
    expect(materialize.mock.calls[0][1]).toBe(commit);
    expect(materialize.mock.calls[0][0]).toEqual({
      kind: "git",
      repo: "example/shop",
      accessRef: "fetch-identity-1"
    });
    expect(snapshot.provenance).toMatchObject({
      kind: "git",
      ref: "feature/model",
      commit,
      fingerprint: fingerprint()
    });
    expect(JSON.stringify(snapshot)).not.toContain("fetch-identity-1");
    expect(
      (await readdir(storageRoot, { recursive: true })).some((path) =>
        path.includes(".git")
      )
    ).toBe(false);
    expect(
      await value.readText(snapshot, ".git/config", control().request)
    ).toMatchObject({ status: "forbidden" });
  });

  it("rejects moving refs and wrong materialized commits before accepting a remote snapshot", async () => {
    for (const boundary of ["resolveCommit", "readCommit"] as const) {
      const deps = dependencies();
      deps.git = {
        ...deps.git,
        [boundary]: async () => portSuccess("b".repeat(40))
      };
      const value = adapter(deps);
      const selection = gitSelection();
      expect(
        await value.capture(scope(selection), selection, control().request)
      ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
      await value.close();
    }
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("authorizes diff sources independently and never reuses head repository scope for the base", async () => {
    const deps = dependencies();
    const authorize = vi.fn(deps.authority.resolve);
    deps.authority = { resolve: authorize };
    const value = adapter(deps);
    const base = { ...gitSelection(), repo: "upstream/shop" };
    const headScope: AuthorizedScope<"graph.diff"> = {
      operation: "graph.diff",
      target: { repo: "example/shop" },
      authorizationRef: "head-access",
      principalRef: "caller-1"
    };
    expect(
      await value.capture(headScope, base, control().request)
    ).toMatchObject({ status: "forbidden" });
    expect(authorize).not.toHaveBeenCalled();
    const baseScope = {
      ...headScope,
      target: { repo: "upstream/shop" },
      authorizationRef: "base-access"
    };
    expect(
      await value.capture(baseScope, base, control().request)
    ).toMatchObject({ status: "ok", value: { status: "captured" } });
    expect(
      authorize.mock.calls.every(
        ([received]) => received.authorizationRef === "base-access"
      )
    ).toBe(true);
  });

  it("distinguishes denied, absent and unavailable source authority without creating snapshots", async () => {
    const outcomes = [
      portForbidden(),
      portAbsent({
        quality: "current",
        evidence: "source",
        completeness: "complete",
        observedAt: now
      }),
      portUnavailable("SOURCE_UNAVAILABLE", {
        quality: "unknown",
        evidence: "source",
        completeness: "unavailable"
      })
    ];
    for (const outcome of outcomes) {
      const deps = dependencies();
      deps.authority = { resolve: async () => outcome };
      const value = adapter(deps);
      const selection = workspaceSelection();
      expect(
        await value.capture(scope(selection), selection, control().request)
      ).toEqual(outcome);
    }
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("requires the actual selected workspace branch and detects branch changes during capture", async () => {
    for (const late of [false, true]) {
      const deps = dependencies();
      let calls = 0;
      deps.git = {
        ...deps.git,
        workspaceState: async () =>
          portSuccess({
            branch: late && calls++ === 0 ? "feature/model" : "main",
            commit
          })
      };
      const value = adapter(deps);
      const selection = workspaceSelection();
      expect(
        await value.capture(scope(selection), selection, control().request)
      ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
    }
  });

  it.each(["edit", "add-config", "delete"])(
    "detects %s races during copying and cleans every partial snapshot",
    async (change) => {
      const deps = dependencies();
      let changed = false;
      deps.files = {
        ...deps.files,
        write: async (path, bytes) => {
          await nodeSourceFileSystem.write(path, bytes);
          if (!changed) {
            changed = true;
            if (change === "edit")
              await writeFile(
                join(workspaceRoot, "settings.json"),
                '{"replicas":2}'
              );
            else if (change === "add-config")
              await writeFile(
                join(workspaceRoot, "modules", "bicepconfig.json"),
                "{}"
              );
            else await rm(join(workspaceRoot, "data.txt"));
          }
        }
      };
      const value = adapter(deps);
      const selection = workspaceSelection();
      const result = await value.capture(
        scope(selection),
        selection,
        control().request
      );
      expect(result.status).not.toBe("ok");
      await value.close();
      expect(await readdir(storageRoot)).toEqual([]);
    }
  );

  it("does not publish incomplete closures or confuse a missing definition with unavailable evidence", async () => {
    const value = adapter();
    await writeFile(
      join(workspaceRoot, "app.bicep"),
      "var content = loadTextContent(filePath)"
    );
    const selection = workspaceSelection();
    const incomplete = await value.capture(
      scope(selection),
      selection,
      control().request
    );
    expect(incomplete).toMatchObject({
      status: "ok",
      value: { status: "incomplete", manifest: { completeness: "incomplete" } }
    });
    expect(JSON.stringify(incomplete)).not.toContain("snapshotRef");
    await rm(join(workspaceRoot, "app.bicep"));
    expect(
      await value.capture(scope(selection), selection, control().request)
    ).toMatchObject({ status: "absent" });
    await value.close();
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("fences unknown, forged and cross-context references and revalidates authorization on reads", async () => {
    const deps = dependencies();
    const value = adapter(deps);
    const snapshot = await captured(value);
    const other = adapter();
    expect(
      await other.readText(snapshot, "data.txt", control().request)
    ).toMatchObject({ status: "unavailable" });
    expect(
      await value.readText({ ...snapshot }, "data.txt", control().request)
    ).toMatchObject({ status: "unavailable" });
    expect(
      await value.readText(snapshot, "../outside", control().request)
    ).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
    expect(
      await value.readText(snapshot, "not-an-input", control().request)
    ).toMatchObject({ status: "forbidden" });
    expect(await other.releaseSnapshot(snapshot)).toMatchObject({
      status: "unavailable"
    });
    deps.authority.resolve = async () => portForbidden();
    expect(
      await value.readText(snapshot, "data.txt", control().request)
    ).toMatchObject({ status: "forbidden" });
  });

  it("cancels before and during capture and removes all partial output", async () => {
    const deps = dependencies();
    const value = adapter(deps);
    const selection = workspaceSelection();
    const stopped = control();
    stopped.abort();
    expect(
      await value.capture(scope(selection), selection, stopped.request)
    ).toMatchObject({ status: "cancelled" });
    const mid = control();
    deps.files.write = async (path, bytes) => {
      await nodeSourceFileSystem.write(path, bytes);
      mid.abort();
    };
    expect(
      await value.capture(scope(selection), selection, mid.request)
    ).toMatchObject({ status: "cancelled" });
    expect(mid.listeners.size).toBe(0);
    await value.close();
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("shutdown signals in-flight external reads, waits for cleanup, and prevents late publication", async () => {
    const deps = dependencies();
    let started: () => void = () => {
      throw new Error("Not initialized");
    };
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    deps.git.materializeCommit = async (
      _grant,
      _commit,
      _destination,
      request
    ) =>
      new Promise((resolve) => {
        const unsubscribe = request.cancellation.onAbort(() => {
          unsubscribe();
          resolve(portCancelled("session_shutdown"));
        });
        started();
      });
    const value = adapter(deps);
    const selection = gitSelection();
    const pending = value.capture(
      scope(selection),
      selection,
      control().request
    );
    await ready;
    expect(await value.close()).toEqual({
      status: "ok",
      value: { status: "released" }
    });
    expect(await pending).toMatchObject({
      status: "cancelled",
      reason: "session_shutdown"
    });
    expect(
      await value.capture(scope(selection), selection, control().request)
    ).toMatchObject({ status: "cancelled", reason: "session_shutdown" });
    expect(await value.close()).toEqual({
      status: "ok",
      value: { status: "already_released" }
    });
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it.each(["maxFiles", "maxFileBytes", "maxTotalBytes"] as const)(
    "requires the explicit %s bound at construction",
    (key) => {
      const deps = dependencies();
      Reflect.deleteProperty(deps.limits, key);
      expect(() => createSourceReadAdapter(deps)).toThrow(TypeError);
    }
  );

  it("pins caller-owned selections before awaiting external authorization", async () => {
    const original = workspaceSelection();
    if (original.source.kind !== "workspace")
      throw new Error("Expected workspace fixture");
    const source = { ...original.source };
    const selection = { ...original, source };
    const deps = dependencies();
    const resolve = deps.authority.resolve;
    deps.authority.resolve = async (...args) => {
      const granted = await resolve(...args);
      source.expectedFingerprint = `sha256:${"0".repeat(64)}`;
      return granted;
    };
    const snapshot = await captured(adapter(deps), selection);
    expect(snapshot.selection).toEqual(original);
  });

  it("does not publish a copied input whose bytes differ from its manifest", async () => {
    const deps = dependencies();
    deps.files.write = async (path, bytes) => {
      await nodeSourceFileSystem.write(
        path,
        path.endsWith("data.txt") ? Buffer.from("corrupted copy") : bytes
      );
    };
    const value = adapter(deps);
    const selection = workspaceSelection();
    expect(
      await value.capture(scope(selection), selection, control().request)
    ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
    await value.close();
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("honors an already-aborted signal without requiring onAbort to replay it", async () => {
    const value = adapter();
    const selection = workspaceSelection();
    expect(
      await value.capture(scope(selection), selection, {
        requestId: "already-aborted",
        cancellation: { aborted: true, onAbort: () => () => {} }
      })
    ).toEqual({ status: "cancelled", reason: "request_cancelled" });
    expect(await readdir(storageRoot)).toEqual([]);
  });
});
