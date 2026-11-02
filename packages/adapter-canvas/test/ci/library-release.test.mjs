import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { libraryReleasePlan } from "../../../../scripts/library-release.mjs";
import { publishLibrary } from "../../../../scripts/publish-libraries.mjs";

const temporary = [];
const repository = fileURLToPath(new URL("../../../..", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "radius-library-release-"));
  temporary.push(root);
  return root;
}

function library(
  root,
  directory,
  overrides = {},
  notes = "## 1.2.3\n\nAdded graphs.\n"
) {
  const path = join(root, "packages", directory);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "package.json"),
    JSON.stringify({
      name: `@radius-project/${directory}`,
      version: "1.2.3",
      private: false,
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org/"
      },
      ...overrides
    })
  );
  if (notes !== undefined) writeFileSync(join(path, "CHANGELOG.md"), notes);
}

afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("npm release planning", () => {
  it("orders dependencies first and uses only the selected version's notes", () => {
    const root = fixture();
    library(
      root,
      "a-renderer",
      { dependencies: { "@radius-project/z-core": "workspace:*" } },
      "# Changelog\n\n## 1.2.3\n\nAdded graphs.\n\n## 1.2.2\n\nOld change.\n"
    );
    library(root, "z-core");
    library(root, "internal", { publishConfig: undefined });
    mkdirSync(join(root, "packages", "not-a-package"));
    expect(libraryReleasePlan(root)).toEqual([
      {
        name: "@radius-project/z-core",
        version: "1.2.3",
        tarball: "radius-project-z-core-1.2.3.tgz",
        notes: "Added graphs.",
        dependencies: []
      },
      {
        name: "@radius-project/a-renderer",
        version: "1.2.3",
        tarball: "radius-project-a-renderer-1.2.3.tgz",
        notes: "Added graphs.",
        dependencies: ["@radius-project/z-core"]
      }
    ]);
  });

  it("rejects an empty release scope", () => {
    expect(() => libraryReleasePlan(fixture())).toThrow(
      "No public npm libraries"
    );
  });

  it.each([
    ["private package", { private: true }, "is private"],
    ["prerelease", { version: "1.2.3-rc.1" }, "match"],
    ["leading-zero version", { version: "01.2.3" }, "match"],
    ["unsafe name", { name: "../../outside" }, "match"],
    [
      "wrong registry",
      {
        publishConfig: { access: "public", registry: "https://example.invalid" }
      },
      "strictly equal"
    ]
  ])("rejects a %s", (_reason, overrides, message) => {
    const root = fixture();
    library(root, "core", overrides);
    expect(() => libraryReleasePlan(root)).toThrow(message);
  });

  it.each([
    ["# Changelog\n\n## 1.2.2\n\nOld change.", "no versioned release notes"],
    ["## 1.2.3\n\n", "empty release notes"]
  ])("rejects incomplete release notes: %s", (notes, message) => {
    const root = fixture();
    library(root, "core", {}, notes);
    expect(() => libraryReleasePlan(root)).toThrow(message);
  });

  it("rejects missing changelogs instead of publishing an unversioned package", () => {
    const root = fixture();
    library(root, "core");
    rmSync(join(root, "packages", "core", "CHANGELOG.md"));
    expect(() => libraryReleasePlan(root)).toThrow("ENOENT");
  });

  it("rejects cyclic library dependencies", () => {
    const root = fixture();
    library(root, "core", {
      dependencies: { "@radius-project/graph": "workspace:*" }
    });
    library(root, "graph", {
      dependencies: { "@radius-project/core": "workspace:*" }
    });
    expect(() => libraryReleasePlan(root)).toThrow("cycle");
  });
});

