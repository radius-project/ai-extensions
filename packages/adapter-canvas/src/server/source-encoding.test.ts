import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Several server responses carry non-ASCII bytes that the user actually sees:
// the OIDC setup output is built from U+2705, U+274C and U+26A0 status glyphs,
// and many comments use em dashes. Those bytes are observable output, not
// decoration, so a mangled re-encode is a behavior change.
//
// This is not hypothetical. During slice 3d-i a PowerShell rewrite of a source
// file round-tripped it through cp1252 and committed a BOM plus 246 mojibake
// characters. Nothing caught it: the corruption sat in comments, so tsc, eslint,
// prettier and the whole suite stayed green. These assertions turn that class of
// corruption into a failing gate instead of a silent commit.
//
// The glyph pins below also cover a second, quieter failure mode: writing a file
// as ASCII silently transliterates every non-ASCII character to "?", which
// leaves no BOM, no U+FFFD and no mojibake for the scans above to find.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCANNED_DIRS = ["src", "test", "plugins"];

function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|js|mjs|json|md|css|html)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

const sourceFiles = SCANNED_DIRS.flatMap((d) => {
  const full = join(ROOT, d);
  try {
    return collectSourceFiles(full);
  } catch {
    return [];
  }
});

describe("source file encoding integrity", () => {
  it("scans a non-trivial number of files", () => {
    expect(sourceFiles.length).toBeGreaterThan(50);
  });

  it("writes every source file as UTF-8 with no byte order mark", () => {
    const withBom = sourceFiles.filter((file) => {
      const bytes = readFileSync(file);
      return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    });
    expect(withBom.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  it("decodes every source file without replacement characters", () => {
    // U+FFFD means the bytes were not valid UTF-8 and information was lost.
    const damaged = sourceFiles.filter((file) =>
      readFileSync(file, "utf8").includes("\uFFFD")
    );
    expect(damaged.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  it("contains no cp1252 mojibake sequences", () => {
    // A UTF-8 file decoded as cp1252 and re-encoded turns every multi-byte
    // character into a run starting with U+00C2/U+00C3/U+00E2. Real prose in
    // this repo never produces those pairs.
    const mojibake = /[\u00C2\u00C3\u00E2][\u0080-\u00BF\u2013-\u2122]/;
    const damaged = sourceFiles.filter((file) =>
      mojibake.test(readFileSync(file, "utf8"))
    );
    expect(damaged.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });
});

describe("server response glyphs", () => {
  const serverSources = [
    join(ROOT, "src", "server.ts"),
    ...collectSourceFiles(join(ROOT, "src", "server")).filter(
      (file) => !file.endsWith(".test.ts")
    )
  ]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  // Pinned by code point rather than by pasting the glyph, so this assertion
  // still means something if the test file itself is ever re-encoded.
  // The code point is carried as its own label so a failure names the missing
  // character rather than printing the (possibly mangled) glyph back at you.
  it.each([
    ["check mark", "2705", "\u2705"],
    ["cross mark", "274C", "\u274C"],
    ["warning sign", "26A0", "\u26A0"],
    ["rightwards arrow", "2192", "\u2192"]
  ])("still emits the %s (U+%s) verbatim", (_label, _codePoint, glyph) => {
    expect(serverSources).toContain(glyph);
  });

  it("emits no replacement characters or mojibake in server output", () => {
    expect(serverSources).not.toContain("\uFFFD");
    expect(serverSources).not.toMatch(/[\u00C2\u00C3\u00E2][\u0080-\u00BF]/);
  });
});
