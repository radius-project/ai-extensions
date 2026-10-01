import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";

export const HEADLAMP_IMAGE =
  "ghcr.io/headlamp-k8s/headlamp:v0.45.0@sha256:db3f0e0fc58d358d41daa3fe7fc852437552c7ee873c3645470f7b86a8e0db49";
export const HEADLAMP_GRAPHVIEW_CSS = "GraphView-Cdd0UtY8.css";
export const TOOL_VERSIONS = {
  "@kinvolk/headlamp-plugin": "0.14.0",
  react: "18.3.1",
  "react-dom": "18.3.1",
  "@types/react": "18.3.28",
  "@types/react-dom": "18.3.7",
  "@xyflow/react": "12.11.6",
  typescript: "5.6.2"
};

export function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function containedPath(root, path) {
  const difference = relative(root, path);
  assert.ok(
    difference !== "" &&
      !difference.startsWith("..") &&
      !isAbsolute(difference),
    `Qualification path must be inside the repository: ${path}`
  );
  return path;
}

export function withoutCandidateStyles(source) {
  const statement = 'import "@radius-project/graph-react/styles.css";';
  assert.equal(
    source.split(statement).length,
    2,
    "Expected one candidate CSS import"
  );
  return source.replace(statement, "");
}

export function validateTarEntries(entries, types = entries.map(() => "File")) {
  assert.ok(entries.length > 0, "Candidate tarball must not be empty");
  assert.equal(
    types.length,
    entries.length,
    "Every tar entry must have a type"
  );
  for (const [index, entry] of entries.entries()) {
    assert.ok(
      types[index] === "File" || types[index] === "Directory",
      `Candidate tarball must not contain links or devices: ${entry}`
    );
    assert.ok(
      entry.startsWith("package/") &&
        !entry.includes("\\") &&
        !entry.split("/").includes(".."),
      `Unsafe candidate tarball entry: ${entry}`
    );
  }
}

export function validatePeerStyles(before, after) {
  assert.deepEqual(
    after,
    before,
    "Radius CSS changed the real Headlamp Flow 12 controls"
  );
}

export function styleChanges(before, after) {
  assert.deepEqual(
    Object.keys(after),
    Object.keys(before),
    "Style sample selectors must match"
  );
  const changes = [];
  for (const selector of Object.keys(before)) {
    assert.equal(
      after[selector].length,
      before[selector].length,
      "Style sample element counts must match"
    );
    for (const [index, properties] of before[selector].entries()) {
      assert.deepEqual(
        Object.keys(after[selector][index]),
        Object.keys(properties),
        "Style sample properties must match"
      );
      for (const property of Object.keys(properties)) {
        if (properties[property] !== after[selector][index][property]) {
          changes.push({
            selector,
            index,
            property,
            before: properties[property],
            after: after[selector][index][property]
          });
        }
      }
    }
  }
  return changes;
}

// The layout engine must travel inside the candidate. Headlamp exposes lodash
// only as `pluginLib.Lodash`, so a candidate that expects a host-resolved
// `dagre` or `graphlib` fails at plugin initialization. The fixture therefore
// installs neither, and this rejects a regression that quietly depends on a
// consumer-provided copy instead of the bundled one.
export function validateBundledLayout(resolve, dependencies = {}) {
  for (const name of ["dagre", "graphlib", "lodash"])
    assert.equal(
      dependencies[name],
      undefined,
      `The candidate must bundle ${name} rather than declare it as a dependency`
    );
  for (const name of ["dagre", "graphlib"])
    assert.throws(
      () => resolve(name),
      /Cannot find module/,
      `The candidate must bundle ${name} instead of resolving a host copy`
    );
}

// `validatePeerStyles` covers the control buttons that actually regressed.
// This widens the same guarantee to every sampled host graph element and
// property, so the qualification asserts the broad audit instead of only
// recording it.
export function validateHostSample(before, after, when) {
  const changes = styleChanges(before, after);
  assert.deepEqual(
    changes,
    [],
    `Radius CSS ${when} the host changed the real Headlamp Flow 12 graph: ${JSON.stringify(changes)}`
  );
}

export function validateCardGeometry(cards) {
  assert.equal(cards.length, 2, "The real Radius renderer must show two nodes");
  for (const card of cards) {
    assert.equal(
      card.cssWidth,
      "220px",
      "Candidate CSS must supply the 220px graph card geometry"
    );
    assert.ok(
      [
        card.left,
        card.right,
        card.top,
        card.bottom,
        card.width,
        card.height
      ].every(Number.isFinite),
      "Graph geometry must be finite"
    );
    assert.ok(
      card.width > 100 && card.height > 50,
      "Graph cards must be visible"
    );
  }
  const [first, second] = cards;
  assert.ok(
    first.right <= second.left ||
      second.right <= first.left ||
      first.bottom <= second.top ||
      second.bottom <= first.top,
    "Graph cards must not overlap"
  );
}
