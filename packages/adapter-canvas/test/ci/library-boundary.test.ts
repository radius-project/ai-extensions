import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const builtins = new Set(
  builtinModules.map((name) => name.replace(/^node:/, ""))
);

function libraryBoundary(): Plugin {
  return {
    name: "github-radius-library-boundary",
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        const importer = args.importer.replaceAll("\\", "/");
        const specifier = args.path.replaceAll("\\", "/");
        const coreImport = importer.includes("/packages/core/");
        const canvasImport =
          /(^|\/)(?:@radius-project\/)?adapter-canvas(?:\/|$)/.test(specifier);
        const sdkImport = /^@github\/copilot-sdk(?:\/|$)/.test(specifier);
        const adapterImport =
          coreImport &&
          /(^|\/)(?:@radius-project\/)?adapter-shared(?:\/|$)/.test(specifier);
        const executionImport =
          coreImport &&
          (builtins.has(specifier.replace(/^node:/, "")) ||
            ["undici", "node-fetch"].includes(specifier));
        if (canvasImport || sdkImport || adapterImport || executionImport) {
          return {
            errors: [
              {
                text: `Library boundary violation: ${args.importer} imports ${args.path}`
              }
            ]
          };
        }
        return undefined;
      });
      builder.onLoad(
        { filter: /[/\\]packages[/\\]adapter-canvas[/\\]src[/\\]/ },
        (args) => ({
          errors: [
            {
              text: `Library boundary violation: resolved Canvas source ${args.path}`
            }
          ]
        })
      );
    }
  };
}

async function bundleFixture(files: Readonly<Record<string, string>>) {
  const fixture: Plugin = {
    name: "library-boundary-fixture",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/|^\// }, (args) => ({
        path: path.posix.resolve(
          path.posix.dirname(args.importer || "/"),
          args.path
        ),
        namespace: "fixture"
      }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => {
        const contents = files[args.path];
        return contents === undefined ?
            { errors: [{ text: `Unspecified fixture source: ${args.path}` }] }
          : { contents, loader: "ts" };
      });
    }
  };
  return build({
    entryPoints: ["/packages/core/entry.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
    plugins: [libraryBoundary(), fixture]
  });
}

describe("GitHub Radius library import boundary", () => {
  it("bundles the public library without a Canvas or SDK dependency", async () => {
    const result = await build({
      absWorkingDir: repoRoot,
      entryPoints: ["packages/core/src/github-radius/index.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      metafile: true,
      logLevel: "silent",
      plugins: [libraryBoundary()]
    });
    expect(result.outputFiles).toHaveLength(1);
    expect(Object.keys(result.metafile.inputs)).toContain(
      "packages/core/src/github-radius/index.ts"
    );
    expect(result.outputFiles[0]?.text).toContain("resolveDeploymentRepair");
  });

  it("accepts a pure transitive dependency", async () => {
    const result = await bundleFixture({
      "/packages/core/entry.ts": 'export { value } from "./helper.ts";',
      "/packages/core/helper.ts": "export const value = 42;"
    });
    expect(result.outputFiles[0]?.text).toContain("42");
  });

  it.each([
    "@radius-project/adapter-canvas",
    "@radius-project/adapter-canvas/private",
    "@radius-project/adapter-shared",
    "@github/copilot-sdk",
    "@github/copilot-sdk/extension",
    "node:fs",
    "fs/promises",
    "path/posix",
    "stream/promises",
    "timers/promises",
    "https",
    "undici"
  ])("rejects a forbidden import hidden in a helper: %s", async (specifier) => {
    await expect(
      bundleFixture({
        "/packages/core/entry.ts": 'export { value } from "./helper.ts";',
        "/packages/core/helper.ts": `import * as dependency from ${JSON.stringify(specifier)}; export const value = dependency;`
      })
    ).rejects.toThrow("Library boundary violation");
  });

  it("rejects a dynamic import hidden in a helper", async () => {
    await expect(
      bundleFixture({
        "/packages/core/entry.ts": 'export { value } from "./helper.ts";',
        "/packages/core/helper.ts":
          'export const value = () => import("@github/copilot-sdk");'
      })
    ).rejects.toThrow("Library boundary violation");
  });

  it("rejects Canvas source reached through an absolute path", async () => {
    await expect(
      bundleFixture({
        "/packages/core/entry.ts":
          'export { value } from "/packages/adapter-canvas/src/internal.ts";',
        "/packages/adapter-canvas/src/internal.ts": "export const value = 1;"
      })
    ).rejects.toThrow("Library boundary violation");
  });
});
