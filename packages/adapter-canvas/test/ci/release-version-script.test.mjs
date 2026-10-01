import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { versionPlan } from "../../../../scripts/release-version.mjs";
import { libraryNames } from "../../../../scripts/libraries.mjs";
import { listPlugins } from "../../../../scripts/plugins.mjs";

const plugins = [{ name: "radius" }, { name: "radius-aws" }];
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const temporaryRepositories = [];

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writePlugin(root, name) {
  const dir = join(root, "plugins", name);
  const extension = join(root, "extensions", name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(extension, { recursive: true });
  writeJson(join(extension, "package.json"), {
    name,
    version: "1.0.0",
    private: true,
    scripts: { "test:artifact": "echo tested" }
  });
  writeJson(join(dir, "plugin.json"), { name, version: "1.0.0" });
  writeFileSync(join(dir, "README.md"), `${name}\n`);
}

function workspace() {
  const artifacts = join(repoRoot, ".artifacts");
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "radius-release-version-"));
  temporaryRepositories.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, ".changeset"));
  mkdirSync(join(root, ".github", "plugin"), { recursive: true });
  for (const name of [
    "plugins.mjs",
    "libraries.mjs",
    "module-entry.mjs",
    "version.mjs",
    "release-version.mjs"
  ]) {
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
    "packages:\n  - extensions/*\n  - packages/*\n"
  );
  // Public libraries are versionable but must never join a plugin release.
  writeJson(join(root, "packages", "core", "package.json"), {
    name: "@radius-project/core",
    version: "0.1.0",
    private: true,
    publishConfig: { access: "public" }
  });
  writeJson(join(root, "packages", "graph-react", "package.json"), {
    name: "@radius-project/graph-react",
    version: "0.1.0",
    private: true,
    dependencies: { "@radius-project/core": "workspace:*" },
    publishConfig: { access: "public" }
  });
  writeJson(join(root, "packages", "internal", "package.json"), {
    name: "@radius-project/internal",
    version: "0.1.0",
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
    ignore: ["@radius-project/internal"]
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
  writeFileSync(
    join(root, ".changeset", "core.md"),
    '---\n"@radius-project/core": minor\n---\n\nAdd graph contracts.\n'
  );
  writeFileSync(
    join(root, ".changeset", "graph-react.md"),
    '---\n"@radius-project/graph-react": minor\n---\n\nAdd the graph renderer.\n'
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
    expect(JSON.parse(before).ignore).toEqual(["@radius-project/internal"]);
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
        readFileSync(join(root, "extensions", "radius", "package.json"), "utf8")
      ).version
    ).toBe("1.1.0");
    expect(
      JSON.parse(
        readFileSync(
          join(root, "extensions", "radius-aws", "package.json"),
          "utf8"
        )
      ).version
    ).toBe("1.0.0");
    expect(existsSync(join(root, ".changeset", "radius.md"))).toBe(false);
    expect(existsSync(join(root, ".changeset", "radius-aws.md"))).toBe(true);
    for (const name of ["core", "graph-react"]) {
      expect(existsSync(join(root, ".changeset", `${name}.md`))).toBe(true);
      expect(
        JSON.parse(
          readFileSync(join(root, "packages", name, "package.json"), "utf8")
        ).version
      ).toBe("0.1.0");
    }

    expect(
      JSON.parse(
        readFileSync(join(root, "plugins", "radius", "plugin.json"), "utf8")
      ).version
    ).toBe("1.1.0");

    // Versioning leaves the catalog on main alone; each publish stamps the
    // throwaway copy it ships.
    const marketplace = JSON.parse(
      readFileSync(join(root, ".github", "plugin", "marketplace.json"), "utf8")
    );
    expect(
      marketplace.plugins.map(({ name, version }) => [name, version])
    ).toEqual([
      ["radius", "1.0.0"],
      ["radius-aws", "1.0.0"]
    ]);
    expect(marketplace.metadata.version).toBe("1.0.0");
  });

  it("excludes libraries from both all-plugin and selected-plugin plans", () => {
    const libraries = ["@radius-project/core", "@radius-project/graph-react"];
    expect(
      versionPlan(plugins, undefined, undefined, { libraries }).ignore
    ).toEqual(libraries);
    expect(versionPlan(plugins, "radius", "edge", { libraries })).toEqual({
      args: ["version", "--snapshot", "edge"],
      ignore: ["radius-aws", ...libraries]
    });
  });

  it("requires a distinct, non-empty library release scope", () => {
    expect(() =>
      versionPlan(plugins, undefined, undefined, { scope: "libraries" })
    ).toThrow("no public npm libraries");
    expect(() =>
      versionPlan(plugins, "radius", undefined, {
        libraries: ["@radius-project/core"],
        scope: "libraries"
      })
    ).toThrow("--libraries cannot be combined with --plugin");
  });

  it("discovers public libraries without enrolling internal workspaces or plugins", () => {
    const root = workspace();
    mkdirSync(join(root, "packages", "without-manifest"));
    writeFileSync(join(root, "packages", "not-a-directory"), "");
    writeJson(join(root, "packages", "unpublished", "package.json"), {
      name: "unpublished"
    });
    expect(libraryNames(root)).toEqual([
      "@radius-project/core",
      "@radius-project/graph-react"
    ]);
    expect(libraryNames(join(root, "empty"))).toEqual([]);
  });

  it("versions only libraries and leaves every plugin note and manifest unchanged", () => {
    const root = workspace();
    const config = join(root, ".changeset", "config.json");
    const before = readFileSync(config, "utf8");
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts", "release-version.mjs"), "--libraries"],
      { cwd: root, encoding: "utf8" }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(config, "utf8")).toBe(before);
    for (const name of ["core", "graph-react"]) {
      expect(existsSync(join(root, ".changeset", `${name}.md`))).toBe(false);
      expect(
        JSON.parse(
          readFileSync(join(root, "packages", name, "package.json"), "utf8")
        ).version
      ).toBe("0.2.0");
    }
    for (const name of ["radius", "radius-aws"]) {
      expect(existsSync(join(root, ".changeset", `${name}.md`))).toBe(true);
      expect(
        JSON.parse(
          readFileSync(join(root, "extensions", name, "package.json"), "utf8")
        ).version
      ).toBe("1.0.0");
      expect(
        JSON.parse(
          readFileSync(join(root, "plugins", name, "plugin.json"), "utf8")
        ).version
      ).toBe("1.0.0");
    }
  });

  it("restores release scoping when Changesets rejects a mixed plugin/library note", () => {
    const root = workspace();
    const config = join(root, ".changeset", "config.json");
    const before = readFileSync(config, "utf8");
    writeFileSync(
      join(root, ".changeset", "mixed.md"),
      '---\n"radius": patch\n"@radius-project/core": patch\n---\n\nInvalid mixed release unit.\n'
    );
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts", "release-version.mjs"), "--plugin", "radius"],
      { cwd: root, encoding: "utf8" }
    );
    expect(result.status).not.toBe(0);
    expect(readFileSync(config, "utf8")).toBe(before);
    expect(existsSync(join(root, ".changeset", "mixed.md"))).toBe(true);
  });

  // The rejection above is what a release job would hit, long after review. A
  // note that names both scopes is a repository mistake, so fail here instead.
  it("keeps every pending changeset within one release scope", () => {
    const libraries = new Set(libraryNames());
    const pluginNames = new Set(listPlugins().map((plugin) => plugin.name));
    const directory = join(repoRoot, ".changeset");
    const notes = readdirSync(directory)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .map((name) => {
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(
          readFileSync(join(directory, name), "utf8")
        );
        return {
          name,
          packages: [...(frontmatter?.[1] ?? "").matchAll(/^"([^"]+)":/gm)].map(
            (match) => match[1]
          )
        };
      });

    expect(
      notes.filter(
        (note) =>
          note.packages.some((name) => libraries.has(name)) &&
          note.packages.some((name) => pluginNames.has(name))
      )
    ).toEqual([]);
    // A note naming nothing recognizable would pass the check above vacuously.
    expect(notes.filter((note) => note.packages.length === 0)).toEqual([]);
  });
});
