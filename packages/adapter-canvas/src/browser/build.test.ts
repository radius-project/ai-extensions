import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertBrowserSafe,
  assertInlineSafe,
  assertParseable,
  assertSelfContained,
  browserEntryFiles,
  browserEntrySpec,
  BROWSER_ENTRIES,
  BROWSER_ENTRY_NAMES,
  compileAllBrowserEntries,
  compileBrowserEntry,
  compileBrowserEntrySpec,
  createBrowserCompiler,
  makeInlineSafe,
  SHARED_ENTRY_GLOBALS,
  validateBrowserEntrySpecs
} from "./build.js";
import type { BrowserBuild, BrowserEntrySpec } from "./build.js";
import {
  browserEntryMarker,
  browserScript,
  browserScriptTag,
  BROWSER_ENTRY_MARKER
} from "./scripts.js";
import { PAGE_REGISTRY_GLOBAL } from "./globals.js";
import { loadBrowserScript } from "./generated.js";
import { resolvePageRegistry } from "./registry.js";
import { createFakeBrowserScope } from "../../test/support/browser/fakes.js";

function outputFile(text: string) {
  return {
    path: "out.js",
    contents: new TextEncoder().encode(text),
    hash: "test",
    text
  };
}

function buildResult(
  text: string,
  imports: readonly { path: string; kind: string }[] = []
) {
  return {
    outputFiles: [outputFile(text)],
    metafile: {
      outputs: {
        "out.js": { imports }
      }
    }
  };
}

const BROWSER_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(BROWSER_DIR, "../..");
const REPO_ROOT = resolve(PACKAGE_DIR, "../..");
const BUILD_MODULE_URL = pathToFileURL(resolve(BROWSER_DIR, "build.ts")).href;

const HEARTBEAT_SPEC: BrowserEntrySpec = {
  name: "heartbeat-test",
  file: "./entries/heartbeat.ts",
  initializer: "installHeartbeatEntry",
  globals: []
};

describe("browser entry specifications", () => {
  it("registers every implemented repository and graph entry exactly once", () => {
    expect(BROWSER_ENTRY_NAMES).toEqual([
      "graph",
      "delete-dialog",
      "heartbeat",
      "operation-chip",
      "oidc-page",
      "deploy-result-page",
      "environment-page",
      "deploying-page",
      "graph-page",
      "planned-graph-page",
      "graph-diff-page",
      "deployed-graph-page"
    ]);
    expect(SHARED_ENTRY_GLOBALS).toEqual([PAGE_REGISTRY_GLOBAL]);
    expect(BROWSER_ENTRIES.map((entry) => entry.initializer)).toEqual([
      "installGraphEntry",
      "installDeleteDialogEntry",
      "installHeartbeatEntry",
      "installOperationChipEntry",
      "installOidcPageEntry",
      "installDeployResultPageEntry",
      "installEnvironmentPageEntry",
      "installDeployingPageEntry",
      "installGraphPageEntry",
      "installPlannedGraphPageEntry",
      "installGraphDiffPageEntry",
      "installDeployedGraphPageEntry"
    ]);
    expect(new Set(BROWSER_ENTRY_NAMES).size).toBe(BROWSER_ENTRY_NAMES.length);
    expect(browserEntrySpec("heartbeat")).toBe(
      BROWSER_ENTRIES.find((entry) => entry.name === "heartbeat")
    );
    expect(() => browserEntrySpec("missing")).toThrow(
      'Unknown browser entry "missing".'
    );
    for (const file of browserEntryFiles()) {
      expect(existsSync(file), file).toBe(true);
    }
  });

  it.each([
    [
      [{ ...HEARTBEAT_SPEC, name: "Bad Name" }],
      'Invalid browser entry name "Bad Name".'
    ],
    [
      [HEARTBEAT_SPEC, HEARTBEAT_SPEC],
      'Duplicate browser entry "heartbeat-test".'
    ],
    [
      [{ ...HEARTBEAT_SPEC, file: "./entry.js" }],
      'Browser entry "heartbeat-test" must name a TypeScript module with forward slashes.'
    ],
    [
      [{ ...HEARTBEAT_SPEC, file: ".\\entry.ts" }],
      'Browser entry "heartbeat-test" must name a TypeScript module with forward slashes.'
    ],
    [
      [{ ...HEARTBEAT_SPEC, initializer: "bad-name" }],
      'Browser entry "heartbeat-test" has invalid initializer "bad-name".'
    ],
    [
      [{ ...HEARTBEAT_SPEC, globals: ["bad-name"] }],
      'Browser entry "heartbeat-test" has invalid global "bad-name".'
    ],
    [
      [{ ...HEARTBEAT_SPEC, globals: ["radiusPageRegistry"] }],
      'Browser entry "heartbeat-test" redeclares shared global "radiusPageRegistry".'
    ],
    [
      [
        { ...HEARTBEAT_SPEC, globals: ["shared"] },
        { ...HEARTBEAT_SPEC, name: "second", globals: ["shared"] }
      ],
      'Browser global "shared" is declared by both "heartbeat-test" and "second".'
    ]
  ])("rejects an invalid or ambiguous entry registry", (specs, message) => {
    expect(() => validateBrowserEntrySpecs(specs)).toThrow(message);
  });
});

