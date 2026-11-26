import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { beginManagedRun } from "../../../src/app-model-staging.js";
import { modelingRunLastActivityAtMs } from "../../../src/workspace.js";
import { GRAPH_APP_BICEP_MAX_WAIT_MS } from "../../../src/graph-progress-contract.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";

describe("managed authoring retry with real staging activity", () => {
  it("requests a fresh missing-model handoff after cancelling without removing the old stage", async () => {
    const workspace = await realpath(
      await mkdtemp(join(tmpdir(), "radius-authoring-retry-"))
    );
    const repo = "acme/widgets";
    const branch = "main";
    const stages: string[] = [];
    let now = Date.now();
    let harness:
      Awaited<ReturnType<typeof createRuntimeSdkHarness>> | undefined;
    try {
      harness = await createRuntimeSdkHarness(
        {
          workspaceContext: { workspacePath: workspace, repo, branch },
          workspaceTreeByRepoBranch: { [`${repo}@${branch}`]: ["Dockerfile"] }
        },
        (deps) => {
          deps.clock.now = () => now;
          deps.appModel.workspaceSourceRevision = async () => "saved-source";
          deps.appModel.modelingRunLastActivityAtMs =
            modelingRunLastActivityAtMs;
          deps.beginManagedModel = (worktree) => {
            const stage = beginManagedRun(worktree);
            stages.push(stage.stagingDir);
            return stage;
          };
          deps.radiusSkillHandoff = () =>
            JSON.stringify({
              nodeCommand: resolve("test", "node"),
              skillBase: resolve("test", "skill"),
              instruction: "Run the skill."
            });
        }
      );
      const { deps, capturedHostCallbacks, extension, session } = harness;
      const { state } = await deps.getOrCreateServer("model-panel", "graph");
      Object.assign(state, {
        canvasInstanceId: "model-panel",
        workspacePath: workspace,
        workspaceRepo: repo,
        workspaceBranch: branch
      });
      const handoff = capturedHostCallbacks.appBicepHandoff;
      const lifecycle = capturedHostCallbacks.authoringLifecycle;
      const complete = extension.tools.find(
        ({ name }) => name === "radius_complete_app_authoring"
      );
      if (!handoff || !complete || !lifecycle)
        throw new Error("Missing registered authoring");
      const request = { repo, branches: [branch], page: "graph", state };

      await handoff(request);
      expect(stages).toHaveLength(1);
      const token = state.appModelAttemptTokens?.[`${repo}::${branch}`];
      expect(token).toBeTruthy();
      await writeFile(join(stages[0], "app.bicep"), "// staged model\n");
      expect(lifecycle.liveStage(state, repo, [branch])).toBe(stages[0]);
      expect(
        await modelingRunLastActivityAtMs(workspace, stages[0])
      ).not.toBeNull();
      now += GRAPH_APP_BICEP_MAX_WAIT_MS * 2;
      await handoff(request);
      expect(stages).toHaveLength(1);
      expect(state.appModelAttemptTokens?.[`${repo}::${branch}`]).toBe(token);
      await expect(
        complete.handler({ requestToken: token, outcome: "cancel" })
      ).resolves.toEqual({ kind: "cancelled" });
      expect(lifecycle.liveStage(state, repo, [branch])).toBeUndefined();
      expect(await modelingRunLastActivityAtMs(workspace)).toBeNull();

      await handoff(request);
      expect(stages).toHaveLength(2);
      expect(state.appModelAttemptTokens?.[`${repo}::${branch}`]).not.toBe(
        token
      );
      expect(session.send).toHaveBeenCalledTimes(2);
    } finally {
      await harness?.extension.shutdown("test");
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
