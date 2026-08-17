import { buildSync } from "esbuild";
import type { BuildOptions, BuildResult } from "esbuild";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BROWSER_SOURCE_DIR = dirname(fileURLToPath(import.meta.url));

export type BrowserEntryName =
  | "graph"
  | "heartbeat"
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

export const SHARED_ENTRY_GLOBALS: readonly string[] = ["radiusPageRegistry"];

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
    name: "heartbeat",
    file: "./entries/heartbeat.ts",
    initializer: "installHeartbeatEntry",
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
  return {
    compile(name) {
      const spec = browserEntrySpec(name);
      const cached = cache.get(spec.name);
      if (cached !== undefined) return cached;
      const code = compileBrowserEntrySpec(spec, build);
      cache.set(spec.name, code);
      return code;
    },
    compileAll() {
      const bundles: Record<string, string> = {};
      for (const spec of BROWSER_ENTRIES) {
        bundles[spec.name] = compileBrowserEntrySpec(spec, build);
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