describe("inline browser safety", () => {
  it("neutralizes HTML and JavaScript line hazards without changing values", () => {
    const original = `</script><!--\u2028\u2029`;
    const source = `var value = ${JSON.stringify(original)};`;
    const safe = makeInlineSafe(source);

    expect(() => assertInlineSafe("safe", safe)).not.toThrow();
    expect(new Function(`${safe} return value;`)()).toBe(original);
  });

  it("reports every remaining inline hazard", () => {
    expect(() => assertInlineSafe("unsafe", "</script><!--\u2029")).toThrow(
      'Browser entry "unsafe" is not inline-safe: it contains a script end tag, an HTML comment opener, a JavaScript line terminator.'
    );
  });

  it("names syntax and self-containment failures explicitly", () => {
    expect(() => assertParseable("broken", "function (")).toThrow(
      /Browser entry "broken" did not parse:/
    );
    expect(() => assertParseable("valid", "var value = 1;")).not.toThrow();
    expect(() =>
      assertSelfContained("imported", 'import value from "./value.js";')
    ).toThrow(
      'Browser entry "imported" is not self-contained: it contains an import declaration.'
    );
    expect(() =>
      assertSelfContained("dynamic", "void import(moduleName);")
    ).toThrow(
      'Browser entry "dynamic" is not self-contained: it contains a dynamic import.'
    );
    expect(() =>
      assertSelfContained("metadata", "const url = import.meta.url;")
    ).toThrow(
      'Browser entry "metadata" is not self-contained: it contains import.meta.'
    );
    expect(() =>
      assertSelfContained("exported", "\n export const value = 1;")
    ).toThrow(
      'Browser entry "exported" is not self-contained: it contains an export.'
    );
    expect(() =>
      assertSelfContained(
        "required",
        'const first = require("value"); const second = __require(moduleName);'
      )
    ).toThrow(
      'Browser entry "required" is not self-contained: it contains a require call.'
    );
    expect(() =>
      assertSelfContained("valid", "(() => { const value = 1; })();")
    ).not.toThrow();
  });

  it("names every Node-only global a bundle must not reach", () => {
    expect(() =>
      assertBrowserSafe("env", "var ref = process.env.RADIUS_DELETE_REF;")
    ).toThrow(
      /Browser entry "env" reaches Node-only globals: process\. Import from a browser-safe subpath/
    );
    expect(() =>
      assertBrowserSafe("buffered", "var raw = Buffer.from(value);")
    ).toThrow(/reaches Node-only globals: Buffer\./);
    expect(() =>
      assertBrowserSafe("scoped", "var target = global.setTimeout;")
    ).toThrow(/reaches Node-only globals: global\./);
    expect(() =>
      assertBrowserSafe("pathed", "var here = __dirname + __filename;")
    ).toThrow(/reaches Node-only globals: __dirname, __filename\./);
    expect(() =>
      assertBrowserSafe("several", "process.cwd(); Buffer.alloc(1);")
    ).toThrow(/reaches Node-only globals: process, Buffer\./);
  });

  // The guard must not fire on ordinary browser code that merely reads like a
  // Node global, or the next contributor learns to work around it.
  it("allows feature detects, own properties, and similarly named identifiers", () => {
    expect(() =>
      assertBrowserSafe(
        "clean",
        [
          'if (typeof process !== "undefined") return;',
          "var state = options.process.id;",
          "var done = processResults(items);",
          "globalThis.radiusPageRegistry = registry;",
          "var label = deployment.Buffer;"
        ].join("\n")
      )
    ).not.toThrow();
  });
});

