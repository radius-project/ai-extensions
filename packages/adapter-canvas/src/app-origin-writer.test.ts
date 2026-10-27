import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateAppModelFreshness,
  parseAppOrigin,
  serializeAppOrigin
} from "@radius-project/core";
import { RADIUS_EXTENSION_REGISTRY } from "@radius-project/adapter-shared";
import { hashAppBicep } from "./app-bicep-hash.js";
import { resolveGeneratorVersion } from "./generator-version.js";

// The origin writer ships inside the installed plugin, where the workspace
// packages are unavailable, so it re-implements the hash that
// packages/core/src/modeling/app-origin.ts reads back. These tests are the
// contract between the two copies: if they drift, the canvas would report every
// freshly generated model as hand-edited.
//
// They also pin the other half of that contract, which is the version. The
// writer records only what it is handed, so the value the canvas resolves for
// itself has to survive the round trip through --skill-version unchanged; a
// writer that worked the version out on its own instead is what reported models
// as permanently stale in #694.

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../extensions/radius/skills/radius-app-bicep/scripts/write-app-origin.mjs"
);

const MODEL =
  "resource app 'Radius.Core/applications@2025-08-01-preview' = {}\n";

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

// The pin show-radius-type.mjs writes for a stable 0.60 CLI. Built from the
// adapter's own registry constant, so a writer whose copy of the registry
// drifted would stop finding the version in it.
const PIN_0_60 = `${RADIUS_EXTENSION_REGISTRY}:0.60`;

function bicepConfig(radius: unknown): string {
  return `${JSON.stringify(
    {
      experimentalFeaturesEnabled: { extensibility: true },
      extensions: { radius, customTypes: "./custom-types.tgz" }
    },
    null,
    2
  )}\n`;
}

function checkout(
  model = MODEL,
  withCommit = true,
  config: string | null = bicepConfig(PIN_0_60)
): Checkout {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "app-origin-"))
  );
  temporaryDirectories.add(root);
  fs.mkdirSync(path.join(root, ".radius"));
  const appPath = path.join(root, ".radius", "app.bicep");
  fs.writeFileSync(appPath, model);
  if (config !== null) {
    fs.writeFileSync(path.join(root, ".radius", "bicepconfig.json"), config);
  }
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

// A second installed copy of the plugin: the same script, at the same place
// inside the same directory layout, under a manifest naming a different
// version. This is the shape of the machine in #694, where the canvas ran one
// copy and the agent launched the other.
function duplicatePlugin(version: string): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "radius-plugin-"))
  );
  temporaryDirectories.add(root);
  const scripts = path.join(root, "skills", "radius-app-bicep", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "radius", version })
  );
  fs.copyFileSync(script, path.join(scripts, "write-app-origin.mjs"));
  return root;
}

