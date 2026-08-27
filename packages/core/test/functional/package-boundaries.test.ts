// Functional: the package boundary `packages/core` is contracted to hold.
//
// Core is compiled into the Canvas browser bundle through its barrel, so a
// single import of a Node built-in or an adapter anywhere in the package breaks
// the bundle — and does so at build time in another package, far from the edit
// that caused it. ESLint already forbids adapter, SDK, and HTTP imports; this
// suite guards the part it does not cover (Node built-ins) and then proves the
// constraint behaviorally: the barrel loads and its journey still runs with the
// HTTP and DOM globals removed from the environment.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src"
);

// Static import/export specifiers, including `export ... from`.
const SPECIFIER_PATTERN =
  /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']/g;

// Derived from the running Node rather than hand-maintained: a list written out
// by hand silently stops covering built-ins it did not anticipate, which lets a
// browser-unsafe import land while this suite stays green.
//
// `builtinModules` reports a few modules (`node:test`, `node:sqlite`, `node:sea`,
// `node:test/reporters`) only in prefixed form, because for those the bare
// specifier is *not* a built-in — it resolves to an npm package. Stripping the
// prefix from those would flag a legitimate `import "sqlite"` as a boundary
// violation, so they stay out of the bare set and are matched by the prefix
// branch alone.
const NODE_BUILTINS = new Set(
  builtinModules.filter((name) => !name.startsWith("node:"))
);

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier);
}

interface SourceFile {
  path: string;
  specifiers: string[];
}

// Comments and template literals can hold prose that looks enough like an import
// to be collected by a text scan, which would fail the boundary check on an
// import that does not exist. Both are removed first.
//
// The scan is string-aware: quoted strings are matched before the comment
// branches so a `//` inside a URL is not mistaken for a comment, and they are
// preserved because a real specifier is a quoted string. Template literals are
// blanked instead, since a static import specifier can never be one.
function stripNonCode(content: string): string {
  return content.replace(
    /`(?:\\.|[^\\`])*`|"(?:\\.|[^\\"])*"|'(?:\\.|[^\\'])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) => {
      if (match.startsWith("`")) return "``";
      if (match.startsWith('"') || match.startsWith("'")) return match;
      return "";
    }
  );
}

function specifiersIn(content: string): string[] {
  const specifiers: string[] = [];
  for (const match of stripNonCode(content).matchAll(SPECIFIER_PATTERN)) {
    specifiers.push(match[1] ?? match[2] ?? match[3]);
  }
  return specifiers;
}

async function collectSourceFiles(): Promise<SourceFile[]> {
  const entries = await readdir(SRC_DIR, {
    recursive: true,
    withFileTypes: true
  });
  const files: SourceFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name.includes(".test.")) continue;
    const absolute = join(entry.parentPath, entry.name);
    files.push({
      path: relative(SRC_DIR, absolute).replace(/\\/g, "/"),
      specifiers: specifiersIn(await readFile(absolute, "utf8"))
    });
  }
  return files;
}

let sourceFiles: SourceFile[] = [];

beforeAll(async () => {
  sourceFiles = await collectSourceFiles();
});

describe("core package boundary", () => {
  it("finds the production sources it is meant to inspect", () => {
    expect(sourceFiles.length).toBeGreaterThan(10);
    expect(sourceFiles.map((f) => f.path)).toContain("index.ts");
  });

  it("imports no Node built-in, so the barrel can be bundled for the browser", () => {
    const offenders = sourceFiles.flatMap((file) =>
      file.specifiers
        .filter((specifier) => isNodeBuiltin(specifier))
        .map((specifier) => `${file.path} -> ${specifier}`)
    );

    expect(offenders).toEqual([]);
  });

  // The check above can only fail a build-breaking import if it recognizes one,
  // so the recognizer is exercised directly. The bare forms here were missing
  // from the hand-maintained list this suite started with.
  it.each([
    "dns",
    "perf_hooks",
    "timers/promises",
    "vm",
    "fs",
    "fs/promises",
    "child_process",
    "node:fs",
    "node:timers/promises",
    "node:test"
  ])("recognizes %s as a Node built-in", (specifier) => {
    expect(isNodeBuiltin(specifier)).toBe(true);
  });

  // `builtinModules` lists these only as `node:`-prefixed because the bare name
  // belongs to npm. Treating the bare form as built-in would fail the boundary
  // check on a legitimate dependency and point at the wrong problem.
  it.each(["sqlite", "test", "sea", "test/reporters"])(
    "does not treat the bare npm name %s as a Node built-in",
    (specifier) => {
      expect(isNodeBuiltin(specifier)).toBe(false);
      expect(isNodeBuiltin(`node:${specifier}`)).toBe(true);
    }
  );

  it.each([
    "./graph/index.js",
    "../ports/index.js",
    "yaml",
    "node-fetch",
    "pathe",
    "process-env-parser"
  ])("does not mistake %s for a Node built-in", (specifier) => {
    expect(isNodeBuiltin(specifier)).toBe(false);
  });

  // The offender list is only as good as the scan that feeds it: a specifier
  // picked out of prose reports a violation for an import that is not there.
  describe("import scan", () => {
    it("collects static, re-export, dynamic, and side-effect specifiers", () => {
      expect(
        specifiersIn(
          [
            'import { a } from "./a.js";',
            'export { b } from "./b.js";',
            'const c = await import("./c.js");',
            'import "./d.js";'
          ].join("\n")
        )
      ).toEqual(["./a.js", "./b.js", "./c.js", "./d.js"]);
    });

    it("ignores an import written after code on the same line", () => {
      expect(
        specifiersIn('import { x } from "./x.js"; // was: import "fs"')
      ).toEqual(["./x.js"]);
    });

    it.each([
      ["a block comment", '/* import { readFile } from "fs"; */'],
      ["a leading line comment", '// import { readFile } from "fs";'],
      ["a template literal", 'const doc = `import { readFile } from "fs";`;']
    ])("ignores an import inside %s", (_label, content) => {
      expect(specifiersIn(content)).toEqual([]);
    });

    it("does not treat a URL in a string as the start of a comment", () => {
      expect(
        specifiersIn(
          ['const docs = "https://example.com/x";', 'import "fs";'].join("\n")
        )
      ).toEqual(["fs"]);
    });
  });

  it("imports no adapter, SDK, or HTTP implementation", () => {
    const forbidden =
      /^(?:@github\/copilot-sdk|@radius-project\/adapter-|undici|node-fetch)|adapter-(?:canvas|shared)/;

    const offenders = sourceFiles.flatMap((file) =>
      file.specifiers
        .filter((specifier) => forbidden.test(specifier))
        .map((specifier) => `${file.path} -> ${specifier}`)
    );

    expect(offenders).toEqual([]);
  });

  it("resolves every relative import with an explicit .js specifier", () => {
    const offenders = sourceFiles.flatMap((file) =>
      file.specifiers
        .filter(
          (specifier) => specifier.startsWith(".") && !specifier.endsWith(".js")
        )
        .map((specifier) => `${file.path} -> ${specifier}`)
    );

    expect(offenders).toEqual([]);
  });
});

