import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CUSTOM_TYPE_STAGED_FILES,
  REQUIRED_STAGED_FILES,
  STAGING_DIR_PREFIX,
  STAGING_IGNORE_PATTERN,
  STAGING_RUN_RECORD,
  evaluateStagedRun,
  publishableFiles,
  serializeAppOrigin
} from "@radius-project/core";
import { hashAppBicep } from "./app-bicep-hash.js";

// The promote script ships inside the installed plugin, where the workspace
// packages are unavailable, so it re-implements the rules that
// packages/core/src/modeling/app-staging.ts owns. These tests exercise the
// script's real behavior against a real git checkout, and assert that its
// verdicts agree with core's — if the two drift, either a partial run could be
// published or a good run could be refused.

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../plugins/radius/skills/radius-app-bicep/scripts/promote-app-model.mjs"
);

const MODEL =
  "resource app 'Radius.Core/applications@2025-08-01-preview' = {}\n";
const CONFIG = '{\n  "experimentalFeaturesEnabled": {}\n}\n';

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

interface Repo {
  root: string;
  radiusDir: string;
}

function repo(existingModel?: string): Repo {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "promote-app-model-"))
  );
  temporaryDirectories.add(root);
  git(root, ["init", "--quiet", "--initial-branch", "main"]);
  git(root, ["config", "user.email", "radius@example.invalid"]);
  git(root, ["config", "user.name", "Radius Test"]);
  const radiusDir = path.join(root, ".radius");
  fs.mkdirSync(radiusDir, { recursive: true });
  if (existingModel !== undefined) {
    fs.writeFileSync(path.join(radiusDir, "app.bicep"), existingModel);
    fs.writeFileSync(path.join(radiusDir, "bicepconfig.json"), CONFIG);
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "existing model"]);
  } else {
    fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "init"]);
  }
  return { root, radiusDir };
}

