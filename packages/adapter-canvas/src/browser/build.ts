import { buildSync } from "esbuild";
import type { BuildOptions, BuildResult } from "esbuild";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PageRegistryGlobal } from "./globals.js";

const BROWSER_SOURCE_DIR = dirname(fileURLToPath(import.meta.url));

export type BrowserEntryName =
  | "graph"
  | "delete-dialog"
  | "heartbeat"
  | "operation-chip"
  | "deploy-result-page"
  | "environment-page"
  | "deploying-page"
  | "graph-page"
  | "planned-graph-page"
  | "graph-diff-page"
  | "deployed-graph-page";

export interface BrowserEntrySpec<Name extends string = string> {
  readonly name: Name;
  readonly file: string;
  readonly initializer: string;
  readonly globals: readonly string[];
}

// `build.mjs` imports this module directly with bare Node type stripping, which
// does not resolve a `.js` specifier to its `.ts` source, so the compiler must
// keep its runtime graph free of relative imports. The type-only import above
// is erased, so it costs nothing at runtime while still making `globals.ts` the
// single definition of the shared global's name.
export const SHARED_ENTRY_GLOBALS: readonly string[] = [
  "radiusPageRegistry" satisfies PageRegistryGlobal
];

export const BROWSER_ENTRIES: readonly BrowserEntrySpec<BrowserEntryName>[] = [
  {
    name: "graph",
    file: "./entries/graph.ts",
    initializer: "installGraphEntry",
    globals: [
      "radiusRenderGraph",
      "radiusSetGraphLoading",
      "radiusSetGraphError"
    ]
  },
  {
    name: "delete-dialog",
    file: "./entries/delete-dialog.ts",
    initializer: "installDeleteDialogEntry",
    globals: ["radiusCreateDeleteDeploymentDialog"]
  },
  {
    name: "heartbeat",
    file: "./entries/heartbeat.ts",
    initializer: "installHeartbeatEntry",
    globals: []
  },
  {
    name: "operation-chip",
    file: "./entries/operation-chip.ts",
    initializer: "installOperationChipEntry",
    globals: []
  },
  {
    name: "deploy-result-page",
    file: "./entries/deploy-result-page.ts",
    initializer: "installDeployResultPageEntry",
    globals: []
  },
  {
    name: "environment-page",
    file: "./entries/environment-page.ts",
    initializer: "installEnvironmentPageEntry",
    globals: []
  },
  {
    name: "deploying-page",
    file: "./entries/deploying-page.ts",
    initializer: "installDeployingPageEntry",
    globals: []
  },
  {
    name: "graph-page",
    file: "./entries/graph-page.ts",
    initializer: "installGraphPageEntry",
    globals: []
  },
  {
    name: "planned-graph-page",
    file: "./entries/planned-graph-page.ts",
    initializer: "installPlannedGraphPageEntry",
    globals: []
  },
  {
    name: "graph-diff-page",
    file: "./entries/graph-diff-page.ts",
    initializer: "installGraphDiffPageEntry",
    globals: []
  },
  {
    name: "deployed-graph-page",
    file: "./entries/deployed-graph-page.ts",
    initializer: "installDeployedGraphPageEntry",
    globals: []
  }
];

export const BROWSER_ENTRY_NAMES: readonly BrowserEntryName[] =
  BROWSER_ENTRIES.map((entry) => entry.name);

const ENTRY_NAME = /^[a-z][a-z0-9-]*$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function validateBrowserEntrySpecs(
  specs: readonly BrowserEntrySpec[]
): void {
  const names = new Set<string>();
  const globals = new Map<string, string>();
  for (const spec of specs) {
    if (!ENTRY_NAME.test(spec.name)) {
      throw new Error(`Invalid browser entry name "${spec.name}".`);
    }
    if (names.has(spec.name)) {
      throw new Error(`Duplicate browser entry "${spec.name}".`);
    }
    names.add(spec.name);
    if (!spec.file.endsWith(".ts") || spec.file.includes("\\")) {
      throw new Error(
        `Browser entry "${spec.name}" must name a TypeScript module with forward slashes.`
      );
    }
    if (!IDENTIFIER.test(spec.initializer)) {
      throw new Error(
        `Browser entry "${spec.name}" has invalid initializer "${spec.initializer}".`
      );
    }
    for (const name of spec.globals) {
      if (!IDENTIFIER.test(name)) {
        throw new Error(
          `Browser entry "${spec.name}" has invalid global "${name}".`
        );
      }
      if (SHARED_ENTRY_GLOBALS.includes(name)) {
        throw new Error(
          `Browser entry "${spec.name}" redeclares shared global "${name}".`
        );
      }
      const owner = globals.get(name);
      if (owner !== undefined) {
        throw new Error(
          `Browser global "${name}" is declared by both "${owner}" and "${spec.name}".`
        );
      }
      globals.set(name, spec.name);
    }
  }
}

