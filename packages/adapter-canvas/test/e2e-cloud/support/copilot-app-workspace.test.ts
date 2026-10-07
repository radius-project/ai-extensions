import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashAppBicep } from "../../../src/app-bicep-hash.js";
import { classifyModelReadiness, MODEL_FILES } from "./copilot-app-modeling.js";
import {
  prepareModelWorkspace,
  readModelSnapshot
} from "./copilot-app-workspace.js";

const BASELINE = "a".repeat(40);
const REPOSITORY = "example/fixture";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "radius-model-preparation-")
  );
  roots.push(root);
  const profileDir = path.join(root, "profile");
  const workspacePath = path.join(profileDir, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  const input = {
    workspacePath,
    profileDir,
    repository: REPOSITORY,
    baselineSha: BASELINE
  };
  const answers = new Map([
    ["rev-parse --show-toplevel", workspacePath],
    ["remote get-url origin", `https://github.com/${REPOSITORY}.git`],
    ["rev-parse HEAD", BASELINE],
    ["status --porcelain", ""]
  ]);
  const git = async (args: readonly string[]) => {
    const result = answers.get(args.join(" "));
    if (result === undefined)
      throw new Error(`Unscripted Git command: ${args.join(" ")}`);
    return result;
  };
  return { root, input, answers, git };
}

describe("prepareModelWorkspace", () => {
  it("removes the baseline model only inside the verified session and preserves other files", async () => {
    const { input, git, root } = await fixture();
    await fs.mkdir(path.join(input.workspacePath, ".radius"));
    await fs.writeFile(
      path.join(input.workspacePath, ".radius", "app.bicep"),
      "old"
    );
    const sentinel = path.join(root, "personal-state");
    await fs.writeFile(sentinel, "preserve");
    await fs.writeFile(path.join(input.workspacePath, "source.txt"), "source");
    const started = await prepareModelWorkspace(input, git);
    expect(started).toBeLessThanOrEqual(Date.now());
    await expect(
      fs.stat(path.join(input.workspacePath, ".radius"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(sentinel, "utf8")).toBe("preserve");
    expect(
      await fs.readFile(path.join(input.workspacePath, "source.txt"), "utf8")
    ).toBe("source");
  });

  it("accepts an already model-free fixture", async () => {
    const { input, git } = await fixture();
    await expect(prepareModelWorkspace(input, git)).resolves.toBeGreaterThan(0);
    expect(
      (await readModelSnapshot(input.workspacePath)).model
    ).toBeUndefined();
  });

  it.each([
    ["rev-parse --show-toplevel", "root", "repository root"],
    [
      "remote get-url origin",
      "https://github.com/example/other.git",
      "fixture repository"
    ],
    ["rev-parse HEAD", "b".repeat(40), "fixture baseline"],
    ["status --porcelain", " M source.txt", "not clean"]
  ])("fails closed for %s", async (command, value, message) => {
    const { input, git, answers, root } = await fixture();
    await fs.mkdir(path.join(input.workspacePath, ".radius"));
    answers.set(command, value === "root" ? root : value);
    await expect(prepareModelWorkspace(input, git)).rejects.toThrow(message);
    expect(
      (await fs.stat(path.join(input.workspacePath, ".radius"))).isDirectory()
    ).toBe(true);
  });

  it("propagates Git errors without removing the baseline", async () => {
    const { input } = await fixture();
    await fs.mkdir(path.join(input.workspacePath, ".radius"));
    await expect(
      prepareModelWorkspace(input, async () => {
        throw new Error("git unavailable");
      })
    ).rejects.toThrow("git unavailable");
    expect(
      (await fs.stat(path.join(input.workspacePath, ".radius"))).isDirectory()
    ).toBe(true);
  });

  it("refuses a session outside the disposable profile", async () => {
    const { input, git, root } = await fixture();
    await expect(
      prepareModelWorkspace({ ...input, workspacePath: root }, git)
    ).rejects.toThrow("disposable profile");
  });

  it("refuses a linked model directory without modifying its target", async () => {
    const { input, git, root } = await fixture();
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "sentinel"), "preserve");
    await fs.symlink(
      outside,
      path.join(input.workspacePath, ".radius"),
      "junction"
    );
    await expect(prepareModelWorkspace(input, git)).rejects.toThrow(
      "normal directory"
    );
    await expect(readModelSnapshot(input.workspacePath)).rejects.toThrow(
      "normal directory"
    );
    expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe(
      "preserve"
    );
  });

  it("resolves directory links before checking workspace containment", async () => {
    const { input, git, root } = await fixture();
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    const link = path.join(input.profileDir, "linked-workspace");
    await fs.symlink(outside, link, "junction");
    await expect(
      prepareModelWorkspace({ ...input, workspacePath: link }, git)
    ).rejects.toThrow("disposable profile");
  });

  it("refuses a file in place of the model directory", async () => {
    const { input, git } = await fixture();
    await fs.writeFile(path.join(input.workspacePath, ".radius"), "preserve");
    await expect(prepareModelWorkspace(input, git)).rejects.toThrow(
      "normal directory"
    );
    await expect(readModelSnapshot(input.workspacePath)).rejects.toThrow(
      "normal directory"
    );
  });
});

