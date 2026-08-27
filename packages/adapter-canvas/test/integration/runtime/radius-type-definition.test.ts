import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STAGING_DIR_PREFIX,
  STAGING_RUN_RECORD
} from "@radius-project/core/modeling";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
);
const script = path.join(
  root,
  "plugins",
  "radius",
  "skills",
  "radius-app-bicep",
  "scripts",
  "show-radius-type.mjs"
);
const fixtureRoot = path.join(
  root,
  "packages",
  "adapter-canvas",
  "test",
  "fixtures",
  "radius-type-definition"
);
const fixtureTypePath = path.join(
  "radius",
  "radius.test",
  "2025-08-01-preview",
  "types.json"
);
const resolver = await import(pathToFileURL(script).href);
const temporaryDirectories = new Set<string>();
const commit = "0123456789abcdef0123456789abcdef01234567";
const identity = {
  version: "v0.60.0",
  commit,
  extension: "br:biceptypes.azurecr.io/radius:0.60"
};
const managedVersion = { version: identity.version, commit: identity.commit };
const fixtureIndex = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, "index.json"), "utf8")
);
const fixtureTypes = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, fixtureTypePath), "utf8")
);

assert.ok(fs.existsSync(script), `resolver script not found: ${script}`);

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radius-type-"));
  temporaryDirectories.add(directory);
  return directory;
}

function stagingDirectory(root = temporaryDirectory()): string {
  const directory = path.join(root, ".radius", `${STAGING_DIR_PREFIX}test`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, STAGING_RUN_RECORD),
    JSON.stringify({
      version: 1,
      runId: "test",
      startedAt: "2026-01-01T00:00:00.000Z",
      baseline: {}
    })
  );
  return directory;
}

function managedIdentityOptions({
  radiusIdentity = managedVersion,
  runRadImpl = vi.fn(() =>
    Promise.resolve({
      stdout: JSON.stringify(radiusIdentity),
      stderr: ""
    })
  )
} = {}) {
  return {
    env: { ...process.env, RADIUS_RAD_BINARY: process.execPath },
    home: temporaryDirectory(),
    runRadImpl
  };
}

function cacheFile(
  cacheRoot: string,
  relativePath: string,
  cacheCommit = commit
): string {
  return path.join(cacheRoot, cacheCommit, ...relativePath.split("/"));
}

function seedCache(cacheRoot: string, cacheCommit = commit): void {
  const indexPath = cacheFile(cacheRoot, "index.json", cacheCommit);
  const typesPath = cacheFile(cacheRoot, fixtureTypePath, cacheCommit);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.mkdirSync(path.dirname(typesPath), { recursive: true });
  fs.copyFileSync(path.join(fixtureRoot, "index.json"), indexPath);
  fs.copyFileSync(path.join(fixtureRoot, fixtureTypePath), typesPath);
}

function fixtureFetch(calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    const value =
      url.endsWith("/index.json") ? fixtureIndex
      : url.endsWith(`/${fixtureTypePath.replaceAll(path.sep, "/")}`) ?
        fixtureTypes
      : null;
    return new Response(JSON.stringify(value), {
      status: value === null ? 404 : 200,
      headers: { "content-type": "application/json" }
    });
  };
}

describe("resource selection and release identity", () => {
  it("parses exact predefined selectors", () => {
    expect(
      resolver.parseResourceSelector("Radius.Data/postgreSqlDatabases")
    ).toEqual({
      type: "Radius.Data/postgreSqlDatabases",
      apiVersion: undefined
    });
    expect(
      resolver.parseResourceSelector(
        "Radius.Data/postgreSqlDatabases@2025-08-01-preview"
      )
    ).toEqual({
      type: "Radius.Data/postgreSqlDatabases",
      apiVersion: "2025-08-01-preview"
    });
    expect(
      resolver.parseResourceSelector(
        "Radius.Company1.Data2/widgets@2025-08-01-preview"
      )
    ).toEqual({
      type: "Radius.Company1.Data2/widgets",
      apiVersion: "2025-08-01-preview"
    });
    expect(() =>
      resolver.parseResourceSelector("Radius.Resources/widgets")
    ).toThrow(/Invalid predefined/u);
    for (const invalid of [
      "radius.data/postgreSqlDatabases",
      "Radius.Core./applications",
      "Radius.Core..Preview/applications",
      "Radius./applications",
      "Radius.1Core/applications"
    ]) {
      expect(() => resolver.parseResourceSelector(invalid)).toThrow(
        /Invalid predefined/u
      );
    }
  });

  it("selects only a unique or explicit API version", () => {
    const selected = resolver.selectResource(fixtureIndex, {
      type: "Radius.Data/postgreSqlDatabases"
    });
    expect(selected.apiVersion).toBe("2025-08-01-preview");

    const ambiguous = structuredClone(fixtureIndex);
    ambiguous.resources["Radius.Data/postgreSqlDatabases@2026-01-01"] =
      ambiguous.resources["Radius.Data/postgreSqlDatabases@2025-08-01-preview"];
    expect(() =>
      resolver.selectResource(ambiguous, {
        type: "Radius.Data/postgreSqlDatabases"
      })
    ).toThrow(/multiple API versions.*2025-08-01-preview, 2026-01-01/u);
    expect(() =>
      resolver.selectResource(fixtureIndex, {
        type: "Radius.Data/postgreSqlDatabases",
        apiVersion: "2026-01-01"
      })
    ).toThrow(/unavailable.*Available versions/u);
    expect(() =>
      resolver.selectResource(fixtureIndex, {
        type: "Radius.Data/neo4jDatabases"
      })
    ).toThrow(
      /^Definition for resource type "Radius\.Data\/neo4jDatabases" was not found in the generated catalog for this Radius release\.$/u
    );
    expect(() =>
      resolver.selectResource(fixtureIndex, {
        type: "Radius.Data/neo4jDatabases",
        apiVersion: "2025-08-01-preview"
      })
    ).toThrow(
      /^Definition for resource type "Radius\.Data\/neo4jDatabases" was not found in the generated catalog for this Radius release\.$/u
    );
  });

  it("derives the release-channel extension from parseable versions", () => {
    expect(resolver.deriveExtensionReference("0.60.0")).toBe(
      "br:biceptypes.azurecr.io/radius:0.60"
    );
    expect(resolver.deriveExtensionReference("v0.61.0-rc.1")).toBe(
      "br:biceptypes.azurecr.io/radius:0.61"
    );
    expect(resolver.deriveExtensionReference("0.61.0+build.7")).toBe(
      "br:biceptypes.azurecr.io/radius:0.61"
    );
    expect(() => resolver.deriveExtensionReference("latest")).toThrow(
      /Unsupported Radius version/u
    );
    expect(() => resolver.deriveExtensionReference("edge")).toThrow(
      /Unsupported Radius version/u
    );
  });

  it("requires only the identity fields used for immutable resolution", () => {
    expect(
      resolver.parseRadiusIdentity(
        JSON.stringify({
          version: "v0.60.0",
          commit
        })
      )
    ).toEqual({ commit, extension: identity.extension });
    expect(
      resolver.parseRadiusIdentity(
        JSON.stringify({
          version: "v0.61.0-rc.1",
          commit
        })
      ).extension
    ).toBe("br:biceptypes.azurecr.io/radius:0.61");
    expect(() =>
      resolver.parseRadiusIdentity(
        JSON.stringify({
          version: "v0.60.0",
          commit: commit.slice(0, 12)
        })
      )
    ).toThrow(/not a full 40-character SHA/u);
  });

  it("rejects malformed or incomplete managed Radius identities", () => {
    for (const [output, expected] of [
      ["not-json", /invalid version JSON/u],
      ["[]", /must be an object/u],
      [JSON.stringify({ commit }), /missing "version"/u],
      [JSON.stringify({ version: "v0.60.0" }), /missing "commit"/u]
    ] as const) {
      expect(() => resolver.parseRadiusIdentity(output)).toThrow(expected);
    }
    expect(() => resolver.deriveExtensionReference(undefined)).toThrow(
      /Unsupported Radius version/u
    );
  });

  it("accepts only safe generated index references", () => {
    expect(
      resolver.parseIndexReference(
        "radius/radius.data/2025-08-01-preview/types.json#/66"
      )
    ).toEqual({
      relativePath: "radius/radius.data/2025-08-01-preview/types.json",
      index: 66
    });
    for (const invalid of [
      "/radius/types.json#/1",
      "radius/../types.json#/1",
      "radius\\types.json#/1",
      "https://example.com/types.json#/1",
      "radius/types.json#/x"
    ]) {
      expect(() => resolver.parseIndexReference(invalid)).toThrow();
    }
    expect(() =>
      resolver.parseIndexReference(`radius/types.json#/${"9".repeat(400)}`)
    ).toThrow(/invalid/u);
  });

  it("validates the generated index shape and selected entry", () => {
    for (const invalid of [null, [], {}, { resources: [] }]) {
      expect(() =>
        resolver.selectResource(invalid, { type: "Radius.Core/applications" })
      ).toThrow(/must be an object/u);
    }
    expect(() =>
      resolver.selectResource(
        {
          resources: {
            "Radius.Core/applications@2025-08-01-preview": null
          }
        },
        {
          type: "Radius.Core/applications",
          apiVersion: "2025-08-01-preview"
        }
      )
    ).toThrow(/unavailable/u);
    expect(() =>
      resolver.selectResource(
        { resources: {} },
        {
          type: "Radius.Core/applications",
          apiVersion: "2025-08-01-preview"
        }
      )
    ).toThrow(
      /^Definition for resource type "Radius\.Core\/applications" was not found in the generated catalog for this Radius release\.$/u
    );
  });
});