validateBrowserEntrySpecs(BROWSER_ENTRIES);

export function browserEntrySpec(
  name: string
): BrowserEntrySpec<BrowserEntryName> {
  const spec = BROWSER_ENTRIES.find((entry) => entry.name === name);
  if (spec === undefined) {
    throw new Error(`Unknown browser entry "${name}".`);
  }
  return spec;
}

export function makeInlineSafe(code: string): string {
  return code
    .replace(/<\/(script)/gi, "<\\/$1")
    .replace(/<!--/g, "<\\!--")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function assertInlineSafe(name: string, code: string): void {
  const hazards: string[] = [];
  if (/<\/script/i.test(code)) hazards.push("a script end tag");
  if (/<!--/.test(code)) hazards.push("an HTML comment opener");
  if (/[\u2028\u2029]/.test(code)) hazards.push("a JavaScript line terminator");
  if (hazards.length > 0) {
    throw new Error(
      `Browser entry "${name}" is not inline-safe: it contains ${hazards.join(", ")}.`
    );
  }
}

export function assertParseable(name: string, code: string): void {
  try {
    new Function(code);
  } catch (error) {
    const detail = String(error).replace(/^[A-Za-z]*Error:\s*/, "");
    throw new Error(`Browser entry "${name}" did not parse: ${detail}`, {
      cause: error
    });
  }
}

export function assertSelfContained(name: string, code: string): void {
  const hazards = [
    [/(^|\n)\s*import\s+/, "an import declaration"],
    [/\bimport\s*\(/, "a dynamic import"],
    [/\bimport\s*\.\s*meta\b/, "import.meta"],
    [/(^|\n)\s*export\s/, "an export"],
    [/\b(?:__require\d*|require)\s*\(/, "a require call"]
  ] as const;
  const found = hazards
    .filter(([pattern]) => pattern.test(code))
    .map(([, description]) => description);
  if (found.length > 0) {
    throw new Error(
      `Browser entry "${name}" is not self-contained: it contains ${found.join(", ")}.`
    );
  }
}

// Reject Node-only globals. esbuild's browser platform does not shim these, so
// a stray one is emitted verbatim and throws a page error on first evaluation —
// which takes the whole entry, and therefore the page's behavior, down with it.
// The usual way one arrives is transitively: a browser module imports a barrel
// that also re-exports server code reading `process.env` at module scope.
//
// This is a textual gate over esbuild's output, not a parse of it, so it is a
// safety net rather than a proof: sufficiently indirect access (a computed
// member name, a value threaded through an unrelated identifier) still gets
// through. It is sized for the shape the bundler actually emits, which with
// `minify: false` preserves the original identifiers and access syntax.
//
// A bare `typeof process !== "undefined"` feature-detect is legitimate and
// stays allowed, so the namespace globals are flagged only where they are
// really *used*: member access by dot or bracket, aliasing or destructuring off
// the binding, or access qualified through the global object. The lookbehind
// keeps unrelated properties (`options.process`) and longer identifiers
// (`processResults`, `globalThis`) from matching.
const NODE_NAMESPACE_GLOBALS = ["process", "Buffer", "global"] as const;

// No browser meaning at all, so any mention is a hazard.
const NODE_BARE_GLOBALS = [
  "__dirname",
  "__filename",
  "setImmediate",
  "clearImmediate"
] as const;

const GLOBAL_OBJECTS = "globalThis|window|self|global";

function nodeGlobalHazards(): readonly (readonly [RegExp, string])[] {
  const hazards: (readonly [RegExp, string])[] = [];
  for (const name of NODE_NAMESPACE_GLOBALS) {
    hazards.push(
      // `process.env`, `process["env"]`
      [new RegExp(String.raw`(?<![.\w$])${name}\s*[.[]`), name],
      // `const { env } = process`, `const p = process`
      [new RegExp(String.raw`=\s*${name}\b`), name],
      // `globalThis.process.env`
      [
        new RegExp(
          String.raw`(?<![.\w$])(?:${GLOBAL_OBJECTS})\s*\.\s*${name}\b`
        ),
        name
      ]
    );
  }
  for (const name of NODE_BARE_GLOBALS) {
    hazards.push([new RegExp(String.raw`(?<![.\w$])${name}\b`), name]);
  }
  return hazards;
}

const NODE_GLOBAL_HAZARDS = nodeGlobalHazards();

export function assertBrowserSafe(name: string, code: string): void {
  const found = [
    ...new Set(
      NODE_GLOBAL_HAZARDS.filter(([pattern]) => pattern.test(code)).map(
        ([, description]) => description
      )
    )
  ];
  if (found.length > 0) {
    throw new Error(
      `Browser entry "${name}" reaches Node-only globals: ${found.join(", ")}. ` +
        `Import from a browser-safe subpath instead of a package barrel that re-exports server code.`
    );
  }
}

function entryPath(spec: BrowserEntrySpec): string {
  return fileURLToPath(new URL(spec.file, import.meta.url));
}

type BrowserBuildResult = {
  readonly outputFiles?: BuildResult["outputFiles"];
  readonly metafile?: {
    readonly outputs: Readonly<
      Record<
        string,
        {
          readonly imports: readonly {
            readonly path: string;
            readonly kind: string;
          }[];
        }
      >
    >;
  };
};
export type BrowserBuild = (options: BuildOptions) => BrowserBuildResult;

const runEsbuild: BrowserBuild = (options) => buildSync(options);

export function compileBrowserEntrySpec(
  spec: BrowserEntrySpec,
  build: BrowserBuild = runEsbuild
): string {
  validateBrowserEntrySpecs([spec]);
  let output: BrowserBuildResult;
  try {
    output = build({
      stdin: {
        contents: `import { ${spec.initializer} as install } from ${JSON.stringify(spec.file)};\ninstall(globalThis);\n`,
        resolveDir: BROWSER_SOURCE_DIR,
        sourcefile: `radius-browser-entry-${spec.name}.ts`,
        loader: "ts"
      },
      absWorkingDir: BROWSER_SOURCE_DIR,
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: ["es2019"],
      charset: "utf8",
      minify: false,
      treeShaking: true,
      sourcemap: false,
      metafile: true,
      legalComments: "none",
      logLevel: "silent"
    });
  } catch (error) {
    const detail = String(error).replace(/^[A-Za-z]*Error:\s*/, "");
    throw new Error(`Browser entry "${spec.name}" failed to build: ${detail}`, {
      cause: error
    });
  }
  const files = output.outputFiles ?? [];
  if (files.length !== 1) {
    throw new Error(
      `Browser entry "${spec.name}" produced ${files.length} output files; expected exactly one self-contained script.`
    );
  }
  const code = makeInlineSafe(files[0].text);
  if (code.trim() === "") {
    throw new Error(
      `Browser entry "${spec.name}" compiled to an empty script.`
    );
  }
  assertInlineSafe(spec.name, code);
  assertParseable(spec.name, code);
  assertSelfContained(spec.name, code);
  assertBrowserSafe(spec.name, code);
  if (output.metafile === undefined) {
    throw new Error(
      `Browser entry "${spec.name}" produced no build metadata; cannot prove self-containment.`
    );
  }
  const runtimeImports = Object.values(output.metafile.outputs).flatMap(
    (entry) => entry.imports
  );
  if (runtimeImports.length > 0) {
    throw new Error(
      `Browser entry "${spec.name}" retained runtime module loads: ${runtimeImports
        .map((entry) => `${entry.kind} ${entry.path}`)
        .join(", ")}.`
    );
  }
  return code;
}

export interface BrowserCompiler {
  compile(name: string): string;
  compileAll(): Record<string, string>;
}

export function createBrowserCompiler(
  build: BrowserBuild = runEsbuild
): BrowserCompiler {
  const cache = new Map<BrowserEntryName, string>();

  function compile(name: string): string {
    const spec = browserEntrySpec(name);
    const cached = cache.get(spec.name);
    if (cached !== undefined) return cached;
    const code = compileBrowserEntrySpec(spec, build);
    cache.set(spec.name, code);
    return code;
  }

  return {
    compile,
    compileAll() {
      const bundles: Record<string, string> = {};
      for (const spec of BROWSER_ENTRIES) {
        bundles[spec.name] = compile(spec.name);
      }
      return bundles;
    }
  };
}

const browserCompiler = createBrowserCompiler();

export function compileBrowserEntry(name: string): string {
  return browserCompiler.compile(name);
}

export function compileAllBrowserEntries(): Record<string, string> {
  return browserCompiler.compileAll();
}

export function browserEntryFiles(): string[] {
  return BROWSER_ENTRIES.map((spec) => entryPath(spec));
}