describe("in-memory browser compiler", () => {
  it("compiles deterministic, parseable, self-contained entry bytes", () => {
    const first = compileAllBrowserEntries();
    const second = compileAllBrowserEntries();

    expect(Object.keys(first)).toEqual(BROWSER_ENTRY_NAMES);
    expect(second).toEqual(first);
    for (const name of BROWSER_ENTRY_NAMES) {
      const code = compileBrowserEntry(name);
      expect(code).toBe(first[name]);
      expect(code.length).toBeGreaterThan(0);
      expect(() => new Function(code)).not.toThrow();
      expect(() => assertInlineSafe(name, code)).not.toThrow();
      expect(() => assertSelfContained(name, code)).not.toThrow();
      expect(() => assertBrowserSafe(name, code)).not.toThrow();
      expect(code).not.toContain(".mjs");
      expect(code).not.toMatch(/<script[^>]+src=/);
    }
  });

  it("emits identical bytes from repository and package working directories", () => {
    const script = `const compiler = await import(${JSON.stringify(
      BUILD_MODULE_URL
    )}); process.stdout.write(compiler.compileBrowserEntry("heartbeat"));`;
    const compileFrom = (cwd: string): string =>
      execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { cwd, encoding: "utf8" }
      );

    expect(compileFrom(REPO_ROOT)).toBe(compileFrom(PACKAGE_DIR));
  });

  it("keeps independently compiled entries isolated", () => {
    const alpha = compileBrowserEntrySpec({
      name: "alpha",
      file: "../../test/fixtures/browser/entry-alpha.ts",
      initializer: "installAlpha",
      globals: ["radiusAlpha"]
    });
    const beta = compileBrowserEntrySpec({
      name: "beta",
      file: "../../test/fixtures/browser/entry-beta.ts",
      initializer: "installBeta",
      globals: ["radiusBeta"]
    });
    const alphaScope: Record<string, unknown> = {};
    const betaScope: Record<string, unknown> = {};

    new Function("globalThis", alpha)(alphaScope);
    new Function("globalThis", beta)(betaScope);

    expect(alphaScope).toEqual({ radiusAlpha: "alpha" });
    expect(betaScope).toEqual({ radiusBeta: "beta" });
    expect(alpha).not.toContain("radiusBeta");
    expect(beta).not.toContain("radiusAlpha");
  });

  it.each([
    [
      "dynamic import",
      {
        name: "dynamic-load",
        file: "../../test/fixtures/browser/entry-dynamic-load.ts",
        initializer: "installDynamicLoad",
        globals: []
      },
      /contains a dynamic import|retained runtime module loads/
    ],
    [
      "dynamic require",
      {
        name: "require-load",
        file: "../../test/fixtures/browser/entry-require-load.ts",
        initializer: "installRequireLoad",
        globals: []
      },
      /contains a require call|retained runtime module loads/
    ],
    [
      "Node global reached through a package barrel",
      {
        name: "node-global",
        file: "../../test/fixtures/browser/entry-node-global.ts",
        initializer: "installNodeGlobal",
        globals: []
      },
      /reaches Node-only globals: process\b/
    ]
  ])("rejects a compiled entry with a residual %s", (_label, spec, error) => {
    expect(() => compileBrowserEntrySpec(spec)).toThrow(error);
  });

  it.each(BROWSER_ENTRIES)(
    "publishes only $name's intended globals when executed",
    (entry) => {
      const browser = createFakeBrowserScope();
      const before = new Set(Object.keys(browser.scope));

      new Function("globalThis", compileBrowserEntry(entry.name))(
        browser.scope
      );

      const published = Object.keys(browser.scope)
        .filter((name) => !before.has(name))
        .sort();
      expect(published).toEqual(
        [...entry.globals, ...SHARED_ENTRY_GLOBALS].sort()
      );
      resolvePageRegistry(browser.scope).teardownAll();
    }
  );

  it("starts the heartbeat when its compiled entry executes", () => {
    const browser = createFakeBrowserScope();
    new Function("globalThis", compileBrowserEntry("heartbeat"))(browser.scope);
    expect(browser.clock.intervals).toBe(1);
    resolvePageRegistry(browser.scope).teardownAll();
  });

  it("memoizes named compiles while compileAll always rebuilds fresh bytes", () => {
    const calls: string[] = [];
    const build: BrowserBuild = (options) => {
      calls.push(options.stdin?.sourcefile ?? "");
      return buildResult("(() => {})();");
    };
    const compiler = createBrowserCompiler(build);

    expect(compiler.compile("heartbeat")).toBe("(() => {})();");
    expect(compiler.compile("heartbeat")).toBe("(() => {})();");
    expect(calls).toHaveLength(1);
    const allEntries = Object.fromEntries(
      BROWSER_ENTRY_NAMES.map((name) => [name, "(() => {})();"])
    );
    expect(compiler.compileAll()).toEqual(allEntries);
    expect(compiler.compileAll()).toEqual(allEntries);
    expect(calls).toHaveLength(1 + BROWSER_ENTRY_NAMES.length * 2);
    expect(compiler.compile("heartbeat")).toBe("(() => {})();");
    expect(calls).toHaveLength(1 + BROWSER_ENTRY_NAMES.length * 2);
  });

  it("passes an explicit browser-only build contract to esbuild", () => {
    const calls: Array<Parameters<BrowserBuild>[0]> = [];
    const build: BrowserBuild = (options) => {
      calls.push(options);
      return buildResult("(() => {})();");
    };

    compileBrowserEntrySpec(HEARTBEAT_SPEC, build);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: ["es2019"],
        sourcemap: false,
        metafile: true
      })
    );
    expect(calls[0].absWorkingDir).toBe(calls[0].stdin?.resolveDir);
    expect(calls[0].stdin).toEqual(
      expect.objectContaining({
        loader: "ts",
        sourcefile: "radius-browser-entry-heartbeat-test.ts"
      })
    );
    expect(calls[0].stdin?.contents).toContain(
      "installHeartbeatEntry as install"
    );
  });

  it("surfaces compiler failures and invalid output shapes with the entry name", () => {
    expect(() =>
      compileBrowserEntrySpec(HEARTBEAT_SPEC, () => {
        throw new Error("compiler unavailable");
      })
    ).toThrow(
      'Browser entry "heartbeat-test" failed to build: compiler unavailable'
    );
    expect(() =>
      compileBrowserEntrySpec(HEARTBEAT_SPEC, () => {
        throw "compiler stopped";
      })
    ).toThrow(
      'Browser entry "heartbeat-test" failed to build: compiler stopped'
    );
    expect(() =>
      compileBrowserEntrySpec(HEARTBEAT_SPEC, () => ({ outputFiles: [] }))
    ).toThrow(
      'Browser entry "heartbeat-test" produced 0 output files; expected exactly one self-contained script.'
    );
    expect(() => compileBrowserEntrySpec(HEARTBEAT_SPEC, () => ({}))).toThrow(
      'Browser entry "heartbeat-test" produced 0 output files; expected exactly one self-contained script.'
    );
    expect(() =>
      compileBrowserEntrySpec(HEARTBEAT_SPEC, () => ({
        outputFiles: [outputFile("one"), outputFile("two")]
      }))
    ).toThrow(
      'Browser entry "heartbeat-test" produced 2 output files; expected exactly one self-contained script.'
    );
    expect(() =>
      compileBrowserEntrySpec(HEARTBEAT_SPEC, () => ({
        outputFiles: [outputFile("   ")]
      }))
    ).toThrow('Browser entry "heartbeat-test" compiled to an empty script.');
    expect(() =>
      compileBrowserEntrySpec(HEARTBEAT_SPEC, () => ({
        outputFiles: [outputFile("function (")]
      }))
    ).toThrow(/Browser entry "heartbeat-test" did not parse:/);
    expect(() =>
      compileBrowserEntrySpec(HEARTBEAT_SPEC, () => ({
        outputFiles: [outputFile("(() => {})();")]
      }))
    ).toThrow(
      'Browser entry "heartbeat-test" produced no build metadata; cannot prove self-containment.'
    );
    expect(() =>
      compileBrowserEntrySpec(HEARTBEAT_SPEC, () =>
        buildResult("(() => {})();", [
          { path: "runtime-module", kind: "dynamic-import" }
        ])
      )
    ).toThrow(
      'Browser entry "heartbeat-test" retained runtime module loads: dynamic-import runtime-module.'
    );
    expect(() =>
      compileBrowserEntrySpec({
        ...HEARTBEAT_SPEC,
        name: "missing",
        file: "./entries/not-present.ts"
      })
    ).toThrow(/Browser entry "missing" failed to build:/);
  });
});

describe("renderer browser script wiring", () => {
  it("wraps one compiled payload in one marked inline script block", () => {
    const tag = browserScriptTag("heartbeat");
    expect(BROWSER_ENTRY_MARKER).toBe("// radius:browser-entry");
    expect(browserEntryMarker("heartbeat")).toBe(
      "// radius:browser-entry heartbeat"
    );
    expect(tag).toBe(
      `<script>\n${browserEntryMarker("heartbeat")}\n${browserScript("heartbeat")}\n</script>`
    );
    expect(tag).not.toMatch(/<script[^>]+src=/);
  });

  it("loads the registered entry and rejects an unknown generated name", () => {
    expect(loadBrowserScript("heartbeat")).toBe(
      compileBrowserEntry("heartbeat")
    );
    expect(() => loadBrowserScript("unknown")).toThrow(
      'Unknown browser entry "unknown".'
    );
  });
});
