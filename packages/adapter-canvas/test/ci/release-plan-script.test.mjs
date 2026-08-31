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

const SCRIPTS = ["plugins.mjs", "release-plan.mjs"].map((name) => [
  name,
  fileURLToPath(new URL(`../../../../scripts/${name}`, import.meta.url))
]);
const temporaryRepositories = [];

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writePlugin(root, name, version, changelogVersions = [version]) {
  const dir = join(root, "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "package.json"), { name, version, private: true });
  writeJson(join(dir, "plugin.json"), { name, version });
  writeFileSync(join(dir, "README.md"), `${name}\n`);
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    changelogVersions
      .map((entry) => `## ${entry}\n\nNotes for ${entry}.\n`)
      .join("\n")
  );
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "radius-release-plan-"));
  temporaryRepositories.push(root);
  mkdirSync(join(root, "scripts"));
  for (const [name, source] of SCRIPTS) {
    copyFileSync(source, join(root, "scripts", name));
  }

  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "user.email", "release@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  writePlugin(root, "radius", "1.0.0");
  writePlugin(root, "radius-aws", "2.0.0");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}

function commit(root, message = "release") {
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function run(root, source = git(root, "rev-parse", "HEAD")) {
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts", "release-plan.mjs"), "--source", source],
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

describe("scripts/release-plan.mjs", () => {
  it("detects only the plugin whose version and changelog changed", () => {
    const root = repository();
    writePlugin(root, "radius", "1.1.0", ["1.1.0", "1.0.0"]);
    const source = commit(root);

    expect(run(root, source)).toMatchObject({
      status: 0,
      stdout: '["radius"]'
    });
  });

  it("detects several independently versioned plugins", () => {
    const root = repository();
    writePlugin(root, "radius", "1.1.0", ["1.1.0", "1.0.0"]);
    writePlugin(root, "radius-aws", "3.0.0", ["3.0.0", "2.0.0"]);
    const source = commit(root);

    expect(JSON.parse(run(root, source).stdout)).toEqual([
      "radius",
      "radius-aws"
    ]);
  });

  it("ignores old changelog entries when the package version did not change", () => {
    const root = repository();
    writeFileSync(join(root, "README.md"), "unrelated\n");
    const source = commit(root);

    expect(run(root, source)).toMatchObject({ status: 0, stdout: "[]" });
  });

  it("rejects a version change without a newly added changelog heading", () => {
    const root = repository();
    writePlugin(root, "radius", "1.1.0", ["1.0.0"]);
    const result = run(root, commit(root));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not add "## 1.1.0"');
  });

  it("accepts a newly added plugin as its initial release", () => {
    const root = repository();
    writePlugin(root, "radius-gcp", "0.1.0");
    const source = commit(root);

    expect(JSON.parse(run(root, source).stdout)).toEqual(["radius-gcp"]);
  });

  it("requires the source to be the checked-out commit", () => {
    const root = repository();
    const base = git(root, "rev-parse", "HEAD");
    writePlugin(root, "radius", "1.1.0", ["1.1.0", "1.0.0"]);
    commit(root);
    const result = run(root, base);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not the checked-out commit");
  });

  it("rejects a malformed source SHA", () => {
    const result = run(repository(), "abc123");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("full 40-character commit SHA");
  });

  it("rejects an invalid released version", () => {
    const root = repository();
    writePlugin(root, "radius", "next", ["next", "1.0.0"]);
    const result = run(root, commit(root));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has an invalid version");
  });
});
