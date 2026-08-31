import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
  new URL("../../../../scripts/plugins.mjs", import.meta.url)
);

const temporaryRepositories = [];

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param plugins directory name -> the `name` its package.json declares, or
 *   `null` to leave the directory without a manifest.
 */
function writeRepository(plugins) {
  const root = mkdtempSync(join(tmpdir(), "radius-plugins-"));
  temporaryRepositories.push(root);

  mkdirSync(join(root, "scripts"));
  // The script resolves the repository from its own location, so exercising it
  // against a fixture means copying it rather than running it in place.
  copyFileSync(SCRIPT, join(root, "scripts", "plugins.mjs"));

  for (const [dir, packaged] of Object.entries(plugins)) {
    mkdirSync(join(root, "plugins", dir), { recursive: true });
    if (packaged === null) continue;
    writeJson(join(root, "plugins", dir, "package.json"), {
      name: packaged,
      version: "1.0.0"
    });
    writeJson(join(root, "plugins", dir, "plugin.json"), { name: packaged });
    writeFileSync(join(root, "plugins", dir, "README.md"), `${packaged}\n`);
  }

  return root;
}

function run(root, ...args) {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [join(root, "scripts", "plugins.mjs"), ...args],
    { cwd: root, encoding: "utf8" }
  );
  return { status, stdout: stdout.trim(), stderr };
}

function env(root, ...args) {
  const result = run(root, ...args);
  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(
    result.stdout.split("\n").map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    })
  );
}

afterEach(() => {
  while (temporaryRepositories.length > 0) {
    rmSync(temporaryRepositories.pop(), { recursive: true, force: true });
  }
});

describe("scripts/plugins.mjs", () => {
  it("discovers every plugin directory in name order", () => {
    const root = writeRepository({
      radius: "radius",
      "radius-aws": "radius-aws"
    });

    expect(run(root).stdout).toBe("radius\nradius-aws");
    expect(run(root, "--json").stdout).toBe('["radius","radius-aws"]');
  });

  it("validates and deduplicates a requested workflow matrix", () => {
    const root = writeRepository({
      radius: "radius",
      "radius-aws": "radius-aws"
    });

    expect(
      run(root, "--select", '["radius-aws","radius","radius-aws"]').stdout
    ).toBe('["radius-aws","radius"]');
    expect(run(root, "--select", "").stdout).toBe('["radius","radius-aws"]');
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["an empty matrix", "[]"],
    ["an unknown plugin", '["radius-gcp"]']
  ])("rejects %s as a workflow matrix", (_label, selected) => {
    const result = run(
      writeRepository({ radius: "radius" }),
      "--select",
      selected
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--select");
  });

  it("ignores a directory that is not a shippable plugin", () => {
    const root = writeRepository({ radius: "radius", scratch: null });

    expect(run(root, "--json").stdout).toBe('["radius"]');
  });

  it("builds every published ref from the plugin name", () => {
    const root = writeRepository({ "radius-aws": "radius-aws" });

    expect(
      env(
        root,
        "--env",
        "radius-aws",
        "--version",
        "2.1.0",
        "--channel",
        "latest"
      )
    ).toEqual({
      PLUGIN_NAME: "radius-aws",
      PLUGIN_DIR: "plugins/radius-aws",
      PLUGIN_DIST: "plugins/radius-aws/dist",
      PLUGIN_ARTIFACT: "plugin-dist-radius-aws",
      PLUGIN_TARBALL: "radius-aws-plugin.tar.gz",
      PLUGIN_SBOM: "radius-aws-plugin.spdx.json",
      PLUGIN_AWESOME_COPILOT: "radius-aws-awesome-copilot.zip",
      PLUGIN_CHANNEL_BRANCH: "releases/radius-aws/latest",
      PLUGIN_CHANNEL_TAG: "radius-aws@latest",
      PLUGIN_SOURCE_TAG: "radius-aws@2.1.0",
      PLUGIN_ARTIFACT_TAG: "radius-aws/v2.1.0",
      PLUGIN_PINNED_BRANCH: "releases/radius-aws/v2.1.0"
    });
  });

  it("keeps release asset names static across versions", () => {
    const root = writeRepository({ radius: "radius" });
    const assets = (version) => {
      const result = env(root, "--env", "radius", "--version", version);
      return [
        result.PLUGIN_TARBALL,
        result.PLUGIN_SBOM,
        result.PLUGIN_AWESOME_COPILOT
      ];
    };

    expect(assets("1.2.0")).toEqual([
      "radius-plugin.tar.gz",
      "radius-plugin.spdx.json",
      "radius-awesome-copilot.zip"
    ]);
    expect(assets("9.0.0")).toEqual(assets("1.2.0"));
  });

  it("emits only the names the caller asked for", () => {
    const root = writeRepository({ radius: "radius" });

    expect(Object.keys(env(root, "--env", "radius"))).toEqual([
      "PLUGIN_NAME",
      "PLUGIN_DIR",
      "PLUGIN_DIST",
      "PLUGIN_ARTIFACT",
      "PLUGIN_TARBALL",
      "PLUGIN_SBOM",
      "PLUGIN_AWESOME_COPILOT"
    ]);
    expect(env(root, "--env", "radius", "--channel", "edge")).toMatchObject({
      PLUGIN_CHANNEL_BRANCH: "releases/radius/edge",
      PLUGIN_CHANNEL_TAG: "radius@edge"
    });
  });

  it("treats an unset selector as the only plugin", () => {
    const root = writeRepository({ radius: "radius" });

    expect(env(root, "--env", "").PLUGIN_NAME).toBe("radius");
  });

  it("refuses to guess once the repository ships several plugins", () => {
    const root = writeRepository({
      radius: "radius",
      "radius-aws": "radius-aws"
    });

    const result = run(root, "--env", "");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--plugin is required");
  });

  it("rejects an unknown plugin", () => {
    const result = run(writeRepository({ radius: "radius" }), "--env", "nope");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no plugin named "nope"');
  });

  it("rejects a channel it does not publish", () => {
    const result = run(
      writeRepository({ radius: "radius" }),
      "--env",
      "radius",
      "--channel",
      "nightly"
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--channel must be one of edge, latest");
  });

  // Every ref name is built from the directory, so a package that disagrees
  // would publish under an identity nothing else resolves.
  it("rejects a package whose name does not match its directory", () => {
    const result = run(writeRepository({ radius: "radius-canvas" }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'must be named "radius" in package.json and plugin.json'
    );
  });

  it("rejects a partial plugin instead of silently skipping it", () => {
    const root = writeRepository({ radius: null });
    writeJson(join(root, "plugins", "radius", "package.json"), {
      name: "radius",
      version: "1.0.0"
    });

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("both package.json and plugin.json");
  });

  it.each(["radius aws", "radius..aws", "radius--aws"])(
    "rejects plugin name %s, which cannot safely form every external ref",
    (name) => {
      const result = run(writeRepository({ [name]: name }));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not a safe plugin/ref name");
    }
  );

  it("rejects a non-SemVer version before writing it to refs or the environment", () => {
    const result = run(
      writeRepository({ radius: "radius" }),
      "--env",
      "radius",
      "--version",
      "../latest"
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--version requires SemVer");
  });

  it("fails when there is nothing to release", () => {
    const result = run(writeRepository({}));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no plugins found");
  });
});
