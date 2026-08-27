import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const VERSION_SCRIPT = fileURLToPath(
  new URL("../../../../scripts/version.mjs", import.meta.url)
);

const MANIFEST = ".github/plugin/marketplace.json";
const PLUGIN_MANIFEST = "plugins/radius/plugin.json";
const SOURCE_OF_TRUTH = "plugins/radius/package.json";

const RELEASED = "0.4.0";
const SNAPSHOT = "0.5.0-edge-20260824000000";

const temporaryRepositories = [];

const objectSource = (ref) => ({
  source: "github",
  repo: "radius-project/ai-extensions",
  path: "plugins/radius/dist",
  ref
});

const catalogEntry = (source, name = "radius") => ({
  name,
  source,
  description: "Model, visualize, and deploy applications with Radius.",
  version: RELEASED,
  repository: "https://github.com/radius-project/ai-extensions",
  license: "Apache-2.0",
  keywords: ["radius", "canvas"]
});

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRepository(plugins) {
  const root = mkdtempSync(join(tmpdir(), "radius-version-"));
  temporaryRepositories.push(root);

  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "plugins", "radius"), { recursive: true });
  mkdirSync(join(root, ".github", "plugin"), { recursive: true });

  // The script resolves the repository from its own location, so publishing
  // against a fixture means copying it rather than running it in place.
  copyFileSync(VERSION_SCRIPT, join(root, "scripts", "version.mjs"));

  writeJson(join(root, SOURCE_OF_TRUTH), {
    name: "radius",
    version: RELEASED,
    private: true
  });
  writeJson(join(root, PLUGIN_MANIFEST), {
    name: "radius",
    version: RELEASED,
    skills: "./skills/",
    extensions: "."
  });
  writeJson(join(root, MANIFEST), {
    name: "radius-plugins",
    metadata: { description: "Radius plugins.", version: RELEASED },
    plugins
  });

  return root;
}

function readJson(root, file) {
  return JSON.parse(readFileSync(join(root, file), "utf8"));
}

function runVersion(root, ...args) {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [join(root, "scripts", "version.mjs"), ...args],
    { cwd: root, encoding: "utf8" }
  );
  return { status, stdout: stdout.trim(), stderr };
}

afterEach(() => {
  while (temporaryRepositories.length > 0) {
    rmSync(temporaryRepositories.pop(), { recursive: true, force: true });
  }
});

describe("scripts/version.mjs --set --channel edge", () => {
  it("stamps the snapshot version and pins the catalog at the edge ref", () => {
    const root = writeRepository([catalogEntry(objectSource("edge"))]);

    const result = runVersion(root, "--set", SNAPSHOT, "--channel", "edge");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(SNAPSHOT);

    const catalog = readJson(root, MANIFEST);
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0].name).toBe("radius");
    expect(catalog.plugins[0].version).toBe(SNAPSHOT);
    expect(catalog.plugins[0].source.ref).toBe("edge");
  });

  it("retargets a catalog whose default channel has switched to latest", () => {
    const root = writeRepository([catalogEntry(objectSource("latest"))]);

    expect(
      runVersion(root, "--set", SNAPSHOT, "--channel", "edge").status
    ).toBe(0);

    const catalog = readJson(root, MANIFEST);
    expect(catalog.plugins[0].source.ref).toBe("edge");
    expect(catalog.plugins[0].version).toBe(SNAPSHOT);
  });

  it("leaves the plugin manifest, source of truth and catalog metadata alone", () => {
    const root = writeRepository([catalogEntry(objectSource("edge"))]);

    expect(
      runVersion(root, "--set", SNAPSHOT, "--channel", "edge").status
    ).toBe(0);

    expect(readJson(root, SOURCE_OF_TRUTH).version).toBe(RELEASED);
    expect(readJson(root, PLUGIN_MANIFEST).version).toBe(RELEASED);
    expect(readJson(root, MANIFEST).metadata.version).toBe(RELEASED);
  });

  it("preserves the rest of the catalog entry", () => {
    const root = writeRepository([catalogEntry(objectSource("edge"))]);

    expect(
      runVersion(root, "--set", SNAPSHOT, "--channel", "edge").status
    ).toBe(0);

    const entry = readJson(root, MANIFEST).plugins[0];
    expect(entry.source).toEqual(objectSource("edge"));
    expect(entry.keywords).toEqual(["radius", "canvas"]);
    expect(entry.license).toBe("Apache-2.0");
  });

  it("reports the written file on stderr so stdout stays the version", () => {
    const root = writeRepository([catalogEntry(objectSource("edge"))]);

    const result = runVersion(root, "--set", SNAPSHOT, "--channel", "edge");

    expect(result.stdout).toBe(SNAPSHOT);
    expect(result.stderr).toContain(`updated ${MANIFEST} -> ${SNAPSHOT}`);
  });
});

describe("scripts/version.mjs --set (stable)", () => {
  it("derives every version without retargeting the catalog ref", () => {
    const root = writeRepository([catalogEntry(objectSource("latest"))]);

    const result = runVersion(root, "--set", "0.5.0");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.5.0");
    expect(readJson(root, SOURCE_OF_TRUTH).version).toBe("0.5.0");
    expect(readJson(root, PLUGIN_MANIFEST).version).toBe("0.5.0");

    const catalog = readJson(root, MANIFEST);
    expect(catalog.metadata.version).toBe("0.5.0");
    expect(catalog.plugins[0].version).toBe("0.5.0");
    expect(catalog.plugins[0].source.ref).toBe("latest");
  });
});

describe("scripts/version.mjs rejects a catalog it cannot publish", () => {
  it("fails when the radius entry is missing", () => {
    const root = writeRepository([
      catalogEntry(objectSource("edge"), "radius-preview")
    ]);
    const before = readFileSync(join(root, MANIFEST), "utf8");

    const result = runVersion(root, "--set", SNAPSHOT, "--channel", "edge");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`no "radius" plugin entry in ${MANIFEST}`);
    expect(readFileSync(join(root, MANIFEST), "utf8")).toBe(before);
  });

  it.each([
    ["a legacy string source", "./plugins/radius"],
    ["a null source", null],
    ["a missing source", undefined]
  ])("fails on %s, which cannot carry a ref", (_label, source) => {
    const root = writeRepository([catalogEntry(source)]);
    const before = readFileSync(join(root, MANIFEST), "utf8");

    const result = runVersion(root, "--set", SNAPSHOT, "--channel", "edge");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `"radius" needs an object source for an edge publish in ${MANIFEST}`
    );
    expect(readFileSync(join(root, MANIFEST), "utf8")).toBe(before);
  });

  it("fails before writing when the catalog is not readable", () => {
    const root = writeRepository([catalogEntry(objectSource("edge"))]);
    rmSync(join(root, MANIFEST));

    const result = runVersion(root, "--set", SNAPSHOT, "--channel", "edge");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(readJson(root, PLUGIN_MANIFEST).version).toBe(RELEASED);
  });

  it.each([
    ["not a semver version", ["--set", "edge-latest", "--channel", "edge"]],
    ["an unknown channel", ["--set", SNAPSHOT, "--channel", "nightly"]]
  ])("fails when %s is requested", (_label, args) => {
    const root = writeRepository([catalogEntry(objectSource("edge"))]);
    const before = readFileSync(join(root, MANIFEST), "utf8");

    const result = runVersion(root, ...args);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(join(root, MANIFEST), "utf8")).toBe(before);
  });
});