describe("core package in a host without HTTP or DOM globals", () => {
  const globals = globalThis as Record<string, unknown>;
  const removed = new Map<string, unknown>();

  afterEach(() => {
    for (const [name, value] of removed) globals[name] = value;
    removed.clear();
  });

  // Only names that were actually present are recorded, so the restore does not
  // define `window`/`document`/`XMLHttpRequest` as own properties holding
  // `undefined` under this config's node environment. `typeof` would still read
  // "undefined", but `"window" in globalThis` would flip to true for everything
  // running after this suite.
  function withoutGlobals(names: string[]): void {
    for (const name of names) {
      if (!(name in globals)) continue;
      removed.set(name, globals[name]);
      delete globals[name];
    }
  }

  it("loads and runs a modeling journey with fetch, window, and document absent", async () => {
    withoutGlobals(["fetch", "XMLHttpRequest", "document", "window"]);

    const core = await import("../../src/index.js");

    const resources = core.applicationGraphToResources({
      resources: [
        {
          id: "/planes/radius/local/resourcegroups/default/providers/Radius.Compute/containers/api",
          name: "api",
          type: "Radius.Compute/containers",
          diffHash: `sha256:${"a".repeat(64)}`,
          connections: []
        }
      ]
    });
    expect(resources).toHaveLength(1);
    expect(core.stateRegistryForEnvironment("acme/storefront", "prod")).toMatch(
      /^ghcr\.io\/acme\//
    );
    expect(core.getPlatform("azure")?.id).toBe("azure");
  });

  it("leaves globals that were never defined absent after the restore", () => {
    const absentBefore = ["XMLHttpRequest", "document", "window"].filter(
      (name) => !(name in globals)
    );
    expect(absentBefore.length).toBeGreaterThan(0);

    withoutGlobals(["fetch", ...absentBefore]);
    for (const [name, value] of removed) globals[name] = value;
    removed.clear();

    for (const name of absentBefore) expect(name in globals).toBe(false);
  });

  it("restores a global that was present before it was removed", () => {
    expect("fetch" in globals).toBe(true);
    const original = globals.fetch;

    withoutGlobals(["fetch"]);
    expect("fetch" in globals).toBe(false);

    for (const [name, value] of removed) globals[name] = value;
    removed.clear();
    expect(globals.fetch).toBe(original);
  });

  it("exposes every subpath the package manifest declares, and nothing more", async () => {
    const packageRoot = join(SRC_DIR, "..");
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8")
    ) as { exports: Record<string, string> };

    // Only these subpaths have an importer outside core; `./workflows` was
    // declared but never imported, so it is not part of the package's contract.
    // `./modeling` carries the staged-run rules, which are core's specification
    // for the bundled promote script rather than public API, so they are
    // reached here instead of being widened onto the top-level barrel. Targets
    // are pinned alongside the keys: a subpath repointed at the wrong module
    // keeps the same key set.
    expect(manifest.exports).toEqual({
      ".": "./src/index.ts",
      "./graph": "./src/graph/index.ts",
      "./modeling": "./src/modeling/index.ts",
      "./platforms": "./src/platforms/index.ts",
      "./remediations": "./src/remediations.ts"
    });

    // Loaded through the manifest's own targets rather than hardcoded source
    // paths, so the declared entry points are what actually gets imported.
    const load = (subpath: string): Promise<Record<string, unknown>> =>
      import(
        pathToFileURL(join(packageRoot, manifest.exports[subpath])).href
      ) as Promise<Record<string, unknown>>;

    const [barrel, graph, modeling, platforms, remediations] =
      await Promise.all([
        load("."),
        load("./graph"),
        load("./modeling"),
        load("./platforms"),
        load("./remediations")
      ]);

    expect(typeof barrel.computeGraphDiff).toBe("function");
    expect(typeof graph.filterGraphVisualizationResources).toBe("function");
    expect(typeof modeling.evaluateStagedRun).toBe("function");
    expect(typeof platforms.buildOidcSubject).toBe("function");
    expect(typeof remediations.remediationView).toBe("function");
  });
});
