import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  libraryExternalImports,
  validateBuildBoundary,
  validateLibraryManifest,
  validateStylesheetBoundary
} from "../../../../scripts/library-artifacts.mjs";
import {
  expectedScopedFlowStyles,
  hoistKeyframes,
  renameKeyframes,
  scopeFlowStyles,
  scopedFlowStylesPath
} from "../../../../scripts/graph-vendor-styles.mjs";

function manifest() {
  return {
    name: "@radius-project/graph-react",
    version: "0.1.0",
    private: true,
    license: "Apache-2.0",
    type: "module",
    typesVersions: {
      "*": {
        brand: ["dist/brand.d.ts"]
      }
    },
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js"
      },

      "./brand": {
        types: "./dist/brand.d.ts",
        import: "./dist/brand.js",
        default: "./dist/brand.js"
      },
      "./base.css": "./dist/base.css",
      "./styles.css": "./dist/styles.css",
      "./package.json": "./package.json"
    },
    dependencies: {
      "@radius-project/core": "0.1.0",
      "@xyflow/react": "12.11.6"
    },
    peerDependencies: {
      react: "^18.3.1 || ^19.2.8",
      "react-dom": "^18.3.1 || ^19.2.8"
    },
    sideEffects: ["**/*.css"]
  };
}

describe("packed library contracts", () => {
  it("retains the exact pinned vendor rules and license inside the graph scope", () => {
    const css = readFileSync(scopedFlowStylesPath, "utf8");
    expect(css).toBe(expectedScopedFlowStyles());
    expect(css).toContain("MIT License");
    expect(css).toContain("Copyright (c) 2019-2025 webkid GmbH");
    expect(css).toContain("@scope (.radius-graph)");
    expect(css).toMatch(/\n\}\n@keyframes radius-graph-dashdraw \{[^@]*\}\n$/);
    expect(css).not.toMatch(/@(?:-webkit-)?keyframes dashdraw/);
  });

  it("moves every keyframes declaration outside the graph scope", () => {
    expect(
      hoistKeyframes(
        ".a{color:red}@keyframes one{from{top:0}to{top:1px}}.b{}" +
          "@-webkit-keyframes two{from{top:0}}"
      )
    ).toEqual({
      rules: ".a{color:red}.b{}",
      keyframes: [
        "@keyframes one{from{top:0}to{top:1px}}",
        "@-webkit-keyframes two{from{top:0}}"
      ]
    });
    expect(hoistKeyframes(".a{}")).toEqual({ rules: ".a{}", keyframes: [] });
    expect(() => hoistKeyframes("@keyframes one{from{top:0}")).toThrow(
      "Unterminated keyframes declaration"
    );
  });

  it("renames every prefixed vendor keyframe declaration and reference", () => {
    expect(
      renameKeyframes(
        "@keyframes dashdraw{from{stroke-dashoffset:10}}\n" +
          "@-webkit-keyframes dashdraw{from{stroke-dashoffset:10}}\n" +
          ".edge{-webkit-animation:dashdraw 0.5s linear infinite;animation:dashdraw 0.5s linear infinite}",
        "dashdraw",
        "radius-graph-dashdraw"
      )
    ).toBe(
      "@keyframes radius-graph-dashdraw{from{stroke-dashoffset:10}}\n" +
        "@-webkit-keyframes radius-graph-dashdraw{from{stroke-dashoffset:10}}\n" +
        ".edge{-webkit-animation:radius-graph-dashdraw 0.5s linear infinite;animation:radius-graph-dashdraw 0.5s linear infinite}"
    );
  });

  it.each([
    [
      "an unreviewed use outside a keyframe or animation",
      "@keyframes dashdraw{}\n.edge{animation:dashdraw 1s}\n.dashdraw-legacy{color:red}",
      "Unreviewed dashdraw occurrence"
    ],
    [
      "a missing declaration",
      ".edge{animation:dashdraw 1s}",
      "Expected a dashdraw keyframes declaration"
    ],
    [
      "a missing reference",
      "@keyframes dashdraw{}",
      "Expected a dashdraw animation reference"
    ]
  ])("refuses to rewrite a vendor update with %s", (_reason, css, message) => {
    expect(() =>
      renameKeyframes(css, "dashdraw", "radius-graph-dashdraw")
    ).toThrow(message);
  });

  it.each(['@import "external.css";', "@font-face { font-family: other; }"])(
    "rejects unreviewed global vendor inputs: %s",
    (css) => {
      expect(() => scopeFlowStyles(css, "MIT")).toThrow();
    }
  );

  it("rejects accidentally bundling the unscoped vendor stylesheet", () => {
    expect(() =>
      validateStylesheetBoundary({
        inputs: { "../../node_modules/@xyflow/react/dist/style.css": {} },
        outputs: {}
      })
    ).toThrow("Unexpected stylesheet input");
  });

  it.each(["styles.css", "base.css"])(
    "bundles %s and React Flow styles without remote assets",
    (entry) => {
      expect(() =>
        validateStylesheetBoundary(
          {
            inputs: {
              [`src\\${entry}`]: {},
              "src/base.css": {},
              "src/flow.css": {}
            },
            outputs: {
              [`dist/${entry}`]: {
                imports: [{ path: "data:image/svg+xml,<svg/>", external: true }]
              }
            }
          },
          entry
        )
      ).not.toThrow();
    }
  );

  it.each(["styles.css", "base.css"])(
    "builds the real %s as one self-contained public stylesheet",
    async (entry) => {
      const result = await build({
        absWorkingDir: fileURLToPath(
          new URL("../../../graph-react/", import.meta.url)
        ),
        entryPoints: [`src/${entry}`],
        outfile: `dist/${entry}`,
        bundle: true,
        write: false,
        target: "es2022",
        metafile: true
      });
      expect(() =>
        validateStylesheetBoundary(result.metafile, entry)
      ).not.toThrow();
      expect(result.outputFiles).toHaveLength(1);
      const css = result.outputFiles[0].text;
      expect(css).toContain(".react-flow__handle");
      expect(css).toContain(".radius-graph");
      expect(css).not.toMatch(/@import\b/);
      expect(css).toMatch(/@scope\s*\(\.radius-graph\)/);
      if (entry === "base.css") {
        expect(Object.keys(result.metafile.inputs)).not.toContain(
          "src/theme.css"
        );
        expect(css).not.toContain('data-radius-appearance="default"');
      } else {
        expect(Object.keys(result.metafile.inputs)).toEqual(
          expect.arrayContaining([
            "src/base.css",
            "src/theme.css",
            "src/styles.css"
          ])
        );
        expect(css).toMatch(/@scope\b/);
      }
    }
  );

  it.each(["src/styles.css", "src/theme.css"])(
    "rejects the default skin input %s from a base-only build",
    (input) => {
      expect(() =>
        validateStylesheetBoundary(
          { inputs: { [input]: {} }, outputs: {} },
          "base.css"
        )
      ).toThrow("Unexpected stylesheet input");
    }
  );

  it("rejects attempts to build the skin as a public entry", () => {
    expect(() =>
      validateStylesheetBoundary({ inputs: {}, outputs: {} }, "theme.css")
    ).toThrow("Unknown public stylesheet");
  });

  it("rejects unexpected stylesheet implementations", () => {
    expect(() =>
      validateStylesheetBoundary({
        inputs: { "../other/styles.css": {} },
        outputs: {}
      })
    ).toThrow("Unexpected stylesheet input");
  });

  it("rejects remote imports left in the compiled stylesheet", () => {
    expect(() =>
      validateStylesheetBoundary({
        inputs: { "src/styles.css": {} },
        outputs: {
          "dist/styles.css": {
            imports: [
              { path: "https://example.invalid/styles.css", external: true }
            ]
          }
        }
      })
    ).toThrow("must not fetch an external asset");
  });

  it.each(["base.css", "styles.css"])(
    "rejects a leftover local skin fetch in %s",
    (entry) => {
      expect(() =>
        validateStylesheetBoundary(
          {
            inputs: { [`src/${entry}`]: {} },
            outputs: {
              [`dist/${entry}`]: {
                imports: [{ path: "./theme.css", external: true }]
              }
            }
          },
          entry
        )
      ).toThrow("must not fetch an external asset");
    }
  );

  it("accepts compiled, licensed graph exports and exact candidate core dependencies", () => {
    expect(() =>
      validateLibraryManifest(manifest(), manifest().name, "0.1.0")
    ).not.toThrow();
  });

  it("accepts only the browser-safe graph and domain subpaths of core", () => {
    const core = {
      name: "@radius-project/core",
      private: true,
      type: "module",
      license: "Apache-2.0",
      typesVersions: {
        "*": {
          graph: ["dist/graph/index.d.ts"],
          domain: ["dist/domain/index.d.ts"]
        }
      },
      exports: {
        ...Object.fromEntries(
          ["graph", "domain"].map((subpath) => [
            `./${subpath}`,
            {
              types: `./dist/${subpath}/index.d.ts`,
              import: `./dist/${subpath}/index.js`,
              default: `./dist/${subpath}/index.js`
            }
          ])
        ),
        "./package.json": "./package.json"
      }
    };
    expect(() =>
      validateLibraryManifest(core, core.name, "0.1.0")
    ).not.toThrow();
    core.exports["."] = "./src/index.ts";
    expect(() => validateLibraryManifest(core, core.name, "0.1.0")).toThrow();
  });

  it("rejects a library that hides its own manifest from consumers", () => {
    const value = manifest();
    delete value.exports["./package.json"];
    expect(() => validateLibraryManifest(value, value.name, "0.1.0")).toThrow();
  });

  it("rejects unrecognized library manifests", () => {
    const value = { ...manifest(), name: "unrecognized" };
    expect(() => validateLibraryManifest(value, value.name, "0.1.0")).toThrow(
      "Unknown library"
    );
  });

  it.each([
    [
      "missing classic TypeScript subpath declarations",
      (value) => {
        delete value.typesVersions;
      }
    ],
    [
      "source-only classic TypeScript declarations",
      (value) => {
        value.typesVersions["*"].brand = ["src/brand.ts"];
      }
    ],
    [
      "workspace dependency",
      (value) => {
        value.dependencies["@radius-project/core"] = "workspace:*";
      }
    ],
    [
      "catalog dependency",
      (value) => {
        value.devDependencies = { vitest: "catalog:" };
      }
    ],
    [
      "wrong core candidate",
      (value) => {
        value.dependencies["@radius-project/core"] = "0.2.0";
      }
    ],
    [
      "source export",
      (value) => {
        value.exports["."].import = "./src/index.ts";
      }
    ],
    [
      "missing declarations",
      (value) => {
        delete value.exports["."].types;
      }
    ],
    [
      "missing stylesheet",
      (value) => {
        delete value.exports["./styles.css"];
      }
    ],
    [
      "missing base stylesheet",
      (value) => {
        delete value.exports["./base.css"];
      }
    ],
    [
      "source base stylesheet",
      (value) => {
        value.exports["./base.css"] = "./src/base.css";
      }
    ],
    [
      "public workspace-only presentation helpers",
      (value) => {
        value.exports["./presentation"] = {
          types: "./dist/presentation.d.ts",
          import: "./dist/presentation.js",
          default: "./dist/presentation.js"
        };
      }
    ],
    [
      "separate theme export",
      (value) => {
        value.exports["./theme.css"] = "./dist/theme.css";
      }
    ],
    [
      "unretained stylesheet",
      (value) => {
        value.sideEffects = false;
      }
    ],
    [
      "publishable package",
      (value) => {
        delete value.private;
      }
    ],
    [
      "consumer-bundled Dagre dependency",
      (value) => {
        value.dependencies.dagre = "0.8.5";
      }
    ],
    [
      "bundled React dependency",
      (value) => {
        value.dependencies.react = "19.2.8";
      }
    ],
    [
      "unsupported peer range",
      (value) => {
        value.peerDependencies.react = "^19.2.8";
      }
    ],
    [
      "unlicensed package",
      (value) => {
        delete value.license;
      }
    ]
  ])("rejects %s", (_label, mutate) => {
    const value = manifest();
    mutate(value);
    expect(() => validateLibraryManifest(value, value.name, "0.1.0")).toThrow();
  });

  it("accepts source-owned inputs with external peer and renderer dependencies", () => {
    const build = {
      inputs: { "src/index.ts": {} },
      outputs: {
        "dist/index.js": { imports: [{ path: "react", external: true }] }
      }
    };
    expect(() => validateBuildBoundary(build, "graph-react")).not.toThrow();
    expect(() => validateBuildBoundary(build, "core")).toThrow("react");
  });

  it("bundles the layout engine instead of deferring conditional requires to consumers", () => {
    for (const dependency of ["dagre", "graphlib", "lodash"]) {
      expect(libraryExternalImports("graph-react")).not.toContain(dependency);
    }
    expect(libraryExternalImports("core")).toEqual([]);
    expect(() => libraryExternalImports("other")).toThrow();
  });

  it.each([
    "node_modules/dagre",
    "../../node_modules/.pnpm/graphlib@2.1.8/node_modules/graphlib",
    "..\\..\\node_modules\\lodash"
  ])(
    "tracks bundled layout licenses without admitting them to core: %s",
    (root) => {
      const metafile = { inputs: { [`${root}/index.js`]: {} }, outputs: {} };
      expect([...validateBuildBoundary(metafile, "graph-react")]).toEqual([
        root.replaceAll("\\", "/")
      ]);
      expect(() => validateBuildBoundary(metafile, "core")).toThrow();
    }
  );

  it("accepts internal chunks in the dependency-free core bundle", () => {
    expect(() =>
      validateBuildBoundary(
        {
          inputs: { "src/graph/index.ts": {}, "src\\domain\\index.ts": {} },
          outputs: {
            "dist/graph/index.js": {
              imports: [{ path: "dist/chunk.js", external: false }]
            }
          }
        },
        "core"
      )
    ).not.toThrow();
  });

  it.each([
    "node:fs",
    "@radius-project/adapter-canvas",
    "@github/copilot-sdk",
    "dagre",
    "graphlib",
    "lodash",
    "lodash/cloneDeep"
  ])("rejects a browser bundle importing %s", (path) => {
    expect(() =>
      validateBuildBoundary(
        {
          inputs: { "src/index.ts": {} },
          outputs: {
            "dist/brand.js": { imports: [] },
            "dist/index.js": { imports: [{ path, external: true }] }
          }
        },
        "graph-react"
      )
    ).toThrow(path);
  });

  it.each([
    "node_modules/react/index.js",
    "../adapter-canvas/src/index.ts",
    "src/index.test.ts"
  ])(
    "rejects bundled implementation outside the public library: %s",
    (input) => {
      expect(() =>
        validateBuildBoundary(
          {
            inputs: { [input]: {} },
            outputs: {}
          },
          "graph-react"
        )
      ).toThrow();
    }
  );
});