describe("npm tarball publication", () => {
  const release = { name: "@radius-project/core", version: "1.2.3" };
  const bytes = Buffer.from("qualified package bytes");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const found = (value = integrity) => ({
    status: 0,
    stdout: JSON.stringify(value)
  });
  const missing = { status: 1, stdout: '{"error":{"code":"E404"}}' };
  const path = "candidate.tgz";

  function runner(results) {
    const calls = [];
    return {
      calls,
      run(args) {
        calls.push(args);
        const result = results.shift();
        if (!result) throw new Error("Unexpected npm command");
        return result;
      }
    };
  }

  it("publishes only after a registry 404 and verifies the exact qualified bytes", () => {
    const { run, calls } = runner([missing, { status: 0 }, found()]);
    publishLibrary(release, bytes, path, run);
    expect(calls).toEqual([
      [
        "view",
        "@radius-project/core@1.2.3",
        "dist.integrity",
        "--json",
        "--registry",
        "https://registry.npmjs.org/"
      ],
      [
        "publish",
        path,
        "--access",
        "public",
        "--provenance",
        "--ignore-scripts",
        "--registry",
        "https://registry.npmjs.org/"
      ],
      [
        "view",
        "@radius-project/core@1.2.3",
        "dist.integrity",
        "--json",
        "--registry",
        "https://registry.npmjs.org/"
      ]
    ]);
  });

  it("resumes a partial release without publishing identical bytes twice", () => {
    const { run, calls } = runner([found()]);
    publishLibrary(release, bytes, path, run);
    expect(calls).toHaveLength(1);
  });

  it("refuses to reuse a version with different registry bytes", () => {
    const { run, calls } = runner([found("sha512-other")]);
    expect(() => publishLibrary(release, bytes, path, run)).toThrow(
      "different bytes"
    );
    expect(calls).toHaveLength(1);
  });

  it.each([
    [
      "null error",
      { status: 1, stdout: "null", stderr: "Null registry error" },
      "Null registry error"
    ],
    [
      "auth failure",
      {
        status: 1,
        stdout: '{"error":{"code":"E401"}}',
        stderr: "Access denied"
      },
      "Access denied"
    ],
    [
      "network failure",
      { status: 1, stdout: "", stderr: "Registry unreachable" },
      "Registry unreachable"
    ],
    [
      "malformed response",
      { status: 1, stdout: "{", stderr: "Invalid response" },
      "Invalid response"
    ],
    [
      "incomplete error",
      { status: 1, stdout: "{}", stderr: "Unknown registry error" },
      "Unknown registry error"
    ]
  ])("fails closed on %s", (_reason, result, message) => {
    const { run, calls } = runner([result]);
    expect(() => publishLibrary(release, bytes, path, run)).toThrow(message);
    expect(calls).toHaveLength(1);
  });

  it.each([
    [[missing, { status: 1, stderr: "Publish denied" }], "Publish denied"],
    [
      [missing, { status: 0 }, { status: 1, stderr: "Read failed" }],
      "Read failed"
    ],
    [[missing, { status: 0 }, found("sha512-other")], "does not match"],
    [[found(null)], "different bytes"]
  ])("propagates publication and verification errors", (results, message) => {
    const { run } = runner(results);
    expect(() => publishLibrary(release, bytes, path, run)).toThrow(message);
  });
});

describe("npm publish command startup", () => {
  function candidate() {
    const root = fixture();
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    const directory = join(root, "qualified candidate");
    mkdirSync(scripts);
    mkdirSync(bin);
    mkdirSync(join(directory, "packages"), { recursive: true });
    for (const name of [
      "publish-libraries.mjs",
      "library-release.mjs",
      "libraries.mjs",
      "plugins.mjs",
      "module-entry.mjs"
    ]) {
      copyFileSync(join(repository, "scripts", name), join(scripts, name));
    }
    library(root, "a-renderer", {
      dependencies: { "@radius-project/z-core": "workspace:*" }
    });
    library(root, "z-core");
    const plan = libraryReleasePlan(root);
    writeFileSync(join(directory, "release-plan.json"), JSON.stringify(plan));
    for (const release of plan) {
      writeFileSync(
        join(directory, "packages", release.tarball),
        `qualified bytes for ${release.name}`
      );
    }
    // A native executable also works with shell-free spawnSync on Windows.
    copyFileSync(
      process.execPath,
      join(bin, process.platform === "win32" ? "npm.exe" : "npm")
    );
    const fake = join(bin, "fake-npm.mjs");
    writeFileSync(
      fake,
      `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

if (["npm", "npm.exe"].includes(basename(process.execPath))) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const args = process.argv.slice(1);
  args[0] = basename(args[0]);
  appendFileSync(join(root, "npm-calls.jsonl"), JSON.stringify(args) + "\\n");
  const statePath = join(root, "npm-state.json");
  const state = existsSync(statePath) ?
    JSON.parse(readFileSync(statePath, "utf8")) : {};
  const plan = JSON.parse(readFileSync(
    join(root, "qualified candidate", "release-plan.json"), "utf8"
  ));
  if (args[0] === "view") {
    assert.deepEqual(args.slice(2), [
      "dist.integrity", "--json", "--registry", "https://registry.npmjs.org/"
    ]);
    assert.ok(plan.some((release) =>
      args[1] === release.name + "@" + release.version
    ));
    console.log(JSON.stringify(state[args[1]] ?? { error: { code: "E404" } }));
    process.exit(state[args[1]] ? 0 : 1);
  }
  assert.equal(args[0], "publish");
  assert.deepEqual(args.slice(2), [
    "--access", "public", "--provenance", "--ignore-scripts",
    "--registry", "https://registry.npmjs.org/"
  ]);
  const release = plan.find((release) => basename(args[1]) === release.tarball);
  assert.ok(release);
  state[release.name + "@" + release.version] =
    "sha512-" + createHash("sha512").update(readFileSync(args[1])).digest("base64");
  writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
`
    );
    return {
      root,
      directory,
      plan,
      run() {
        return spawnSync(
          process.execPath,
          [join(scripts, "publish-libraries.mjs"), directory],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 10_000,
            env: {
              ...(process.platform === "win32" ?
                { SystemRoot: process.env.SystemRoot }
              : {}),
              PATH: bin,
              NODE_OPTIONS: `--import=${pathToFileURL(fake).href}`
            }
          }
        );
      },
      calls() {
        const path = join(root, "npm-calls.jsonl");
        return existsSync(path) ?
            readFileSync(path, "utf8").trim().split("\n").map(JSON.parse)
          : [];
      }
    };
  }

  it("rejects a plan that differs from source before running npm", () => {
    const context = candidate();
    context.plan[0].version = "9.9.9";
    writeFileSync(
      join(context.directory, "release-plan.json"),
      JSON.stringify(context.plan)
    );
    const result = context.run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "The qualified candidate does not match the checked-out release source."
    );
    expect(context.calls()).toEqual([]);
  });

  it("rejects a missing first tarball before running npm", () => {
    const context = candidate();
    const path = join(context.directory, "packages", context.plan[0].tarball);
    rmSync(path);
    const result = context.run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).toContain(context.plan[0].tarball);
    expect(context.calls()).toEqual([]);
  });

  it("publishes and verifies dependencies before consumers", () => {
    const context = candidate();
    const result = context.run();
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(context.plan.map(({ name }) => name)).toEqual([
      "@radius-project/z-core",
      "@radius-project/a-renderer"
    ]);
    expect(context.calls()).toEqual(
      context.plan.flatMap((release) => {
        const query = [
          "view",
          `${release.name}@${release.version}`,
          "dist.integrity",
          "--json",
          "--registry",
          "https://registry.npmjs.org/"
        ];
        return [
          query,
          [
            "publish",
            join(context.directory, "packages", release.tarball),
            "--access",
            "public",
            "--provenance",
            "--ignore-scripts",
            "--registry",
            "https://registry.npmjs.org/"
          ],
          query
        ];
      })
    );
    for (const release of context.plan) {
      expect(result.stdout).toContain(
        `Verified ${release.name}@${release.version} on npm.`
      );
    }
  });
});

