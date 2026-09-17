import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectSourceInputs,
  resolveInputReference,
  scanBicepInputs,
  scanConfigurationInputs
} from "./source-access-closure.js";
import { nodeSourceFileSystem } from "./source-access-files.js";

describe("conservative Bicep input discovery", () => {
  it.each([
    "br:registry.invalid/types:1",
    "br/types:1",
    "ts:spec:1",
    "ts/spec:1"
  ])(
    "keeps remote extension %s out of an isolated compilation closure",
    (reference) => {
      expect(
        scanBicepInputs(`extension '${reference}'`, [], "compilation")
      ).toEqual({ complete: false, references: [] });
      expect(
        scanConfigurationInputs(
          JSON.stringify({ extensions: { remote: reference } }),
          "compilation"
        )
      ).toEqual({ complete: true, references: [], extensions: [] });
    }
  );
  it("retains local compiler inputs and rejects non-string extension configurations", () => {
    expect(
      scanBicepInputs("extension './local.tgz'", [], "compilation")
    ).toEqual({
      complete: true,
      references: [{ path: "./local.tgz", kind: "custom-type" }]
    });
    expect(
      scanConfigurationInputs(
        '{"extensions":{"local":"./local.tgz","invalid":false}}',
        "compilation"
      )
    ).toEqual({
      complete: false,
      references: [{ path: "./local.tgz", kind: "custom-type" }],
      extensions: ["local", "invalid"]
    });
  });
  it.each([
    "var text = 'br:registry.invalid/${name}:1'",
    "var text = '${{ extension: 'br:registry.invalid/types:1' }}'",
    "var text = '${'nested-${name}'}'",
    "var text = '${name /* } */}'",
    "var text = 'br:ordinary' /*\n comment */\nvar other = 'ts:ordinary'",
    "var text = '\\n\\r\\t\\u{41}\\$\\'\\\\'",
    "var data = { extension: 'br:registry.invalid/types:1', module: 'br:ordinary' }",
    "var extension = 'br:ordinary'\nvar module = extension"
  ])(
    "distinguishes inert strings and expression identifiers from dependency syntax: %s",
    (text) => {
      expect(scanBicepInputs(text)).toEqual({ complete: true, references: [] });
    }
  );

  it("captures static file loads inside interpolated expressions", () => {
    expect(
      scanBicepInputs("var text = 'br:${sys.loadTextContent('./name.txt')}:1'")
    ).toEqual({
      complete: true,
      references: [{ path: "./name.txt", kind: "file" }]
    });
  });

  it.each(["\n", "\r\n", "\r"])(
    "finds declarations after comments with %j line endings",
    (newline) => {
      expect(
        scanBicepInputs(
          `// inert br:ignored${newline}module x './child.bicep' = {}`
        )
      ).toEqual({
        complete: true,
        references: [{ path: "./child.bicep", kind: "module" }]
      });
      expect(
        scanBicepInputs(
          `var x = 1 /*${newline}*/ module x 'br:registry.invalid/module:1' = {}`
        )
      ).toMatchObject({ complete: false });
    }
  );

  it.each([
    "var text = '${name'",
    "var text = '${{ key: 1 }'",
    "var text = '${name /* unfinished'",
    "var text = '${'unfinished",
    "var text = '\\u{invalid}'",
    "var text = '\\u{110000}'",
    "var text = '${loadTextContent(path)}'",
    "module remote 'br:${name}:1' = {}",
    "extension '${name}'",
    "var text = loadTextContent('${name}')"
  ])("keeps malformed or dynamic dependencies incomplete: %s", (text) => {
    expect(scanBicepInputs(text).complete).toBe(false);
  });
  it("ignores a final comment without a newline", () => {
    expect(scanBicepInputs("// no inputs")).toEqual({
      complete: true,
      references: []
    });
  });
  it("recognizes static local module and load-file dependencies without treating comments/text as code", () => {
    const scan = scanBicepInputs(`
      // module ignored './outside.bicep' = {}
      /* loadTextContent('ignored.txt') */
      var text = 'loadTextContent(ignored)'
      var block = '''
      module ignored './ignored.bicep' = {}
      '''
      module api './modules/api.bicep' = {}
      var settings = loadJsonContent('../settings.json', '$.service')
      var textFile = sys.loadTextContent('./readme.txt')
      var yaml = loadYamlContent('./settings.yaml')
      var bytes = loadFileAsBase64('./data.bin')
    `);
    expect(scan).toEqual({
      complete: true,
      references: [
        { path: "./modules/api.bicep", kind: "module" },
        { path: "../settings.json", kind: "file" },
        { path: "./readme.txt", kind: "file" },
        { path: "./settings.yaml", kind: "file" },
        { path: "./data.bin", kind: "file" }
      ]
    });
  });

  it("decodes supported literal escapes and ignores identifiers that are not load calls", () => {
    expect(
      scanBicepInputs(
        "var loadTextContent = 1\nvar x = loadTextContent('it\\'s.txt')"
      )
    ).toEqual({
      complete: true,
      references: [{ path: "it's.txt", kind: "file" }]
    });
    expect(
      scanBicepInputs("var x = loadTextContent('dir\\\\file')").references
    ).toEqual([{ path: "dir\\file", kind: "file" }]);
  });

  it("captures direct extension package references and requires declared aliases to resolve", () => {
    expect(scanBicepInputs("extension './custom-types.tgz'")).toEqual({
      complete: true,
      references: [{ path: "./custom-types.tgz", kind: "custom-type" }]
    });
    expect(scanBicepInputs("extension customTypes").complete).toBe(false);
    expect(
      scanBicepInputs("extension customTypes", ["customTypes"]).complete
    ).toBe(true);
    expect(
      scanBicepInputs("extension 'br:registry.invalid/types:1'").complete
    ).toBe(true);
    expect(scanBicepInputs("extension").complete).toBe(false);
  });

  it.each([
    "module x modulePath = {}",
    "var x = loadTextContent(filePath)",
    "var x = loadJsonContent('./' + name)",
    "var x = 'prefix-${loadTextContent(path)}'",
    "module x 'br:registry.invalid/module:1' = {}",
    "module x 'ts:subscription/group/template:1' = {}",
    "module x 'br/alias:1' = {}",
    "import { T } from './types.bicep'",
    "using './app.bicep'",
    "var x = loadTextContent('''file''')",
    "var x = loadTextContent('bad\\q')",
    "var x = 'unfinished",
    "var x = '''unfinished",
    "/* unfinished",
    "module",
    "var x = loadTextContent(",
    "var x = loadDirectoryFileInfo('./files', '*.json')"
  ])(
    "does not assert complete closure for unsupported or malformed syntax %j",
    (text) => {
      expect(scanBicepInputs(text).complete).toBe(false);
    }
  );

  describe("effective local input closure", () => {
    let root: string;
    const limits = {
      maxFiles: 100,
      maxFileBytes: 100_000,
      maxTotalBytes: 500_000
    };
    beforeEach(async () => {
      root = join(
        process.cwd(),
        ".artifacts",
        `source-closure-${randomUUID()}`
      );
      await mkdir(root, { recursive: true });
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });
    async function seed(files: Record<string, string | Uint8Array>) {
      for (const [path, bytes] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), bytes);
      }
    }
    const collect = (definition = "app.bicep", bounds = limits) =>
      collectSourceInputs(nodeSourceFileSystem, root, definition, bounds, {
        aborted: false
      });

    it("deduplicates module cycles and repeated file references while preserving stronger input roles", async () => {
      await seed({
        "app.bicep":
          "var x = loadTextContent('./child.bicep')\nmodule child './child.bicep' = {}",
        "child.bicep":
          "module parent './app.bicep' = {}\nvar x = loadTextContent('./child.bicep')"
      });
      const result = await collect();
      expect(result.complete).toBe(true);
      expect(
        result.inputs.map(({ path, kind, existed }) => ({
          path,
          kind,
          existed
        }))
      ).toEqual([
        { path: "app.bicep", kind: "definition", existed: true },
        { path: "bicepconfig.json", kind: "configuration", existed: false },
        { path: "child.bicep", kind: "module", existed: true }
      ]);
    });

    it("selects the nearest configuration without reading an overridden ancestor or generated output", async () => {
      await seed({
        "models/app.bicep": "extension radius",
        "models/bicepconfig.json":
          '{"extensions":{"radius":"br:registry.invalid/types:1"}}',
        "bicepconfig.json": "ignored invalid ancestor",
        "models/generated.json": "not an input"
      });
      const result = await collect("models/app.bicep");
      expect(result.complete).toBe(true);
      expect(result.inputs.map(({ path }) => path)).toEqual([
        "models/app.bicep",
        "models/bicepconfig.json"
      ]);
    });

    it.each(["configured", "direct"])(
      "owns the exact bytes of a %s standalone local extension input without generator companions",
      async (kind) => {
        const archive = Buffer.from([31, 139, 8, 0, 255, 128, 13, 10]);
        await seed({
          "app.bicep":
            kind === "configured" ? "extension radius" : (
              "extension './types/extension.tgz' as radius"
            ),
          ...(kind === "configured" ?
            {
              "bicepconfig.json":
                '{"extensions":{"radius":"./types/extension.tgz","duplicate":"./types/extension.tgz"}}'
            }
          : {}),
          "types/extension.tgz": archive,
          "types/unrelated-recipe.bicep": "module x dynamic = {}",
          "types/custom-types.yaml": "not a compiler input"
        });
        const result = await collect();
        expect(result.complete).toBe(true);
        expect(result.inputs.map(({ path }) => path).sort()).toEqual([
          "app.bicep",
          "bicepconfig.json",
          "types/extension.tgz"
        ]);
        expect(
          result.inputs.find(({ kind }) => kind === "custom-type")
        ).toEqual({
          path: "types/extension.tgz",
          kind: "custom-type",
          existed: true,
          contentHash: `sha256:${createHash("sha256").update(archive).digest("hex")}`
        });
        expect(result.bytes.get("types/extension.tgz")).toEqual(archive);
      }
    );

    it.each(["configured", "direct"])(
      "captures %s local custom types, recipe artifacts and their transitive inputs",
      async (kind) => {
        await seed({
          "app.bicep":
            kind === "configured" ?
              "extension customTypes"
            : "extension './types/custom-types.tgz'",
          "bicepconfig.json":
            kind === "configured" ?
              '{"extensions":{"customTypes":"./types/custom-types.tgz","secondAlias":"./types/custom-types.tgz"}}'
            : "{}",
          "types/custom-types.tgz": Buffer.from([0, 255, 42]),
          "types/custom-types.yaml": "types: {}",
          "types/custom-recipe-pack.bicep":
            "var description = loadTextContent('./description.txt')",
          "types/db-recipe.bicep":
            "module shared './modules/shared.bicep' = {}",
          "types/modules/shared.bicep": "param name string",
          "types/description.txt": "custom recipe",
          "types/generated.json": "not an input"
        });
        const result = await collect();
        expect(result.complete).toBe(true);
        expect(result.inputs.map(({ path }) => path).sort()).toEqual([
          "app.bicep",
          "bicepconfig.json",
          "types/bicepconfig.json",
          "types/custom-recipe-pack.bicep",
          "types/custom-types.tgz",
          "types/custom-types.yaml",
          "types/db-recipe.bicep",
          "types/description.txt",
          "types/modules/bicepconfig.json",
          "types/modules/shared.bicep"
        ]);
        expect(
          result.inputs.find(({ path }) => path === "types/db-recipe.bicep")
            ?.kind
        ).toBe("recipe");
        expect(result.bytes.get("types/custom-types.tgz")).toEqual(
          Buffer.from([0, 255, 42])
        );
      }
    );

    it.each<Record<string, string | Uint8Array>>([
      { "app.bicep": "module missing './missing.bicep' = {}" },
      { "app.bicep": "var missing = loadTextContent('./missing.txt')" },
      { "app.bicep": "extension './unknown.json'", "unknown.json": "opaque" },
      { "app.bicep": "extension './missing.tgz' as radius" },
      { "app.bicep": "extension unknownAlias" },
      { "app.bicep": "extension './${package}.tgz' as radius" },
      { "app.bicep": "extension './types/custom-types.tgz'" },
      {
        "app.bicep": "extension './custom-types.tgz'",
        "custom-types.tgz": "archive",
        "custom-recipe-pack.bicep": ""
      },
      {
        "app.bicep": "extension './custom-types.tgz' as radius",
        "custom-types.tgz": "archive",
        "custom-types.yaml": "types: {}"
      },
      { "app.bicep": "var x = loadTextContent(dynamicPath)" },
      { "app.bicep": "module x './module.json' = {}", "module.json": "{}" },
      { "app.bicep": Buffer.from([255]) },
      { "app.bicep": "", "bicepconfig.json": Buffer.from([255]) },
      { "app.bicep": "", "bicepconfig.json": "{ broken" }
    ])(
      "does not establish a complete closure for unresolved input set %#",
      async (files) => {
        await seed(files);
        const result = await collect();
        expect(result.complete).toBe(false);
        expect(result.definitionPresent).toBe(true);
      }
    );

    it.each([
      "../outside.tgz",
      "/outside.tgz",
      "C:/outside.tgz",
      "%2e%2e/outside.tgz",
      "br/alias:extension"
    ])("rejects an unsafe standalone extension path %j", async (path) => {
      await seed({ "app.bicep": `extension '${path}' as radius` });
      await expect(collect()).rejects.toMatchObject({
        result: { status: "failed", error: { code: "INVALID_REQUEST" } }
      });
    });

    it("rejects a case alias instead of capturing another extension path", async () => {
      await seed({
        "app.bicep": "extension './EXTENSION.tgz' as radius",
        "extension.tgz": Buffer.from([31, 139, 8])
      });
      await expect(collect()).rejects.toMatchObject({
        result: { status: "failed", error: { code: "INVALID_REQUEST" } }
      });
    });

    it("records an absent selected definition separately from an incomplete present one", async () => {
      const result = await collect();
      expect(result).toMatchObject({
        complete: false,
        definitionPresent: false,
        inputs: [{ path: "app.bicep", existed: false, contentHash: null }]
      });
    });

    it("enforces the exact file-count and total-byte bounds without dropping their incomplete signal", async () => {
      await seed({ "app.bicep": "param x string" });
      expect(
        (
          await collect("app.bicep", {
            ...limits,
            maxFiles: 2,
            maxTotalBytes: 14
          })
        ).complete
      ).toBe(true);
      expect(
        (await collect("app.bicep", { ...limits, maxFiles: 1 })).complete
      ).toBe(false);
      expect(
        (await collect("app.bicep", { ...limits, maxTotalBytes: 13 })).complete
      ).toBe(false);
      expect(
        (await collect("app.bicep", { ...limits, maxFileBytes: 14 })).complete
      ).toBe(true);
      await expect(
        collect("app.bicep", { ...limits, maxFileBytes: 13 })
      ).rejects.toMatchObject({
        result: {
          status: "unavailable",
          error: { code: "VALIDATION_INCOMPLETE" }
        }
      });
    });
  });

  it("resolves ordinary parent module references within the repository", () => {
    expect(
      resolveInputReference(".radius/modules/api.bicep", "../settings.json")
    ).toBe(".radius/settings.json");
    expect(resolveInputReference("app.bicep", "./modules/api.bicep")).toBe(
      "modules/api.bicep"
    );
  });

  it.each([
    "../../outside",
    "/outside",
    "C:\\outside",
    "C:/outside",
    "\\\\host\\share",
    "%2e%2e/file",
    "file\n",
    "./a/../../outside"
  ])("rejects unsafe dependency reference %j", (reference) => {
    expect(() => resolveInputReference("app.bicep", reference)).toThrow();
  });
});

describe("repository Bicep configuration inputs", () => {
  it("collects configured local extension packages and retains remote references as configuration data", () => {
    expect(
      scanConfigurationInputs(
        JSON.stringify({
          extensions: {
            radius: "br:biceptypes.azurecr.io/radius:1",
            customTypes: "./custom-types.tgz"
          },
          experimentalFeaturesEnabled: { extensibility: true }
        })
      )
    ).toEqual({
      complete: true,
      references: [{ path: "./custom-types.tgz", kind: "custom-type" }],
      extensions: ["radius", "customTypes"]
    });
    expect(scanConfigurationInputs("{}")).toEqual({
      complete: true,
      references: [],
      extensions: []
    });
  });

  it.each([
    "",
    "{",
    "[]",
    "null",
    '{"extensions":[]}',
    '{"extensions":null}',
    '{"extensions":{"custom":{}}}',
    '{"extensions":{"custom":""}}',
    '{"extensions":{"custom":"unknown:artifact"}}'
  ])("reports unsupported configuration %j as incomplete", (text) => {
    expect(scanConfigurationInputs(text).complete).toBe(false);
  });
});
