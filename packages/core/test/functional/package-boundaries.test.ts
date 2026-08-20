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
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src"
);

// Static import/export specifiers, including `export ... from`.
const SPECIFIER_PATTERN =
  /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']/g;

const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "fs/promises",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "process",
  "stream",
  "url",
  "util",
  "worker_threads",
  "zlib"
]);

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
        .filter(
          (specifier) =>
            specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)
        )
        .map((specifier) => `${file.path} -> ${specifier}`)
    );

    expect(offenders).toEqual([]);
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

    expect(core.RADIUS_CORE_VERSION).toBe("0.1.0");
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

  it("exposes every documented submodule entry point", async () => {
    const [graph, modeling, platforms, workflows] = await Promise.all([
      import("../../src/graph/index.js"),
      import("../../src/modeling/index.js"),
      import("../../src/platforms/index.js"),
      import("../../src/workflows/index.js")
    ]);

    expect(typeof graph.computeGraphDiff).toBe("function");
    expect(typeof modeling.evaluateAppSource).toBe("function");
    expect(typeof platforms.getPlatform).toBe("function");
    expect(typeof workflows.generateDeployWorkflow).toBe("function");
  });
});