function run(
  cwd: string,
  args: string[]
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8"
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

function begin(target: Repo, runId = "test-run"): string {
  const result = run(target.root, ["--begin", "--run-id", runId]);
  expect(result.status).toBe(0);
  return result.stdout;
}

function origin(model: string): string {
  return serializeAppOrigin({
    generatedAt: "2026-08-20T00:00:00.000Z",
    sourceCommit: "a".repeat(40),
    skillVersion: "1.0.0",
    appBicepHash: hashAppBicep(model)
  });
}

// Writes a complete run into the staging directory.
function stageCompleteRun(stagingDir: string, model = MODEL): void {
  fs.writeFileSync(path.join(stagingDir, "app.bicep"), model);
  fs.writeFileSync(path.join(stagingDir, "bicepconfig.json"), CONFIG);
  fs.writeFileSync(path.join(stagingDir, "app.origin.json"), origin(model));
}

function stagedNames(stagingDir: string): string[] {
  return fs
    .readdirSync(stagingDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

function radiusSnapshot(radiusDir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const entry of fs.readdirSync(radiusDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      snapshot[entry.name] = fs.readFileSync(
        path.join(radiusDir, entry.name),
        "utf8"
      );
    }
  }
  return snapshot;
}

function stagedInGit(root: string): string[] {
  return git(root, ["diff", "--cached", "--name-only"])
    .split("\n")
    .filter(Boolean);
}

describe("--begin", () => {
  it("creates a staging directory inside .radius and prints it", () => {
    const target = repo();
    const stagingDir = begin(target);
    expect(path.dirname(stagingDir)).toBe(target.radiusDir);
    expect(path.basename(stagingDir)).toBe(`${STAGING_DIR_PREFIX}test-run`);
    expect(fs.existsSync(stagingDir)).toBe(true);
  });

  it("creates .radius when the repository has none", () => {
    const target = repo();
    fs.rmSync(target.radiusDir, { recursive: true, force: true });
    expect(fs.existsSync(begin(target))).toBe(true);
  });

  // Starting a run writes NOTHING outside its staging directory, including the
  // ignore rule. That is what lets a failed run be byte-identical by
  // construction rather than by a revert that has to be correct.
  it("writes nothing outside the staging directory", () => {
    const target = repo(MODEL);
    const before = radiusSnapshot(target.radiusDir);
    begin(target, "one");
    begin(target, "two");
    expect(radiusSnapshot(target.radiusDir)).toEqual(before);
    expect(fs.existsSync(path.join(target.radiusDir, ".gitignore"))).toBe(
      false
    );
  });

  // A run that finished always removed its own staging directory, so anything
  // still there belongs to an interrupted run and is never a real model.
  it("removes a staging directory left behind by an interrupted run", () => {
    const target = repo();
    const leftover = path.join(target.radiusDir, `${STAGING_DIR_PREFIX}old`);
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, "app.bicep"), "half written\n");
    begin(target);
    expect(fs.existsSync(leftover)).toBe(false);
  });

  it("leaves non-staging entries in .radius alone", () => {
    const target = repo(MODEL);
    begin(target);
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toBe(MODEL);
  });

  it("fingerprints every file the run could replace", () => {
    const target = repo(MODEL);
    const record = JSON.parse(
      fs.readFileSync(path.join(begin(target), STAGING_RUN_RECORD), "utf8")
    ) as { baseline: Record<string, string | null>; runId: string };
    expect(record.baseline["app.bicep"]).toBe(hashAppBicep(MODEL));
    expect(record.baseline["bicepconfig.json"]).toBe(hashAppBicep(CONFIG));
    // A file that does not exist is recorded as absent, which is as meaningful
    // as a hash: one that appears during the run is a change too.
    expect(record.baseline["custom-types.yaml"]).toBeNull();
    expect(record.runId).toBe("test-run");
  });

  it("records every managed file as absent when the repository has no model", () => {
    const record = JSON.parse(
      fs.readFileSync(path.join(begin(repo()), STAGING_RUN_RECORD), "utf8")
    ) as { baseline: Record<string, string | null> };
    expect(Object.values(record.baseline).every((hash) => hash === null)).toBe(
      true
    );
  });

  it("sanitizes a run id that would escape .radius", () => {
    const target = repo();
    const stagingDir = run(target.root, [
      "--begin",
      "--run-id",
      "../../etc"
    ]).stdout;
    expect(path.dirname(stagingDir)).toBe(target.radiusDir);
  });

  // Two runs sharing one directory name would sweep each other away, and the
  // sweep cannot tell a live run from an abandoned one.
  it("gives each run its own directory when no run id is given", () => {
    const target = repo();
    const first = run(target.root, ["--begin"]).stdout;
    const second = run(target.root, ["--begin"]).stdout;
    expect(path.basename(first)).toMatch(
      new RegExp(`^\\${STAGING_DIR_PREFIX}.+`)
    );
    expect(first).not.toBe(second);
  });
});