describe("network and cache behavior", () => {
  it("retries retryable responses once", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await resolver.fetchJson(
      `https://raw.githubusercontent.com/radius-project/radius/${commit}/index.json`,
      {
        fetchImpl: async () => {
          attempts += 1;
          return new Response(attempts === 1 ? "busy" : '{"ok":true}', {
            status: attempts === 1 ? 500 : 200
          });
        },
        sleep: async (milliseconds: number) => delays.push(milliseconds)
      }
    );
    expect(attempts).toBe(2);
    expect(delays).toEqual([300]);
    expect(result.value).toEqual({ ok: true });
  });

  it("uses the default retry clock", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const pending = resolver.fetchJson(
        `https://raw.githubusercontent.com/radius-project/radius/${commit}/default-clock.json`,
        {
          fetchImpl: async () => {
            attempts += 1;
            return new Response(attempts === 1 ? "busy" : '{"ok":true}', {
              status: attempts === 1 ? 500 : 200
            });
          }
        }
      );
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ value: { ok: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry ordinary 4xx responses", async () => {
    let attempts = 0;
    await expect(
      resolver.fetchJson(
        `https://raw.githubusercontent.com/radius-project/radius/${commit}/missing.json`,
        {
          fetchImpl: async () => {
            attempts += 1;
            return new Response("missing", { status: 404 });
          }
        }
      )
    ).rejects.toThrow(/HTTP 404/u);
    expect(attempts).toBe(1);
  });

  it("allows only the pinned HTTPS source and rejects redirects", async () => {
    const fetchImpl = vi.fn();
    for (const url of [
      "https://evil.example.com/index.json",
      "http://raw.githubusercontent.com/radius-project/radius/index.json"
    ]) {
      await expect(resolver.fetchJson(url, { fetchImpl })).rejects.toThrow(
        /unsupported source URL/u
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();

    let attempts = 0;
    const redirected = new Response('{"ok":true}', { status: 200 });
    Object.defineProperty(redirected, "redirected", { value: true });
    await expect(
      resolver.fetchJson(
        `https://raw.githubusercontent.com/radius-project/radius/${commit}/redirected.json`,
        {
          fetchImpl: async () => {
            attempts += 1;
            return redirected;
          }
        }
      )
    ).rejects.toThrow(/redirected unexpectedly/u);
    expect(attempts).toBe(1);
  });

  it("bounds responses before and while reading the body", async () => {
    let bodyRead = false;
    await expect(
      resolver.fetchJson(
        `https://raw.githubusercontent.com/radius-project/radius/${commit}/declared-large.json`,
        {
          maxBytes: 4,
          fetchImpl: async () => ({
            redirected: false,
            ok: true,
            status: 200,
            headers: new Headers({ "content-length": "50000" }),
            body: {
              getReader: () => {
                bodyRead = true;
                throw new Error("body must not be read");
              }
            }
          })
        }
      )
    ).rejects.toThrow(/exceeded 4 bytes/u);
    expect(bodyRead).toBe(false);

    await expect(
      resolver.fetchJson(
        `https://raw.githubusercontent.com/radius-project/radius/${commit}/streamed-large.json`,
        {
          maxBytes: 4,
          fetchImpl: async () => new Response("12345", { status: 200 })
        }
      )
    ).rejects.toThrow(/exceeded 4 bytes/u);

    const result = await resolver.fetchJson(
      `https://raw.githubusercontent.com/radius-project/radius/${commit}/sized.json`,
      {
        maxBytes: 11,
        fetchImpl: async () =>
          new Response('{"ok":true}', {
            status: 200,
            headers: { "content-length": "11" }
          })
      }
    );
    expect(result.value).toEqual({ ok: true });

    await expect(
      resolver.fetchJson(
        `https://raw.githubusercontent.com/radius-project/radius/${commit}/empty.json`,
        {
          fetchImpl: async () => new Response(null, { status: 200 })
        }
      )
    ).rejects.toThrow(/invalid JSON/u);
  });

  it("treats invalid JSON as permanent and retries transient transport failures", async () => {
    let invalidAttempts = 0;
    await expect(
      resolver.fetchJson(
        `https://raw.githubusercontent.com/radius-project/radius/${commit}/invalid.json`,
        {
          fetchImpl: async () => {
            invalidAttempts += 1;
            return new Response("not-json", { status: 200 });
          }
        }
      )
    ).rejects.toThrow(/invalid JSON/u);
    expect(invalidAttempts).toBe(1);

    let transportAttempts = 0;
    const transportDelays: number[] = [];
    const result = await resolver.fetchJson(
      `https://raw.githubusercontent.com/radius-project/radius/${commit}/transient.json`,
      {
        fetchImpl: async () => {
          transportAttempts += 1;
          if (transportAttempts === 1) throw new Error("connection reset");
          return new Response('{"ok":true}', { status: 200 });
        },
        sleep: async (milliseconds: number) =>
          transportDelays.push(milliseconds)
      }
    );
    expect(transportAttempts).toBe(2);
    expect(transportDelays).toEqual([300]);
    expect(result.value).toEqual({ ok: true });
  });

  it.each([408, 429])("retries HTTP %s once", async (status) => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await resolver.fetchJson(
      `https://raw.githubusercontent.com/radius-project/radius/${commit}/${status}.json`,
      {
        fetchImpl: async () => {
          attempts += 1;
          return new Response(attempts === 1 ? "retry" : '{"ok":true}', {
            status: attempts === 1 ? status : 200
          });
        },
        sleep: async (milliseconds: number) => delays.push(milliseconds)
      }
    );
    expect(attempts).toBe(2);
    expect(delays).toEqual([300]);
    expect(result.value).toEqual({ ok: true });
  });

  it.each([
    ["2", 2_000],
    ["60", 5_000],
    ["invalid", 300],
    ["0", 300]
  ])("honors a bounded Retry-After value %s", async (retryAfter, expected) => {
    let attempts = 0;
    const delays: number[] = [];
    await resolver.fetchJson(
      `https://raw.githubusercontent.com/radius-project/radius/${commit}/rate-limit.json`,
      {
        fetchImpl: async () => {
          attempts += 1;
          return new Response(attempts === 1 ? "retry" : '{"ok":true}', {
            status: attempts === 1 ? 429 : 200,
            headers: attempts === 1 ? { "retry-after": retryAfter } : undefined
          });
        },
        sleep: async (milliseconds: number) => delays.push(milliseconds)
      }
    );
    expect(delays).toEqual([expected]);
  });

  it("honors an HTTP-date Retry-After value", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    try {
      let attempts = 0;
      const delays: number[] = [];
      await resolver.fetchJson(
        `https://raw.githubusercontent.com/radius-project/radius/${commit}/dated-rate-limit.json`,
        {
          fetchImpl: async () => {
            attempts += 1;
            return new Response(attempts === 1 ? "retry" : '{"ok":true}', {
              status: attempts === 1 ? 429 : 200,
              headers:
                attempts === 1 ?
                  { "retry-after": "Wed, 26 Aug 2026 00:00:02 GMT" }
                : undefined
            });
          },
          sleep: async (milliseconds: number) => delays.push(milliseconds)
        }
      );
      expect(delays).toEqual([2_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds timed-out requests", async () => {
    let attempts = 0;
    await expect(
      resolver.fetchJson(
        `https://raw.githubusercontent.com/radius-project/radius/${commit}/slow.json`,
        {
          timeoutMs: 5,
          fetchImpl: async (_url: string, options: RequestInit) => {
            attempts += 1;
            return await new Promise((_resolve, reject) => {
              options.signal?.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"));
              });
            });
          }
        }
      )
    ).rejects.toThrow(/timed out/u);
    expect(attempts).toBe(1);
  });

  it("uses a valid cache without network access", async () => {
    const cacheRoot = temporaryDirectory();
    seedCache(cacheRoot);
    const contract = await resolver.resolveRadiusTypes(
      ["Radius.Data/postgreSqlDatabases"],
      {
        ...managedIdentityOptions(),
        cacheRoot,
        fetchImpl: async () => {
          throw new Error("network should not be used");
        }
      }
    );
    expect(contract.resources[0].apiVersion).toBe("2025-08-01-preview");
    expect(contract.resources[0].schema.properties.application).toBeUndefined();
  });

  it("retains the active and most recent previous commit caches", async () => {
    const cacheRoot = temporaryDirectory();
    seedCache(cacheRoot);
    const previousCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const staleCommit = "cccccccccccccccccccccccccccccccccccccccc";
    const commitNamedFile = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const previousDirectory = path.join(cacheRoot, previousCommit);
    const staleDirectory = path.join(cacheRoot, staleCommit);
    const unrelatedDirectory = path.join(cacheRoot, "local-notes");
    const unrelatedFile = path.join(cacheRoot, commitNamedFile);
    fs.mkdirSync(previousDirectory);
    fs.writeFileSync(path.join(previousDirectory, "index.json"), "{}");
    fs.mkdirSync(staleDirectory);
    fs.writeFileSync(path.join(staleDirectory, "index.json"), "{}");
    fs.utimesSync(previousDirectory, new Date(2_000), new Date(2_000));
    fs.utimesSync(staleDirectory, new Date(1_000), new Date(1_000));
    fs.mkdirSync(unrelatedDirectory);
    fs.writeFileSync(unrelatedFile, "keep");

    await resolver.resolveRadiusTypes(["Radius.Core/applications"], {
      ...managedIdentityOptions(),
      cacheRoot,
      fetchImpl: async () => {
        throw new Error("network should not be used");
      }
    });

    expect(fs.existsSync(staleDirectory)).toBe(false);
    expect(fs.existsSync(previousDirectory)).toBe(true);
    expect(fs.existsSync(path.join(cacheRoot, commit))).toBe(true);
    expect(fs.existsSync(unrelatedDirectory)).toBe(true);
    expect(fs.readFileSync(unrelatedFile, "utf8")).toBe("keep");
  });

  it("lets two managed Radius versions reuse the same cache", async () => {
    const cacheRoot = temporaryDirectory();
    const previousCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    seedCache(cacheRoot);
    seedCache(cacheRoot, previousCommit);
    const offline = async () => {
      throw new Error("network should not be used");
    };

    await resolver.resolveRadiusTypes(["Radius.Core/applications"], {
      ...managedIdentityOptions(),
      cacheRoot,
      fetchImpl: offline
    });
    await resolver.resolveRadiusTypes(["Radius.Core/applications"], {
      ...managedIdentityOptions({
        radiusIdentity: { version: identity.version, commit: previousCommit }
      }),
      cacheRoot,
      fetchImpl: offline
    });

    expect(fs.existsSync(path.join(cacheRoot, commit))).toBe(true);
    expect(fs.existsSync(path.join(cacheRoot, previousCommit))).toBe(true);
  });

  it("preserves existing commit caches when a replacement index is unavailable", async () => {
    const cacheRoot = temporaryDirectory();
    const first = path.join(
      cacheRoot,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    const second = path.join(
      cacheRoot,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    fs.mkdirSync(first);
    fs.mkdirSync(second);

    await expect(
      resolver.resolveRadiusTypes(["Radius.Core/applications"], {
        ...managedIdentityOptions(),
        cacheRoot,
        fetchImpl: async () => {
          throw new Error("offline");
        },
        sleep: async () => {}
      })
    ).rejects.toThrow(/offline/u);

    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
  });

  it("treats cache-pruning failures as non-fatal", async () => {
    const cacheRoot = temporaryDirectory();
    seedCache(cacheRoot);
    const previousCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const staleCommit = "cccccccccccccccccccccccccccccccccccccccc";
    const previousDirectory = path.join(cacheRoot, previousCommit);
    const staleDirectory = path.join(cacheRoot, staleCommit);
    fs.mkdirSync(previousDirectory);
    fs.mkdirSync(staleDirectory);
    fs.utimesSync(previousDirectory, new Date(2_000), new Date(2_000));
    fs.utimesSync(staleDirectory, new Date(1_000), new Date(1_000));
    const warnings: string[] = [];

    const readdir = vi
      .spyOn(fs.promises, "readdir")
      .mockRejectedValueOnce(new Error("inspection denied"));
    try {
      const contract = await resolver.resolveRadiusTypes(
        ["Radius.Core/applications"],
        {
          ...managedIdentityOptions(),
          cacheRoot,
          fetchImpl: async () => {
            throw new Error("network should not be used");
          },
          warn: (warning: string) => warnings.push(warning)
        }
      );
      expect(contract.resources[0].type).toBe("Radius.Core/applications");
    } finally {
      readdir.mockRestore();
    }
    expect(warnings).toEqual([
      "Warning: could not inspect Radius definition cache: inspection denied"
    ]);

    const remove = vi
      .spyOn(fs.promises, "rm")
      .mockRejectedValueOnce(new Error("removal denied"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const contract = await resolver.resolveRadiusTypes(
        ["Radius.Core/applications"],
        {
          ...managedIdentityOptions(),
          cacheRoot,
          fetchImpl: async () => {
            throw new Error("network should not be used");
          }
        }
      );
      expect(contract.resources[0].type).toBe("Radius.Core/applications");
      expect(consoleError).toHaveBeenCalledWith(
        `Warning: could not prune stale Radius definition cache "${staleCommit}": removal denied`
      );
    } finally {
      remove.mockRestore();
      consoleError.mockRestore();
    }
    expect(fs.existsSync(staleDirectory)).toBe(true);
  });

  it("keeps cache maintenance failures non-fatal and fail-safe", async () => {
    const cacheRoot = temporaryDirectory();
    seedCache(cacheRoot);
    const previousCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const previousDirectory = path.join(cacheRoot, previousCommit);
    fs.mkdirSync(previousDirectory);
    const warnings: string[] = [];

    const update = vi
      .spyOn(fs.promises, "utimes")
      .mockRejectedValueOnce(new Error("timestamp denied"));
    const inspect = vi
      .spyOn(fs.promises, "stat")
      .mockRejectedValueOnce(new Error("stat denied"));
    try {
      const contract = await resolver.resolveRadiusTypes(
        ["Radius.Core/applications"],
        {
          ...managedIdentityOptions(),
          cacheRoot,
          fetchImpl: async () => {
            throw new Error("network should not be used");
          },
          warn: (warning: string) => warnings.push(warning)
        }
      );
      expect(contract.resources[0].type).toBe("Radius.Core/applications");
    } finally {
      update.mockRestore();
      inspect.mockRestore();
    }

    expect(warnings).toEqual([
      "Warning: could not update the active Radius definition cache: timestamp denied",
      `Warning: could not inspect Radius definition cache "${previousCommit}": stat denied`
    ]);
    expect(fs.existsSync(previousDirectory)).toBe(true);

    const absent = Object.assign(new Error("gone"), { code: "ENOENT" });
    const read = vi.spyOn(fs.promises, "readdir").mockRejectedValueOnce(absent);
    try {
      await resolver.resolveRadiusTypes(["Radius.Core/applications"], {
        ...managedIdentityOptions(),
        cacheRoot,
        fetchImpl: async () => {
          throw new Error("network should not be used");
        },
        warn: (warning: string) => warnings.push(warning)
      });
    } finally {
      read.mockRestore();
    }
    expect(warnings).toHaveLength(2);
  });

  it("resolves multiple types with one index and one namespace fetch", async () => {
    const cacheRoot = temporaryDirectory();
    const calls: string[] = [];
    const options = {
      ...managedIdentityOptions(),
      cacheRoot,
      fetchImpl: fixtureFetch(calls)
    };
    const contract = await resolver.resolveRadiusTypes(
      ["Radius.Compute/containers", "Radius.Core/applications"],
      options
    );
    expect(calls).toHaveLength(2);
    expect(
      contract.resources.map((resource: { type: string }) => resource.type)
    ).toEqual(["Radius.Compute/containers", "Radius.Core/applications"]);
    await resolver.resolveRadiusTypes(["Radius.Compute/containers"], options);
    expect(calls).toHaveLength(2);
  });

  it("returns selectors that resolve to the same API version only once", async () => {
    const calls: string[] = [];
    const contract = await resolver.resolveRadiusTypes(
      [
        "Radius.Core/applications",
        "Radius.Core/applications@2025-08-01-preview",
        "Radius.Core/applications"
      ],
      {
        ...managedIdentityOptions(),
        cacheRoot: temporaryDirectory(),
        fetchImpl: fixtureFetch(calls)
      }
    );

    expect(
      contract.resources.map((resource: { type: string }) => resource.type)
    ).toEqual(["Radius.Core/applications"]);
    expect(calls).toHaveLength(2);
  });

  it("returns every found definition alongside catalog misses", async () => {
    const calls: string[] = [];
    const contract = await resolver.resolveRadiusTypes(
      [
        "Radius.Core/applications",
        "Radius.Data/neo4jDatabases",
        "Radius.Data/neo4jDatabases@2025-08-01-preview",
        "Radius.Data/postgreSqlDatabases"
      ],
      {
        ...managedIdentityOptions(),
        cacheRoot: temporaryDirectory(),
        fetchImpl: fixtureFetch(calls)
      }
    );

    expect(
      contract.resources.map((resource: { type: string }) => resource.type)
    ).toEqual(["Radius.Core/applications", "Radius.Data/postgreSqlDatabases"]);
    expect(contract.notFound).toEqual([
      {
        type: "Radius.Data/neo4jDatabases",
        message:
          'Definition for resource type "Radius.Data/neo4jDatabases" was not found in the generated catalog for this Radius release.'
      }
    ]);
    expect(calls).toHaveLength(2);
  });

  it("replaces malformed cache entries and tolerates concurrent writers", async () => {
    const corruptRoot = temporaryDirectory();
    const corruptIndex = cacheFile(corruptRoot, "index.json");
    fs.mkdirSync(path.dirname(corruptIndex), { recursive: true });
    fs.writeFileSync(corruptIndex, "{");
    const corruptCalls: string[] = [];
    await resolver.resolveRadiusTypes(["Radius.Core/applications"], {
      ...managedIdentityOptions(),
      cacheRoot: corruptRoot,
      fetchImpl: fixtureFetch(corruptCalls)
    });
    expect(corruptCalls).toHaveLength(2);

    const concurrentRoot = temporaryDirectory();
    const concurrentCalls: string[] = [];
    await Promise.all([
      resolver.resolveRadiusTypes(["Radius.Compute/containerImages"], {
        ...managedIdentityOptions(),
        cacheRoot: concurrentRoot,
        fetchImpl: fixtureFetch(concurrentCalls)
      }),
      resolver.resolveRadiusTypes(["Radius.Compute/containerImages"], {
        ...managedIdentityOptions(),
        cacheRoot: concurrentRoot,
        fetchImpl: fixtureFetch(concurrentCalls)
      })
    ]);
    expect(
      JSON.parse(
        fs.readFileSync(cacheFile(concurrentRoot, fixtureTypePath), "utf8")
      )
    ).toEqual(fixtureTypes);
  });

  it("refreshes a structurally stale cached namespace before returning a contract", async () => {
    const cacheRoot = temporaryDirectory();
    seedCache(cacheRoot);
    fs.writeFileSync(
      cacheFile(cacheRoot, fixtureTypePath),
      JSON.stringify([{ $type: "FutureType" }])
    );
    const calls: string[] = [];

    const contract = await resolver.resolveRadiusTypes(
      ["Radius.Core/applications"],
      {
        ...managedIdentityOptions(),
        cacheRoot,
        fetchImpl: fixtureFetch(calls)
      }
    );

    expect(calls).toHaveLength(1);
    expect(contract.resources[0].type).toBe("Radius.Core/applications");
    expect(
      JSON.parse(fs.readFileSync(cacheFile(cacheRoot, fixtureTypePath), "utf8"))
    ).toEqual(fixtureTypes);
  });

  it("warns and continues when fetched definitions cannot be cached", async () => {
    const root = temporaryDirectory();
    const blockedCacheRoot = path.join(root, "cache-file");
    fs.writeFileSync(blockedCacheRoot, "not a directory");
    const warnings: string[] = [];
    const calls: string[] = [];

    const contract = await resolver.resolveRadiusTypes(
      ["Radius.Core/applications"],
      {
        ...managedIdentityOptions(),
        cacheRoot: blockedCacheRoot,
        fetchImpl: fixtureFetch(calls),
        warn: (warning: string) => warnings.push(warning)
      }
    );

    expect(contract.resources[0].type).toBe("Radius.Core/applications");
    expect(calls).toHaveLength(2);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/could not cache Radius definitions/u);
  });

  it("uses the default cache and warning boundary when no overrides are supplied", async () => {
    const home = temporaryDirectory();
    const defaultCacheRoot = path.join(
      home,
      ".radius",
      "ai-extensions",
      "cache",
      "radius-resource-types",
      "v1"
    );
    fs.mkdirSync(path.dirname(defaultCacheRoot), { recursive: true });
    fs.writeFileSync(defaultCacheRoot, "not a directory");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const contract = await resolver.resolveRadiusTypes(
        [
          {
            type: "Radius.Core/applications",
            apiVersion: "2025-08-01-preview"
          }
        ],
        {
          ...managedIdentityOptions(),
          fetchImpl: fixtureFetch([])
        }
      );
      expect(contract.resources[0].apiVersion).toBe("2025-08-01-preview");
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringMatching(/could not cache Radius definitions/u)
      );
    } finally {
      consoleError.mockRestore();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });

  it("reports the resolution stage and selected resource on failures", async () => {
    await expect(
      resolver.resolveRadiusTypes(["Radius.Core/applications"], {
        ...managedIdentityOptions(),
        cacheRoot: temporaryDirectory(),
        fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 })
      })
    ).rejects.toThrow(
      /Could not resolve "Radius.Core\/applications" during generated resource index/u
    );

    await expect(
      resolver.resolveRadiusTypes(["Radius.Core/applications@1900-01-01"], {
        ...managedIdentityOptions(),
        cacheRoot: temporaryDirectory(),
        fetchImpl: fixtureFetch([])
      })
    ).rejects.toThrow(/during resource selection.*unavailable/u);

    await expect(
      resolver.resolveRadiusTypes(["Radius.Core/applications"], {
        ...managedIdentityOptions(),
        cacheRoot: temporaryDirectory(),
        fetchImpl: async (url: string) =>
          new Response(
            JSON.stringify(url.endsWith("/index.json") ? fixtureIndex : {}),
            { status: 200 }
          )
      })
    ).rejects.toThrow(/during generated namespace definitions/u);

    await expect(
      resolver.resolveRadiusTypes(
        ["Radius.Core/applications@2025-08-01-preview"],
        {
          ...managedIdentityOptions(),
          cacheRoot: temporaryDirectory(),
          fetchImpl: async (url: string) =>
            new Response(
              JSON.stringify(
                url.endsWith("/index.json") ? fixtureIndex : (
                  [{ $type: "FutureType" }]
                )
              ),
              { status: 200 }
            )
        }
      )
    ).rejects.toThrow(/during generated resource contract/u);
  });
});

