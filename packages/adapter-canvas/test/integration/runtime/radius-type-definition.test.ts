import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
  const directory = path.join(root, ".radius", ".staging-test");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "run.json"),
    JSON.stringify({
      version: 1,
      runId: "test",
      startedAt: "2026-01-01T00:00:00.000Z",
      baseline: {}
    })
  );
  return directory;
}

function cacheFile(cacheRoot: string, relativePath: string): string {
  return path.join(cacheRoot, commit, ...relativePath.split("/"));
}

function seedCache(cacheRoot: string): void {
  const indexPath = cacheFile(cacheRoot, "index.json");
  const typesPath = cacheFile(cacheRoot, fixtureTypePath);
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
    expect(() =>
      resolver.parseResourceSelector("Radius.Resources/widgets")
    ).toThrow(/Invalid predefined/u);
    expect(() =>
      resolver.parseResourceSelector("radius.data/postgreSqlDatabases")
    ).toThrow(/Invalid predefined/u);
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
    ).toThrow(/unavailable in this Radius release/u);
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
  });
});

describe("compact model-facing schemas", () => {
  it("returns canonical inputs and outputs in one recursive schema", () => {
    const schema = resolver.buildSchema(fixtureTypes, 14);
    const properties = schema.properties.properties.properties;

    expect(Object.keys(schema.properties)).toEqual([
      "apiVersion",
      "id",
      "location",
      "name",
      "properties",
      "type"
    ]);
    expect(schema.properties.application).toBeUndefined();
    expect(schema.required).toEqual(["name", "properties"]);
    expect(schema.properties.name).toEqual({ type: "string" });
    expect(schema.properties.properties.required).toEqual([
      "environment",
      "password",
      "username"
    ]);
    expect(properties.application).toEqual({ type: "string" });
    expect(properties.password).toEqual({
      type: "string",
      sensitive: true
    });
    expect(properties.host).toEqual({ type: "string", readOnly: true });
    expect(properties.port).toEqual({ type: "string", readOnly: true });
    expect(properties.size).toEqual({
      type: "string",
      enum: ["L", "M", "S"]
    });
  });

  it("returns maps, arrays, and canonical compute outputs", () => {
    const image = resolver.buildSchema(fixtureTypes, 19);
    const imageProperties = image.properties.properties.properties;
    expect(imageProperties.build.required).toEqual(["source"]);
    expect(imageProperties.imageReference.readOnly).toBe(true);

    const containers = resolver.buildSchema(fixtureTypes, 27);
    const containerProperties = containers.properties.properties.properties;
    expect(containerProperties.containers.additionalProperties).toMatchObject({
      type: "object"
    });
    expect(containerProperties.hosts).toEqual({
      type: "object",
      properties: {},
      additionalProperties: { type: "string" },
      readOnly: true
    });

    const application = resolver.buildSchema(fixtureTypes, 32);
    expect(JSON.stringify(application)).not.toMatch(/getGraph|functions/u);
  });

  it("normalizes primitives, general unions, and discriminated objects", () => {
    const types = [
      { $type: "AnyType" },
      { $type: "NullType" },
      { $type: "BooleanType" },
      { $type: "IntegerType", minValue: 1, maxValue: 9 },
      {
        $type: "StringType",
        minLength: 2,
        maxLength: 8,
        pattern: "^[a-z]+$"
      },
      { $type: "ArrayType", itemType: { $ref: "#/4" }, minLength: 1 },
      { $type: "UnionType", elements: [{ $ref: "#/2" }, { $ref: "#/4" }] },
      {
        $type: "ObjectType",
        name: "variant",
        properties: {
          value: { flags: 1, type: { $ref: "#/3" } }
        }
      },
      {
        $type: "DiscriminatedObjectType",
        name: "choice",
        discriminator: "kind",
        baseProperties: {
          kind: { flags: 1, type: { $ref: "#/4" } }
        },
        elements: { selected: { $ref: "#/7" } }
      }
    ];

    expect(resolver.normalizeTypeReference({ $ref: "#/0" }, types)).toEqual({
      type: "any"
    });
    expect(resolver.normalizeTypeReference({ $ref: "#/1" }, types)).toEqual({
      type: "null"
    });
    expect(resolver.normalizeTypeReference({ $ref: "#/3" }, types)).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 9
    });
    expect(resolver.normalizeTypeReference({ $ref: "#/5" }, types)).toEqual({
      type: "array",
      items: {
        type: "string",
        minLength: 2,
        maxLength: 8,
        pattern: "^[a-z]+$"
      },
      minItems: 1
    });
    expect(resolver.normalizeTypeReference({ $ref: "#/6" }, types)).toEqual({
      oneOf: [
        { type: "boolean" },
        {
          type: "string",
          minLength: 2,
          maxLength: 8,
          pattern: "^[a-z]+$"
        }
      ]
    });
    expect(
      resolver.normalizeTypeReference({ $ref: "#/8" }, types)
    ).toMatchObject({
      type: "object",
      discriminator: "kind",
      required: ["kind"],
      properties: { kind: { type: "string" } },
      variants: {
        selected: {
          required: ["kind", "value"],
          properties: {
            kind: { type: "string" },
            value: { type: "integer", minimum: 1, maximum: 9 }
          }
        }
      }
    });
  });

  it("fails on unknown flags, references, kinds, and cycles", () => {
    expect(() => resolver.decodePropertyFlags(32)).toThrow(/unsupported/u);
    expect(() =>
      resolver.normalizeTypeReference({ $ref: "other.json#/0" }, fixtureTypes)
    ).toThrow(/local #\/N/u);
    expect(() =>
      resolver.normalizeTypeReference({ $ref: "#/0" }, [
        { $type: "FutureType" }
      ])
    ).toThrow(/unsupported generated type kind/u);
    expect(() =>
      resolver.normalizeTypeReference({ $ref: "#/0" }, [
        {
          $type: "ObjectType",
          properties: {
            self: { flags: 0, type: { $ref: "#/0" } }
          }
        }
      ])
    ).toThrow(/recursive type cycle/u);
  });

  it("emits no compiler internals or redundant model-facing metadata", () => {
    const serialized = JSON.stringify(resolver.buildSchema(fixtureTypes, 14));
    expect(serialized).not.toMatch(
      /\$ref|"flags"|ObjectType|ResourceType|description|functions|readable|writable/u
    );
    expect(serialized).toContain('"required":["name","properties"]');
  });
});

