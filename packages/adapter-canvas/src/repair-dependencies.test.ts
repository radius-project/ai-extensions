import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

interface Dependencies {
  artifactDeclarations(source: string): { kind: string; value: string }[];
  supplementalRepairInputs(
    sources: string[],
    root: string,
    files: typeof fs
  ): Map<string, string>;
}
const dependency: Dependencies = await import(
  pathToFileURL(
    path.resolve(
      import.meta.dirname,
      "../../../extensions/radius/skills/radius-app-bicep/scripts/repair-dependencies.mjs"
    )
  ).href
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture(text: string, config: object | null = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-deps-"))
  );
  roots.push(root);
  const app = path.join(root, "apps", "custom.bicep");
  fs.mkdirSync(path.dirname(app));
  fs.writeFileSync(app, text);
  if (config !== null)
    fs.writeFileSync(
      path.join(root, "bicepconfig.json"),
      JSON.stringify(config)
    );
  return {
    root,
    app,
    read: () => dependency.supplementalRepairInputs([app], root, fs)
  };
}

describe("repair artifact declarations", () => {
  it("reads literal module/import/extension declarations, not comments, nested properties or interpolated payloads", () => {
    const source = [
      "// module fake './ignored.bicep'",
      "/* extension './also-ignored.tgz' */",
      "var text = '${concat('extension', '\\'not an artifact\\'')}'",
      "var object = { module: 'also not a module' }",
      "var multiline = '''",
      "module ignored 'ignored.bicep'",
      "'''",
      "@description('actual dependency')",
      "module nested '../nested.bicep' = { name: 'nested' }",
      "import { Message as LocalMessage } from '../type.bicep'",
      "import * as types from '../types.json'",
      "extension './types.tgz' as custom",
      "extension configured",
      "provider legacy",
      "using '../params.json'"
    ].join("\n");
    expect(dependency.artifactDeclarations(source)).toEqual([
      { kind: "module", value: "../nested.bicep" },
      { kind: "module", value: "../type.bicep" },
      { kind: "module", value: "../types.json" },
      { kind: "extension", value: "./types.tgz" },
      { kind: "extension-alias", value: "configured" },
      { kind: "extension-alias", value: "legacy" },
      { kind: "module", value: "../params.json" }
    ]);
  });
  it("decodes escaped path characters and multiline import declarations", () => {
    expect(
      dependency.artifactDeclarations(
        "import {\n Name\n}\nfrom\n'./\\u{61}\\'\\$\\\\\\t\\n\\r.json'"
      )
    ).toEqual([{ kind: "module", value: "./a'$\\\t\n\r.json" }]);
    expect(
      dependency.artifactDeclarations("extension '''types.tgz'''")
    ).toEqual([{ kind: "extension", value: "types.tgz" }]);
  });
  it.each([
    "var a = 'unterminated",
    "var a = '''unterminated",
    "/* no end",
    "var a = {",
    "}",
    "var a = '\\q'",
    "var a = '\\uNO'",
    "module 'no-name' 'a.json'",
    "module a '${name}.json'",
    "import * without alias from 'x'",
    "import Name from 'x'",
    "extension",
    "using variable"
  ])("refuses unprovable syntax %s", (source) => {
    expect(() => dependency.artifactDeclarations(source)).toThrow();
  });
  it("handles empty source and a final line comment without inventing declarations", () => {
    expect(dependency.artifactDeclarations("")).toEqual([]);
    expect(dependency.artifactDeclarations("// extension custom")).toEqual([]);
  });
});

