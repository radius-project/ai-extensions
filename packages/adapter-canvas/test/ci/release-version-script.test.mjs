import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { versionPlan } from "../../../../scripts/release-version.mjs";

const plugins = [{ name: "radius" }, { name: "radius-aws" }];
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const temporaryRepositories = [];

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writePlugin(root, name) {
  const dir = join(root, "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "package.json"), {
    name,
    version: "1.0.0",
    private: true
  });
  writeJson(join(dir, "plugin.json"), { name, version: "1.0.0" });
  writeFileSync(join(dir, "README.md"), `${name}\n`);
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "radius-release-version-"));
  temporaryRepositories.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, ".changeset"));
  mkdirSync(join(root, ".github", "plugin"), { recursive: true });
  for (const name of ["plugins.mjs", "version.mjs", "release-version.mjs"]) {
    copyFileSync(join(repoRoot, "scripts", name), join(root, "scripts", name));
  }
  symlinkSync(
    join(repoRoot, "node_modules"),
    join(root, "node_modules"),
    "junction"
  );

  writeJson(join(root, "package.json"), { name: "fixture", private: true });
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - plugins/*\n  - packages/*\n"
  );
  // Mirrors production: the internal packages are permanently ignored in the
  // config file, which is what makes a CLI `--ignore` illegal.
  writeJson(join(root, "packages", "core", "package.json"), {
    name: "@radius-project/core",
    version: "0.0.0",
    private: true
  });
  writeJson(join(root, ".changeset", "config.json"), {
    changelog: false,
    commit: false,
    fixed: [],
    linked: [],
    access: "restricted",
    baseBranch: "main",
    updateInternalDependencies: "patch",
    privatePackages: { version: true, tag: false },
    ignore: ["@radius-project/core"]
  });
  writePlugin(root, "radius");
  writePlugin(root, "radius-aws");
  writeJson(join(root, ".github", "plugin", "marketplace.json"), {
    name: "fixture",
    metadata: { version: "1.0.0" },
    plugins: [
      { name: "radius", version: "1.0.0", source: { ref: "radius@edge" } },
      {
        name: "radius-aws",
        version: "1.0.0",
        source: { ref: "radius-aws@edge" }
      }
    ]
  });
  writeFileSync(
    join(root, ".changeset", "radius.md"),
    '---\n"radius": minor\n---\n\nRelease radius.\n'
  );
  writeFileSync(
    join(root, ".changeset", "radius-aws.md"),
    '---\n"radius-aws": major\n---\n\nRelease radius-aws.\n'
  );
  return root;
}

afterEach(() => {
  while (temporaryRepositories.length > 0) {
    rmSync(temporaryRepositories.pop(), { recursive: true, force: true });
  }
});

describe("scripts/release-version.mjs", () => {
  it("versions every plugin when no scope is selected", () => {
    expect(versionPlan(plugins)).toEqual({ args: ["version"], ignore: [] });
    expect(versionPlan(plugins, "")).toEqual({ args: ["version"], ignore: [] });
  });

  // `changeset version` rejects the --ignore flag outright when the config file
  // defines ignores, so the scope has to travel through the config instead.
  it("scopes a release without passing --ignore to the CLI", () => {
    expect(versionPlan(plugins, "radius")).toEqual({
      args: ["version"],
      ignore: ["radius-aws"]
    });
    expect(versionPlan(plugins, "radius-aws")).toEqual({
      args: ["version"],
      ignore: ["radius"]
    });
  });

  it("applies the same plugin scope to a snapshot release", () => {
    expect(versionPlan(plugins, "radius-aws", "edge")).toEqual({
      args: ["version", "--snapshot", "edge"],
      ignore: ["radius"]
    });
  });

  it("rejects a plugin the registry did not discover", () => {
    expect(() => versionPlan(plugins, "radius-gcp")).toThrow(
      'no plugin named "radius-gcp"'
    );
  });

  it("restores the changeset config after scoping a release", () => {
    const root = workspace();
    const config = join(root, ".changeset", "config.json");
    const before = readFileSync(config, "utf8");

    const result = spawnSync(
      process.execPath,
      [join(root, "scripts", "release-version.mjs"), "--plugin", "radius"],
      { cwd: root, encoding: "utf8" }
    );

    expect(result.status, result.stderr).toBe(0);
    // The temporary scope must never reach the release commit.
    expect(readFileSync(config, "utf8")).toBe(before);
    expect(JSON.parse(before).ignore).toEqual(["@radius-project/core"]);
  });

  it("versions one plugin and leaves the other plugin queued", () => {
    const root = workspace();
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts", "release-version.mjs"), "--plugin", "radius"],
      { cwd: root, encoding: "utf8" }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(
        readFileSync(join(root, "plugins", "radius", "package.json"), "utf8")
      ).version
    ).toBe("1.1.0");
    expect(
      JSON.parse(
        readFileSync(
          join(root, "plugins", "radius-aws", "package.json"),
          "utf8"
        )
      ).version
    ).toBe("1.0.0");
    expect(existsSync(join(root, ".changeset", "radius.md"))).toBe(false);
    expect(existsSync(join(root, ".changeset", "radius-aws.md"))).toBe(true);

    const marketplace = JSON.parse(
      readFileSync(join(root, ".github", "plugin", "marketplace.json"), "utf8")
    );
    expect(
      marketplace.plugins.map(({ name, version }) => [name, version])
    ).toEqual([
      ["radius", "1.1.0"],
      ["radius-aws", "1.0.0"]
    ]);
    expect(marketplace.metadata.version).toBe("1.0.0");
  });
});