describe("network and cache behavior", () => {
  it("retries retryable responses once", async () => {
    let attempts = 0;
    const result = await resolver.fetchJson(
      `https://raw.githubusercontent.com/radius-project/radius/${commit}/index.json`,
      {
        fetchImpl: async () => {
          attempts += 1;
          return new Response(attempts === 1 ? "busy" : '{"ok":true}', {
            status: attempts === 1 ? 500 : 200
          });
        }
      }
    );
    expect(attempts).toBe(2);
    expect(result.value).toEqual({ ok: true });
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
    expect(attempts).toBe(2);
  });

  it("uses a valid cache without network access", async () => {
    const cacheRoot = temporaryDirectory();
    seedCache(cacheRoot);
    const contract = await resolver.resolveRadiusTypes(
      ["Radius.Data/postgreSqlDatabases"],
      {
        identity,
        cacheRoot,
        fetchImpl: async () => {
          throw new Error("network should not be used");
        }
      }
    );
    expect(contract.resources[0].apiVersion).toBe("2025-08-01-preview");
    expect(contract.resources[0].schema.properties.application).toBeUndefined();
  });

  it("resolves multiple types with one index and one namespace fetch", async () => {
    const cacheRoot = temporaryDirectory();
    const calls: string[] = [];
    const options = {
      identity,
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

  it("replaces malformed cache entries and tolerates concurrent writers", async () => {
    const corruptRoot = temporaryDirectory();
    const corruptIndex = cacheFile(corruptRoot, "index.json");
    fs.mkdirSync(path.dirname(corruptIndex), { recursive: true });
    fs.writeFileSync(corruptIndex, "{");
    const corruptCalls: string[] = [];
    await resolver.resolveRadiusTypes(["Radius.Core/applications"], {
      identity,
      cacheRoot: corruptRoot,
      fetchImpl: fixtureFetch(corruptCalls)
    });
    expect(corruptCalls).toHaveLength(2);

    const concurrentRoot = temporaryDirectory();
    const concurrentCalls: string[] = [];
    await Promise.all([
      resolver.resolveRadiusTypes(["Radius.Compute/containerImages"], {
        identity,
        cacheRoot: concurrentRoot,
        fetchImpl: fixtureFetch(concurrentCalls)
      }),
      resolver.resolveRadiusTypes(["Radius.Compute/containerImages"], {
        identity,
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
});

describe("command boundary", () => {
  it("prints stable JSON only after a successful resolution", async () => {
    let stdout = "";
    let stderr = "";
    let configured = "";
    const status = await resolver.main(
      [
        "--staging",
        "/workspace/.radius/.staging-test",
        "Radius.Core/applications"
      ],
      {
        stdout: { write: (value: string) => (stdout += value) },
        stderr: { write: (value: string) => (stderr += value) },
        resolve: async () => ({
          contractVersion: 1,
          extension: identity.extension,
          resources: []
        }),
        writeConfig: async (_directory: string, extension: string) => {
          configured = extension;
        }
      }
    );
    expect(status).toBe(0);
    expect(stdout).toBe('{"contractVersion":1,"resources":[]}\n');
    expect(stderr).toBe("");
    expect(configured).toBe(identity.extension);
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
    expect(
      await resolver.main(
        [
          "--staging",
          "/workspace/.radius/.staging-test",
          "Radius.Core/applications"
        ],
        {
          stdout: { write: (value: string) => (stdout += value) },
          stderr: { write: (value: string) => (stderr += value) },
          resolve: async () => {
            throw new Error("resolution failed");
          }
        }
      )
    ).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("resolution failed\n");

    stderr = "";
    expect(
      await resolver.main(
        [
          "--staging",
          "/workspace/.radius/.staging-test",
          "Radius.Core/applications"
        ],
        {
          stdout: { write: (value: string) => (stdout += value) },
          stderr: { write: (value: string) => (stderr += value) },
          resolve: async () => ({
            extension: identity.extension
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
  it("uses only the current Radius config and normalizes its alias", async () => {
    const root = temporaryDirectory();
    const staging = stagingDirectory(root);
    fs.writeFileSync(
      path.join(staging, "bicepconfig.json"),
      JSON.stringify({
        extensions: { radius: "br:biceptypes.azurecr.io/radius:0.59" }
      })
    );
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
});