describe("compiler-resolution supplementation", () => {
  it("includes implicit extension types with the compiler's home expansion", () => {
    const f = fixture("output result string = 'no explicit declaration'", {
      implicitExtensions: ["custom"],
      extensions: { custom: "../types.tgz" },
      cacheRootDirectory: "~/.fixture-bicep"
    });
    fs.writeFileSync(path.join(f.root, "types.tgz"), "types");
    const files = [...f.read().keys()];
    expect(files[0]).toBe(path.join(f.root, "types.tgz"));
    expect(files[1]).toContain(
      path.join(os.homedir(), ".fixture-bicep", "local")
    );
  });
  it.each(["~", " "])(
    "matches compiler home/default cache selection for %j",
    (cacheRootDirectory) => {
      const f = fixture("extension 'br/team:custom:v1' as custom", {
        cacheRootDirectory,
        moduleAliases: { br: { team: { registry: "registry.example" } } }
      });
      expect([...f.read().keys()][0]).toBe(
        path.join(
          os.homedir(),
          cacheRootDirectory === "~" ? "" : ".bicep",
          "br",
          "registry.example",
          "custom",
          "v1$",
          "types.tgz"
        )
      );
    }
  );
  it.each([
    { cacheRootDirectory: 1 },
    { cacheRootDirectory: "relative" },
    { implicitExtensions: "custom" },
    { implicitExtensions: [1] },
    { implicitExtensions: [""] }
  ])("refuses invalid effective compiler configuration %j", (config) => {
    const f = fixture("output result string = 'value'", config);
    expect(f.read).toThrow();
  });
  it("follows extensionless local sources and their JSON imports once", () => {
    const f = fixture("module local '../module' = {}");
    const module = path.join(f.root, "module");
    fs.writeFileSync(
      module,
      "import { Data } from './data.json'\nmodule repeat './module' = {}"
    );
    expect([
      ...dependency.supplementalRepairInputs([f.app, module], f.root, fs).keys()
    ]).toEqual([module, path.join(f.root, "data.json")]);
  });
  it("checks local extension confinement before reading its bytes", () => {
    const f = fixture("extension '../linked/types.tgz' as custom");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "repair-external-"));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, "types.tgz"), "must not be read");
    fs.symlinkSync(
      outside,
      path.join(f.root, "linked"),
      process.platform === "win32" ? "junction" : "dir"
    );
    expect(f.read).toThrow("without symlinks or junctions");
  });
  it("includes local packages and content-addressed restored types, using inherited configuration", () => {
    const f = fixture(
      "extension custom\nmodule legacy '../legacy.json' = { name: 'legacy' }",
      {
        extensions: { custom: "./types.tgz" },
        cacheRootDirectory: "unused"
      }
    );
    const cache = path.join(f.root, "cache");
    fs.writeFileSync(
      path.join(f.root, "bicepconfig.json"),
      JSON.stringify({
        extensions: { custom: "./types.tgz" },
        cacheRootDirectory: cache
      })
    );
    const bytes = Buffer.from("raw-package\r\n");
    fs.writeFileSync(path.join(f.root, "types.tgz"), bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect([...f.read()]).toEqual([
      [path.join(f.root, "types.tgz"), f.root],
      [path.join(cache, "local", `sha256_${hash}`, "types.tgz"), cache],
      [path.join(f.root, "legacy.json"), f.root]
    ]);
  });
  it("does not skip a configured override of the az alias", () => {
    const f = fixture("extension az", {
      extensions: { az: "./types.tgz" },
      implicitExtensions: []
    });
    fs.writeFileSync(path.join(f.root, "types.tgz"), "types");
    expect(f.read().has(path.join(f.root, "types.tgz"))).toBe(true);
  });
  it.each([
    [
      "br:REGISTRY.example:443/types/custom:MixedTag",
      "registry.example$443",
      "types$custom",
      "MixedTag$21"
    ],
    [
      `br:registry.example/types/custom@sha256:${"a".repeat(64)}`,
      "registry.example",
      "types$custom",
      `sha256#${"a".repeat(64)}`
    ]
  ])(
    "confines restored OCI type evidence for %s",
    (reference, registry, repository, version) => {
      const f = fixture(`extension '${reference}' as custom`);
      const result = [...f.read().keys()];
      expect(result).toEqual(
        ["types.tgz", "manifest", "metadata"].map((name) =>
          path.join(
            os.homedir(),
            ".bicep",
            "br",
            registry,
            repository,
            version,
            name
          )
        )
      );
    }
  );
  it("resolves configured registry aliases without changing their source meaning", () => {
    const f = fixture("extension 'br/team:custom:v1' as custom", {
      moduleAliases: {
        br: { team: { registry: "registry.example", modulePath: "team" } }
      }
    });
    expect([...f.read().keys()][0]).toBe(
      path.join(
        os.homedir(),
        ".bicep",
        "br",
        "registry.example",
        "team$custom",
        "v1$",
        "types.tgz"
      )
    );
  });
  it("accepts intrinsic extensions and skips non-Bicep compiler files", () => {
    const f = fixture("extension sys\nextension az\nextension named", {
      extensions: { named: "builtin:" }
    });
    expect(f.read().size).toBe(0);
    expect(
      dependency.supplementalRepairInputs(
        [path.join(f.root, "data.json")],
        f.root,
        fs
      ).size
    ).toBe(0);
    const defaultConfig = fixture("extension az", null);
    expect(defaultConfig.read().size).toBe(0);
  });
  it.each([
    "extension missing",
    "extension 'br:invalid' as custom",
    "extension 'br:registry.example/../custom:v1' as custom",
    "extension 'br:registry.example/custom:bad tag' as custom",
    "extension 'br/missing:custom:v1' as custom",
    "module remote 'br:registry.example/module:v1' = {}",
    "module external '/outside.json' = {}",
    "module traversal '../../outside.json' = {}",
    "module omitted '../omitted.bicep' = {}"
  ])("refuses incomplete or unconfined artifact evidence: %s", (text) => {
    const f = fixture(text);
    expect(f.read).toThrow();
  });
  it("refuses malformed inherited configuration instead of switching to defaults", () => {
    const f = fixture("extension az");
    fs.writeFileSync(path.join(f.root, "bicepconfig.json"), "{");
    expect(f.read).toThrow("Cannot resolve repair configuration");
  });
});
