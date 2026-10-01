import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./plugins.mjs";

export const scopedFlowStylesPath = join(
  repoRoot,
  "packages",
  "graph-react",
  "src",
  "flow.css"
);

// Renames a vendor keyframe so a scoped copy of the stylesheet cannot capture
// the identically named animation a host defines for its own graph. A plain
// string replacement would silently rewrite comments, URLs, and unrelated
// identifiers, so every occurrence must first be a declaration or an animation
// reference. A vendor update that introduces any other use fails review here
// instead of producing a plausible but wrong generated asset.
export function renameKeyframes(css, from, to) {
  const count = (pattern) => (css.match(pattern) ?? []).length;
  const declarations = count(
    new RegExp(`@(?:-webkit-)?keyframes\\s+${from}\\b`, "g")
  );
  const references = count(new RegExp(`animation:[^;{}]*\\b${from}\\b`, "g"));
  assert.ok(declarations > 0, `Expected a ${from} keyframes declaration`);
  assert.ok(references > 0, `Expected a ${from} animation reference`);
  assert.equal(
    count(new RegExp(`\\b${from}\\b`, "g")),
    declarations + references,
    `Unreviewed ${from} occurrence outside a keyframes declaration or animation`
  );
  return css.replaceAll(from, to);
}

// `@scope` accepts only style rules and conditional group rules, so a browser
// drops a keyframes declaration nested inside it. The prefixed declarations are
// moved after the scope, where they stay global without restyling the host.
export function hoistKeyframes(css) {
  const keyframes = [];
  let rules = "";
  let index = 0;
  for (const match of css.matchAll(/@(?:-webkit-)?keyframes\b[^{]*\{/g)) {
    let end = match.index + match[0].length;
    for (let depth = 1; depth > 0; end++) {
      assert.ok(end < css.length, "Unterminated keyframes declaration");
      if (css[end] === "{") depth++;
      else if (css[end] === "}") depth--;
    }
    rules += css.slice(index, match.index);
    keyframes.push(css.slice(match.index, end));
    index = end;
  }
  return { rules: rules + css.slice(index), keyframes };
}

export function scopeFlowStyles(css, license) {
  assert.doesNotMatch(css, /@(?:import|font-face)\b/);
  const { rules, keyframes } = hoistKeyframes(
    renameKeyframes(css.trim(), "dashdraw", "radius-graph-dashdraw")
  );
  return `/*!
Generated from @xyflow/react@12.11.6 by scripts/graph-vendor-styles.mjs.
Do not edit: regenerate after reviewing a vendor update.

${license.trim()}
*/
@scope (.radius-graph) {
${rules.trim()}
}
${keyframes.join("\n")}
`;
}

export function expectedScopedFlowStyles() {
  const fromGraph = createRequire(
    join(repoRoot, "packages", "graph-react", "package.json")
  );
  const cssPath = fromGraph.resolve("@xyflow/react/dist/style.css");
  const root = resolve(dirname(cssPath), "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.version, "12.11.6");
  return scopeFlowStyles(
    readFileSync(cssPath, "utf8"),
    readFileSync(join(root, "LICENSE"), "utf8")
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const expected = expectedScopedFlowStyles();
  if (process.argv[2] === "--check") {
    assert.equal(readFileSync(scopedFlowStylesPath, "utf8"), expected);
  } else {
    assert.equal(process.argv.length, 2, "Use no arguments or --check.");
    writeFileSync(scopedFlowStylesPath, expected);
  }
}
