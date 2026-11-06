import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  toSafeRepoRelPath,
  normalizeDeploymentAppFile,
  uncommittedGeneratedPaths,
  safeWorkspacePath,
  readWorkspaceFile,
  runWorkspaceGit
} from "./deployment-workspace.js";

beforeEach(() => {
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE"
  ]) {
    vi.stubEnv(name, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

describe("deployment model path admission", () => {
  it.each([
    [".radius/app.bicep", ".radius/app.bicep"],
    [".\\models\\\\.\\App.BICEP", "models/App.BICEP"],
    ["./models//custom.bicep", "models/custom.bicep"],
    ["app.bicep", "app.bicep"]
  ])("canonicalizes %s without changing filename case", (input, expected) => {
    expect(normalizeDeploymentAppFile(input)).toBe(expected);
  });
  it.each([
    "",
    ".",
    "../app.bicep",
    "models/../app.bicep",
    "/app.bicep",
    "\\app.bicep",
    "C:\\app.bicep",
    "//host/app.bicep",
    "app\0.bicep",
    "app file.bicep",
    "app\nfile.bicep",
    "app\tfile.bicep",
    "'app.bicep",
    "${{inputs.model}}.bicep",
    "-app.bicep",
    "./-app.bicep",
    "models/app.json",
    "models/app.bicep/",
    "app*.bicep"
  ])("rejects unsupported deployment path %j", (input) => {
    expect(() => normalizeDeploymentAppFile(input)).toThrow();
  });
});

describe("deployment workspace file and Git bindings", () => {
  it("normalizes files within the workspace and rejects sibling traversal", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "radius-deploy-files-")
    );
    try {
      await fs.mkdir(path.join(root, ".radius"));
      await fs.writeFile(path.join(root, ".radius", "app.bicep"), "model");
      expect(safeWorkspacePath(root, ".")).toBe(root);
      expect(safeWorkspacePath(null, "model")).toBe("");
      expect(safeWorkspacePath(root, null)).toBe("");
      expect(() => safeWorkspacePath(root, "../outside/model")).toThrow(
        "escapes workspace"
      );
      expect(await readWorkspaceFile(root, ".radius\\app.bicep")).toBe("model");
      expect(await readWorkspaceFile(root, "missing")).toBeNull();
      expect(await readWorkspaceFile(root, "../outside/model")).toBeNull();
      expect(await readWorkspaceFile(null, "model")).toBeNull();
      await fs.writeFile(path.join(root, "empty"), "");
      expect(await readWorkspaceFile(root, "/empty")).toBe("");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves trimmed and verbatim Git output and reports unavailable workspaces", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "radius-deploy-git-"));
    try {
      expect(await runWorkspaceGit(undefined, ["status"])).toEqual({
        ok: false,
        stdout: ""
      });
      expect(
        await runWorkspaceGit(root, ["rev-parse", "--show-toplevel"])
      ).toEqual({ ok: false, stdout: "" });
      execFileSync("git", ["init", "--quiet", "--initial-branch", "main"], {
        cwd: root
      });
      expect(
        await runWorkspaceGit(root, ["symbolic-ref", "--short", "HEAD"])
      ).toEqual({
        ok: true,
        stdout: "main"
      });
      expect(
        await runWorkspaceGit(
          root,
          ["symbolic-ref", "--short", "HEAD"],
          false,
          1024
        )
      ).toEqual({
        ok: true,
        stdout: "main\n"
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("toSafeRepoRelPath", () => {
  it("returns a normal repo-relative path unchanged", () => {
    expect(toSafeRepoRelPath("src/persistence/mysql.js")).toBe(
      "src/persistence/mysql.js"
    );
  });

  it("normalizes backslashes to forward slashes (Windows-generated refs)", () => {
    expect(toSafeRepoRelPath("src\\persistence\\mysql.js")).toBe(
      "src/persistence/mysql.js"
    );
  });

  it("neutralizes a single leading slash to repo-root-relative", () => {
    expect(toSafeRepoRelPath("/src/db.js")).toBe("src/db.js");
  });

  it("rejects Windows drive-letter absolute paths on every platform", () => {
    expect(() => toSafeRepoRelPath("C:\\Windows\\win.ini")).toThrow();
    expect(() => toSafeRepoRelPath("C:/Windows/win.ini")).toThrow();
    expect(() => toSafeRepoRelPath("C:config")).toThrow();
  });

  it("rejects UNC paths", () => {
    expect(() => toSafeRepoRelPath("\\\\server\\share\\x")).toThrow();
    expect(() => toSafeRepoRelPath("//server/share/x")).toThrow();
  });

  it("rejects parent traversal, empty, and NUL", () => {
    expect(() => toSafeRepoRelPath("../../etc/passwd")).toThrow();
    expect(() => toSafeRepoRelPath("a/../b")).toThrow();
    expect(() => toSafeRepoRelPath("")).toThrow();
    expect(() => toSafeRepoRelPath("src/db\0.js")).toThrow();
    expect(() => toSafeRepoRelPath(null)).toThrow();
  });
});

describe("uncommittedGeneratedPaths", () => {
  async function checkout(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rad-pending-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    git("init", "--quiet", "--initial-branch", "main");
    git("config", "user.email", "radius@example.invalid");
    git("config", "user.name", "Radius Test");
    git("config", "commit.gpgsign", "false");
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "app.js"), "console.log(1)\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "source");
    return dir;
  }

  async function withCheckout(
    run: (dir: string) => Promise<void>
  ): Promise<void> {
    const dir = await checkout();
    try {
      await run(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("is empty when no generated files exist", async () => {
    await withCheckout(async (dir) => {
      expect(await uncommittedGeneratedPaths(dir)).toEqual([]);
    });
  });

  it("reports an untracked model directory", async () => {
    await withCheckout(async (dir) => {
      await fs.mkdir(path.join(dir, ".radius"), { recursive: true });
      await fs.writeFile(
        path.join(dir, ".radius", "app.bicep"),
        "resource {}\n"
      );

      expect(await uncommittedGeneratedPaths(dir)).toEqual([".radius"]);
    });
  });

  it("reports every pending generated root in allowlist order", async () => {
    await withCheckout(async (dir) => {
      await fs.mkdir(path.join(dir, ".radius"), { recursive: true });
      await fs.writeFile(path.join(dir, ".radius", "app.bicep"), "a\n");
      await fs.writeFile(path.join(dir, "app.origin.json"), "{}\n");
      await fs.writeFile(path.join(dir, "app.bicep"), "b\n");

      expect(await uncommittedGeneratedPaths(dir)).toEqual([
        ".radius",
        "app.bicep",
        "app.origin.json"
      ]);
    });
  });

  it("reports a staged generated file", async () => {
    await withCheckout(async (dir) => {
      await fs.writeFile(path.join(dir, "app.bicep"), "a\n");
      execFileSync("git", ["add", "app.bicep"], { cwd: dir });

      expect(await uncommittedGeneratedPaths(dir)).toEqual(["app.bicep"]);
    });
  });

  it("reports an unstaged edit to a committed generated file", async () => {
    await withCheckout(async (dir) => {
      await fs.mkdir(path.join(dir, ".radius"), { recursive: true });
      await fs.writeFile(path.join(dir, ".radius", "app.bicep"), "a\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "--quiet", "-m", "model"], { cwd: dir });
      expect(await uncommittedGeneratedPaths(dir)).toEqual([]);

      await fs.writeFile(path.join(dir, ".radius", "app.bicep"), "b\n");
      expect(await uncommittedGeneratedPaths(dir)).toEqual([".radius"]);
    });
  });

  it("ignores uncommitted application source", async () => {
    await withCheckout(async (dir) => {
      await fs.writeFile(path.join(dir, "src", "app.js"), "console.log(2)\n");
      await fs.writeFile(path.join(dir, "src", "new.js"), "export {};\n");

      expect(await uncommittedGeneratedPaths(dir)).toEqual([]);
    });
  });

  it("does not match a path that merely shares a prefix", async () => {
    await withCheckout(async (dir) => {
      await fs.writeFile(path.join(dir, "app.biceps"), "not the model\n");
      await fs.mkdir(path.join(dir, ".radiusx"), { recursive: true });
      await fs.writeFile(path.join(dir, ".radiusx", "x"), "x\n");

      expect(await uncommittedGeneratedPaths(dir)).toEqual([]);
    });
  });

  it("is empty when there is no workspace or no git", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "rad-nogit-"));
    try {
      expect(await uncommittedGeneratedPaths("")).toEqual([]);
      expect(await uncommittedGeneratedPaths(null)).toEqual([]);
      expect(await uncommittedGeneratedPaths(undefined)).toEqual([]);
      expect(await uncommittedGeneratedPaths(bare)).toEqual([]);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });
});
