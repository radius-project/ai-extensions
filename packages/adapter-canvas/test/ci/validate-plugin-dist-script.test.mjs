import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const SCRIPTS = ["plugins.mjs", "validate-plugin-dist.mjs"].map((name) => [
  name,
  fileURLToPath(new URL(`../../../../scripts/${name}`, import.meta.url))
]);
const temporaryRepositories = [];
const SOURCE = "a".repeat(40);
const OTHER_SOURCE = "b".repeat(40);
const MANIFEST_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const schemaFetchResponses = new Map();
let manifestSchemaResponse;
const SCHEMA_FETCH_PRELOAD = [
  "globalThis.fetch = async (url) => {",
  "  if (url !== process.env.RADIUS_TEST_SCHEMA_URL) {",
  '    throw new Error("unexpected schema URL: " + url);',
  "  }",
  "  if (process.env.RADIUS_TEST_SCHEMA_ERROR !== undefined) {",
  "    throw new Error(process.env.RADIUS_TEST_SCHEMA_ERROR);",
  "  }",
  "  return new Response(process.env.RADIUS_TEST_SCHEMA_BODY, {",
  "    status: Number(process.env.RADIUS_TEST_SCHEMA_STATUS)",
  "  });",
  "};",
  ""
].join("\n");

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function configureSchemaFetch(
  root,
  { body = manifestSchemaResponse, status = 200, error } = {}
) {
  if (body === undefined) throw new Error("schema response is not initialized");
  schemaFetchResponses.set(root, { body, status, error });
}

function repository({
  pluginName = "radius",
  packageJson = {},
  manifest = {},
  readme = "Radius\n"
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "radius-dist-"));
  temporaryRepositories.push(root);
  const plugin = join(root, "plugins", pluginName);
  const extension = join(root, "extensions", pluginName);
  const dist = join(root, ".artifacts", pluginName);
  mkdirSync(join(root, "scripts"));
  mkdirSync(plugin, { recursive: true });
  mkdirSync(extension, { recursive: true });
  mkdirSync(join(dist, "skills"), { recursive: true });
  for (const [name, source] of SCRIPTS) {
    copyFileSync(source, join(root, "scripts", name));
  }
  writeFileSync(join(root, "schema-fetch.mjs"), SCHEMA_FETCH_PRELOAD);
  configureSchemaFetch(root);

  writeJson(join(extension, "package.json"), {
    name: pluginName,
    version: "1.2.0",
    scripts: { "test:artifact": "echo tested" }
  });
  writeJson(join(plugin, "plugin.json"), {
    name: pluginName,
    version: "1.2.0"
  });
  writeFileSync(join(plugin, "README.md"), "Radius source\n");
  writeJson(join(dist, "package.json"), {
    name: pluginName,
    version: "1.2.0",
    main: "extension.mjs",
    radiusSourceRef: SOURCE,
    ...packageJson
  });
  writeJson(join(dist, "plugin.json"), {
    $schema: MANIFEST_SCHEMA,
    name: pluginName,
    version: "1.2.0",
    ...manifest
  });
  writeFileSync(join(dist, "README.md"), readme);
  writeFileSync(join(dist, "LICENSE"), "Apache License\n");
  writeFileSync(join(dist, "extension.mjs"), "export {};\n");
  mkdirSync(join(dist, "workflows"));
  return { root, dist };
}

function canvasDist(dist) {
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "assets", "preview.png"), "png\n");
}

function canvasRepository(manifest = {}) {
  const created = repository({
    manifest: {
      keywords: ["radius", "canvas"],
      extensions: {
        "com.github.copilot": { logo: "assets/preview.png" }
      },
      ...manifest
    }
  });
  canvasDist(created.dist);
  return created;
}