describe("command boundary", () => {
  it("queries managed identity through the injected process boundary", async () => {
    const cacheRoot = temporaryDirectory();
    seedCache(cacheRoot);
    const runRadImpl = vi.fn(() =>
      Promise.resolve({ stdout: JSON.stringify(identity), stderr: "" })
    );
    const identityOptions = managedIdentityOptions({ runRadImpl });

    const contract = await resolver.resolveRadiusTypes(
      ["Radius.Core/applications"],
      {
        ...identityOptions,
        cacheRoot,
        fetchImpl: async () => {
          throw new Error("network should not be used");
        }
      }
    );

    expect(contract.extension).toBe(identity.extension);
    expect(runRadImpl).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      ["version", "--cli", "--output", "json"],
      expect.objectContaining({
        label: "Managed Radius version query",
        timeout: 10_000,
        env: expect.objectContaining({
          BICEP: path.join(
            identityOptions.home,
            ".radius",
            "ai-extensions",
            "bin",
            `bicep${process.platform === "win32" ? ".exe" : ""}`
          )
        })
      })
    );
  });

  it("propagates a managed-runner timeout without fetching definitions", async () => {
    const cacheRoot = temporaryDirectory();
    seedCache(cacheRoot);
    const runRadImpl = vi.fn(() =>
      Promise.reject(
        new Error("Managed Radius version query timed out after 1ms")
      )
    );
    const fetchImpl = vi.fn();

    await expect(
      resolver.resolveRadiusTypes(["Radius.Core/applications"], {
        ...managedIdentityOptions({ runRadImpl }),
        cacheRoot,
        processTimeoutMs: 1,
        fetchImpl
      })
    ).rejects.toThrow(
      /Managed Radius version query failed: Managed Radius version query timed out after 1ms/u
    );
    expect(runRadImpl).toHaveBeenCalledWith(
      process.execPath,
      ["version", "--cli", "--output", "json"],
      expect.objectContaining({ timeout: 1 })
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("queries the configured managed binary through the importable resolver seam", async () => {
    const home = temporaryDirectory();
    const fakeVersion = path.join(home, "version");
    fs.writeFileSync(
      fakeVersion,
      `console.log(${JSON.stringify(JSON.stringify(identity))});\n`
    );
    const cacheRoot = path.join(home, "cache");
    seedCache(cacheRoot);
    const previousDirectory = process.cwd();
    process.chdir(home);
    try {
      const contract = await resolver.resolveRadiusTypes(
        ["Radius.Core/applications"],
        {
          env: { ...process.env, RADIUS_RAD_BINARY: process.execPath },
          home,
          cacheRoot,
          fetchImpl: async () => {
            throw new Error("network should not be used");
          }
        }
      );
      expect(contract.extension).toBe(identity.extension);
    } finally {
      process.chdir(previousDirectory);
    }
  });

  it("reports missing and failing managed binaries as identity failures", async () => {
    const missingHome = temporaryDirectory();
    await expect(
      resolver.resolveRadiusTypes(["Radius.Core/applications"], {
        env: {},
        home: missingHome,
        cacheRoot: path.join(missingHome, "cache")
      })
    ).rejects.toThrow(/managed Radius identity.*binary not found/u);

    const failingHome = temporaryDirectory();
    fs.writeFileSync(
      path.join(failingHome, "version"),
      'console.error("version failed"); process.exit(3);\n'
    );
    const previousDirectory = process.cwd();
    process.chdir(failingHome);
    try {
      await expect(
        resolver.resolveRadiusTypes(["Radius.Core/applications"], {
          env: { ...process.env, RADIUS_RAD_BINARY: process.execPath },
          home: failingHome,
          cacheRoot: path.join(failingHome, "cache")
        })
      ).rejects.toThrow(/Managed Radius version query failed: version failed/u);

      fs.writeFileSync(path.join(failingHome, "version"), "process.exit(4);\n");
      await expect(
        resolver.resolveRadiusTypes(["Radius.Core/applications"], {
          env: { ...process.env, RADIUS_RAD_BINARY: process.execPath },
          home: failingHome,
          cacheRoot: path.join(failingHome, "cache")
        })
      ).rejects.toThrow(
        /Managed Radius version query failed: Managed Radius version query exited with/u
      );
    } finally {
      process.chdir(previousDirectory);
    }
  });

  it("prints help and rejects malformed command arguments", async () => {
    for (const help of ["--help", "-h"]) {
      let stdout = "";
      let stderr = "";
      expect(
        await resolver.main([help], {
          stdout: { write: (value: string) => (stdout += value) },
          stderr: { write: (value: string) => (stderr += value) }
        })
      ).toBe(0);
      expect(stdout).toMatch(/^Usage:/u);
      expect(stderr).toBe("");
    }

    for (const args of [
      ["--staging"],
      ["--staging", "/tmp/one", "--staging", "/tmp/two"],
      ["--staging", "--help", "Radius.Core/applications"],
      ["--unknown"],
      ["--staging", "/tmp/staging"],
      ["Radius.Core/applications"]
    ]) {
      let stdout = "";
      let stderr = "";
      expect(
        await resolver.main(args, {
          stdout: { write: (value: string) => (stdout += value) },
          stderr: { write: (value: string) => (stderr += value) }
        })
      ).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toMatch(/Usage:/u);
    }
  });

  it("prints stable JSON only after a successful resolution", async () => {
    let stdout = "";
    let stderr = "";
    let configured = "";
    const staging = stagingDirectory();
    const status = await resolver.main(
      ["--staging", staging, "Radius.Core/applications"],
      {
        stdout: { write: (value: string) => (stdout += value) },
        stderr: { write: (value: string) => (stderr += value) },
        resolve: async () => ({
          contractVersion: 1,
          extension: identity.extension,
          resources: [],
          notFound: []
        }),
        writeConfig: async (_directory: string, extension: string) => {
          configured = extension;
        }
      }
    );
    expect(status).toBe(0);
    expect(stdout).toBe('{"contractVersion":1,"resources":[],"notFound":[]}\n');
    expect(stderr).toBe("");
    expect(configured).toBe(identity.extension);
  });

  it("prints and configures a successful partial contract", async () => {
    let stdout = "";
    let stderr = "";
    const staging = stagingDirectory();
    const writeConfig = vi.fn();
    const resource = {
      type: "Radius.Core/applications",
      apiVersion: "2025-08-01-preview",
      schema: { type: "object" }
    };
    const missing = {
      type: "Radius.Data/neo4jDatabases",
      message:
        'Definition for resource type "Radius.Data/neo4jDatabases" was not found in the generated catalog for this Radius release.'
    };

    const status = await resolver.main(
      [
        "--staging",
        staging,
        "Radius.Core/applications",
        "Radius.Data/neo4jDatabases"
      ],
      {
        stdout: { write: (value: string) => (stdout += value) },
        stderr: { write: (value: string) => (stderr += value) },
        resolve: async () => ({
          contractVersion: 1,
          extension: identity.extension,
          resources: [resource],
          notFound: [missing]
        }),
        writeConfig
      }
    );

    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      contractVersion: 1,
      resources: [resource],
      notFound: [missing]
    });
    expect(stderr).toBe("");
    expect(writeConfig).toHaveBeenCalledExactlyOnceWith(
      staging,
      identity.extension
    );
  });

  it("rejects an invalid staging directory before resolution", async () => {
    let stdout = "";
    let stderr = "";
    const resolve = vi.fn();
    const writeConfig = vi.fn();
    const staging = path.join(
      temporaryDirectory(),
      ".radius",
      `${STAGING_DIR_PREFIX}missing`
    );

    const status = await resolver.main(
      ["--staging", staging, "Radius.Core/applications"],
      {
        stdout: { write: (value: string) => (stdout += value) },
        stderr: { write: (value: string) => (stderr += value) },
        resolve,
        writeConfig
      }
    );

    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(`Invalid Radius staging directory "${staging}".\n`);
    expect(resolve).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("keeps stdout empty on usage and operational failures", async () => {
    let stdout = "";
    let stderr = "";
    expect(
      await resolver.main([], {
        stdout: { write: (value: string) => (stdout += value) },
        stderr: { write: (value: string) => (stderr += value) }
      })
    ).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/Usage/u);

    stderr = "";
    const resolutionStaging = stagingDirectory();
    expect(
      await resolver.main(
        ["--staging", resolutionStaging, "Radius.Core/applications"],
        {
          stdout: { write: (value: string) => (stdout += value) },
          stderr: { write: (value: string) => (stderr += value) },
          resolve: async () => {
            throw "resolution failed";
          }
        }
      )
    ).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("resolution failed\n");

    stderr = "";
    const configStaging = stagingDirectory();
    expect(
      await resolver.main(
        ["--staging", configStaging, "Radius.Core/applications"],
        {
          stdout: { write: (value: string) => (stdout += value) },
          stderr: { write: (value: string) => (stderr += value) },
          resolve: async () => ({
            contractVersion: 1,
            extension: identity.extension,
            resources: [],
            notFound: []
          }),
          writeConfig: async () => {
            throw new Error("config conflict");
          }
        }
      )
    ).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("config conflict\n");
  });

  it("returns and configures partial results from the executable", () => {
    const home = temporaryDirectory();
    const staging = stagingDirectory(home);
    const fakeVersion = path.join(home, "version");
    fs.writeFileSync(
      fakeVersion,
      `console.log(${JSON.stringify(JSON.stringify(identity))});\n`
    );
    seedCache(
      path.join(
        home,
        ".radius",
        "ai-extensions",
        "cache",
        "radius-resource-types",
        "v1"
      )
    );

    const result = spawnSync(
      process.execPath,
      [
        script,
        "--staging",
        staging,
        "Radius.Core/applications",
        "Radius.Data/neo4jDatabases",
        "Radius.Data/postgreSqlDatabases"
      ],
      {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          RADIUS_RAD_BINARY: process.execPath
        },
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      contractVersion: 1,
      resources: [
        { type: "Radius.Core/applications" },
        { type: "Radius.Data/postgreSqlDatabases" }
      ],
      notFound: [
        {
          type: "Radius.Data/neo4jDatabases",
          message:
            'Definition for resource type "Radius.Data/neo4jDatabases" was not found in the generated catalog for this Radius release.'
        }
      ]
    });
    expect(result.stderr).toBe("");
    expect(
      JSON.parse(
        fs.readFileSync(path.join(staging, "bicepconfig.json"), "utf8")
      )
    ).toEqual({
      experimentalFeaturesEnabled: { extensibility: true },
      extensions: { radius: identity.extension }
    });
  });

  it("runs end to end with the managed version command and offline cache", () => {
    const home = temporaryDirectory();
    const staging = stagingDirectory(home);
    const fakeVersion = path.join(home, "version");
    fs.writeFileSync(
      fakeVersion,
      `console.log(${JSON.stringify(JSON.stringify(identity))});\n`
    );
    const cacheRoot = path.join(
      home,
      ".radius",
      "ai-extensions",
      "cache",
      "radius-resource-types",
      "v1"
    );
    seedCache(cacheRoot);

    const result = spawnSync(
      process.execPath,
      [
        script,
        "--staging",
        staging,
        "Radius.Data/postgreSqlDatabases",
        "Radius.Compute/containers",
        "Radius.Compute/containerImages",
        "Radius.Core/applications"
      ],
      {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          RADIUS_RAD_BINARY: process.execPath
        },
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true
      }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).not.toContain("\n");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(20 * 1024);
    const contract = JSON.parse(result.stdout);
    expect(contract.radius).toBeUndefined();
    expect(contract.extension).toBeUndefined();
    expect(contract.notFound).toEqual([]);
    expect(
      contract.resources.map((resource: { type: string }) => resource.type)
    ).toEqual([
      "Radius.Data/postgreSqlDatabases",
      "Radius.Compute/containers",
      "Radius.Compute/containerImages",
      "Radius.Core/applications"
    ]);
    expect(
      contract.resources.every((resource: object) => "schema" in resource)
    ).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(staging, "bicepconfig.json"), "utf8")
      )
    ).toEqual({
      experimentalFeaturesEnabled: { extensibility: true },
      extensions: { radius: identity.extension }
    });
    expect(result.stderr).toBe("");
  });
});

