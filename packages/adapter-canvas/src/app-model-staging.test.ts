import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashAppBicep } from "./app-bicep-hash.js";
import {
  beginManagedRun,
  type ManagedModelStaging,
  type ObservedModelFile
} from "./app-model-staging.js";
import { createDeferred } from "../test/support/browser/fakes.js";

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

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// A git checkout, with a committed model in .radius/ when `files` names one.
function repo(files: Record<string, string> = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "managed-model-run-"))
  );
  temporaryDirectories.add(root);
  git(root, ["init", "--quiet", "--initial-branch", "main"]);
  git(root, ["config", "user.email", "radius@example.invalid"]);
  git(root, ["config", "user.name", "Radius Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  const radiusDir = path.join(root, ".radius");
  fs.mkdirSync(radiusDir);
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  for (const [name, text] of Object.entries(files))
    fs.writeFileSync(path.join(radiusDir, name), text);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "init"]);
  return { root, radiusDir };
}

function read(dir: string, name: string): string | undefined {
  const file = path.join(dir, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
}

// Stands in for the stage's check: it writes the origin record of the model
// and the Bicep configuration, as the skills' check does.
async function check(dir: string): Promise<void> {
  const model = read(dir, "app.bicep") ?? "";
  fs.writeFileSync(path.join(dir, "bicepconfig.json"), CONFIG);
  fs.writeFileSync(
    path.join(dir, "app.origin.json"),
    JSON.stringify({ appBicepHash: hashAppBicep(model), stage: "model" })
  );
}

function promote(run: ManagedModelStaging) {
  return run.promote(
    async () => {},
    () => {}
  );
}

function stagedInGit(root: string): string[] {
  return git(root, ["diff", "--cached", "--name-status"])
    .split("\n")
    .filter(Boolean);
}

describe("managed model runs", () => {
  it("starts a run in the layout of the skills' staged runs and hides it from git", () => {
    const { root, radiusDir } = repo({
      "app.bicep": "original model",
      "bicepconfig.json": CONFIG,
      "postgres-recipe.bicep": "recipe",
      "notes.md": "not published"
    });

    const run = beginManagedRun(root);

    expect(path.dirname(run.stagingDir)).toBe(radiusDir);
    expect(path.basename(run.stagingDir)).toMatch(/^\.staging-managed-/u);
    expect(fs.readdirSync(run.stagingDir).sort()).toEqual([
      ".gitignore",
      "app.bicep",
      "bicepconfig.json",
      "postgres-recipe.bicep",
      "run.json",
      "start.bicep"
    ]);
    expect(read(run.stagingDir, ".gitignore")).toBe("*\n");
    expect(read(run.stagingDir, "start.bicep")).toBe("original model");
    expect(JSON.parse(read(run.stagingDir, "run.json") ?? "")).toEqual({
      version: 1,
      startedAt: expect.any(String),
      baseline: {
        "app.bicep": sha256("original model"),
        "bicepconfig.json": sha256(CONFIG),
        "postgres-recipe.bicep": sha256("recipe")
      }
    });
    expect(git(root, ["status", "--porcelain", "--untracked-files=all"])).toBe(
      ""
    );
  });

  it("checks a copy with its own bookkeeping, then publishes it and removes the files that the run deleted", async () => {
    const { root, radiusDir } = repo({
      "app.bicep": "original model",
      "bicepconfig.json": CONFIG,
      "custom-types.yaml": "types",
      "custom-types.tgz": "extension"
    });
    fs.writeFileSync(path.join(root, ".gitignore"), "*.tgz\n");
    const run = beginManagedRun(root);
    const record = read(run.stagingDir, "run.json");
    fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), MODEL);
    fs.rmSync(path.join(run.stagingDir, "custom-types.yaml"));
    fs.rmSync(path.join(run.stagingDir, "custom-types.tgz"));
    fs.writeFileSync(path.join(run.stagingDir, "run.json"), "{}");

    let copy = "";
    await run.validate(async (dir) => {
      copy = dir;
      expect(path.dirname(dir)).toBe(radiusDir);
      expect(read(dir, "run.json")).toBe(record);
      expect(read(dir, "start.bicep")).toBe("original model");
      await check(dir);
    });

    await expect(promote(run)).resolves.toEqual({
      published: ["app.bicep", "app.origin.json", "bicepconfig.json"].map(
        (name) => path.join(radiusDir, name)
      ),
      gitError: ""
    });
    expect(read(radiusDir, "app.bicep")).toBe(MODEL);
    expect(read(radiusDir, "custom-types.yaml")).toBeUndefined();
    expect(read(radiusDir, ".gitignore")).toBe(".staging-*/\n");
    expect(fs.existsSync(run.stagingDir)).toBe(false);
    expect(fs.existsSync(copy)).toBe(false);
    expect(stagedInGit(root)).toEqual([
      "A\t.radius/.gitignore",
      "M\t.radius/app.bicep",
      "A\t.radius/app.origin.json",
      "D\t.radius/custom-types.tgz",
      "D\t.radius/custom-types.yaml"
    ]);
  });

  it("reports a published model even when its validation copy cannot be removed", async () => {
    const { root, radiusDir } = repo({
      "app.bicep": "original model",
      "bicepconfig.json": CONFIG
    });
    const run = beginManagedRun(root);
    fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), MODEL);
    let copy = "";
    await run.validate(async (dir) => {
      copy = dir;
      await check(dir);
    });
    const rm = fs.rmSync;
    const rmSpy = vi
      .spyOn(fs, "rmSync")
      .mockImplementation((target, options) => {
        if (target === copy) throw new Error("EBUSY: resource busy or locked");
        rm(target, options);
      });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    syncBuiltinESMExports();
    try {
      await expect(promote(run)).resolves.toMatchObject({ gitError: "" });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("could not be removed (EBUSY")
      );
    } finally {
      rmSpy.mockRestore();
      error.mockRestore();
      syncBuiltinESMExports();
    }
    expect(read(radiusDir, "app.bicep")).toBe(MODEL);
  });

  it.each([
    ["an edited model", "app.bicep", "user edit"],
    ["a new Recipe", "postgres-recipe.bicep", "user recipe"]
  ])(
    "keeps %s that appeared in .radius/ during the run, even when the staged run.json was edited",
    async (_label, name, text) => {
      const { root, radiusDir } = repo({ "app.bicep": "original" });
      const run = beginManagedRun(root);
      fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), MODEL);
      fs.writeFileSync(path.join(run.stagingDir, name), MODEL);
      fs.writeFileSync(path.join(radiusDir, name), text);
      fs.writeFileSync(
        path.join(run.stagingDir, "run.json"),
        JSON.stringify({ baseline: {} })
      );
      expect(() => run.assertBaseline()).toThrow(
        `Managed model files changed while modeling: ${name}.`
      );
      await run.validate(check);

      await expect(promote(run)).rejects.toThrow("changed while modeling");
      expect(read(radiusDir, name)).toBe(text);
      expect(stagedInGit(root)).toEqual([]);
    }
  );

  it("refuses to start or publish when a model file that the canvas observed changed", async () => {
    const { root, radiusDir } = repo();
    const legacy = path.join(root, "app.bicep");
    fs.writeFileSync(legacy, "legacy model");
    const observed: ObservedModelFile[] = [
      { path: "app.bicep", hash: sha256("legacy model") },
      { path: "app.origin.json", hash: null }
    ];
    fs.writeFileSync(legacy, "saved edit");
    expect(() => beginManagedRun(root, observed)).toThrow(
      "changed while modeling: app.bicep"
    );
    fs.writeFileSync(legacy, "legacy model");

    const run = beginManagedRun(root, observed);
    fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), MODEL);
    await run.validate(check);
    await expect(
      run.promote(
        async () => {
          fs.writeFileSync(path.join(root, "app.origin.json"), "{}");
        },
        () => {}
      )
    ).rejects.toThrow("changed while modeling: app.origin.json");
    expect(read(radiusDir, "app.bicep")).toBeUndefined();

    fs.rmSync(path.join(root, "app.origin.json"));
    const refresh = beginManagedRun(root, observed);
    fs.writeFileSync(path.join(refresh.stagingDir, "app.bicep"), MODEL);
    await refresh.validate(check);
    await promote(refresh);
    expect(read(radiusDir, "app.bicep")).toBe(MODEL);
    expect(fs.readFileSync(legacy, "utf8")).toBe("legacy model");
  });

  it.each(["copy", "staging directory"])(
    "refuses a model that changed in the %s during validation",
    async (where) => {
      const { root, radiusDir } = repo({ "app.bicep": "original" });
      const run = beginManagedRun(root);
      fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), MODEL);
      await expect(
        run.validate(async (dir) => {
          await check(dir);
          fs.appendFileSync(
            path.join(where === "copy" ? dir : run.stagingDir, "app.bicep"),
            "// changed\n"
          );
        })
      ).rejects.toThrow("changed while Radius was validating");
      await expect(promote(run)).rejects.toThrow("not passed validation");
      expect(read(radiusDir, "app.bicep")).toBe("original");
    }
  );

  it.each([
    ["of another model", JSON.stringify({ appBicepHash: hashAppBicep("x") })],
    ["without a model hash", "null"],
    ["that is not JSON", "{"]
  ])(
    "refuses a check that left an origin record %s",
    async (_label, origin) => {
      const { root, radiusDir } = repo({
        "app.bicep": "original",
        "bicepconfig.json": CONFIG,
        "app.origin.json": origin
      });
      const run = beginManagedRun(root);
      fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), MODEL);
      await expect(run.validate(async () => {})).rejects.toThrow(
        "origin record does not describe the checked model"
      );
      expect(read(radiusDir, "app.bicep")).toBe("original");
    }
  );

  it("validates a run once, only with a model, and only when the check completes the run", async () => {
    const { root } = repo();
    const empty = beginManagedRun(root);
    await expect(empty.validate(check)).rejects.toThrow("has no model");

    const incomplete = beginManagedRun(root);
    fs.writeFileSync(path.join(incomplete.stagingDir, "app.bicep"), MODEL);
    await expect(
      incomplete.validate(async (dir) => {
        await check(dir);
        fs.rmSync(path.join(dir, "bicepconfig.json"));
      })
    ).rejects.toThrow("missing bicepconfig.json");

    const run = beginManagedRun(root);
    fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), MODEL);
    await run.validate(check);
    await expect(run.validate(check)).rejects.toThrow(
      "already started final validation"
    );
    await expect(
      run.promote(
        async () => {
          fs.writeFileSync(path.join(run.stagingDir, "bicepconfig.json"), "{}");
        },
        () => {}
      )
    ).rejects.toThrow("changed afterward");
  });

  it("refuses entries in .radius/ or the run that are not regular files", async () => {
    const elsewhere = repo().root;
    const linked = repo().root;
    fs.rmSync(path.join(linked, ".radius"), { recursive: true });
    fs.symlinkSync(
      path.join(elsewhere, ".radius"),
      path.join(linked, ".radius")
    );
    expect(() => beginManagedRun(linked)).toThrow(
      "requires a real .radius directory"
    );

    const { root, radiusDir } = repo({ "app.bicep": "original" });
    fs.mkdirSync(path.join(radiusDir, "bicepconfig.json"));
    expect(() => beginManagedRun(root)).toThrow("not a stable regular file");
    fs.rmdirSync(path.join(radiusDir, "bicepconfig.json"));
    fs.symlinkSync(
      path.join(root, "README.md"),
      path.join(radiusDir, "bicepconfig.json")
    );
    expect(() => beginManagedRun(root)).toThrow("bicepconfig.json");
    fs.rmSync(path.join(radiusDir, "bicepconfig.json"));

    const run = beginManagedRun(root);
    fs.mkdirSync(path.join(run.stagingDir, "fixture-recipe.bicep"));
    await expect(run.validate(check)).rejects.toThrow("fixture-recipe.bicep");
  });

  it.each([false, true])(
    "puts every file back when a move fails, and keeps the copy only when that also fails (restore fails: %s)",
    async (failRestore) => {
      const { root, radiusDir } = repo({
        "app.bicep": "original",
        "bicepconfig.json": CONFIG
      });
      const run = beginManagedRun(root);
      fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), MODEL);
      let copy = "";
      await run.validate(async (dir) => {
        copy = dir;
        await check(dir);
      });
      const config = path.join(radiusDir, "bicepconfig.json");
      const backup = path.join(copy, "bicepconfig.json.published-backup");
      const rename = fs.renameSync;
      const renameSpy = vi
        .spyOn(fs, "renameSync")
        .mockImplementation((from, to) => {
          if (to === config && from === path.join(copy, "bicepconfig.json"))
            throw new Error("could not publish the config");
          if (failRestore && from === backup && to === config)
            throw new Error("could not restore the config");
          rename(from, to);
        });
      syncBuiltinESMExports();
      try {
        await expect(promote(run)).rejects.toThrow(
          failRestore ?
            `Recovery files remain at ${copy}`
          : "every file was put back"
        );
      } finally {
        renameSpy.mockRestore();
        syncBuiltinESMExports();
      }

      run.cancel();
      expect(read(radiusDir, "app.bicep")).toBe("original");
      expect(stagedInGit(root)).toEqual([]);
      if (failRestore) {
        expect(read(copy, "bicepconfig.json.published-backup")).toBe(CONFIG);
        expect(fs.existsSync(config)).toBe(false);
      } else {
        expect(fs.existsSync(copy)).toBe(false);
        expect(read(radiusDir, "bicepconfig.json")).toBe(CONFIG);
      }
    }
  );

  it("admits the commit after Git discovery and preparation, and indexes only after the commit", async () => {
    const { root, radiusDir } = repo({ "app.bicep": "original" });
    const run = beginManagedRun(root);
    fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), MODEL);
    await run.validate(check);
    const discovery = createDeferred<string>();
    const events: string[] = [];
    const promotion = run.promote(
      async () => {
        events.push("prepare");
      },
      () => {
        expect(read(radiusDir, "app.bicep")).toBe("original");
        events.push("admit");
      },
      {
        onFilesystemCommitted(identity) {
          expect(identity).toEqual({
            definitionHash: sha256(MODEL),
            originHash: sha256(read(radiusDir, "app.origin.json") ?? "")
          });
          events.push("commit");
        },
        gitPorts: {
          discoverRepositoryRoot: (directory) => {
            expect(directory).toBe(radiusDir);
            events.push("discover");
            return discovery.promise;
          },
          stageFiles: async (repoRoot, files, removed) => {
            expect(repoRoot).toBe(root);
            expect(removed).toEqual([]);
            expect(files).toContain(path.join(radiusDir, ".gitignore"));
            events.push("index");
            throw new Error("index is locked");
          }
        }
      }
    );

    expect(events).toEqual(["discover"]);
    discovery.resolve(root);
    await expect(promotion).resolves.toMatchObject({
      gitError: "index is locked"
    });
    expect(events).toEqual(["discover", "prepare", "admit", "commit", "index"]);
    expect(read(radiusDir, "app.bicep")).toBe(MODEL);
  });

  it.each(["preparation", "final admission"])(
    "does not commit or index when %s refuses the promotion",
    async (refusal) => {
      const { root, radiusDir } = repo({ "app.bicep": "original" });
      const run = beginManagedRun(root);
      fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), MODEL);
      await run.validate(check);
      const stageFiles = vi.fn(async () => {});

      await expect(
        run.promote(
          async () => {
            if (refusal === "preparation") throw new Error("request changed");
          },
          () => {
            if (refusal === "final admission")
              throw new Error("request changed");
          },
          {
            gitPorts: {
              discoverRepositoryRoot: async () => root,
              stageFiles
            }
          }
        )
      ).rejects.toThrow("request changed");
      expect(read(radiusDir, "app.bicep")).toBe("original");
      expect(stageFiles).not.toHaveBeenCalled();
    }
  );

  it.skipIf(process.platform === "win32")(
    "adds the staging rule to an existing .radius/.gitignore once, and keeps its mode",
    async () => {
      const { root, radiusDir } = repo({ ".gitignore": "*.tmp" });
      const ignore = path.join(radiusDir, ".gitignore");
      fs.chmodSync(ignore, 0o664);
      const staged: (readonly string[])[] = [];
      for (const text of [MODEL, `${MODEL}// next\n`]) {
        const run = beginManagedRun(root);
        fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), text);
        await run.validate(check);
        await run.promote(
          async () => {},
          () => {},
          {
            gitPorts: {
              discoverRepositoryRoot: async () => root,
              stageFiles: async (_root, files) => {
                staged.push(files);
              }
            }
          }
        );
      }
      expect(read(radiusDir, ".gitignore")).toBe("*.tmp\n.staging-*/\n");
      expect(fs.statSync(ignore).mode & 0o777).toBe(0o664);
      expect(staged.map((files) => files.includes(ignore))).toEqual([
        true,
        false
      ]);
    }
  );

  it("keeps the published model and reports Git's error when Git discovery fails", async () => {
    const { root, radiusDir } = repo();
    const run = beginManagedRun(root);
    fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), MODEL);
    await run.validate(check);
    const stageFiles = vi.fn(async () => {});

    await expect(
      run.promote(
        async () => {},
        () => {},
        {
          gitPorts: {
            discoverRepositoryRoot: async () => {
              throw Object.assign(new Error("rev-parse failed"), {
                stderr: "not a git repository\n"
              });
            },
            stageFiles
          }
        }
      )
    ).resolves.toMatchObject({ gitError: "not a git repository" });
    expect(read(radiusDir, "app.bicep")).toBe(MODEL);
    expect(stageFiles).not.toHaveBeenCalled();
  });

  it("refuses to start when a published file cannot be read, rather than treating it as absent", () => {
    const { root, radiusDir } = repo({
      "app.bicep": "original",
      "bicepconfig.json": CONFIG
    });
    const config = path.join(radiusDir, "bicepconfig.json");
    const open = fs.openSync;
    const openSpy = vi
      .spyOn(fs, "openSync")
      .mockImplementation((file, ...args) => {
        if (file === config) {
          throw Object.assign(new Error("Cannot open the config"), {
            code: "ENOENT"
          });
        }
        return open(file, ...args);
      });
    syncBuiltinESMExports();
    try {
      expect(() => beginManagedRun(root)).toThrow("Cannot open the config");
    } finally {
      openSpy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(
      fs.readdirSync(radiusDir).filter((name) => name.startsWith(".staging-"))
    ).toEqual([]);
  });

  it("refuses a cancelled run and a replaced staging directory without touching a successor", async () => {
    const { root, radiusDir } = repo();
    fs.rmSync(radiusDir, { recursive: true });
    const validated = beginManagedRun(root);
    fs.writeFileSync(path.join(validated.stagingDir, "app.bicep"), MODEL);
    let copy = "";
    await validated.validate(async (dir) => {
      copy = dir;
      await check(dir);
    });
    validated.cancel();
    expect(fs.existsSync(copy)).toBe(false);
    await expect(promote(validated)).rejects.toThrow("no longer active");
    const cancelled = beginManagedRun(root);
    cancelled.cancel();
    const replaced = beginManagedRun(root);
    for (const run of [cancelled, replaced])
      fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), MODEL);
    await expect(cancelled.validate(check)).rejects.toThrow("no longer active");
    await replaced.validate(check);
    await expect(
      replaced.promote(
        async () => {
          fs.renameSync(replaced.stagingDir, `${replaced.stagingDir}-moved`);
          fs.mkdirSync(replaced.stagingDir);
        },
        () => {}
      )
    ).rejects.toThrow("directory or its parent changed");
    expect(read(radiusDir, "app.bicep")).toBeUndefined();

    const successor = beginManagedRun(root);
    fs.writeFileSync(path.join(successor.stagingDir, "app.bicep"), MODEL);
    await successor.validate(check);
    await promote(successor);
    expect(read(radiusDir, "app.bicep")).toBe(MODEL);
    expect(fs.existsSync(cancelled.stagingDir)).toBe(true);
  });

  it("keeps the validation copy when the check's exit is unconfirmed", async () => {
    const { root } = repo();
    const run = beginManagedRun(root);
    fs.writeFileSync(path.join(run.stagingDir, "app.bicep"), MODEL);
    const started = createDeferred<string>();
    const stopped = createDeferred<void>();
    const unconfirmed = new Error("process exit unconfirmed");
    const validating = run.validate(
      async (dir) => {
        started.resolve(dir);
        await stopped.promise;
      },
      (error) => error === unconfirmed
    );
    const result = expect(validating).rejects.toThrow(
      "Validation cleanup is incomplete"
    );
    const copy = await started.promise;
    run.cancel();
    stopped.reject(unconfirmed);
    await result;
    expect(fs.existsSync(copy)).toBe(true);
  });
});