describe("publish", () => {
  it("publishes a complete run and stages it in git", () => {
    const target = repo();
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);

    const result = run(target.root, ["--staging", stagingDir]);

    expect(result.status).toBe(0);
    expect(fs.existsSync(stagingDir)).toBe(false);
    for (const file of REQUIRED_STAGED_FILES) {
      expect(fs.existsSync(path.join(target.radiusDir, file))).toBe(true);
    }
    expect(stagedInGit(target.root)).toEqual(
      expect.arrayContaining([
        ".radius/app.bicep",
        ".radius/bicepconfig.json",
        ".radius/app.origin.json",
        ".radius/.gitignore"
      ])
    );
  });

  it("publishes supporting custom-type artifacts alongside the required set", () => {
    const target = repo();
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    for (const file of CUSTOM_TYPE_STAGED_FILES) {
      fs.writeFileSync(path.join(stagingDir, file), "artifact");
    }
    fs.writeFileSync(
      path.join(stagingDir, "custom-recipe-pack.bicep"),
      "pack\n"
    );

    expect(run(target.root, ["--staging", stagingDir]).status).toBe(0);
    for (const file of [
      ...CUSTOM_TYPE_STAGED_FILES,
      "custom-recipe-pack.bicep"
    ]) {
      expect(fs.existsSync(path.join(target.radiusDir, file))).toBe(true);
    }
    // Run bookkeeping is never published.
    expect(fs.existsSync(path.join(target.radiusDir, STAGING_RUN_RECORD))).toBe(
      false
    );
  });

  it.each(REQUIRED_STAGED_FILES)(
    "refuses a run missing %s and leaves .radius byte-identical",
    (missing) => {
      const target = repo(MODEL);
      const before = radiusSnapshot(target.radiusDir);
      const stagingDir = begin(target);
      stageCompleteRun(stagingDir);
      fs.rmSync(path.join(stagingDir, missing));

      const result = run(target.root, ["--staging", stagingDir]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(missing);
      expect(result.stderr).toContain("Nothing was written");
      expect(fs.existsSync(stagingDir)).toBe(false);
      expect(radiusSnapshot(target.radiusDir)).toEqual(before);
      expect(stagedInGit(target.root)).toEqual([]);
    }
  );

  it("refuses a custom-type run whose published package never arrived", () => {
    const target = repo();
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    fs.writeFileSync(path.join(stagingDir, "custom-types.yaml"), "types");

    const result = run(target.root, ["--staging", stagingDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("custom-types.tgz");
  });

  it("refuses an empty staged model", () => {
    const target = repo();
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    fs.writeFileSync(path.join(stagingDir, "app.bicep"), "   \n");

    const result = run(target.root, ["--staging", stagingDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("empty");
  });

  // The origin record is only written after the Bicep checker passes, so a run
  // with no usable record is a model that was never proven to compile.
  it.each([
    ["no record content", ""],
    ["malformed JSON", "{"],
    ["a record without a hash", '{"generatedAt":"now"}']
  ])("refuses a run with %s", (_label, originText) => {
    const target = repo();
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    fs.writeFileSync(path.join(stagingDir, "app.origin.json"), originText);

    const result = run(target.root, ["--staging", stagingDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("origin record");
    expect(fs.existsSync(path.join(target.radiusDir, "app.bicep"))).toBe(false);
  });

  it("refuses a run whose model changed after it was recorded", () => {
    const target = repo();
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    fs.writeFileSync(path.join(stagingDir, "app.bicep"), "edited after\n");

    const result = run(target.root, ["--staging", stagingDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Bicep checker");
  });

  it("refuses when the user edited the model while the run was in progress", () => {
    const target = repo(MODEL);
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    const handEdited = `${MODEL}// hand edited\n`;
    fs.writeFileSync(path.join(target.radiusDir, "app.bicep"), handEdited);

    const result = run(target.root, ["--staging", stagingDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("changed while modeling was running");
    expect(result.stderr).toContain("intact");
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toBe(handEdited);
    expect(fs.existsSync(stagingDir)).toBe(false);
    expect(stagedInGit(target.root)).toEqual([]);
  });

  it("refuses when a model appeared during a run that started with none", () => {
    const target = repo();
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    fs.writeFileSync(path.join(target.radiusDir, "app.bicep"), "appeared\n");

    expect(run(target.root, ["--staging", stagingDir]).status).toBe(1);
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toBe("appeared\n");
  });

  it("ignores staging directories once the run publishes", () => {
    const target = repo();
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);

    expect(run(target.root, ["--staging", stagingDir]).status).toBe(0);

    const ignore = fs.readFileSync(
      path.join(target.radiusDir, ".gitignore"),
      "utf8"
    );
    expect(
      ignore
        .split("\n")
        .filter((line) => line.trim() === STAGING_IGNORE_PATTERN)
    ).toHaveLength(1);
    expect(stagedInGit(target.root)).toContain(".radius/.gitignore");
  });

  it("appends the ignore rule without disturbing an existing file", () => {
    const target = repo();
    fs.writeFileSync(path.join(target.radiusDir, ".gitignore"), "*.tmp");
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);

    expect(run(target.root, ["--staging", stagingDir]).status).toBe(0);

    expect(
      fs.readFileSync(path.join(target.radiusDir, ".gitignore"), "utf8")
    ).toBe(`*.tmp\n${STAGING_IGNORE_PATTERN}\n`);
  });

  it("leaves an ignore file alone when it already has the rule", () => {
    const target = repo();
    const original = `${STAGING_IGNORE_PATTERN}\n*.tmp\n`;
    fs.writeFileSync(path.join(target.radiusDir, ".gitignore"), original);
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);

    expect(run(target.root, ["--staging", stagingDir]).status).toBe(0);

    expect(
      fs.readFileSync(path.join(target.radiusDir, ".gitignore"), "utf8")
    ).toBe(original);
  });

  // The lost-record case: the refusal claims `.radius/` is byte-identical, and
  // it must actually be, with nothing left over for a revert to have to undo.
  it("leaves .radius byte-identical when the run record is gone", () => {
    const target = repo(MODEL);
    const before = radiusSnapshot(target.radiusDir);
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    fs.rmSync(path.join(stagingDir, STAGING_RUN_RECORD));

    const result = run(target.root, ["--staging", stagingDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Nothing was written");
    expect(radiusSnapshot(target.radiusDir)).toEqual(before);
    expect(fs.existsSync(path.join(target.radiusDir, ".gitignore"))).toBe(
      false
    );
    expect(stagedInGit(target.root)).toEqual([]);
  });

  it("refuses when the run record was lost", () => {
    const target = repo(MODEL);
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    fs.rmSync(path.join(stagingDir, STAGING_RUN_RECORD));

    expect(run(target.root, ["--staging", stagingDir]).status).toBe(1);
  });

  it("refuses when the run record is malformed", () => {
    const target = repo();
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    fs.writeFileSync(path.join(stagingDir, STAGING_RUN_RECORD), "{");
    fs.writeFileSync(path.join(target.radiusDir, "app.bicep"), "appeared\n");

    expect(run(target.root, ["--staging", stagingDir]).status).toBe(1);
  });

  // Without the run record there is no evidence of what `.radius/` held when
  // the run started, which is what makes `--begin` mandatory rather than
  // merely recommended.
  it("refuses a staging directory an agent assembled without --begin", () => {
    const target = repo(MODEL);
    const before = radiusSnapshot(target.radiusDir);
    const stagingDir = path.join(target.radiusDir, `${STAGING_DIR_PREFIX}hand`);
    fs.mkdirSync(stagingDir);
    stageCompleteRun(stagingDir);

    const result = run(target.root, ["--staging", stagingDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--begin");
    expect(radiusSnapshot(target.radiusDir)).toEqual(before);
  });

  it("refuses a run whose record was tampered with", () => {
    const target = repo();
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    fs.writeFileSync(
      path.join(stagingDir, STAGING_RUN_RECORD),
      JSON.stringify({ baseline: "not-an-object" })
    );

    expect(run(target.root, ["--staging", stagingDir]).status).toBe(1);
  });

  it("refuses when a supporting file was edited during the run", () => {
    const target = repo(MODEL);
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    const edited = '{"hand":"tuned"}\n';
    fs.writeFileSync(path.join(target.radiusDir, "bicepconfig.json"), edited);

    const result = run(target.root, ["--staging", stagingDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".radius/bicepconfig.json");
    expect(
      fs.readFileSync(path.join(target.radiusDir, "bicepconfig.json"), "utf8")
    ).toBe(edited);
  });

  it("does not publish files it does not recognize", () => {
    const target = repo();
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    fs.writeFileSync(path.join(stagingDir, "notes.md"), "scratch\n");
    fs.writeFileSync(path.join(stagingDir, ".env"), "TOKEN=secret\n");

    expect(run(target.root, ["--staging", stagingDir]).status).toBe(0);
    expect(fs.existsSync(path.join(target.radiusDir, "notes.md"))).toBe(false);
    expect(fs.existsSync(path.join(target.radiusDir, ".env"))).toBe(false);
    expect(stagedInGit(target.root)).not.toContain(".radius/.env");
  });

  // Each rename is atomic; the set of them is not. A destination that cannot be
  // replaced has to be found before anything moves.
  it("refuses rather than half-publishing when a destination is not a file", () => {
    const target = repo(MODEL);
    const before = radiusSnapshot(target.radiusDir);
    // A directory where a published file goes, in a repository whose managed
    // files are otherwise exactly as the run found them.
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    fs.mkdirSync(path.join(target.radiusDir, "custom-recipe-pack.bicep"));
    fs.writeFileSync(
      path.join(stagingDir, "custom-recipe-pack.bicep"),
      "pack\n"
    );

    const result = run(target.root, ["--staging", stagingDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a regular file");
    // The model that was already there is untouched, not replaced by the run.
    expect(
      fs.readFileSync(path.join(target.radiusDir, "app.bicep"), "utf8")
    ).toBe(before["app.bicep"]);
    expect(stagedInGit(target.root)).toEqual([]);
  });

  it("reports a distinct status when the files are published but not staged", () => {
    const target = repo();
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);
    fs.rmSync(path.join(target.root, ".git"), { recursive: true, force: true });

    const result = run(target.root, ["--staging", stagingDir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("NOT staged");
    expect(fs.existsSync(path.join(target.radiusDir, "app.bicep"))).toBe(true);
  });

  // Confinement is not lexical only: a symlink named like a staging directory
  // must never be followed, written through, or published from.
  it("refuses a staging path that is a symlink", () => {
    const target = repo();
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "promote-outside-"))
    );
    temporaryDirectories.add(outside);
    stageCompleteRun(outside);
    const link = path.join(target.radiusDir, `${STAGING_DIR_PREFIX}link`);
    fs.symlinkSync(outside, link);

    const result = run(target.root, ["--staging", link]);

    expect(result.status).toBe(1);
    expect(fs.existsSync(path.join(target.radiusDir, "app.bicep"))).toBe(false);
    // The linked-to directory is not deleted either.
    expect(fs.existsSync(path.join(outside, "app.bicep"))).toBe(true);
  });

  it("does not delete through a symlink while sweeping up leftovers", () => {
    const target = repo();
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "promote-outside-"))
    );
    temporaryDirectories.add(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep\n");
    fs.symlinkSync(
      outside,
      path.join(target.radiusDir, `${STAGING_DIR_PREFIX}link`)
    );

    begin(target);

    expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
  });

  it("requires a staging directory", () => {
    const target = repo();
    const result = run(target.root, []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--staging");
  });

  // Path confinement: the publish moves files, so a directory outside
  // `.radius/` must never be accepted as a run to publish.
  it.each([
    ["a directory outside .radius", (target: Repo) => target.root],
    [
      "a non-staging directory inside .radius",
      (target: Repo) => path.join(target.radiusDir, "somewhere")
    ],
    [
      "a nested staging-looking directory",
      (target: Repo) =>
        path.join(target.radiusDir, "nested", `${STAGING_DIR_PREFIX}x`)
    ]
  ])("rejects %s", (_label, resolveDir) => {
    const target = repo();
    const result = run(target.root, ["--staging", resolveDir(target)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be a");
  });

  it("reports a staging directory that does not exist", () => {
    const target = repo();
    const result = run(target.root, [
      "--staging",
      path.join(target.radiusDir, `${STAGING_DIR_PREFIX}gone`)
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No staged modeling run");
  });

  it("honors an explicit --radius-dir", () => {
    const target = repo();
    const stagingDir = run(target.root, [
      "--begin",
      "--radius-dir",
      target.radiusDir
    ]).stdout;
    stageCompleteRun(stagingDir);
    expect(
      run(os.tmpdir(), [
        "--staging",
        stagingDir,
        "--radius-dir",
        target.radiusDir
      ]).status
    ).toBe(0);
  });

  it("does not stage an ignore file this run did not write", () => {
    const target = repo();
    fs.writeFileSync(
      path.join(target.radiusDir, ".gitignore"),
      `${STAGING_IGNORE_PATTERN}\n`
    );
    git(target.root, ["add", "."]);
    git(target.root, ["commit", "--quiet", "-m", "ignore"]);
    fs.appendFileSync(path.join(target.radiusDir, ".gitignore"), "*.user\n");
    const stagingDir = begin(target);
    stageCompleteRun(stagingDir);

    expect(run(target.root, ["--staging", stagingDir]).status).toBe(0);
    // The user's unrelated edit is left unstaged rather than committed on
    // their behalf.
    expect(stagedInGit(target.root)).not.toContain(".radius/.gitignore");
  });
});

describe("--abort", () => {
  it("discards the run and leaves .radius byte-identical", () => {
    const target = repo(MODEL);
    const before = radiusSnapshot(target.radiusDir);
    const stagingDir = begin(target);
    fs.writeFileSync(path.join(stagingDir, "app.bicep"), "half written\n");

    const result = run(target.root, ["--abort", "--staging", stagingDir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Nothing was written");
    expect(fs.existsSync(stagingDir)).toBe(false);
    expect(radiusSnapshot(target.radiusDir)).toEqual(before);
    expect(stagedInGit(target.root)).toEqual([]);
  });

  it("leaves an ignore file the user wrote during the run alone", () => {
    const target = repo(MODEL);
    const stagingDir = begin(target);
    const userEdit = "*.log\n";
    fs.writeFileSync(path.join(target.radiusDir, ".gitignore"), userEdit);

    run(target.root, ["--abort", "--staging", stagingDir]);

    expect(
      fs.readFileSync(path.join(target.radiusDir, ".gitignore"), "utf8")
    ).toBe(userEdit);
  });

  it("is safe to run twice", () => {
    const target = repo();
    const stagingDir = begin(target);
    expect(run(target.root, ["--abort", "--staging", stagingDir]).status).toBe(
      0
    );
    expect(run(target.root, ["--abort", "--staging", stagingDir]).status).toBe(
      0
    );
  });

  it("rejects a directory outside .radius", () => {
    const target = repo();
    const result = run(target.root, ["--abort", "--staging", target.root]);
    expect(result.status).toBe(1);
    expect(fs.existsSync(target.root)).toBe(true);
  });

  it("requires a staging directory", () => {
    expect(run(repo().root, ["--abort"]).status).toBe(1);
  });
});

// The script re-implements core's rules. These cases assert both reach the same
// verdict, which is the contract that keeps them from drifting.
describe("agreement with the core rules", () => {
  const cases: Array<{
    name: string;
    stage: (stagingDir: string, radiusDir: string) => void;
    existingModel?: string;
  }> = [
    { name: "a complete run", stage: (dir) => stageCompleteRun(dir) },
    {
      name: "an incomplete run",
      stage: (dir) => {
        stageCompleteRun(dir);
        fs.rmSync(path.join(dir, "bicepconfig.json"));
      }
    },
    {
      name: "a run with a mismatched origin record",
      stage: (dir) => {
        stageCompleteRun(dir);
        fs.writeFileSync(path.join(dir, "app.bicep"), "changed\n");
      }
    },
    {
      name: "an edit to the model during the run",
      existingModel: MODEL,
      stage: (dir, radiusDir) => {
        stageCompleteRun(dir);
        fs.writeFileSync(path.join(radiusDir, "app.bicep"), "edited\n");
      }
    },
    {
      name: "an edit to a supporting file during the run",
      existingModel: MODEL,
      stage: (dir, radiusDir) => {
        stageCompleteRun(dir);
        fs.writeFileSync(
          path.join(radiusDir, "bicepconfig.json"),
          '{"edited":true}\n'
        );
      }
    },
    {
      name: "a run with unexpected files in the staging directory",
      stage: (dir) => {
        stageCompleteRun(dir);
        fs.writeFileSync(path.join(dir, "notes.md"), "scratch\n");
      }
    }
  ];

  it.each(cases)("agrees on $name", ({ stage, existingModel }) => {
    const target = repo(existingModel);
    const stagingDir = begin(target);
    stage(stagingDir, target.radiusDir);

    const record = JSON.parse(
      fs.readFileSync(path.join(stagingDir, STAGING_RUN_RECORD), "utf8")
    ) as { baseline: Record<string, string | null> };
    const staged = stagedNames(stagingDir);
    const read = (dir: string, name: string): string | null => {
      const file = path.join(dir, name);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    };
    const currentHashes: Record<string, string | null> = {};
    for (const name of Object.keys(record.baseline)) {
      const content = read(target.radiusDir, name);
      currentHashes[name] = content === null ? null : hashAppBicep(content);
    }
    const core = evaluateStagedRun({
      stagedFiles: staged,
      appBicep: read(stagingDir, "app.bicep"),
      originText: read(stagingDir, "app.origin.json"),
      record,
      currentHashes,
      hashAppBicep
    });

    const result = run(target.root, ["--staging", stagingDir]);

    expect(result.status === 0).toBe(core.publishable);
    if (core.publishable) {
      expect(publishableFiles(staged)).toEqual(
        expect.arrayContaining(
          fs
            .readdirSync(target.radiusDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name !== ".gitignore")
            .map((entry) => entry.name)
        )
      );
    }
  });
});