describe("staged Bicep configuration", () => {
  it("creates a minimal config and fills a blank Radius alias", async () => {
    const root = temporaryDirectory();
    const staging = stagingDirectory(root);

    await resolver.writeStagedBicepConfig(staging, identity.extension);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(staging, "bicepconfig.json"), "utf8")
      )
    ).toEqual({
      experimentalFeaturesEnabled: { extensibility: true },
      extensions: { radius: identity.extension }
    });

    const blankRoot = temporaryDirectory();
    const blankStaging = stagingDirectory(blankRoot);
    fs.writeFileSync(
      path.join(blankRoot, ".radius", "bicepconfig.json"),
      JSON.stringify({ extensions: { radius: "   " } })
    );
    await resolver.writeStagedBicepConfig(blankStaging, identity.extension);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(blankStaging, "bicepconfig.json"), "utf8")
      ).extensions.radius
    ).toBe(identity.extension);
  });

  it("uses the current Radius config when no staged config exists", async () => {
    const root = temporaryDirectory();
    const staging = stagingDirectory(root);
    fs.writeFileSync(
      path.join(root, ".radius", "bicepconfig.json"),
      JSON.stringify({
        analyzers: { core: { enabled: false } },
        experimentalFeaturesEnabled: { symbolicNameCodegen: true },
        extensions: {
          radius: `  ${identity.extension}  `,
          customTypes: "./custom-types.tgz"
        }
      })
    );

    await resolver.writeStagedBicepConfig(staging, identity.extension);

    expect(
      JSON.parse(
        fs.readFileSync(path.join(staging, "bicepconfig.json"), "utf8")
      )
    ).toEqual({
      analyzers: { core: { enabled: false } },
      experimentalFeaturesEnabled: {
        symbolicNameCodegen: true,
        extensibility: true
      },
      extensions: {
        radius: identity.extension,
        customTypes: "./custom-types.tgz"
      }
    });
  });

  it("preserves a staged customTypes alias on its first run", async () => {
    const staging = stagingDirectory();
    fs.writeFileSync(
      path.join(staging, "bicepconfig.json"),
      JSON.stringify({
        extensions: { customTypes: "./custom-types.tgz" }
      })
    );

    await resolver.writeStagedBicepConfig(staging, identity.extension);

    expect(
      JSON.parse(
        fs.readFileSync(path.join(staging, "bicepconfig.json"), "utf8")
      )
    ).toEqual({
      experimentalFeaturesEnabled: { extensibility: true },
      extensions: {
        customTypes: "./custom-types.tgz",
        radius: identity.extension
      }
    });
  });

  it("fails without writing for mismatched, malformed, or fake staging input", async () => {
    const root = temporaryDirectory();
    const staging = stagingDirectory(root);
    const config = path.join(root, ".radius", "bicepconfig.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        extensions: { radius: "br:biceptypes.azurecr.io/radius:0.59" }
      })
    );
    await expect(
      resolver.writeStagedBicepConfig(staging, identity.extension)
    ).rejects.toThrow(/does not match managed Radius extension/u);
    expect(fs.existsSync(path.join(staging, "bicepconfig.json"))).toBe(false);

    fs.writeFileSync(config, "{");
    await expect(
      resolver.writeStagedBicepConfig(staging, identity.extension)
    ).rejects.toThrow(/Could not parse/u);
    expect(fs.existsSync(path.join(staging, "bicepconfig.json"))).toBe(false);

    await expect(
      resolver.writeStagedBicepConfig(root, identity.extension)
    ).rejects.toThrow(/Invalid Radius staging/u);
  });

  it("rejects malformed config sections, aliases, and staging records", async () => {
    for (const configValue of [
      [],
      { experimentalFeaturesEnabled: [] },
      { extensions: [] },
      { extensions: { radius: 60 } }
    ]) {
      const root = temporaryDirectory();
      const staging = stagingDirectory(root);
      fs.writeFileSync(
        path.join(root, ".radius", "bicepconfig.json"),
        JSON.stringify(configValue)
      );
      await expect(
        resolver.writeStagedBicepConfig(staging, identity.extension)
      ).rejects.toThrow(/must be an object|must be a string|Could not parse/u);
      expect(fs.existsSync(path.join(staging, "bicepconfig.json"))).toBe(false);
    }

    const wrongName = path.join(
      temporaryDirectory(),
      ".radius",
      "staging-test"
    );
    fs.mkdirSync(wrongName, { recursive: true });
    fs.writeFileSync(path.join(wrongName, STAGING_RUN_RECORD), "{}");
    await expect(
      resolver.writeStagedBicepConfig(wrongName, identity.extension)
    ).rejects.toThrow(/Invalid Radius staging/u);

    const invalidRun = stagingDirectory();
    fs.rmSync(path.join(invalidRun, STAGING_RUN_RECORD));
    fs.mkdirSync(path.join(invalidRun, STAGING_RUN_RECORD));
    await expect(
      resolver.writeStagedBicepConfig(invalidRun, identity.extension)
    ).rejects.toThrow(/Invalid Radius staging/u);
  });

  it("requires a parseable staging record with a valid baseline", async () => {
    for (const record of [
      "not valid json",
      "null",
      "[]",
      "{}",
      JSON.stringify({ baseline: null }),
      JSON.stringify({ baseline: [] }),
      JSON.stringify({ baseline: { "app.bicep": 7 } })
    ]) {
      const staging = stagingDirectory();
      fs.writeFileSync(path.join(staging, STAGING_RUN_RECORD), record);

      await expect(
        resolver.writeStagedBicepConfig(staging, identity.extension)
      ).rejects.toThrow(/Invalid Radius staging/u);
      expect(fs.existsSync(path.join(staging, "bicepconfig.json"))).toBe(false);
    }

    const staging = stagingDirectory();
    fs.writeFileSync(
      path.join(staging, STAGING_RUN_RECORD),
      JSON.stringify({
        version: 1,
        runId: "test",
        startedAt: "2026-01-01T00:00:00.000Z",
        baseline: {
          "app.bicep": null,
          "bicepconfig.json": "0123456789abcdef"
        }
      })
    );
    await resolver.writeStagedBicepConfig(staging, identity.extension);
    expect(fs.existsSync(path.join(staging, "bicepconfig.json"))).toBe(true);
  });
});
