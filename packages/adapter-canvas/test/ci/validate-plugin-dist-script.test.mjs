import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPTS = ["plugins.mjs", "validate-plugin-dist.mjs"].map((name) => [
  name,
  fileURLToPath(new URL(`../../../../scripts/${name}`, import.meta.url))
]);
const temporaryRepositories = [];
const SOURCE = "a".repeat(40);
const OTHER_SOURCE = "b".repeat(40);

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function repository({
  packageJson = {},
  manifest = {},
  readme = "Radius\n"
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "radius-dist-"));
  temporaryRepositories.push(root);
  const plugin = join(root, "plugins", "radius");
  const dist = join(plugin, "dist");
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(dist, "skills"), { recursive: true });
  for (const [name, source] of SCRIPTS) {
    copyFileSync(source, join(root, "scripts", name));
  }

  writeJson(join(plugin, "package.json"), {
    name: "radius",
    version: "1.2.0",
    scripts: { "test:artifact": "echo tested" }
  });
  writeJson(join(plugin, "plugin.json"), { name: "radius", version: "1.2.0" });
  writeFileSync(join(plugin, "README.md"), "Radius source\n");
  writeJson(join(dist, "package.json"), {
    name: "radius",
    version: "1.2.0",
    main: "extension.mjs",
    radiusSourceRef: SOURCE,
    ...packageJson
  });
  writeJson(join(dist, "plugin.json"), {
    name: "radius",
    version: "1.2.0",
    skills: "./skills/",
    extensions: ".",
    ...manifest
  });
  writeFileSync(join(dist, "README.md"), readme);
  writeFileSync(join(dist, "LICENSE"), "Apache License\n");
  writeFileSync(join(dist, "extension.mjs"), "export {};\n");
  mkdirSync(join(dist, "workflows"));
  return { root, dist };
}

function run(root, ...args) {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "scripts", "validate-plugin-dist.mjs"),
      "--plugin",
      "radius",
      ...args
    ],
    { cwd: root, encoding: "utf8" }
  );
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr
  };
}

afterEach(() => {
  while (temporaryRepositories.length > 0) {
    rmSync(temporaryRepositories.pop(), { recursive: true, force: true });
  }
});

describe("scripts/validate-plugin-dist.mjs", () => {
  it("accepts a complete manifest-driven plugin dist", () => {
    const { root } = repository();

    expect(run(root, "--version", "1.2.0", "--source", SOURCE)).toMatchObject({
      status: 0,
      stdout: "radius@1.2.0"
    });
  });

  it.each([
    ["package name", { packageJson: { name: "other" } }, "both be named"],
    ["manifest version", { manifest: { version: "1.1.0" } }, "same semver"],
    ["invalid version", { packageJson: { version: "next" } }, "same semver"],
    ["empty README", { readme: "" }, "must not be empty"]
  ])("rejects an invalid %s", (_label, options, message) => {
    const result = run(repository(options).root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("requires the first-party license", () => {
    const { root, dist } = repository();
    rmSync(join(dist, "LICENSE"));

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LICENSE does not exist");
  });

  it("rejects a version other than the one the workflow selected", () => {
    const result = run(repository().root, "--version", "1.3.0");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected 1.3.0");
  });

  it.each([
    ["a missing source ref", undefined, "must carry a full"],
    ["a mutable source ref", "main", "must carry a full"],
    ["an uppercase source ref", SOURCE.toUpperCase(), "must carry a full"]
  ])("rejects %s", (_label, radiusSourceRef, message) => {
    const result = run(repository({ packageJson: { radiusSourceRef } }).root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("rejects a source ref other than the commit the workflow selected", () => {
    const result = run(repository().root, "--source", OTHER_SOURCE);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`expected ${OTHER_SOURCE}`);
  });

  it("rejects a mutable expected source ref", () => {
    const result = run(repository().root, "--source", "main");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--source must be a full lowercase");
  });

  it("requires the extension workflow assets", () => {
    const { root, dist } = repository();
    rmSync(join(dist, "workflows"), { recursive: true });

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("workflows does not exist");
  });

  it.each([
    [
      "missing main",
      { packageJson: { main: "missing.mjs" } },
      "does not exist"
    ],
    ["escaping main", { packageJson: { main: "../outside.mjs" } }, "escapes"],
    [
      "missing skills",
      { manifest: { skills: "./missing/" } },
      "does not exist"
    ],
    [
      "absolute skills",
      { manifest: { skills: "/tmp/skills" } },
      "must stay inside"
    ]
  ])("rejects %s", (_label, options, message) => {
    const result = run(repository(options).root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("validates every skills directory in an array", () => {
    const { root } = repository({
      manifest: { skills: ["./skills/", "./missing/"] }
    });

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("./missing/");
  });

  it("rejects symlinks in the published tree", () => {
    const { root, dist } = repository();
    try {
      symlinkSync(join(dist, "README.md"), join(dist, "linked-readme.md"));
    } catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") return;
      throw error;
    }

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contains a symlink");
  });

  // Every path check reads through the dist root, so a symlinked root would let
  // validation pass for files outside the plugin tree entirely.
  it("rejects a dist root that is itself a symlink", () => {
    const { root, dist } = repository();
    const elsewhere = join(root, "elsewhere");
    renameSync(dist, elsewhere);
    try {
      symlinkSync(elsewhere, dist, "junction");
    } catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") return;
      throw error;
    }

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a symlink");
  });

  it.each([
    ["a number", 7],
    ["an array", ["."]],
    ["an object", {}]
  ])("rejects an extensions value that is %s", (_label, extensions) => {
    const result = run(repository({ manifest: { extensions } }).root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plugin.json#extensions");
  });

  it("reports malformed JSON without a stack trace", () => {
    const { root, dist } = repository();
    writeFileSync(join(dist, "plugin.json"), "{broken");

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plugin.json is not readable JSON");
  });
});
