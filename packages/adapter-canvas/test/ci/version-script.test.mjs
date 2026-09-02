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

const SCRIPTS = ["version.mjs", "plugins.mjs"].map((name) => [
  name,
  fileURLToPath(new URL(`../../../../scripts/${name}`, import.meta.url))
]);

const MANIFEST = ".github/plugin/marketplace.json";
const PLUGIN_MANIFEST = "plugins/radius/plugin.json";
const SOURCE_OF_TRUTH = "extensions/radius/package.json";

const RELEASED = "0.4.0";
const SNAPSHOT = "0.5.0-edge-0b33186";

const temporaryRepositories = [];

const objectSource = (ref, name = "radius") => ({
  source: "github",
  repo: "radius-project/ai-extensions",
  path: `extensions/${name}`,
  ref
});

const catalogEntry = (source, name = "radius", version = RELEASED) => ({
  name,
  source,
  description: "Model, visualize, and deploy applications with Radius.",
  version,
  repository: "https://github.com/radius-project/ai-extensions",
  license: "Apache-2.0",
  keywords: ["radius", "canvas"]
});

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Adds a plugin directory the registry will discover. */
function writePlugin(root, name, version = RELEASED) {
  mkdirSync(join(root, "plugins", name), { recursive: true });
  mkdirSync(join(root, "extensions", name), { recursive: true });
  writeJson(join(root, "extensions", name, "package.json"), {
    name,
    version,
    private: true,
    scripts: { "test:artifact": "echo tested" }
  });
  writeJson(join(root, "plugins", name, "plugin.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name,
    version
  });
  writeFileSync(join(root, "plugins", name, "README.md"), `${name}\n`);
}

function writeChangelog(root, name, contents) {
  writeFileSync(join(root, "extensions", name, "CHANGELOG.md"), contents);
}

