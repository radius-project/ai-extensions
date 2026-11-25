import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  pluginVersionCandidates,
  resolvePluginVersion
} from "./plugin-version.js";

const PLUGIN_ROOT = path.join("/opt", "radius");
const MODULE_DIR = path.join(
  PLUGIN_ROOT,
  "com.github.copilot",
  "extensions",
  "radius"
);

function reader(files: Record<string, string>) {
  return (filePath: string): string => {
    const text = files[filePath];
    if (text === undefined) {
      throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
    }
    return text;
  };
}

describe("pluginVersionCandidates", () => {
  it("prefers the installed plugin manifest over the workspace source", () => {
    expect(pluginVersionCandidates(MODULE_DIR)).toEqual([
      path.join(PLUGIN_ROOT, "package.json"),
      path.resolve(MODULE_DIR, "../../../extensions/radius/package.json")
    ]);
  });
});

describe("resolvePluginVersion", () => {
  const [installed, source] = pluginVersionCandidates(MODULE_DIR);

  it("reads the installed plugin manifest version", () => {
    expect(
      resolvePluginVersion({
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
      resolvePluginVersion({
        moduleDir: MODULE_DIR,
        readFile: reader({ [source]: JSON.stringify({ version: "0.0.0" }) })
      })
    ).toBe("0.0.0");
  });

  it("trims surrounding whitespace", () => {
    expect(
      resolvePluginVersion({
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
      resolvePluginVersion({
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
      resolvePluginVersion({ moduleDir: MODULE_DIR, readFile: reader({}) })
    ).toBe("");
  });
});

describe("this build", () => {
  it("resolves its own manifest version", () => {
    // Not asserted against a literal: Changesets owns extensions/radius/package.json
    // and bumps it on release, so pinning the number here would fail on the
    // first one.
    expect(resolvePluginVersion()).toMatch(/^\d+\.\d+\.\d+/u);
  });
});