function run(args: string[], cwd: string, entry = script) {
  return spawnSync(process.execPath, [entry, ...args], {
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
      radiusVersion: "0.60",
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
        radiusVersion: "0.60",
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

  // The writer records the version it is HANDED and never works one out. A
  // version discovered from this script's own location is a real version, just
  // not necessarily the running one: two copies of the plugin can be installed
  // with identical layouts and different versions, and a guess then disagrees
  // with the canvas permanently. Blank is a designed value — the reader skips
  // the generator check for it — so it is the honest thing to record when
  // nobody told us (#694).
  it.each([
    ["no version is passed", [] as string[]],
    ["the flag is given no value", ["--skill-version"]],
    [
      "the prompt placeholder was never substituted",
      ["--skill-version", "<loaded-skill-version>"]
    ]
  ])("records no version at all when %s", (_label, args) => {
    const repo = checkout();

    const result = run([repo.appPath, ...args], repo.root);

    expect(result.status).toBe(0);
    expect(
      parseAppOrigin(fs.readFileSync(repo.originPath, "utf8"))?.skillVersion
    ).toBe("");
  });

  // Recording blank is correct but must not be silent: the likeliest cause is a
  // caller that should have passed a version, and an unexplained blank switches
  // the generator comparison off for this model with nothing to show for it.
  // The two causes need different fixes, so the warning names which one it was
  // rather than claiming no flag was supplied when one was.
  it("warns that no version value reached it", () => {
    const repo = checkout();

    const result = run([repo.appPath], repo.root);

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/no --skill-version value was supplied/u);
  });

  it("names the placeholder as the cause when the prompt never substituted it", () => {
    const repo = checkout();

    const result = run(
      [repo.appPath, "--skill-version", "<loaded-skill-version>"],
      repo.root
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("<loaded-skill-version>");
    expect(result.stderr).not.toMatch(/no --skill-version value was supplied/u);
  });

  // The warning is advisory. A version that WAS supplied is recorded without
  // complaint, so a correct run stays quiet.
  it("says nothing when a version was supplied", () => {
    const repo = checkout();

    const result = run([repo.appPath, "--skill-version", "0.1.0"], repo.root);

    expect(result.stderr).toBe("");
  });

  // A blank version is not a broken record. It has to stay readable, or the
  // model would report as unverified on every graph open, which is worse than
  // losing the generator comparison for it.
  it("still writes a record the core parser accepts when no version is passed", () => {
    const repo = checkout();

    run(
      [repo.appPath, "--generated-at", "2026-08-11T05:32:32.000Z"],
      repo.root
    );

    expect(parseAppOrigin(fs.readFileSync(repo.originPath, "utf8"))).toEqual({
      generatedAt: "2026-08-11T05:32:32.000Z",
      sourceCommit: repo.commit,
      skillVersion: "",
      radiusVersion: "0.60",
      appBicepHash: hashAppBicep(MODEL)
    });
  });

  // The scenario the writer must not reproduce: the script runs from one
  // installed copy of the plugin while the canvas runs another. Copying the
  // script into a plugin layout whose manifest names a different version proves
  // the script no longer adopts the version sitting next to it.
  it("ignores the manifest of whichever plugin copy it is launched from", () => {
    const repo = checkout();
    const scripts = path.join(
      duplicatePlugin("9.9.9-other-copy"),
      "skills",
      "radius-app-bicep",
      "scripts"
    );

    const result = run(
      [repo.appPath, "--skill-version", "0.0.0"],
      repo.root,
      path.join(scripts, "write-app-origin.mjs")
    );

    expect(result.status).toBe(0);
    expect(
      parseAppOrigin(fs.readFileSync(repo.originPath, "utf8"))?.skillVersion
    ).toBe("0.0.0");
  });

  // Same duplicated-install layout, but with nothing handed to the writer. The
  // old fallback stamped 9.9.9-other-copy here, which the canvas then compared
  // against its own version forever.
  it("records nothing rather than the launching copy's version", () => {
    const repo = checkout();
    const scripts = path.join(
      duplicatePlugin("9.9.9-other-copy"),
      "skills",
      "radius-app-bicep",
      "scripts"
    );

    run([repo.appPath], repo.root, path.join(scripts, "write-app-origin.mjs"));

    expect(
      parseAppOrigin(fs.readFileSync(repo.originPath, "utf8"))?.skillVersion
    ).toBe("");
  });

  // The end-to-end shape of the contract: the canvas resolves one version, hands
  // it to the writer, and later compares the record against the same value. As
  // long as that one value makes the round trip, a freshly generated model reads
  // as current — which is what the duplicated install broke.
  it("reports a model as up to date when the canvas's own version made the round trip", () => {
    const repo = checkout();
    const installed = resolveGeneratorVersion();

    run([repo.appPath, "--skill-version", installed], repo.root);

    const result = evaluateAppModelFreshness({
      model: MODEL,
      originText: fs.readFileSync(repo.originPath, "utf8"),
      headCommit: repo.commit,
      generatorVersion: installed,
      hashAppBicep
    });

    expect(result.status).toBe("up-to-date");
    expect(result.stale).toBe(false);
  });

  it.each([
    ["a stable release", "0.60", "0.60"],
    ["a prerelease", "0.61.0-rc1", "0.61.0-rc1"],
    ["an edge build", "latest", "latest"]
  ])(
    "records the Radius version of %s from the pin beside the model",
    (_label, tag, expected) => {
      const repo = checkout(
        MODEL,
        true,
        bicepConfig(`  ${RADIUS_EXTENSION_REGISTRY}:${tag}  `)
      );

      const result = run([repo.appPath, "--skill-version", "1"], repo.root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(
        parseAppOrigin(fs.readFileSync(repo.originPath, "utf8"))?.radiusVersion
      ).toBe(expected);
    }
  );

  // Like a blank skillVersion, a blank radiusVersion only switches one
  // comparison off. The record is still written, because without it the model
  // would read as unverified on every graph open. The warning says which of the
  // causes it was, since each needs a different fix.
  it.each([
    ["there is no bicepconfig.json", null, /bicepconfig\.json does not exist/u],
    [
      "bicepconfig.json is not JSON",
      "{ not json",
      /bicepconfig\.json could not be read as JSON/u
    ],
    [
      "bicepconfig.json is JSON null",
      "null",
      /bicepconfig\.json does not pin extensions\.radius/u
    ],
    [
      "the pin is missing",
      `${JSON.stringify({ extensions: {} })}\n`,
      /does not pin extensions\.radius/u
    ],
    ["the pin is blank", bicepConfig("  "), /does not pin extensions\.radius/u],
    [
      "the pin is not a string",
      bicepConfig(60),
      /does not pin extensions\.radius/u
    ],
    [
      "the pin names another registry",
      bicepConfig("br:example.invalid/radius:0.60"),
      /"br:example\.invalid\/radius:0\.60", which is not a br:biceptypes\.azurecr\.io\/radius:<version> reference/u
    ],
    [
      "the pin is a local package",
      bicepConfig("./radius.tgz"),
      /which is not a br:biceptypes\.azurecr\.io\/radius:<version> reference/u
    ],
    [
      "the pin has no version",
      bicepConfig(`${RADIUS_EXTENSION_REGISTRY}:`),
      /which is not a br:biceptypes\.azurecr\.io\/radius:<version> reference/u
    ]
  ])(
    "records an unknown Radius version with a warning when %s",
    (_label, config, warning) => {
      const repo = checkout(MODEL, true, config);

      const result = run([repo.appPath, "--skill-version", "1"], repo.root);

      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(warning);
      expect(result.stderr).toMatch(
        /skip the Radius version comparison for this model/u
      );
      expect(
        parseAppOrigin(fs.readFileSync(repo.originPath, "utf8"))
      ).toMatchObject({ radiusVersion: "", skillVersion: "1" });
    }
  );

  // The installed CLI and the record have to describe the version in the same
  // form, or every model would read as needing a refresh.
  it("reports a model as up to date when the installed CLI uses the recorded Radius version", () => {
    const repo = checkout();

    run([repo.appPath, "--skill-version", "1"], repo.root);

    expect(
      evaluateAppModelFreshness({
        model: MODEL,
        originText: fs.readFileSync(repo.originPath, "utf8"),
        headCommit: repo.commit,
        generatorVersion: "1",
        radiusVersion: "0.60",
        hashAppBicep
      }).status
    ).toBe("up-to-date");
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