describe("readModelSnapshot", () => {
  it("reports a missing file when generation removes it between stat and read", async () => {
    const { input } = await fixture();
    await fs.mkdir(path.join(input.workspacePath, ".radius"));
    await fs.writeFile(
      path.join(input.workspacePath, ".radius", "app.bicep"),
      "model"
    );
    const snapshot = await readModelSnapshot(
      input.workspacePath,
      async (file) => {
        await fs.rm(file);
        return fs.readFile(file, "utf8");
      }
    );
    expect(snapshot.model).toBeUndefined();
    expect(snapshot.times[".radius/app.bicep"]).toBeUndefined();
  });

  it("propagates read errors other than missing files", async () => {
    const { input } = await fixture();
    await fs.mkdir(path.join(input.workspacePath, ".radius"));
    await fs.writeFile(
      path.join(input.workspacePath, ".radius", "app.bicep"),
      "model"
    );
    const failure = Object.assign(new Error("access denied"), {
      code: "EACCES"
    });
    await expect(
      readModelSnapshot(input.workspacePath, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });

  it("reads the generated model and refuses non-file entries", async () => {
    const { input } = await fixture();
    await fs.mkdir(path.join(input.workspacePath, ".radius"));
    for (const file of MODEL_FILES)
      await fs.writeFile(path.join(input.workspacePath, file), file);
    const snapshot = await readModelSnapshot(input.workspacePath);
    expect(snapshot.model).toBe(".radius/app.bicep");
    expect(snapshot.originText).toBe(".radius/app.origin.json");
    expect(
      Object.values(snapshot.times).every((value) => typeof value === "number")
    ).toBe(true);
    await fs.rm(path.join(input.workspacePath, ".radius", "app.bicep"));
    await fs.mkdir(path.join(input.workspacePath, ".radius", "app.bicep"));
    await expect(readModelSnapshot(input.workspacePath)).rejects.toThrow(
      "regular file"
    );
  });

  it("rejects old origin evidence even when a real checkout gives every file a fresh timestamp", async () => {
    const { input, root } = await fixture();
    const config = path.join(root, "empty.gitconfig");
    await fs.writeFile(config, "");
    const git = (args: string[], stdin?: string) =>
      execFileSync("git", args, {
        cwd: input.workspacePath,
        input: stdin,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: config,
          GIT_CONFIG_NOSYSTEM: "1"
        }
      }).trim();
    git(["init", "--quiet"]);
    const model = "old baseline model";
    const contents = [
      model,
      "{}",
      JSON.stringify({
        generatedAt: "2000-01-01T00:00:00Z",
        sourceCommit: BASELINE,
        appBicepHash: hashAppBicep(model)
      })
    ];
    for (const [index, file] of MODEL_FILES.entries()) {
      const blob = git(["hash-object", "-w", "--stdin"], contents[index]);
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`]);
    }
    const startedAtMs = Date.now();
    git(["checkout-index", "--all"]);
    const snapshot = await readModelSnapshot(input.workspacePath);
    expect(
      Object.values(snapshot.times).every(
        (value) => value !== undefined && value >= startedAtMs
      )
    ).toBe(true);
    const readiness = classifyModelReadiness({
      ...snapshot,
      startedAtMs,
      previousTimes: snapshot.times,
      baselineSha: BASELINE,
      sessionStatus: "Idle"
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.originProblem).toContain("after model cleanup");
  });
});
