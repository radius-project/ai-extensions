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
// browser-unsafe import land while this suite stays green. `builtinModules`
// reports prefix-only modules (`node:test`, `node:sqlite`) in prefixed form, so
// every entry is normalized to its bare specifier and the prefixed form is
// matched separately below.
const NODE_BUILTINS = new Set(
  builtinModules.map((name) => name.replace(/^node:/, ""))
);

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier);
}

interface SourceFile {
  path: string;
  specifiers: string[];
}

// Prose in a header comment can look enough like an import to be picked up by a
// text scan, so comments are removed before specifiers are collected.
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
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
    const content = stripComments(await readFile(absolute, "utf8"));
    const specifiers: string[] = [];
    for (const match of content.matchAll(SPECIFIER_PATTERN)) {
      specifiers.push(match[1] ?? match[2] ?? match[3]);
    }
    files.push({
      path: relative(SRC_DIR, absolute).replace(/\\/g, "/"),
      specifiers
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

  function withoutGlobals(names: string[]): void {
    for (const name of names) {
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

  it("exposes every subpath the package manifest declares, and nothing more", async () => {
    const packageRoot = join(SRC_DIR, "..");
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8")
    ) as { exports: Record<string, string> };

    // Only these three subpaths have an importer outside core. `./modeling` and
    // `./workflows` were declared but never imported, so they are not part of
    // the package's contract. Targets are pinned alongside the keys: a subpath
    // repointed at the wrong module keeps the same key set.
    expect(manifest.exports).toEqual({
      ".": "./src/index.ts",
      "./graph": "./src/graph/index.ts",
      "./platforms": "./src/platforms/index.ts"
    });

    // Loaded through the manifest's own targets rather than hardcoded source
    // paths, so the declared entry points are what actually gets imported.
    const load = (subpath: string): Promise<Record<string, unknown>> =>
      import(
        pathToFileURL(join(packageRoot, manifest.exports[subpath])).href
      ) as Promise<Record<string, unknown>>;

    const [barrel, graph, platforms] = await Promise.all([
      load("."),
      load("./graph"),
      load("./platforms")
    ]);

    expect(typeof barrel.computeGraphDiff).toBe("function");
    expect(typeof graph.filterGraphVisualizationResources).toBe("function");
    expect(typeof platforms.buildOidcSubject).toBe("function");
  });
});