function writeRepository(
  plugins,
  { metadataVersion = RELEASED, pluginDirs } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "radius-version-"));
  temporaryRepositories.push(root);

  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, ".github", "plugin"), { recursive: true });

  // The scripts resolve the repository from their own location, so exercising
  // them against a fixture means copying them rather than running in place.
  for (const [name, source] of SCRIPTS) {
    copyFileSync(source, join(root, "scripts", name));
  }

  for (const entry of pluginDirs ?? plugins) {
    writePlugin(root, entry.name, entry.version);
  }
  writeJson(join(root, MANIFEST), {
    name: "radius-plugins",
    metadata: { description: "Radius plugins.", version: metadataVersion },
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

describe("scripts/version.mjs across several plugins", () => {
  const twoPlugins = () =>
    writeRepository(
      [
        catalogEntry(objectSource("radius@latest"), "radius", "0.4.0"),
        catalogEntry(
          objectSource("radius-aws@latest", "radius-aws"),
          "radius-aws",
          "1.2.0"
        )
      ],
      { metadataVersion: "1.2.0" }
    );

  it("requires a plugin once more than one can be meant", () => {
    const result = runVersion(twoPlugins());

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--plugin is required");
    expect(result.stderr).toContain("radius, radius-aws");
  });

  it("reads each plugin's own source of truth", () => {
    const root = twoPlugins();

    expect(runVersion(root, "--plugin", "radius").stdout).toBe("0.4.0");
    expect(runVersion(root, "--plugin", "radius-aws").stdout).toBe("1.2.0");
  });

  it("prints release notes from only the selected plugin's current version", () => {
    const root = twoPlugins();
    writeChangelog(root, "radius", "## 0.4.0\n\nRadius notes.\n");
    writeChangelog(
      root,
      "radius-aws",
      "## 1.2.0\n\nAWS notes.\n\nSecond paragraph.\n\n## 1.1.0\n\nOld notes.\n"
    );

    const result = runVersion(
      root,
      "--release-notes",
      "--plugin",
      "radius-aws"
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("AWS notes.\n\nSecond paragraph.");
  });

  it.each([
    ["missing", undefined, "does not exist"],
    ["empty", "## 1.2.0\n\n## 1.1.0\n\nOld notes.\n", "empty entry"]
  ])(
    "rejects %s release notes for the selected plugin",
    (_label, changelog, message) => {
      const root = twoPlugins();
      if (changelog !== undefined) {
        writeChangelog(root, "radius-aws", changelog);
      }

      const result = runVersion(
        root,
        "--release-notes",
        "--plugin",
        "radius-aws"
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("extensions/radius-aws/CHANGELOG.md");
      expect(result.stderr).toContain(message);
    }
  );

  it("compares the selected plugin's version", () => {
    const root = twoPlugins();

    expect(
      runVersion(root, "--compare", "1.0.0", "--plugin", "radius").stdout
    ).toBe("-1");
    expect(
      runVersion(root, "--compare", "1.0.0", "--plugin", "radius-aws").stdout
    ).toBe("1");
    expect(
      runVersion(root, "--compare", "1.2.0", "--plugin", "radius-aws").stdout
    ).toBe("0");
  });

  it("releases one plugin without touching the other", () => {
    const root = twoPlugins();

    expect(
      runVersion(root, "--set", "0.5.0", "--plugin", "radius").status
    ).toBe(0);

    expect(readJson(root, "plugins/radius/plugin.json").version).toBe("0.5.0");
    expect(readJson(root, "plugins/radius-aws/plugin.json").version).toBe(
      "1.2.0"
    );

    // A release leaves the catalog on main alone, entry and ref alike.
    const catalog = readJson(root, MANIFEST);
    const entry = (name) => catalog.plugins.find((p) => p.name === name);
    expect(entry("radius").version).toBe("0.4.0");
    expect(entry("radius").source.ref).toBe("radius@latest");
    expect(entry("radius-aws").version).toBe("1.2.0");
    expect(entry("radius-aws").source.ref).toBe("radius-aws@latest");
  });

  it("leaves the independently versioned marketplace metadata alone", () => {
    const root = twoPlugins();

    expect(
      runVersion(root, "--set", "2.0.0", "--plugin", "radius").status
    ).toBe(0);
    expect(readJson(root, MANIFEST).metadata.version).toBe("1.2.0");

    expect(
      runVersion(root, "--set", "1.3.0", "--plugin", "radius-aws").status
    ).toBe(0);
    expect(readJson(root, MANIFEST).metadata.version).toBe("1.2.0");
  });

  it("preserves explicit marketplace metadata during a repository-wide sync", () => {
    const root = twoPlugins();
    const catalog = readJson(root, MANIFEST);
    catalog.metadata.description = "A different marketplace description.";
    writeJson(join(root, MANIFEST), catalog);

    expect(runVersion(root, "--sync").status).toBe(0);
    expect(readJson(root, MANIFEST).metadata).toEqual({
      description: "A different marketplace description.",
      version: "1.2.0"
    });
  });

  it("only retargets the edge entry of the plugin being published", () => {
    const root = twoPlugins();

    expect(
      runVersion(
        root,
        "--set",
        SNAPSHOT,
        "--plugin",
        "radius-aws",
        "--channel",
        "edge"
      ).status
    ).toBe(0);

    const catalog = readJson(root, MANIFEST);
    const entry = (name) => catalog.plugins.find((p) => p.name === name);
    expect(entry("radius-aws").source.ref).toBe("radius-aws@edge");
    expect(entry("radius-aws").version).toBe(SNAPSHOT);
    expect(entry("radius").source.ref).toBe("radius@latest");
    expect(entry("radius").version).toBe("0.4.0");
  });

  it("reports every drifted file, whichever plugin owns it", () => {
    const root = twoPlugins();
    writeJson(join(root, "plugins", "radius-aws", "plugin.json"), {
      name: "radius-aws",
      version: "0.0.1"
    });

    const result = runVersion(root, "--check");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("plugins/radius-aws/plugin.json#version");
    expect(result.stderr).toContain('expected "1.2.0"');
  });

  it("repairs every plugin at once", () => {
    const root = twoPlugins();
    writeJson(join(root, "plugins", "radius-aws", "plugin.json"), {
      name: "radius-aws",
      version: "0.0.1"
    });

    expect(runVersion(root, "--sync").status).toBe(0);
    expect(runVersion(root, "--check", "--plugin", "radius").status).toBe(0);
    expect(readJson(root, "plugins/radius-aws/plugin.json").version).toBe(
      "1.2.0"
    );
  });

  // Each publish stamps the version into the throwaway catalog it ships, so a
  // stale entry on main is not drift anything has to repair.
  it("never writes a version into the catalog on main", () => {
    const root = twoPlugins();
    const stale = readJson(root, MANIFEST);
    stale.plugins.find((p) => p.name === "radius-aws").version = "0.0.1";
    writeJson(join(root, MANIFEST), stale);

    expect(runVersion(root, "--check").status).toBe(0);
    expect(runVersion(root, "--sync").status).toBe(0);
    expect(
      readJson(root, MANIFEST).plugins.find((p) => p.name === "radius-aws")
        .version
    ).toBe("0.0.1");
  });

  it("rejects a plugin the repository does not ship", () => {
    const result = runVersion(twoPlugins(), "--plugin", "radius-gcp");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no plugin named "radius-gcp"');
  });
});

describe("scripts/version.mjs --set --channel edge", () => {
  it("stamps the snapshot version and pins the catalog at the edge ref", () => {
    const root = writeRepository([catalogEntry(objectSource("radius@edge"))]);

    const result = runVersion(root, "--set", SNAPSHOT, "--channel", "edge");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(SNAPSHOT);

    const catalog = readJson(root, MANIFEST);
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0].name).toBe("radius");
    expect(catalog.plugins[0].version).toBe(SNAPSHOT);
    expect(catalog.plugins[0].source.ref).toBe("radius@edge");
  });

  it("retargets a catalog whose default channel has switched to latest", () => {
    const root = writeRepository([catalogEntry(objectSource("radius@latest"))]);

    expect(
      runVersion(root, "--set", SNAPSHOT, "--channel", "edge").status
    ).toBe(0);

    const catalog = readJson(root, MANIFEST);
    expect(catalog.plugins[0].source.ref).toBe("radius@edge");
    expect(catalog.plugins[0].version).toBe(SNAPSHOT);
  });

  it("leaves the plugin manifest, source of truth and catalog metadata alone", () => {
    const root = writeRepository([catalogEntry(objectSource("radius@edge"))]);

    expect(
      runVersion(root, "--set", SNAPSHOT, "--channel", "edge").status
    ).toBe(0);

    expect(readJson(root, SOURCE_OF_TRUTH).version).toBe(RELEASED);
    expect(readJson(root, PLUGIN_MANIFEST).version).toBe(RELEASED);
    expect(readJson(root, MANIFEST).metadata.version).toBe(RELEASED);
  });

  it("preserves the rest of the catalog entry", () => {
    const root = writeRepository([catalogEntry(objectSource("radius@edge"))]);

    expect(
      runVersion(root, "--set", SNAPSHOT, "--channel", "edge").status
    ).toBe(0);

    const entry = readJson(root, MANIFEST).plugins[0];
    expect(entry.source).toEqual(objectSource("radius@edge"));
    expect(entry.keywords).toEqual(["radius", "canvas"]);
    expect(entry.license).toBe("Apache-2.0");
  });

  it("reports the written file on stderr so stdout stays the version", () => {
    const root = writeRepository([catalogEntry(objectSource("radius@edge"))]);

    const result = runVersion(root, "--set", SNAPSHOT, "--channel", "edge");

    expect(result.stdout).toBe(SNAPSHOT);
    expect(result.stderr).toContain(`updated ${MANIFEST}`);
  });
});

describe("scripts/version.mjs --set (stable)", () => {
  it("derives every version without touching the catalog", () => {
    const root = writeRepository([catalogEntry(objectSource("radius@latest"))]);

    const result = runVersion(root, "--set", "0.5.0");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.5.0");
    expect(readJson(root, SOURCE_OF_TRUTH).version).toBe("0.5.0");
    expect(readJson(root, PLUGIN_MANIFEST).version).toBe("0.5.0");

    const catalog = readJson(root, MANIFEST);
    expect(catalog.metadata.version).toBe(RELEASED);
    expect(catalog.plugins[0].version).toBe(RELEASED);
    expect(catalog.plugins[0].source.ref).toBe("radius@latest");
  });
});

describe("scripts/version.mjs rejects a catalog it cannot publish", () => {
  it("fails when the radius entry is missing", () => {
    const root = writeRepository(
      [catalogEntry(objectSource("radius@edge"), "radius-preview")],
      { pluginDirs: [{ name: "radius" }] }
    );
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
      `"radius" needs an object source for a channel publish in ${MANIFEST}`
    );
    expect(readFileSync(join(root, MANIFEST), "utf8")).toBe(before);
  });

  it("fails before writing when the catalog is not readable", () => {
    const root = writeRepository([catalogEntry(objectSource("radius@edge"))]);
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
    const root = writeRepository([catalogEntry(objectSource("radius@edge"))]);
    const before = readFileSync(join(root, MANIFEST), "utf8");

    const result = runVersion(root, ...args);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(join(root, MANIFEST), "utf8")).toBe(before);
  });
});
