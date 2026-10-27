import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface Run {
  root: string;
  target: string;
  staged: string;
  backup: string;
  context: string;
}
interface Validation {
  record: Run;
}
interface Repair {
  begin(cwd: string, target: string): Promise<Run>;
  load(context: string): Run;
  prepareValidation(context: string, app: string): Promise<Validation>;
  finishValidation(validation: Validation, success: boolean): Promise<void>;
  publish(context: string): Promise<{ code: number; message: string }>;
  abort(context: string): void;
}
interface Module {
  createRepairStaging(options?: {
    files?: typeof fs;
    references?: (
      app: string
    ) => Promise<{ filePaths: string[] } | { error: string }>;
    runGit?: (cwd: string, args: string[]) => string;
  }): Repair;
}
const module: Module = await import(
  pathToFileURL(
    path.resolve(
      import.meta.dirname,
      "../../../extensions/radius/skills/radius-app-bicep/scripts/repair-staging.mjs"
    )
  ).href
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function fixture(options: Parameters<Module["createRepairStaging"]>[0] = {}) {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-stage-"))
  );
  roots.push(root);
  git(root, ["init", "--quiet", "--initial-branch", "main"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  const target = path.join(root, "apps", "custom [model].bicep");
  const dependency = path.join(root, "modules", "nested.bicep");
  fs.mkdirSync(path.dirname(target));
  fs.mkdirSync(path.dirname(dependency));
  fs.writeFileSync(target, "param original string = 'original'\r\n");
  fs.writeFileSync(dependency, "param readonly string\r\n");
  fs.writeFileSync(path.join(root, "bicepconfig.json"), "{}\n");
  fs.writeFileSync(path.join(root, "unrelated.txt"), "old\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  fs.writeFileSync(path.join(root, "unrelated.txt"), "staged unrelated\n");
  git(root, ["add", "--", "unrelated.txt"]);
  const dependencies = [dependency];
  const references = async (app: string) => ({
    filePaths: [app, ...dependencies]
  });
  const repair = module.createRepairStaging({ references, ...options });
  return {
    root,
    target,
    dependency,
    dependencies,
    repair,
    begin: () => repair.begin(root, path.relative(root, target))
  };
}
async function validate(repair: Repair, run: Run) {
  const validation = await repair.prepareValidation(run.context, run.staged);
  await repair.finishValidation(validation, true);
}

describe("existing-file repair transaction", () => {
  it("removes its temporary metadata and staged sibling when metadata publication is denied", async () => {
    let temporary = "";
    const f = fixture({
      files: {
        ...fs,
        renameSync(from, to) {
          if (String(from).endsWith("run.json.tmp")) {
            temporary = String(from);
            throw new Error("metadata rename denied");
          }
          fs.renameSync(from, to);
        }
      }
    });
    await expect(f.begin()).rejects.toThrow("metadata rename denied");
    expect(fs.existsSync(temporary)).toBe(false);
    expect(fs.readdirSync(path.dirname(f.target))).toEqual([
      "custom [model].bicep"
    ]);
    expect(fs.readFileSync(f.target, "utf8")).toContain("original");
  });
  it.each(["validation", "certificate", "publication"] as const)(
    "rejects a worktree branch retarget before %s",
    async (phase) => {
      const f = fixture();
      const run = await f.begin();
      const validation =
        phase === "validation" ? undefined : (
          await f.repair.prepareValidation(run.context, run.staged)
        );
      if (phase === "publication" && validation)
        await f.repair.finishValidation(validation, true);
      git(f.root, ["switch", "--quiet", "-c", "replacement"]);
      const work =
        phase === "validation" ?
          f.repair.prepareValidation(run.context, run.staged)
        : phase === "certificate" && validation ?
          f.repair.finishValidation(validation, true)
        : f.repair.publish(run.context);
      await expect(work).rejects.toThrow("changed branches");
      expect(fs.readFileSync(f.target, "utf8")).toContain("original");
      f.repair.abort(run.context);
    }
  );
  it("rejects a directory replaced by a junction after its initial path check", async () => {
    let directory = "";
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "repair-swap-"));
    roots.push(outside);
    fs.writeFileSync(
      path.join(outside, "custom [model].bicep"),
      "outside bytes"
    );
    const f = fixture({
      files: {
        ...fs,
        lstatSync: ((file, options) => {
          const result = fs.lstatSync(file, options);
          if (file === directory) {
            const original = directory;
            directory = "";
            fs.renameSync(original, `${original}-saved`);
            fs.symlinkSync(
              outside,
              original,
              process.platform === "win32" ? "junction" : "dir"
            );
          }
          return result;
        }) as typeof fs.lstatSync
      }
    });
    directory = path.dirname(f.target);
    await expect(f.begin()).rejects.toThrow("indirect path");
    expect(
      fs.readFileSync(path.join(outside, "custom [model].bicep"), "utf8")
    ).toBe("outside bytes");
  });
  it("rejects an inconsistent Git root before staging any model", async () => {
    let reads = 0;
    const f = fixture({
      runGit(cwd, args) {
        const value = git(cwd, args);
        return args.includes("--show-toplevel") && ++reads === 2 ?
            path.dirname(value)
          : value;
      }
    });
    await expect(f.begin()).rejects.toThrow("real Git workspace root");
    expect(fs.readdirSync(path.dirname(f.target))).toEqual([
      "custom [model].bicep"
    ]);
  });
  it("creates only owned exclusions when Git's optional exclude file is absent", async () => {
    const f = fixture();
    const exclude = path.join(f.root, ".git", "info", "exclude");
    fs.unlinkSync(exclude);
    const run = await f.begin();
    expect(fs.readFileSync(exclude, "utf8")).toContain(
      path.basename(run.staged)
    );
    f.repair.abort(run.context);
    expect(fs.readFileSync(exclude, "utf8")).toBe("");
  });
  it("reports the original failure and retained artifact paths if cleanup also fails", async () => {
    const f = fixture({
      files: {
        ...fs,
        readFileSync: ((file, options) => {
          if (String(file).endsWith(`${path.sep}info${path.sep}exclude`))
            throw new Error("exclude permission denied");
          return fs.readFileSync(file, options);
        }) as typeof fs.readFileSync
      }
    });
    await expect(f.begin()).rejects.toThrow(
      /Repair staging failed: exclude permission denied; cleanup failed: exclude permission denied.*Retain context/s
    );
    expect(fs.readFileSync(f.target, "utf8")).toContain("original");
  });
  it.each(["apps/../other.bicep", "apps/model.txt", "../outside.bicep"])(
    "rejects a malformed persisted target %s",
    async (target) => {
      const f = fixture();
      const run = await f.begin();
      const record = JSON.parse(fs.readFileSync(run.context, "utf8")) as {
        target: string;
      };
      record.target = target;
      fs.writeFileSync(run.context, JSON.stringify(record));
      expect(() => f.repair.load(run.context)).toThrow(
        /Invalid repair target|outside the workspace/
      );
    }
  );
  it.runIf(process.platform !== "win32")(
    "refuses a symlink context before reading through it",
    async () => {
      const f = fixture();
      const run = await f.begin();
      fs.renameSync(run.context, `${run.context}.saved`);
      fs.symlinkSync(`${run.context}.saved`, run.context);
      expect(() => f.repair.load(run.context)).toThrow(
        "context cannot be a symlink"
      );
    }
  );
  it("refuses two sibling reads with different dependency sets", async () => {
    let extra = "";
    const f = fixture({
      references: async (app) => ({
        filePaths: extra && app.endsWith(".probe.bicep") ? [app, extra] : [app]
      })
    });
    const run = await f.begin();
    extra = f.dependency;
    await expect(
      f.repair.prepareValidation(run.context, run.staged)
    ).rejects.toThrow("depends on the temporary filename");
    f.repair.abort(run.context);
  });
  it("waits for both compiler reads before cleaning a failed sibling check", async () => {
    let active = false;
    let release: ((value: { filePaths: string[] }) => void) | undefined;
    let probe = "";
    let started: (() => void) | undefined;
    const probeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = fixture({
      references: async (app) => {
        if (!active) return { filePaths: [app] };
        if (app.endsWith(".probe.bicep")) {
          probe = app;
          started?.();
          return new Promise<{ filePaths: string[] }>((resolve) => {
            release = resolve;
          });
        }
        throw new Error("compiler read failed");
      }
    });
    const run = await f.begin();
    active = true;
    const validation = f.repair.prepareValidation(run.context, run.staged);
    await probeStarted;
    expect(fs.existsSync(probe)).toBe(true);
    if (!release) throw new Error("Probe did not start");
    release({ filePaths: [probe] });
    await expect(validation).rejects.toThrow("compiler read failed");
    expect(fs.existsSync(probe)).toBe(false);
    f.repair.abort(run.context);
  });
  it("refuses an edited initial copy rather than silently adopting its bytes", async () => {
    const f = fixture({
      references: async (app) => {
        if (path.basename(app).startsWith(".radius-repair-"))
          fs.writeFileSync(app, "param unexpected string\n");
        return { filePaths: [app] };
      }
    });
    await expect(f.begin()).rejects.toThrow("source changed while copying");
    expect(fs.readFileSync(f.target, "utf8")).toContain("original");
    expect(fs.readdirSync(path.dirname(f.target))).toEqual([
      "custom [model].bicep"
    ]);
  });
  it.each(["apps/line\nbreak.bicep", "apps/tab\tname.bicep"])(
    "refuses names that cannot form literal Git exclusions (%j)",
    async (target) => {
      const f = fixture();
      await expect(f.repair.begin(f.root, target)).rejects.toThrow(
        "workspace-relative"
      );
      expect(fs.readdirSync(path.join(f.root, "apps"))).toEqual([
        "custom [model].bicep"
      ]);
    }
  );
  it("binds the context path to the admitted filename even for an identical hard link", async () => {
    const f = fixture();
    const run = await f.begin();
    const alias = path.join(path.dirname(f.target), "other.bicep");
    fs.linkSync(f.target, alias);
    const record = JSON.parse(fs.readFileSync(run.context, "utf8")) as {
      target: string;
    };
    record.target = path.relative(f.root, alias);
    fs.writeFileSync(run.context, JSON.stringify(record));
    expect(() => f.repair.load(run.context)).toThrow("cannot retarget");
    expect(fs.readFileSync(alias, "utf8")).toContain("original");
  });
  it("rejects a restored extension artifact changed after validation", async () => {
    const f = fixture();
    const bytes = Buffer.from("local compiler package");
    const packageFile = path.join(f.root, "types.tgz");
    fs.writeFileSync(packageFile, bytes);
    const hash = (await import("node:crypto"))
      .createHash("sha256")
      .update(bytes)
      .digest("hex");
    const cache = path.join(f.root, ".git", "types-cache");
    const restored = path.join(cache, "local", `sha256_${hash}`, "types.tgz");
    fs.mkdirSync(path.dirname(restored), { recursive: true });
    fs.writeFileSync(restored, "restored schema bytes");
    fs.writeFileSync(
      path.join(f.root, "bicepconfig.json"),
      JSON.stringify({
        extensions: { custom: "./types.tgz" },
        cacheRootDirectory: cache
      })
    );
    fs.writeFileSync(f.target, "extension custom\n");
    const run = await f.begin();
    await validate(f.repair, run);
    fs.appendFileSync(restored, "changed");
    await expect(f.repair.publish(run.context)).rejects.toThrow(
      "input changed"
    );
    expect(fs.readFileSync(f.target, "utf8")).toBe("extension custom\n");
    f.repair.abort(run.context);
  });
  it("uses a second sibling to reject deduplicated computed self-reads", async () => {
    let run: Run | undefined;
    const f = fixture({
      references: async (app) => ({
        filePaths:
          run && app.endsWith(".probe.bicep") ? [app, run.staged] : [app]
      })
    });
    run = await f.begin();
    await expect(
      f.repair.prepareValidation(run.context, run.staged)
    ).rejects.toThrow("Self-referential");
    f.repair.abort(run.context);
  });
  it.runIf(process.platform === "win32")(
    "accepts Windows short workspace spelling, preserves filename casing and refuses a delete-sharing lock",
    async () => {
      const f = fixture();
      const spelling = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:RADIUS_REPAIR_PATH).ShortPath"
        ],
        {
          env: { ...process.env, RADIUS_REPAIR_PATH: f.root },
          encoding: "utf8",
          windowsHide: true
        }
      );
      expect(spelling.status, spelling.stderr).toBe(0);
      const shortRoot = spelling.stdout.trim();
      expect(fs.realpathSync.native(shortRoot)).toBe(f.root);
      const run = await f.repair.begin(
        shortRoot,
        path.relative(f.root, f.target).toUpperCase()
      );
      expect(run.target).toBe(path.relative(f.root, f.target));
      fs.writeFileSync(run.staged, "param repaired string\n");
      await validate(f.repair, run);
      const locker = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$file = [IO.File]::Open($env:RADIUS_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); [Console]::WriteLine('locked'); [Console]::ReadLine(); $file.Dispose()"
        ],
        {
          env: { ...process.env, RADIUS_LOCK_FILE: f.target },
          windowsHide: true
        }
      );
      const closed = once(locker, "close");
      try {
        await new Promise<void>((resolve, reject) => {
          let output = "";
          locker.stdout.on("data", (data: Buffer) => {
            output += data.toString();
            if (output.includes("locked")) resolve();
          });
          locker.once("error", reject);
          locker.once("exit", (code) =>
            reject(new Error(`Lock holder exited before readiness: ${code}`))
          );
        });
        const result = await f.repair.publish(run.context);
        expect(result.code).toBe(1);
        expect(result.message).toContain("original restored");
        expect(fs.readFileSync(f.target, "utf8")).toContain("original");
      } finally {
        locker.stdin.end("\n");
        await closed;
      }
    }
  );
  it("preserves independent exclusions and cleans two abandoned runs independently", async () => {
    const f = fixture();
    const exclude = path.join(f.root, ".git", "info", "exclude");
    fs.writeFileSync(exclude, "/keep-this");
    const first = await f.begin();
    const second = await f.begin();
    f.repair.abort(first.context);
    expect(fs.existsSync(second.staged)).toBe(true);
    expect(fs.readFileSync(exclude, "utf8")).toContain(
      path.basename(second.staged)
    );
    f.repair.abort(second.context);
    expect(fs.readFileSync(exclude, "utf8").trim()).toBe("/keep-this");
    f.repair.abort(second.context);
  });
  it("accepts default configuration but refuses configuration inherited above the Git workspace", async () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.root, "bicepconfig.json"));
    const run = await f.begin();
    await validate(f.repair, run);
    expect((await f.repair.publish(run.context)).code).toBe(0);
    const nested = path.join(f.root, "nested");
    fs.mkdirSync(nested);
    git(nested, ["init", "--quiet", "--initial-branch", "main"]);
    fs.writeFileSync(path.join(nested, "app.bicep"), "param a string\n");
    fs.writeFileSync(path.join(f.root, "bicepconfig.json"), "{}");
    const repair = module.createRepairStaging({
      references: async (app) => ({ filePaths: [app] })
    });
    await expect(repair.begin(nested, "app.bicep")).rejects.toThrow(
      "outside the workspace"
    );
  });
  it("refuses changed dependency resolution at begin and after the checker completes", async () => {
    const f = fixture();
    const extra = path.join(f.root, "additional.json");
    fs.writeFileSync(extra, "{}");
    let references = 0;
    const repair = module.createRepairStaging({
      references: async (app) => ({
        filePaths: ++references === 1 ? [app] : [app, extra]
      })
    });
    await expect(
      repair.begin(f.root, path.relative(f.root, f.target))
    ).rejects.toThrow("changes the model");
    const run = await f.begin();
    const validation = await f.repair.prepareValidation(
      run.context,
      run.staged
    );
    f.dependencies.push(extra);
    await expect(f.repair.finishValidation(validation, true)).rejects.toThrow(
      "resolution changed"
    );
    f.repair.abort(run.context);
  });
  it.each(["version", "target", "id", "staged", "budget"] as const)(
    "rejects tampered %s context instead of retargeting",
    async (field) => {
      const f = fixture();
      const run = await f.begin();
      const record: Record<string, unknown> = JSON.parse(
        fs.readFileSync(run.context, "utf8")
      );
      const original = fs.readFileSync(run.context);
      if (field === "version") record.version = 2;
      if (field === "target") record.target = "../outside.bicep";
      if (field === "id") record.id = "not-a-run";
      if (field === "staged") record.staged = f.target;
      if (field === "budget") record.repair = { attempts: -1 };
      fs.writeFileSync(run.context, JSON.stringify(record));
      await expect(f.repair.publish(run.context)).rejects.toThrow();
      expect(fs.readFileSync(f.target, "utf8")).toContain("original");
      fs.writeFileSync(run.context, original);
      f.repair.abort(run.context);
    }
  );
  it("refuses Git metadata dependencies and a staged model named in UTF-16", async () => {
    const f = fixture();
    f.dependencies.push(path.join(f.root, ".git", "config"));
    await expect(f.begin()).rejects.toThrow("Git metadata");
    f.dependencies.pop();
    const run = await f.begin();
    fs.writeFileSync(
      run.staged,
      Buffer.from(`\uFEFFvar self = '${path.basename(run.staged)}'`, "utf16le")
    );
    await expect(
      f.repair.prepareValidation(run.context, run.staged)
    ).rejects.toThrow("temporary sibling");
    f.repair.abort(run.context);
  });
  it("reports Git filters that would commit different bytes as a staging failure", async () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.root, ".gitattributes"),
      "*.bicep text eol=lf\n"
    );
    const run = await f.begin();
    fs.writeFileSync(run.staged, "param repaired string\r\n");
    await validate(f.repair, run);
    const result = await f.repair.publish(run.context);
    expect(result.code).toBe(2);
    expect(result.message).toContain("Git filters changed");
    expect(fs.readFileSync(f.target, "utf8")).toBe("param repaired string\r\n");
  });
  it("retains transaction context and backup when post-publication cleanup is blocked", async () => {
    let backup: string | undefined;
    const f = fixture({
      files: {
        ...fs,
        unlinkSync(file) {
          if (file === backup) throw new Error("fixture backup is locked");
          fs.unlinkSync(file);
        }
      }
    });
    const run = await f.begin();
    backup = run.backup;
    await validate(f.repair, run);
    expect((await f.repair.publish(run.context)).code).toBe(3);
    expect(fs.existsSync(run.context)).toBe(true);
    expect(fs.existsSync(run.backup)).toBe(true);
    expect(() => f.repair.abort(run.context)).toThrow("Recovery required");
  });
  it.each([false, true])(
    "publishes only the custom file, preserving dependencies, index and canonical metadata (canonical=%s)",
    async (canonical) => {
      const f = fixture();
      if (canonical) {
        fs.mkdirSync(path.join(f.root, ".radius"));
        fs.writeFileSync(
          path.join(f.root, ".radius", "app.bicep"),
          "canonical\n"
        );
        fs.writeFileSync(
          path.join(f.root, ".radius", "app.origin.json"),
          "origin\n"
        );
      }
      const before = git(f.root, ["show", ":unrelated.txt"]);
      const run = await f.begin();
      expect(path.dirname(run.staged)).toBe(path.dirname(f.target));
      expect(git(f.root, ["status", "--porcelain"])).not.toContain(
        ".radius-repair-"
      );
      const bytes = "param repaired string = 'exact bytes'\r\n \t";
      fs.writeFileSync(run.staged, bytes);
      await validate(f.repair, run);
      expect(await f.repair.publish(run.context)).toEqual({
        code: 0,
        message: `Published and staged only ${run.target}.`
      });
      expect(fs.readFileSync(f.target, "utf8")).toBe(bytes);
      expect(
        git(f.root, ["show", `:${run.target.split(path.sep).join("/")}`])
      ).toBe(bytes.trim());
      expect(git(f.root, ["show", ":unrelated.txt"])).toBe(before);
      expect(fs.readFileSync(f.dependency, "utf8")).toBe(
        "param readonly string\r\n"
      );
      expect(fs.readdirSync(path.dirname(f.target))).toEqual([
        path.basename(f.target)
      ]);
      expect(fs.existsSync(path.join(f.root, ".radius"))).toBe(canonical);
      if (canonical)
        expect(
          fs.readFileSync(path.join(f.root, ".radius", "app.bicep"), "utf8")
        ).toBe("canonical\n");
      f.repair.abort(run.context);
      f.repair.abort(run.context);
    }
  );

  it.each([
    "../outside.bicep",
    ".git/model.bicep",
    "C:\\outside.bicep",
    "/outside.bicep",
    "apps/not.json",
    "apps/missing.bicep",
    "apps"
  ])("refuses unsafe target %s before staging", async (target) => {
    const f = fixture();
    await expect(f.repair.begin(f.root, target)).rejects.toThrow();
    expect(fs.readdirSync(path.dirname(f.target))).toEqual([
      path.basename(f.target)
    ]);
  });
  it("requires a Git workspace and retains canonical mode", async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.root, ".radius"));
    fs.writeFileSync(path.join(f.root, ".radius", "app.bicep"), "existing");
    await expect(f.repair.begin(f.root, ".radius/app.bicep")).rejects.toThrow(
      "canonical"
    );
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "repair-nongit-"));
    roots.push(outside);
    await expect(f.repair.begin(outside, "model.bicep")).rejects.toThrow();
  });
  it.each(["target", "parent"] as const)(
    "refuses a symlink/junction %s",
    async (kind) => {
      const f = fixture();
      if (kind === "parent") {
        fs.symlinkSync(
          path.dirname(f.target),
          path.join(f.root, "indirect"),
          process.platform === "win32" ? "junction" : "dir"
        );
        await expect(
          f.repair.begin(f.root, path.join("indirect", path.basename(f.target)))
        ).rejects.toThrow("symlinks or junctions");
      } else if (process.platform !== "win32") {
        fs.symlinkSync(f.target, path.join(f.root, "linked.bicep"));
        await expect(f.repair.begin(f.root, "linked.bicep")).rejects.toThrow(
          "symlinks or junctions"
        );
      } else {
        // Junctions need no Windows developer-mode symlink privilege.
        fs.symlinkSync(
          path.dirname(f.target),
          path.join(f.root, "linked.bicep"),
          "junction"
        );
        await expect(f.repair.begin(f.root, "linked.bicep")).rejects.toThrow(
          "symlinks or junctions"
        );
      }
    }
  );
  it.each([
    "target-crlf",
    "target-tail",
    "target-identity",
    "dependency",
    "configuration",
    "nearer-config",
    "new-dependency"
  ] as const)(
    "refuses concurrent %s changes after validation",
    async (change) => {
      const f = fixture();
      const run = await f.begin();
      fs.writeFileSync(run.staged, "param repaired string\n");
      await validate(f.repair, run);
      if (change === "target-crlf")
        fs.writeFileSync(
          f.target,
          fs.readFileSync(f.target, "utf8").replaceAll("\r", "")
        );
      if (change === "target-tail") fs.appendFileSync(f.target, " ");
      if (change === "target-identity") {
        const replacement = `${f.target}.replacement`;
        fs.copyFileSync(f.target, replacement);
        fs.renameSync(replacement, f.target);
      }
      if (change === "dependency") fs.appendFileSync(f.dependency, " ");
      if (change === "configuration")
        fs.writeFileSync(path.join(f.root, "bicepconfig.json"), "{ }\n");
      if (change === "nearer-config")
        fs.writeFileSync(path.join(f.root, "apps", "bicepconfig.json"), "{}");
      if (change === "new-dependency") {
        const file = path.join(f.root, "modules", "data.txt");
        fs.writeFileSync(file, "new input");
        f.dependencies.push(file);
      }
      const original = fs.readFileSync(f.target);
      await expect(f.repair.publish(run.context)).rejects.toThrow();
      expect(fs.readFileSync(f.target)).toEqual(original);
      expect(git(f.root, ["diff", "--cached", "--name-only"])).toBe(
        "unrelated.txt"
      );
      f.repair.abort(run.context);
    }
  );
  it("fingerprints newly resolved read-only imports/data at validation", async () => {
    const f = fixture();
    const run = await f.begin();
    const data = path.join(f.root, "modules", "data.json");
    fs.writeFileSync(data, '{"value":1}\r\n');
    f.dependencies.push(data);
    await validate(f.repair, run);
    fs.appendFileSync(data, " ");
    await expect(f.repair.publish(run.context)).rejects.toThrow(
      "not passed validation"
    );
    f.repair.abort(run.context);
  });
  it.each([
    "unavailable",
    "missing-model",
    "unconfined",
    "missing-input",
    "self-reference"
  ] as const)(
    "fails closed when compiler resolution is %s",
    async (failure) => {
      const f = fixture();
      const repair = module.createRepairStaging({
        references: async (app) => {
          if (failure === "unavailable")
            return { error: "compiler unavailable" };
          if (failure === "missing-model") return { filePaths: [] };
          if (failure === "unconfined")
            return {
              filePaths: [app, path.join(f.root, "..", "outside.bicep")]
            };
          if (failure === "missing-input")
            return { filePaths: [app, path.join(f.root, "missing.json")] };
          return { filePaths: [app, f.target] };
        }
      });
      await expect(
        repair.begin(f.root, path.relative(f.root, f.target))
      ).rejects.toThrow();
      expect(fs.existsSync(path.join(f.root, ".radius"))).toBe(false);
      expect(fs.readdirSync(path.dirname(f.target))).toEqual([
        path.basename(f.target)
      ]);
    }
  );
  it("refuses empty, retargeted, self-naming, invalid and changed staged bytes", async () => {
    const f = fixture();
    const run = await f.begin();
    await expect(
      f.repair.prepareValidation(run.context, f.target)
    ).rejects.toThrow("staged sibling");
    fs.writeFileSync(run.staged, "");
    await expect(
      f.repair.prepareValidation(run.context, run.staged)
    ).rejects.toThrow("empty");
    fs.writeFileSync(run.staged, `var self = '${path.basename(run.staged)}'`);
    await expect(
      f.repair.prepareValidation(run.context, run.staged)
    ).rejects.toThrow("temporary sibling");
    fs.writeFileSync(run.staged, "param x string\n");
    const validation = await f.repair.prepareValidation(
      run.context,
      run.staged
    );
    await f.repair.finishValidation(validation, false);
    await expect(f.repair.publish(run.context)).rejects.toThrow(
      "not passed validation"
    );
    await validate(f.repair, run);
    fs.appendFileSync(run.staged, " ");
    await expect(f.repair.publish(run.context)).rejects.toThrow(
      "not passed validation"
    );
    f.repair.abort(run.context);
  });
  it("rejects input changes during validation and preserves the live file", async () => {
    const f = fixture();
    const run = await f.begin();
    const validation = await f.repair.prepareValidation(
      run.context,
      run.staged
    );
    fs.writeFileSync(f.dependency, "changed");
    await expect(f.repair.finishValidation(validation, true)).rejects.toThrow(
      "input changed"
    );
    f.repair.abort(run.context);
  });
  it.each(["replacement", "dependency", "target"] as const)(
    "preserves concurrent writes during publication (%s)",
    async (change) => {
      let run: Run | undefined;
      const f = fixture({
        files: {
          ...fs,
          renameSync(from, to) {
            fs.renameSync(from, to);
            if (run && to === run.backup && change === "replacement")
              fs.writeFileSync(from, "concurrent replacement\n");
          },
          linkSync(from, to) {
            fs.linkSync(from, to);
            if (run && from === run.staged) {
              if (change === "dependency")
                fs.writeFileSync(f.dependency, "concurrent dependency\n");
              if (change === "target")
                fs.writeFileSync(to, "concurrent target edit\n");
            }
          }
        }
      });
      run = await f.begin();
      fs.writeFileSync(run.staged, "param repaired string\n");
      await validate(f.repair, run);
      const result = await f.repair.publish(run.context);
      expect(result.code).toBe(change === "dependency" ? 1 : 3);
      if (change === "dependency") {
        expect(fs.readFileSync(f.target, "utf8")).toContain("original");
        expect(fs.readFileSync(f.dependency, "utf8")).toContain(
          "concurrent dependency"
        );
      } else {
        expect(fs.readFileSync(f.target, "utf8")).toContain("concurrent");
        expect(fs.readFileSync(run.backup, "utf8")).toContain("original");
        expect(() => f.repair.abort(run.context)).toThrow("Recovery required");
      }
      expect(git(f.root, ["diff", "--cached", "--name-only"])).toBe(
        "unrelated.txt"
      );
    }
  );

  it.each(["first-rename", "install", "rollback", "git-add"] as const)(
    "reports %s failures without losing repair evidence or unrelated staging",
    async (failure) => {
      let run: Run | undefined;
      const f = fixture({
        files: {
          ...fs,
          renameSync(from, to) {
            if (run && failure === "first-rename" && to === run.backup)
              throw new Error("fixture locked file");
            fs.renameSync(from, to);
          },
          linkSync(from, to) {
            if (
              run &&
              (((failure === "install" || failure === "rollback") &&
                from === run.staged) ||
                (failure === "rollback" && from === run.backup))
            )
              throw new Error("fixture locked file");
            fs.linkSync(from, to);
          }
        },
        runGit(cwd, args) {
          if (failure === "git-add" && args.includes("add"))
            throw new Error("fixture index lock");
          return git(cwd, args);
        }
      });
      run = await f.begin();
      fs.writeFileSync(run.staged, "param repair string\n");
      await validate(f.repair, run);
      const outcome = await f.repair.publish(run.context);
      expect(outcome.code).toBe(
        failure === "rollback" ? 3
        : failure === "git-add" ? 2
        : 1
      );
      if (failure === "rollback") {
        expect(outcome.message).toContain(run.backup);
        expect(fs.readFileSync(run.backup, "utf8")).toContain("original");
        expect(() => f.repair.abort(run?.context ?? "")).toThrow(
          "Recovery required"
        );
        await expect(f.repair.publish(run.context)).rejects.toThrow(
          "Recovery required"
        );
      } else {
        expect(fs.readFileSync(f.target, "utf8")).toContain(
          failure === "git-add" ? "repair" : "original"
        );
        f.repair.abort(run.context);
      }
      expect(git(f.root, ["diff", "--cached", "--name-only"])).toBe(
        "unrelated.txt"
      );
    }
  );
});
