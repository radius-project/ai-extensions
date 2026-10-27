import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { decodeText, requestFileReferences } from "./bicep-security-rules.mjs";
import {
  repairFileFingerprint,
  supplementalRepairInputs
} from "./repair-dependencies.mjs";

const samePath = (left, right) =>
  process.platform === "win32" ?
    left.toLowerCase() === right.toLowerCase()
  : left === right;
const binary = path.join(
  os.homedir(),
  ".radius",
  "ai-extensions",
  "bin",
  process.platform === "win32" ? "bicep.exe" : "bicep"
);

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true
  });
  if (result.error || result.status !== 0)
    throw new Error(
      result.error?.message || result.stderr.trim() || "Git failed."
    );
  return result.stdout.trim();
}

// Both callers use this same filesystem transaction and compiler-resolution
// contract. The filesystem port also permits deterministic rollback failures.
export function createRepairStaging({
  files = fs,
  references = (app) => requestFileReferences(binary, app),
  runGit = git
} = {}) {
  function workspace(cwd) {
    const root = files.realpathSync(
      runGit(cwd, ["rev-parse", "--show-toplevel"])
    );
    if (
      !samePath(
        root,
        path.resolve(runGit(root, ["rev-parse", "--show-toplevel"]))
      )
    )
      throw new Error("Repair requires a real Git workspace root.");
    return root;
  }

  function relative(root, file) {
    const name = path.relative(root, file);
    if (
      !name ||
      name === ".." ||
      name.startsWith(`..${path.sep}`) ||
      path.isAbsolute(name)
    )
      throw new Error(`Repair input is outside the workspace: ${file}`);
    return name;
  }

  function regular(root, file) {
    return repairFileFingerprint(root, file, files);
  }

  function targetPath(root, input) {
    if (
      typeof input !== "string" ||
      !input ||
      /[\u0000-\u001f\u007f]/u.test(input) ||
      (process.platform === "win32" && input.includes(":")) ||
      path.isAbsolute(input) ||
      path.win32.isAbsolute(input) ||
      input
        .split(/[\\/]/u)
        .some((part) => part === ".." || part.toLowerCase() === ".git") ||
      (process.platform !== "win32" && input.includes("\\")) ||
      !/\.bicep$/iu.test(input)
    )
      throw new Error(
        "Repair target must be an existing workspace-relative .bicep file."
      );
    const target = path.resolve(root, input);
    regular(root, target);
    if (samePath(target, path.join(root, ".radius", "app.bicep")))
      throw new Error("Use canonical staging for .radius/app.bicep.");
    return files.realpathSync(target);
  }

  function metadata(root) {
    return path.resolve(
      root,
      runGit(root, ["rev-parse", "--git-path", "radius-repairs"])
    );
  }

  function head(root) {
    return files.readFileSync(
      path.resolve(root, runGit(root, ["rev-parse", "--git-path", "HEAD"])),
      "utf8"
    );
  }

  function currentBranch(record) {
    if (record.head !== head(record.root))
      throw new Error(
        "The repair worktree changed branches; begin a new admitted repair."
      );
  }

  function layout(root, target, id) {
    if (!/^[a-f0-9-]{36}$/u.test(id))
      throw new Error("Invalid repair run identity.");
    const binding = createHash("sha256")
      .update(relative(root, target))
      .digest("hex");
    return {
      context: path.join(metadata(root), `${id}-${binding}`, "run.json"),
      staged: path.join(path.dirname(target), `.radius-repair-${id}.bicep`),
      probe: path.join(
        path.dirname(target),
        `.radius-repair-${id}.probe.bicep`
      ),
      backup: path.join(path.dirname(target), `.radius-repair-${id}.backup`)
    };
  }

  function write(context, record) {
    const temp = `${context}.tmp`;
    files.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx"
    });
    try {
      files.renameSync(temp, context);
    } finally {
      if (files.existsSync(temp)) files.unlinkSync(temp);
    }
  }

  function exclusions(record, add) {
    const file = path.resolve(
      record.root,
      runGit(record.root, ["rev-parse", "--git-path", "info/exclude"])
    );
    const entries = [record.staged, record.probe, record.backup].map(
      (item) =>
        `/${relative(record.root, item)
          .split(path.sep)
          .join("/")
          .replace(/[\\*?[\]!# ]/gu, "\\$&")}`
    );
    files.mkdirSync(path.dirname(file), { recursive: true });
    let old = "";
    try {
      old = files.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const next =
      add ?
        `${old}${old && !old.endsWith("\n") ? "\n" : ""}${entries.join("\n")}\n`
      : old
          .split("\n")
          .filter((line) => !entries.includes(line))
          .join("\n");
    files.writeFileSync(file, next);
  }

  function load(context) {
    if (files.lstatSync(context).isSymbolicLink())
      throw new Error("Repair context cannot be a symlink.");
    const record = JSON.parse(files.readFileSync(context, "utf8"));
    if (
      record.version !== 1 ||
      record.mode !== "repair" ||
      workspace(record.root) !== record.root ||
      !record.repair ||
      !Number.isInteger(record.repair.attempts) ||
      record.repair.attempts < 0
    )
      throw new Error("Invalid repair context.");
    const target = path.resolve(record.root, record.target);
    if (
      relative(record.root, target) !== record.target ||
      !/\.bicep$/iu.test(target)
    )
      throw new Error("Invalid repair target.");
    const expected = layout(record.root, target, record.id);
    for (const key of ["context", "staged", "probe", "backup"])
      if (
        !samePath(
          path.resolve(key === "context" ? context : record[key]),
          expected[key]
        )
      )
        throw new Error("Repair context cannot retarget its run.");
    return { ...record, context: expected.context };
  }

  function unchanged(root, snapshot) {
    for (const [file, fingerprint] of Object.entries(snapshot)) {
      if (fingerprint === null) {
        if (files.existsSync(file))
          throw new Error(`A nearer configuration appeared: ${file}`);
      } else if (
        JSON.stringify(
          fingerprint.boundary ?
            {
              ...regular(fingerprint.boundary, file),
              boundary: fingerprint.boundary
            }
          : regular(root, file)
        ) !== JSON.stringify(fingerprint)
      ) {
        throw new Error(`Read-only repair input changed: ${file}`);
      }
    }
  }

  async function snapshot(record, app) {
    const result = await references(app);
    if (
      result.error ||
      !Array.isArray(result.filePaths) ||
      !result.filePaths.some((file) => samePath(file, app))
    )
      throw new Error(
        `Cannot establish repair dependencies: ${result.error || "model missing from compiler references"}`
      );
    const inputs = {};
    for (const file of [...new Set(result.filePaths)].sort()) {
      regular(record.root, file);
      if (
        samePath(file, record.backup) ||
        (!samePath(file, app) &&
          (samePath(file, record.staged) ||
            samePath(file, record.probe) ||
            samePath(file, path.resolve(record.root, record.target))))
      )
        throw new Error(
          "Self-referential model reads cannot be validated under a sibling filename."
        );
      if (!samePath(file, app)) inputs[file] = regular(record.root, file);
      let directory = path.dirname(file);
      for (;;) {
        const config = path.join(directory, "bicepconfig.json");
        if (files.existsSync(config)) {
          inputs[config] = regular(record.root, config);
          break;
        }
        inputs[config] = null;
        if (samePath(directory, record.root)) {
          // Bicep may inherit configuration above Git's root; do not silently
          // substitute defaults for that unconfined input.
          for (
            let above = path.dirname(directory);
            ;
            above = path.dirname(above)
          ) {
            if (files.existsSync(path.join(above, "bicepconfig.json")))
              throw new Error(
                "Inherited Bicep configuration is outside the workspace."
              );
            if (above === path.dirname(above)) break;
          }
          break;
        }
        directory = path.dirname(directory);
      }
    }
    for (const [file, boundary] of supplementalRepairInputs(
      result.filePaths,
      record.root,
      files
    )) {
      inputs[file] = { ...regular(boundary, file), boundary };
    }
    return Object.fromEntries(
      Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))
    );
  }

  async function snapshots(record, apps) {
    const results = await Promise.allSettled(
      apps.map((app) => snapshot(record, app))
    );
    // Both compiler processes must settle before an input is removed.
    return results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  }

  function clean(record) {
    if (files.existsSync(record.backup) || record.phase === "recovery-required")
      throw new Error(
        `Recovery required for ${record.target}; retain backup ${record.backup}. Do not retry promotion.`
      );
    exclusions(record, false);
    for (const file of [record.staged, record.probe, record.context]) {
      if (files.existsSync(file)) files.unlinkSync(file);
    }
  }

  async function begin(cwd, input) {
    const root = workspace(cwd);
    const target = targetPath(root, input);
    const id = randomUUID();
    const record = {
      version: 1,
      mode: "repair",
      id,
      root,
      head: head(root),
      target: relative(root, target),
      ...layout(root, target, id),
      baseline: regular(root, target),
      phase: "editing",
      dependencies: {},
      repair: { attempts: 0, fingerprint: null }
    };
    files.mkdirSync(path.dirname(record.context), { recursive: true });
    try {
      files.writeFileSync(record.staged, files.readFileSync(target), {
        flag: "wx",
        mode: files.statSync(target).mode
      });
      const [original, copied] = await snapshots(record, [
        target,
        record.staged
      ]);
      record.dependencies = original;
      if (JSON.stringify(copied) !== JSON.stringify(record.dependencies))
        throw new Error(
          "Sibling validation changes the model's dependency resolution."
        );
      unchanged(root, { ...record.dependencies, [target]: record.baseline });
      if (regular(root, record.staged).hash !== record.baseline.hash)
        throw new Error("The source changed while copying the repair model.");
      currentBranch(record);
      write(record.context, record);
      exclusions(record, true);
      return record;
    } catch (error) {
      try {
        clean(record);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          `Repair staging failed: ${error.message}; cleanup failed: ${cleanup.message}. Retain context ${record.context} and staged file ${record.staged} for inspection.`,
          { cause: cleanup }
        );
      }
      throw error;
    }
  }

  async function prepareValidation(context, app) {
    const record = load(context);
    currentBranch(record);
    if (
      !samePath(path.resolve(app), record.staged) ||
      record.phase !== "editing"
    )
      throw new Error("Validation must use this repair run's staged sibling.");
    const target = targetPath(record.root, record.target);
    unchanged(record.root, {
      ...record.dependencies,
      [target]: record.baseline
    });
    const staged = regular(record.root, record.staged);
    const text = decodeText(files.readFileSync(record.staged));
    if (!text.trim()) throw new Error("The staged repair model is empty.");
    if (
      (process.platform === "win32" ? text.toLowerCase() : text).includes(
        path.basename(record.staged)
      )
    )
      throw new Error("A repair cannot read its temporary sibling by name.");
    // A second sibling reveals self-reads hidden by getFileReferences'
    // de-duplication of the entrypoint, including computed/escaped paths.
    files.writeFileSync(record.probe, files.readFileSync(record.staged), {
      flag: "wx"
    });
    let dependencies;
    try {
      const [stagedInputs, probeInputs] = await snapshots(record, [
        record.staged,
        record.probe
      ]);
      dependencies = stagedInputs;
      if (JSON.stringify(probeInputs) !== JSON.stringify(dependencies))
        throw new Error(
          "Repair dependency resolution depends on the temporary filename."
        );
    } finally {
      files.unlinkSync(record.probe);
    }
    unchanged(record.root, dependencies);
    return { record, staged, dependencies };
  }

  async function finishValidation(validation, success) {
    const { record, staged, dependencies } = validation;
    currentBranch(record);
    const current = load(record.context);
    unchanged(record.root, {
      ...record.dependencies,
      ...dependencies,
      [path.resolve(record.root, record.target)]: record.baseline,
      [record.staged]: staged
    });
    const resolved = await snapshot(record, record.staged);
    if (JSON.stringify(resolved) !== JSON.stringify(dependencies))
      throw new Error(
        "Repair dependency resolution changed during validation."
      );
    currentBranch(record);
    write(record.context, {
      ...current,
      validated: success ? { staged, dependencies } : null
    });
  }

  async function publish(context) {
    const record = load(context);
    if (record.phase !== "editing" || files.existsSync(record.backup))
      throw new Error(
        `Recovery required: ${record.target}; backup ${record.backup}. Do not retry promotion.`
      );
    const validation = await prepareValidation(context, record.staged);
    if (
      !record.validated ||
      JSON.stringify(record.validated) !==
        JSON.stringify({
          staged: validation.staged,
          dependencies: validation.dependencies
        })
    )
      throw new Error(
        "The exact staged bytes and dependencies have not passed validation."
      );
    const target = path.resolve(record.root, record.target);
    // No awaited work separates the final raw-byte/identity check from rename.
    unchanged(record.root, {
      ...record.dependencies,
      ...validation.dependencies,
      [target]: record.baseline,
      [record.staged]: validation.staged
    });
    currentBranch(record);
    write(context, { ...record, phase: "publishing" });
    let displaced = false;
    let installed = false;
    try {
      files.renameSync(target, record.backup);
      displaced = true;
      unchanged(record.root, {
        [record.backup]: record.baseline,
        ...validation.dependencies
      });
      // A rename would overwrite a file created after the original moved.
      // An exclusive same-filesystem link publishes atomically without that race.
      files.linkSync(record.staged, target);
      installed = true;
      files.unlinkSync(record.staged);
      unchanged(record.root, {
        [target]: validation.staged,
        ...validation.dependencies
      });
      currentBranch(record);
    } catch (error) {
      if (displaced) {
        try {
          if (installed) {
            unchanged(record.root, { [target]: validation.staged });
            files.linkSync(target, record.staged);
            files.unlinkSync(target);
          }
          files.linkSync(record.backup, target);
          files.unlinkSync(record.backup);
        } catch (rollback) {
          return {
            code: 3,
            message: `Recovery required for ${record.target}: ${error.message}; rollback failed: ${rollback.message}. Backup: ${record.backup}. Do not retry promotion.`
          };
        }
      }
      clean(record);
      return {
        code: 1,
        message: `Repair publication refused; original restored: ${error.message}`
      };
    }
    try {
      files.unlinkSync(record.backup);
      clean(record);
    } catch (error) {
      return {
        code: 3,
        message: `Recovery required after publishing ${record.target}: cleanup failed: ${error.message}. Context: ${context}; backup: ${record.backup}. Do not retry promotion.`
      };
    }
    try {
      runGit(record.root, ["--literal-pathspecs", "add", "--", record.target]);
      unchanged(record.root, { [target]: validation.staged });
      const rawBlob = runGit(record.root, [
        "hash-object",
        "--no-filters",
        "--",
        target
      ]);
      const stagedBlob = runGit(record.root, [
        "rev-parse",
        "--verify",
        `:${record.target.split(path.sep).join("/")}`
      ]);
      if (rawBlob !== stagedBlob)
        throw new Error(
          "Git filters changed the staged bytes; inspect this target's index entry before committing."
        );
    } catch (error) {
      return {
        code: 2,
        message: `Published ${record.target}, but Git staging failed: ${error.message}. Do not rerun promotion.`
      };
    }
    return { code: 0, message: `Published and staged only ${record.target}.` };
  }

  return {
    begin,
    load,
    prepareValidation,
    finishValidation,
    publish,
    abort(context) {
      if (!files.existsSync(context)) return;
      clean(load(context));
    }
  };
}