describe("npm release workflow boundary", () => {
  const workflow = parse(
    readFileSync(
      join(repository, ".github", "workflows", "release-libraries.yml"),
      "utf8"
    )
  );
  const { validate, candidate, publish } = workflow.jobs;

  it("pins candidate qualification and publication to Ubuntu 24.04", () => {
    expect(candidate["runs-on"]).toBe("ubuntu-24.04");
    expect(publish["runs-on"]).toBe("ubuntu-24.04");
  });

  it("admits only manual main-branch releases through the full shared gate", () => {
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({});
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(validate.if).toBe("github.ref == 'refs/heads/main'");
    expect(validate.uses).toBe("./.github/workflows/build.yml");
    expect(validate.with).toEqual({
      channel: "release",
      ref: "${{ github.sha }}"
    });
    expect(candidate.needs).toBe("validate");
    expect(publish.needs).toBe("candidate");
  });

  it("qualifies packed bytes before passing the same artifact to publication", () => {
    const runs = candidate.steps.flatMap((step) => step.run ?? []);
    expect(runs).toContain("pnpm run test:integration:libraries");
    expect(
      runs.some((run) =>
        run.includes("--candidates .artifacts/libraries/packages")
      )
    ).toBe(true);
    const upload = candidate.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@")
    );
    const download = publish.steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact@")
    );
    expect(download.with.name).toBe(upload.with.name);
    expect(upload.with.path).toContain(".artifacts/headlamp-release");
    expect(upload.with.path).toContain(".artifacts/libraries/*.spdx.json");
    expect(download.with.path).toBe(".artifacts/npm-release");
    expect(
      publish.steps.some(
        (step) =>
          step.run ===
          "node scripts/publish-libraries.mjs .artifacts/npm-release/libraries"
      )
    ).toBe(true);
  });

  it("grants OIDC only to the dependency-free protected publish job", () => {
    expect(candidate.permissions).toEqual({ contents: "read" });
    expect(publish.permissions).toEqual({
      contents: "write",
      "id-token": "write"
    });
    expect(publish.environment).toBe("npm");
    const text = JSON.stringify(publish);
    expect(text).not.toMatch(
      /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.|pnpm install|npm install/
    );
    expect(
      publish.steps.every(
        (step) => !step.uses || /@[a-f0-9]{40}$/.test(step.uses)
      )
    ).toBe(true);
  });

  it("verifies the source signature before publishing and creates the tag before its draft release", () => {
    const steps = publish.steps;
    const verify = steps.findIndex(
      (step) => step.name === "Require a verified release source"
    );
    const publication = steps.findIndex(
      (step) =>
        step.name === "Publish the qualified tarballs with npm provenance"
    );
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(publication);
    expect(steps[verify].run).toContain(".commit.verification.verified");
    const release = steps.at(-1).run;
    expect(release.indexOf('-f "ref=refs/tags/$tag"')).toBeLessThan(
      release.indexOf('gh release create "$tag" --verify-tag --draft')
    );
    expect(release).toContain('!= "$SOURCE_SHA"');
    expect(release).toContain("libraries/*.spdx.json");
  });
});
