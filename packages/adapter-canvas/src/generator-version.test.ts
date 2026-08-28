import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createGeneratorVersionReader,
  generatorVersionCandidates,
  resolveGeneratorVersion
} from "./generator-version.js";

const MODULE_DIR = path.join("/opt", "extensions", "radius");

function reader(files: Record<string, string>) {
  return (filePath: string): string => {
    const text = files[filePath];
    if (text === undefined) {
      throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
    }
    return text;
  };
}

describe("generatorVersionCandidates", () => {
  it("prefers the installed manifest beside the bundle over the workspace source", () => {
    expect(generatorVersionCandidates(MODULE_DIR)).toEqual([
      path.join(MODULE_DIR, "package.json"),
      path.resolve(MODULE_DIR, "../../../plugins/radius/package.json")
    ]);
  });
});

describe("resolveGeneratorVersion", () => {
  const [installed, source] = generatorVersionCandidates(MODULE_DIR);

  it("reads the installed plugin manifest version", () => {
    expect(
      resolveGeneratorVersion({
        moduleDir: MODULE_DIR,
        readFile: reader({
          [installed]: JSON.stringify({
            name: "radius",
            version: "0.1.0-edge-0b33186"
          })
        })
      })
    ).toBe("0.1.0-edge-0b33186");
  });

  it("falls back to the workspace source manifest when no bundle manifest exists", () => {
    expect(
      resolveGeneratorVersion({
        moduleDir: MODULE_DIR,
        readFile: reader({ [source]: JSON.stringify({ version: "0.0.0" }) })
      })
    ).toBe("0.0.0");
  });

  it("trims surrounding whitespace", () => {
    expect(
      resolveGeneratorVersion({
        moduleDir: MODULE_DIR,
        readFile: reader({
          [installed]: JSON.stringify({ version: " 1.2.3 " })
        })
      })
    ).toBe("1.2.3");
  });

  it.each([
    ["malformed JSON", "{ not json"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"0.1.0"'],
    ["a manifest with no version", JSON.stringify({ name: "radius" })],
    ["a non-string version", JSON.stringify({ version: 3 })],
    ["a blank version", JSON.stringify({ version: "   " })]
  ])("skips %s and continues to the next candidate", (_label, text) => {
    expect(
      resolveGeneratorVersion({
        moduleDir: MODULE_DIR,
        readFile: reader({
          [installed]: text,
          [source]: JSON.stringify({ version: "2.0.0" })
        })
      })
    ).toBe("2.0.0");
  });

  it("reports an unknown version rather than guessing when nothing is readable", () => {
    expect(
      resolveGeneratorVersion({ moduleDir: MODULE_DIR, readFile: reader({}) })
    ).toBe("");
  });
});

describe("createGeneratorVersionReader", () => {
  const [installed] = generatorVersionCandidates(MODULE_DIR);

  it("resolves this build's own manifest version", () => {
    // Not asserted against a literal: Changesets owns plugins/radius/package.json
    // and bumps it on release, so pinning the number here would fail on the
    // first one. The behavior under test is that the reader agrees with a direct
    // resolve and returns something usable.
    const version = createGeneratorVersionReader()();

    expect(version).toBe(resolveGeneratorVersion());
    expect(version).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("reads the manifest once and reuses the answer", () => {
    const readFile = vi.fn(
      reader({ [installed]: JSON.stringify({ version: "1.2.3" }) })
    );
    const read = createGeneratorVersionReader({
      moduleDir: MODULE_DIR,
      readFile
    });

    expect(read()).toBe("1.2.3");
    expect(read()).toBe("1.2.3");
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("keeps each reader's memo to itself", () => {
    const first = createGeneratorVersionReader({
      moduleDir: MODULE_DIR,
      readFile: reader({ [installed]: JSON.stringify({ version: "1.0.0" }) })
    });
    const second = createGeneratorVersionReader({
      moduleDir: MODULE_DIR,
      readFile: reader({ [installed]: JSON.stringify({ version: "2.0.0" }) })
    });

    expect(first()).toBe("1.0.0");
    expect(second()).toBe("2.0.0");
  });
});
