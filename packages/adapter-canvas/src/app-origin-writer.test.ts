import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseAppOrigin, serializeAppOrigin } from "@radius-project/core";
import { hashAppBicep } from "./app-bicep-hash.js";
import { resolveGeneratorVersion } from "./generator-version.js";

// The origin writer ships inside the installed plugin, where the workspace
// packages are unavailable, so it re-implements the hash that
// packages/core/src/modeling/app-origin.ts reads back. These tests are the
// contract between the two copies: if they drift, the canvas would report every
// freshly generated model as hand-edited.

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../extensions/radius/skills/radius-app-bicep/scripts/write-app-origin.mjs"
);

const MODEL =
  "resource app 'Radius.Core/applications@2025-08-01-preview' = {}\n";

// The version the script should discover on its own: the manifest of the plugin
// the script ships inside, addressed the same way the script addresses it.
function pluginManifestVersion(): string {
  const manifest = path.resolve(path.dirname(script), "../../../package.json");
  return JSON.parse(fs.readFileSync(manifest, "utf8")).version as string;
}

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

interface Checkout {
  root: string;
  appPath: string;
  originPath: string;
  commit: string;
}

function checkout(model = MODEL, withCommit = true): Checkout {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "app-origin-"))
  );
  temporaryDirectories.add(root);
  fs.mkdirSync(path.join(root, ".radius"));
  const appPath = path.join(root, ".radius", "app.bicep");
  fs.writeFileSync(appPath, model);
  git(root, ["init", "--quiet", "--initial-branch", "main"]);
  git(root, ["config", "user.email", "radius@example.invalid"]);
  git(root, ["config", "user.name", "Radius Test"]);
  let commit = "";
  if (withCommit) {
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "model"]);
    commit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8"
    }).stdout.trim();
  }
  return {
    root,
    appPath,
    originPath: path.join(root, ".radius", "app.origin.json"),
    commit
  };
}

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8"
  });
}

describe("write-app-origin", () => {
  it("writes an origin record the core parser accepts and reports as up to date", () => {
    const repo = checkout();

    const result = run(
      [
        repo.appPath,
        "--skill-version",
        "0.1.0-edge-0b33186",
        "--generated-at",
        "2026-08-11T05:32:32.000Z"
      ],
      repo.root
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(repo.originPath);
    expect(parseAppOrigin(fs.readFileSync(repo.originPath, "utf8"))).toEqual({
      generatedAt: "2026-08-11T05:32:32.000Z",
      sourceCommit: repo.commit,
      skillVersion: "0.1.0-edge-0b33186",
      appBicepHash: hashAppBicep(MODEL)
    });
  });

  it("serializes exactly what the core serializer produces", () => {
    const repo = checkout();

    run(
      [
        repo.appPath,
        "--skill-version",
        "0.1.0",
        "--generated-at",
        "2026-08-11T05:32:32.000Z"
      ],
      repo.root
    );

    expect(fs.readFileSync(repo.originPath, "utf8")).toBe(
      serializeAppOrigin({
        generatedAt: "2026-08-11T05:32:32.000Z",
        sourceCommit: repo.commit,
        skillVersion: "0.1.0",
        appBicepHash: hashAppBicep(MODEL)
      })
    );
  });

  it("hashes a CRLF checkout the same as its LF original", () => {
    const repo = checkout(MODEL.replace(/\n/gu, "\r\n"));

    run([repo.appPath, "--skill-version", "0.1.0"], repo.root);

    expect(
      parseAppOrigin(fs.readFileSync(repo.originPath, "utf8"))?.appBicepHash
    ).toBe(hashAppBicep(MODEL));
  });

  it("defaults to .radius/app.bicep relative to the working directory", () => {
    const repo = checkout();

    const result = run(["--skill-version", "0.1.0"], repo.root);

    expect(result.status).toBe(0);
    expect(fs.existsSync(repo.originPath)).toBe(true);
  });

  it("records the current time when none is supplied", () => {
    const repo = checkout();
    const before = Date.now();

    run([repo.appPath, "--skill-version", "0.1.0"], repo.root);

    const generatedAt = parseAppOrigin(
      fs.readFileSync(repo.originPath, "utf8")
    )?.generatedAt;
    expect(Date.parse(generatedAt ?? "")).toBeGreaterThanOrEqual(before);
  });

  // SKILL.md can be loaded directly as a plugin skill, in which case nothing
  // substitutes <loaded-skill-version> and the placeholder arrives literally.
  // Recording it would make every later check see a version that can never
  // match, so the script resolves the version itself instead.
  it.each([
    ["no version is passed", [] as string[]],
    ["the flag is given no value", ["--skill-version"]],
    [
      "the prompt placeholder was never substituted",
      ["--skill-version", "<loaded-skill-version>"]
    ]
  ])("falls back to the plugin manifest version when %s", (_label, args) => {
    const repo = checkout();

    const result = run([repo.appPath, ...args], repo.root);

    expect(result.status).toBe(0);
    expect(
      parseAppOrigin(fs.readFileSync(repo.originPath, "utf8"))?.skillVersion
    ).toBe(pluginManifestVersion());
  });

  // The writer and the reader must agree on what "this generator" is called, or
  // every freshly generated model reports itself as generator-changed.
  it("records the same version the extension resolves for itself", () => {
    const repo = checkout();

    run([repo.appPath], repo.root);

    expect(
      parseAppOrigin(fs.readFileSync(repo.originPath, "utf8"))?.skillVersion
    ).toBe(resolveGeneratorVersion());
  });

  it("refuses to write a record for a model it cannot read", () => {
    const repo = checkout();

    const result = run(
      [path.join(repo.root, ".radius", "absent.bicep"), "--skill-version", "1"],
      repo.root
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Cannot read the application model/u);
    expect(fs.existsSync(repo.originPath)).toBe(false);
  });

  it("fails closed when no source commit can be resolved", () => {
    const repo = checkout(MODEL, false);

    const result = run([repo.appPath, "--skill-version", "1"], repo.root);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Cannot resolve the source commit/u);
    expect(fs.existsSync(repo.originPath)).toBe(false);
  });
});
