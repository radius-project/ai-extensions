import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isMainModule } from "../../../../scripts/module-entry.mjs";

const temporaryDirectories = [];

function makeDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "radius-module-entry-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
  }
});

describe("isMainModule", () => {
  // macOS reports os.tmpdir() under /var but ESM resolves the same file's
  // module URL through /private/var, so the two spellings must compare equal.
  it("matches paths that differ only by a canonicalized prefix", () => {
    const lexical = join(tmpdir(), "alias", "script.mjs");
    const canonical = join(tmpdir(), "canonical", "script.mjs");
    const canonicalize = (candidate) =>
      candidate === lexical || candidate === canonical ? canonical : candidate;

    expect(isMainModule(lexical, pathToFileURL(canonical), canonicalize)).toBe(
      true
    );
  });

  it("rejects a different file that canonicalizes elsewhere", () => {
    const canonical = join(tmpdir(), "canonical", "script.mjs");
    expect(
      isMainModule(
        join(tmpdir(), "other", "script.mjs"),
        pathToFileURL(canonical),
        (candidate) => candidate
      )
    ).toBe(false);
  });

  it.each([
    ["absent", undefined],
    ["empty", ""]
  ])("reports %s argv paths as not the entry point", (_label, argvPath) => {
    const canonical = join(tmpdir(), "canonical", "script.mjs");
    expect(
      isMainModule(argvPath, pathToFileURL(canonical), (candidate) => candidate)
    ).toBe(false);
  });

  // realpathSync throws ENOENT for a path that does not exist. Importing a
  // script must not fail because of an argv[1] the script never owned, so an
  // unresolvable path falls back to its literal value and simply mismatches.
  it("falls back to the literal path when canonicalization throws", () => {
    const missing = join(tmpdir(), "definitely-absent", "script.mjs");
    const moduleUrl = pathToFileURL(join(tmpdir(), "real", "script.mjs"));

    expect(() =>
      isMainModule(missing, moduleUrl, () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      })
    ).not.toThrow();
    expect(
      isMainModule(missing, moduleUrl, () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      })
    ).toBe(false);
  });

  it("still matches when both sides fail to canonicalize identically", () => {
    const same = join(tmpdir(), "absent", "script.mjs");
    expect(
      isMainModule(same, pathToFileURL(same), () => {
        throw new Error("unresolvable");
      })
    ).toBe(true);
  });

  // The default canonicalizer is realpathSync. Exercise it against a real
  // symlink so the production path is covered, not only the injected stub.
  it("resolves a real symlink with the default canonicalizer", (context) => {
    const directory = makeDirectory();
    const target = join(directory, "script.mjs");
    const link = join(directory, "link.mjs");
    writeFileSync(target, "export default 1;\n");
    try {
      symlinkSync(target, link);
    } catch {
      // Windows refuses symlink creation without Developer Mode or elevation.
      context.skip();
      return;
    }

    expect(isMainModule(link, pathToFileURL(target))).toBe(true);
    expect(isMainModule(target, pathToFileURL(target))).toBe(true);
  });

  it("does not throw for a missing path with the default canonicalizer", () => {
    const directory = makeDirectory();
    const target = join(directory, "script.mjs");
    writeFileSync(target, "export default 1;\n");

    expect(
      isMainModule(join(directory, "absent.mjs"), pathToFileURL(target))
    ).toBe(false);
  });
});
