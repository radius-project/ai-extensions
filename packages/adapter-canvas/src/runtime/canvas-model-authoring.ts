import { isAbsolute, join } from "node:path";
import { redactCredentials } from "@radius-project/core";
import { appModelTargetKey } from "../app-model-authoring-failure.js";
import type { CanvasState } from "../shared.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import { createModelAuthoringOwner } from "./model-authoring-owner.js";
import { errorMessage } from "./util.js";

export function createCanvasModelAuthoring(
  deps: RadiusExtensionDependencies,
  workspaceState: () => Promise<CanvasState>
) {
  const owner = createModelAuthoringOwner({
    staging: deps.beginManagedModel,
    async resolveTarget() {
      const state = await workspaceState();
      const {
        workspaceRepo: repo,
        workspaceBranch: branch,
        workspacePath: workspace
      } = state;
      if (!repo || !branch || !workspace) return null;
      const sourceRevision =
        await deps.appModel.workspaceSourceRevision(workspace);
      const latest = await workspaceState();
      if (
        latest.workspaceRepo !== repo ||
        latest.workspaceBranch !== branch ||
        latest.workspacePath !== workspace
      )
        return null;
      return { repo, branch, workspace, sourceRevision };
    }
  });

  return {
    owner,
    begin(
      state: CanvasState,
      repo: string,
      branch: string,
      token: string,
      revision: string | undefined,
      skillHandoff: string
    ): string {
      const instanceId = state.canvasInstanceId;
      const workspace = state.workspacePath;
      const key = appModelTargetKey(repo, branch);
      const current = () =>
        !!instanceId &&
        deps.servers.get(instanceId)?.state === state &&
        state.appModelAttemptTokens?.[key] === token;
      const handoff: unknown = JSON.parse(skillHandoff);
      if (typeof handoff !== "object" || !handoff) {
        throw new Error(
          "The Radius authoring skill did not provide a bootstrap."
        );
      }
      const node = Reflect.get(handoff, "nodeCommand");
      const skillBase = Reflect.get(handoff, "skillBase");
      // The packaged bootstrap carries a specific stop instruction for this case.
      if (node === null) return skillHandoff;
      if (
        !workspace ||
        !revision ||
        typeof node !== "string" ||
        !isAbsolute(node) ||
        typeof skillBase !== "string" ||
        !isAbsolute(skillBase)
      ) {
        throw new Error(
          "Cannot establish the managed Radius authoring source or validator."
        );
      }
      const stagingDir = owner.begin(
        token,
        {
          repo: state.workspaceRepo || repo,
          branch: state.workspaceBranch || branch,
          workspace,
          sourceRevision: revision
        },
        current,
        async (appFile) => {
          try {
            await deps.process.execFile(
              node,
              [
                join(skillBase, "scripts", "validate-bicep.mjs"),
                appFile,
                "--managed-final"
              ],
              { cwd: workspace, encoding: "utf8", timeout: 120_000 }
            );
          } catch (error) {
            const stderr =
              error instanceof Error ? Reflect.get(error, "stderr") : undefined;
            const diagnostic =
              typeof stderr === "string" && stderr.trim() ?
                stderr.trim()
              : errorMessage(error);
            throw new Error(
              `Radius model validation failed: ${redactCredentials(diagnostic).slice(0, 4000)}`,
              { cause: error }
            );
          }
        }
      );
      return JSON.stringify({
        ...handoff,
        repoPath: workspace,
        managedAuthoring: { requestToken: token, stagingDir }
      });
    }
  };
}
