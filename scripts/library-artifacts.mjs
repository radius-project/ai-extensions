import assert from "node:assert/strict";

const publicExports = {
  "@radius-project/core": {
    "./graph": "./dist/graph/index",
    "./domain": "./dist/domain/index",
    "./package.json": "./package.json"
  },
  "@radius-project/graph-react": {
    ".": "./dist/index",
    "./brand": "./dist/brand",
    "./base.css": "./dist/base.css",
    "./styles.css": "./dist/styles.css",
    "./package.json": "./package.json"
  }
};

const legacyTypeExports = {
  "@radius-project/core": {
    graph: ["dist/graph/index.d.ts"],
    domain: ["dist/domain/index.d.ts"]
  },
  "@radius-project/graph-react": {
    brand: ["dist/brand.d.ts"]
  }
};

export function validateLibraryManifest(manifest, name, coreVersion) {
  assert.equal(manifest.name, name);
  // Guards against an accidental publish until a publish workflow exists.
  assert.equal(manifest.private, true, `${name} must stay private`);
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.type, "module");
  assert.doesNotMatch(JSON.stringify(manifest), /(?:workspace|catalog):/);
  const expected = publicExports[name];
  assert.ok(expected, `Unknown library: ${name}`);
  assert.deepEqual(manifest.typesVersions, { "*": legacyTypeExports[name] });
  assert.deepEqual(
    Object.keys(manifest.exports).sort(),
    Object.keys(expected).sort()
  );
  for (const [subpath, target] of Object.entries(expected)) {
    if (subpath.endsWith(".css") || subpath === "./package.json") {
      assert.equal(manifest.exports[subpath], target);
    } else {
      assert.deepEqual(manifest.exports[subpath], {
        types: `${target}.d.ts`,
        import: `${target}.js`,
        default: `${target}.js`
      });
    }
  }
  if (name === "@radius-project/graph-react") {
    assert.equal(manifest.dependencies["@radius-project/core"], coreVersion);
    assert.equal(manifest.dependencies.dagre, undefined);
    assert.equal(manifest.dependencies["@xyflow/react"], "12.11.6");
    assert.equal(manifest.dependencies.react, undefined);
    assert.equal(manifest.dependencies["react-dom"], undefined);
    assert.deepEqual(manifest.peerDependencies, {
      react: "^18.3.1 || ^19.2.8",
      "react-dom": "^18.3.1 || ^19.2.8"
    });
    assert.deepEqual(manifest.sideEffects, ["**/*.css"]);
  }
}

export function libraryExternalImports(directory) {
  assert.ok(directory === "core" || directory === "graph-react");
  return directory === "core" ?
      []
    : [
        "react",
        "react-dom/client",
        "@xyflow/react",
        "@radius-project/core/graph",
        "@radius-project/core/domain"
      ];
}

export function validateBuildBoundary(metafile, directory) {
  const allowed = new Set(libraryExternalImports(directory));
  const bundledRoots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const path = input.replaceAll("\\", "/");
    assert.doesNotMatch(path, /adapter-|\.test\.|\.browser\./);
    const vendor = path.match(
      /(?:^|\/)node_modules\/(?:dagre|graphlib|lodash)\//
    );
    if (directory === "graph-react" && vendor) {
      bundledRoots.add(path.slice(0, vendor.index + vendor[0].length - 1));
    } else {
      assert.match(path, /^src\//);
      assert.doesNotMatch(path, /node_modules/);
    }
  }
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external) {
        assert.ok(
          allowed.has(imported.path),
          `Unexpected external import: ${imported.path}`
        );
      }
    }
  }
  return bundledRoots;
}

export function validateStylesheetBoundary(metafile, entry = "styles.css") {
  assert.ok(
    entry === "base.css" || entry === "styles.css",
    `Unknown public stylesheet: ${entry}`
  );
  const allowed = new Set(
    entry === "base.css" ?
      ["src/base.css", "src/flow.css"]
    : ["src/styles.css", "src/base.css", "src/theme.css", "src/flow.css"]
  );
  for (const input of Object.keys(metafile.inputs)) {
    const path = input.replaceAll("\\", "/");
    assert.ok(allowed.has(path), `Unexpected stylesheet input: ${input}`);
  }
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      assert.ok(
        imported.path.startsWith("data:"),
        `Stylesheet must not fetch an external asset: ${imported.path}`
      );
    }
  }
}
