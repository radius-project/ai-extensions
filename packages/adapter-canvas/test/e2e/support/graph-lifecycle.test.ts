import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { readHarnessWorkspace } from "./graph-lifecycle.js";

it("observes a real branch rename rather than the cached canvas branch", async () => {
  const root = await mkdtemp(resolve(".test-harness-graph-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  try {
    git("init", "--initial-branch=fixture-before");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture"
    );
    const state = {
      workspacePath: root,
      workspaceRepo: "owner/repo",
      workspaceBranch: "fixture-before"
    };
    expect(await readHarnessWorkspace(state)).toMatchObject({
      branch: "fixture-before"
    });
    git("branch", "-m", "fixture-after");
    expect(await readHarnessWorkspace(state)).toMatchObject({
      branch: "fixture-after",
      repo: "owner/repo"
    });
    expect(state.workspaceBranch).toBe("fixture-before");
    await expect(
      readHarnessWorkspace({ workspacePath: resolve(root, "missing") })
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
