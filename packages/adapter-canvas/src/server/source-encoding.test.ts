import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

const ROOT = join(__dirname, "..", "..");
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

describe("server.ts response glyphs", () => {
  const server = readFileSync(join(ROOT, "src", "server.ts"), "utf8");

  // Pinned by code point rather than by pasting the glyph, so this assertion
  // still means something if the test file itself is ever re-encoded.
  it.each([
    ["check mark", "\u2705"],
    ["cross mark", "\u274C"],
    ["warning sign", "\u26A0"],
    ["rightwards arrow", "\u2192"]
  ])("still emits the %s (U+%s) verbatim", (_label, glyph) => {
    expect(server).toContain(glyph);
  });

  it("emits no replacement characters or mojibake in server output", () => {
    expect(server).not.toContain("\uFFFD");
    expect(server).not.toMatch(/[\u00C2\u00C3\u00E2][\u0080-\u00BF]/);
  });
});
