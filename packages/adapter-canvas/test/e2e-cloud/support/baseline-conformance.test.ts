import { describe, expect, it } from "vitest";
import { REQUIRED_STAGED_FILES } from "@radius-project/core/modeling";
import {
  assertBaselineConformance,
  compileBaselineWorkspace,
  evaluateBaselineConformance,
  type BaselineCompileResult,
  type BaselineConformancePorts
} from "./baseline-conformance.js";
import path from "node:path";

const ALL_FILES = [...REQUIRED_STAGED_FILES];

function ports(overrides: {
  files?: readonly string[];
  listError?: Error;
  compile?: BaselineCompileResult;
  compileError?: Error;
}): BaselineConformancePorts {
  return {
    listBaselineFiles: () =>
      overrides.listError ?
        Promise.reject(overrides.listError)
      : Promise.resolve(overrides.files ?? ALL_FILES),
    compileBaseline: () => {
      if (overrides.compileError) return Promise.reject(overrides.compileError);
      if (!overrides.compile)
        return Promise.reject(
          new Error(
            "compileBaseline was called by a scenario that did not model it."
          )
        );
      return Promise.resolve(overrides.compile);
    }
  };
}

describe("evaluateBaselineConformance", () => {
  it("accepts a baseline carrying every required file and compiling cleanly", async () => {
    const result = await evaluateBaselineConformance(
      ports({ compile: { ok: true, diagnostics: [] } })
    );

    expect(result).toEqual({
      ok: true,
      missingFiles: [],
      compiled: true,
      diagnostics: [],
      summary: ""
    });
  });

  it("requires exactly the set the product stages, with no local restatement", async () => {
    // Pins the coupling itself: if `REQUIRED_STAGED_FILES` grows a member, this
    // check must start demanding it of the fixture repository rather than
    // silently continuing to accept the old set.
    expect(ALL_FILES).toEqual([
      "app.bicep",
      "bicepconfig.json",
      "app.origin.json"
    ]);

    const result = await evaluateBaselineConformance(ports({ files: [] }));
    expect(result.missingFiles).toEqual(ALL_FILES);
  });

  it("accepts a compile that succeeds with warnings, and keeps them visible", async () => {
    const result = await evaluateBaselineConformance(
      ports({
        compile: {
          ok: true,
          diagnostics: ["Warning BCP081: unrecognized type"]
        }
      })
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual(["Warning BCP081: unrecognized type"]);
    expect(result.summary).toBe("");
  });

  it("ignores extra files the baseline happens to carry", async () => {
    const result = await evaluateBaselineConformance(
      ports({
        files: [...ALL_FILES, "custom-types.yaml", "README.md"],
        compile: { ok: true, diagnostics: [] }
      })
    );

    expect(result.ok).toBe(true);
  });

  it.each(ALL_FILES)("reports %s when it alone is missing", async (missing) => {
    const result = await evaluateBaselineConformance(
      ports({ files: ALL_FILES.filter((file) => file !== missing) })
    );

    expect(result.ok).toBe(false);
    expect(result.missingFiles).toEqual([missing]);
    expect(result.summary).toContain(
      `missing 1 required staged file(s): ${missing}`
    );
  });

  it("reports every missing file when the baseline is empty", async () => {
    const result = await evaluateBaselineConformance(ports({ files: [] }));

    expect(result.missingFiles).toEqual(ALL_FILES);
    expect(result.summary).toContain(
      `missing 3 required staged file(s): ${ALL_FILES.join(", ")}`
    );
  });

  it("does not attempt to compile a baseline that is missing app.bicep", async () => {
    // The unmodelled `compileBaseline` in this fixture rejects, so reaching a
    // resolved result is itself the proof that it was never called.
    const result = await evaluateBaselineConformance(
      ports({ files: ["bicepconfig.json", "app.origin.json"] })
    );

    expect(result.compiled).toBe(false);
    expect(result.summary).toContain("Compilation was not attempted.");
  });

  it("reports a compile failure with its diagnostics", async () => {
    const result = await evaluateBaselineConformance(
      ports({
        compile: {
          ok: false,
          diagnostics: [
            'BCP204: Extension "radius" is not recognized.',
            "BCP007: This declaration type is not recognized."
          ]
        }
      })
    );

    expect(result.ok).toBe(false);
    expect(result.compiled).toBe(false);
    expect(result.missingFiles).toEqual([]);
    expect(result.summary).toContain("no longer compiles");
    expect(result.summary).toContain(
      '  BCP204: Extension "radius" is not recognized.'
    );
    expect(result.summary).toContain(
      "  BCP007: This declaration type is not recognized."
    );
  });

  it("still explains a compile failure that produced no diagnostics", async () => {
    const result = await evaluateBaselineConformance(
      ports({ compile: { ok: false, diagnostics: [] } })
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("(the compiler reported no diagnostics)");
  });

  it("propagates a failure to list the baseline rather than reporting files missing", async () => {
    await expect(
      evaluateBaselineConformance(
        ports({ listError: new Error("HTTP 404: tree not found") })
      )
    ).rejects.toThrow("HTTP 404: tree not found");
  });

  it("propagates a compiler that could not be run", async () => {
    await expect(
      evaluateBaselineConformance(
        ports({ compileError: new Error("bicep binary is not installed") })
      )
    ).rejects.toThrow("bicep binary is not installed");
  });
});

describe("assertBaselineConformance", () => {
  it("returns the result when the baseline conforms", async () => {
    await expect(
      assertBaselineConformance(
        ports({ compile: { ok: true, diagnostics: [] } })
      )
    ).resolves.toMatchObject({ ok: true, compiled: true });
  });

  describe("compileBaselineWorkspace", () => {
    it("compiles with the committed Radius artifacts directory", async () => {
      const calls: Array<{
        definitionFile: string;
        radArtifactsDir: string;
      }> = [];

      await expect(
        compileBaselineWorkspace("/tmp/fixture", ".radius", {
          readTextFile: (file) => {
            expect(file).toBe(
              path.join("/tmp/fixture", ".radius", "app.bicep")
            );
            return Promise.resolve("extension radius");
          },
          buildGraph: (_content, definitionFile, options) => {
            options.log("compiled with repository config");
            calls.push({
              definitionFile,
              radArtifactsDir: options.radArtifactsDir
            });
            return Promise.resolve([{ type: "Applications.Core/containers" }]);
          }
        })
      ).resolves.toEqual({
        ok: true,
        diagnostics: ["compiled with repository config"]
      });

      expect(calls).toEqual([
        {
          definitionFile: ".radius/app.bicep",
          radArtifactsDir: path.join("/tmp/fixture", ".radius")
        }
      ]);
    });

    it("normalizes Windows separators in the graph definition path", async () => {
      const definitions: string[] = [];

      await compileBaselineWorkspace("C:\\fixture", ".radius\\nested", {
        readTextFile: () => Promise.resolve("extension radius"),
        buildGraph: (_content, definitionFile) => {
          definitions.push(definitionFile);
          return Promise.resolve([{}]);
        }
      });

      expect(definitions).toEqual([".radius/nested/app.bicep"]);
    });

    it("reports an unreadable application file", async () => {
      await expect(
        compileBaselineWorkspace("/tmp/fixture", ".radius", {
          readTextFile: () => Promise.reject(new Error("EACCES")),
          buildGraph: () =>
            Promise.reject(new Error("buildGraph must not be called"))
        })
      ).resolves.toEqual({ ok: false, diagnostics: ["EACCES"] });
    });

    it("reports compiler diagnostics and a thrown failure", async () => {
      await expect(
        compileBaselineWorkspace("/tmp/fixture", ".radius", {
          readTextFile: () => Promise.resolve("extension radius"),
          buildGraph: (_content, _definitionFile, options) => {
            options.log("BCP081");
            return Promise.reject("compile failed");
          }
        })
      ).resolves.toEqual({
        ok: false,
        diagnostics: ["BCP081", "compile failed"]
      });
    });

    it("rejects a baseline that compiles to no visible resources", async () => {
      await expect(
        compileBaselineWorkspace("/tmp/fixture", ".radius", {
          readTextFile: () => Promise.resolve("extension radius"),
          buildGraph: () => Promise.resolve([])
        })
      ).resolves.toEqual({
        ok: false,
        diagnostics: ["The baseline compiled to no resources."]
      });
    });
  });

  it("throws the summary when a required file is missing", async () => {
    await expect(
      assertBaselineConformance(ports({ files: ["app.bicep"] }))
    ).rejects.toThrow(
      /missing 2 required staged file\(s\): bicepconfig\.json, app\.origin\.json/
    );
  });

  it("throws the summary when the baseline no longer compiles", async () => {
    await expect(
      assertBaselineConformance(
        ports({ compile: { ok: false, diagnostics: ["BCP204"] } })
      )
    ).rejects.toThrow(/no longer compiles:\n {2}BCP204/);
  });
});