function run(root, ...args) {
  const pluginArgs = args.includes("--plugin") ? [] : ["--plugin", "radius"];
  const schemaResponse = schemaFetchResponses.get(root);
  if (schemaResponse === undefined) {
    throw new Error(`schema response is not configured for ${root}`);
  }
  const env = {
    ...process.env,
    RADIUS_TEST_SCHEMA_URL: MANIFEST_SCHEMA,
    RADIUS_TEST_SCHEMA_BODY: schemaResponse.body,
    RADIUS_TEST_SCHEMA_STATUS: String(schemaResponse.status)
  };
  if (schemaResponse.error !== undefined) {
    env.RADIUS_TEST_SCHEMA_ERROR = schemaResponse.error;
  }
  const result = spawnSync(
    process.execPath,
    [
      `--import=${pathToFileURL(join(root, "schema-fetch.mjs")).href}`,
      join(root, "scripts", "validate-plugin-dist.mjs"),
      ...pluginArgs,
      ...args
    ],
    { cwd: root, encoding: "utf8", env }
  );
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr
  };
}

beforeAll(async () => {
  const response = await fetch(MANIFEST_SCHEMA, {
    headers: { accept: "application/schema+json, application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`schema request failed with HTTP ${response.status}`);
  }
  manifestSchemaResponse = await response.text();
}, 15_000);

afterEach(() => {
  while (temporaryRepositories.length > 0) {
    const root = temporaryRepositories.pop();
    schemaFetchResponses.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("scripts/validate-plugin-dist.mjs", () => {
  it("accepts a complete manifest-driven plugin dist", () => {
    const { root } = repository({
      manifest: {
        description: "Model and deploy applications",
        author: {
          name: "Microsoft",
          email: "radius@example.com",
          url: "https://example.com/radius"
        },
        homepage: "https://radapp.io",
        repository: "https://github.com/radius-project/ai-extensions",
        license: "Apache-2.0",
        keywords: ["radius", "deploy"]
      }
    });

    expect(run(root, "--version", "1.2.0", "--source", SOURCE)).toMatchObject({
      status: 0,
      stdout: "radius@1.2.0"
    });
  });

  it.each([
    ["a network failure", { error: "offline" }, "could not be fetched"],
    ["an HTTP failure", { status: 503 }, "failed with HTTP 503"],
    ["malformed JSON", { body: "{broken" }, "not readable JSON"],
    ["non-object JSON", { body: "null" }, "must be a JSON object"]
  ])(
    "fails closed when the schema response has %s",
    (_label, response, message) => {
      const { root } = repository();
      configureSchemaFetch(root, response);

      const result = run(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    }
  );

  it("rejects a schema response with an unexpected identity", () => {
    const { root } = repository();
    const schema = JSON.parse(manifestSchemaResponse);
    schema.$id = "https://example.com/plugin.schema.json";
    configureSchemaFetch(root, { body: JSON.stringify(schema) });

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unexpected $id");
  });

  it.each([
    ["package name", { packageJson: { name: "other" } }, "both be named"],
    ["manifest version", { manifest: { version: "1.1.0" } }, "same semver"],
    ["invalid version", { packageJson: { version: "next" } }, "same semver"],
    ["empty README", { readme: "" }, "must not be empty"]
  ])("rejects an invalid %s", (_label, options, message) => {
    const result = run(repository(options).root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("requires the first-party license", () => {
    const { root, dist } = repository();
    rmSync(join(dist, "LICENSE"));

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LICENSE does not exist");
  });

  it("rejects a version other than the one the workflow selected", () => {
    const result = run(repository().root, "--version", "1.3.0");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected 1.3.0");
  });

  it.each([
    ["a missing source ref", undefined, "must carry a full"],
    ["a mutable source ref", "main", "must carry a full"],
    ["an uppercase source ref", SOURCE.toUpperCase(), "must carry a full"]
  ])("rejects %s", (_label, radiusSourceRef, message) => {
    const result = run(repository({ packageJson: { radiusSourceRef } }).root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("rejects a source ref other than the commit the workflow selected", () => {
    const result = run(repository().root, "--source", OTHER_SOURCE);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`expected ${OTHER_SOURCE}`);
  });

  it("rejects a mutable expected source ref", () => {
    const result = run(repository().root, "--source", "main");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--source must be a full lowercase");
  });

  it("requires the extension workflow assets", () => {
    const { root, dist } = repository();
    rmSync(join(dist, "workflows"), { recursive: true });

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("workflows does not exist");
  });

  it.each([
    [
      "missing main",
      { packageJson: { main: "missing.mjs" } },
      "does not exist"
    ],
    ["escaping main", { packageJson: { main: "../outside.mjs" } }, "escapes"]
  ])("rejects %s", (_label, options, message) => {
    const result = run(repository(options).root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  // Agent Plugins 1.0.0 discovers skills from the fixed skills/ directory, so a
  // dist that ships none is unusable no matter what the manifest says.
  it("requires the fixed skills directory", () => {
    const { root, dist } = repository();
    rmSync(join(dist, "skills"), { recursive: true });

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("skills does not exist");
  });

  it("rejects symlinks in the published tree", () => {
    const { root, dist } = repository();
    try {
      symlinkSync(join(dist, "README.md"), join(dist, "linked-readme.md"));
    } catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") return;
      throw error;
    }

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contains a symlink");
  });

  // Every path check reads through the dist root, so a symlinked root would let
  // validation pass for files outside the plugin tree entirely.
  it("rejects a dist root that is itself a symlink", () => {
    const { root, dist } = repository();
    const elsewhere = join(root, "elsewhere");
    renameSync(dist, elsewhere);
    try {
      symlinkSync(elsewhere, dist, "junction");
    } catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") return;
      throw error;
    }

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a symlink");
  });

  it.each([
    ["a number", 7],
    ["an array", ["."]],
    ["null", null],
    ["the legacy path string", "."]
  ])("rejects an extensions value that is %s", (_label, extensions) => {
    const result = run(repository({ manifest: { extensions } }).root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plugin.json#extensions");
  });

  it.each([
    ["keywords", "radius"],
    ["author", "Microsoft"]
  ])("rejects a schema-invalid %s value", (field, value) => {
    const result = run(repository({ manifest: { [field]: value } }).root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`plugin.json#${field}`);
  });

  it.each(["description", "homepage", "repository", "license"])(
    "rejects a non-string %s value",
    (field) => {
      const result = run(repository({ manifest: { [field]: 7 } }).root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`plugin.json#${field} must be a string`);
    }
  );

  it("rejects a non-string keyword", () => {
    const result = run(
      repository({ manifest: { keywords: ["radius", 7] } }).root
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plugin.json#keywords[1] must be a string");
  });

  it.each([
    ["an unknown field", { team: "Radius" }, "unknown fields: team"],
    ["a non-string field", { name: 7 }, "author.name must be a string"]
  ])("rejects an author object with %s", (_label, author, message) => {
    const result = run(repository({ manifest: { author } }).root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("accepts client data under a reverse-domain extension namespace", () => {
    const { root } = repository({
      manifest: { extensions: { "com.github.copilot": { logo: "logo.png" } } }
    });

    expect(run(root)).toMatchObject({ status: 0, stdout: "radius@1.2.0" });
  });

  describe("canvas contract", () => {
    it("accepts a canvas plugin whose entry point is at the plugin root", () => {
      const { root } = canvasRepository();

      expect(run(root)).toMatchObject({ status: 0, stdout: "radius@1.2.0" });
    });

    it("accepts schema-compliant client metadata with a root entry point", () => {
      const { root } = canvasRepository({
        extensions: {
          "com.github.copilot": {
            logo: "assets/preview.png",
            theme: "radius"
          }
        }
      });

      expect(run(root)).toMatchObject({ status: 0, stdout: "radius@1.2.0" });
    });

    it.each([
      [
        "a top-level logo",
        { logo: "assets/preview.png" },
        "declares unknown fields: logo"
      ],
      [
        "an extensions directory name",
        { extensions: "extensions" },
        "plugin.json#extensions must be an object"
      ]
    ])(
      "holds a plugin that is not a canvas to the closed schema for %s",
      (_label, manifest, message) => {
        const { root, dist } = repository({ manifest });
        canvasDist(dist);

        const result = run(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
      }
    );

    it.each([
      [
        "a logo the gallery will not accept",
        {
          extensions: {
            "com.github.copilot": { logo: "assets/logo.png" }
          }
        },
        'plugin.json#extensions["com.github.copilot"].logo must be "assets/preview.png"'
      ],
      [
        "a path-valued extensions field",
        { extensions: "extensions" },
        "plugin.json#extensions must be an object"
      ]
    ])("rejects %s", (_label, manifest, message) => {
      const { root } = canvasRepository(manifest);

      const result = run(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    });

    it.each([
      ["the Copilot namespace", { extensions: {} }],
      ["the namespaced logo", { extensions: { "com.github.copilot": {} } }]
    ])("rejects a canvas missing %s", (_label, manifest) => {
      const { root } = canvasRepository(manifest);

      const result = run(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'plugin.json#extensions["com.github.copilot"].logo must be "assets/preview.png"'
      );
    });

    it.each([
      [
        "assets/preview.png",
        'plugin.json#extensions["com.github.copilot"].logo does not exist'
      ],
      ["extension.mjs", "canvas entry point does not exist"]
    ])("rejects a canvas plugin missing %s", (missing, message) => {
      const { root, dist } = canvasRepository();
      rmSync(join(dist, missing), { recursive: true, force: true });

      const result = run(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    });

    it("rejects a canvas whose entry point exists only in a nested directory", () => {
      const { root, dist } = canvasRepository();
      rmSync(join(dist, "extension.mjs"));
      mkdirSync(join(dist, "extensions"));
      writeFileSync(join(dist, "extensions", "extension.mjs"), "export {};\n");

      const result = run(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("canvas entry point does not exist");
    });
  });

  it("rejects non-object extension namespace data", () => {
    const result = run(
      repository({
        manifest: { extensions: { "com.github.copilot": "logo.png" } }
      }).root
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "plugin.json#extensions.com.github.copilot must be an object"
    );
  });

  it.each([
    ["a single label", "copilot"],
    ["an empty label", "com..copilot"],
    ["an invalid DNS label", "com.github_copilot"],
    ["an overlong DNS label", `com.${"a".repeat(64)}`]
  ])("rejects an extension namespace with %s", (_label, namespace) => {
    const result = run(
      repository({ manifest: { extensions: { [namespace]: {} } } }).root
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reverse-domain namespace");
  });

  it("accepts a plugin name at the schema length limit", () => {
    const pluginName = "a".repeat(64);
    const { root } = repository({ pluginName });

    expect(run(root, "--plugin", pluginName)).toMatchObject({
      status: 0,
      stdout: `${pluginName}@1.2.0`
    });
  });

  it("rejects a plugin name above the schema length limit", () => {
    const pluginName = "a".repeat(65);
    const { root } = repository({ pluginName });

    const result = run(root, "--plugin", pluginName);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plugin.json#name");
  });

  it.each([
    ["a missing schema", undefined, "plugin.json#$schema is required"],
    [
      "a superseded schema",
      "https://agent-plugins.org/schemas/0.9.0/x.json",
      "plugin.json#$schema must be"
    ]
  ])("rejects %s identifier", (_label, schema, message) => {
    const result = run(repository({ manifest: { $schema: schema } }).root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("fails closed when the remote schema uses an unsupported keyword", () => {
    const { root } = repository();
    const schema = JSON.parse(manifestSchemaResponse);
    schema.properties.description.format = "uri";
    configureSchemaFetch(root, { body: JSON.stringify(schema) });

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported keyword");
    expect(result.stderr).toContain("schema.properties.description.format");
  });

  // The manifest schema is closed, so a field the spec dropped would be
  // reported and ignored by a conformant client rather than honored.
  it("rejects fields outside the closed manifest schema", () => {
    const result = run(repository({ manifest: { skills: "./skills/" } }).root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "plugin.json declares unknown fields: skills"
    );
  });

  it("reports malformed JSON without a stack trace", () => {
    const { root, dist } = repository();
    writeFileSync(join(dist, "plugin.json"), "{broken");

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plugin.json is not readable JSON");
  });
});
