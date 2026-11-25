import { isAbsolute, join } from "node:path";
import { redactCredentials } from "@radius-project/core";
import { appModelTargetKey } from "../app-model-authoring-failure.js";
import type { CanvasState } from "../shared.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import { createModelAuthoringOwner } from "./model-authoring-owner.js";
import { errorMessage } from "./util.js";

export function readCanvasAuthoringBootstrap(skillHandoff: string) {
  const handoff: unknown = JSON.parse(skillHandoff);
  if (typeof handoff !== "object" || !handoff) {
    throw new Error("The Radius authoring skill did not provide a bootstrap.");
  }
  const node = Reflect.get(handoff, "nodeCommand");
  const skillBase = Reflect.get(handoff, "skillBase");
  return {
    handoff,
    node:
      node === null ? null
      : typeof node === "string" && isAbsolute(node) ? node
      : undefined,
    skillBase:
      typeof skillBase === "string" && isAbsolute(skillBase) ?
        skillBase
      : undefined
  };
}

export function createCanvasModelAuthoring(
  deps: Pick<
    RadiusExtensionDependencies,
    "beginManagedModel" | "appModel" | "servers" | "process" | "logError"
  >,
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

  const panels = new WeakMap<CanvasState, Set<string> | null>();
  const panelRequests = (state: CanvasState): Set<string> | null => {
    const active = panels.get(state);
    if (active !== undefined) return active;
    const created = new Set<string>();
    panels.set(state, created);
    return created;
  };

  return {
    owner,
    openPanel(state: CanvasState): void {
      if (panels.get(state) === null) panels.set(state, new Set());
    },
    closePanel(state: CanvasState): void {
      const active = panelRequests(state);
      panels.set(state, null);
      for (const token of active ?? []) {
        try {
          owner.cancel(token);
        } catch (error) {
          deps.logError(
            `Could not cancel Radius canvas authoring: ${redactCredentials(errorMessage(error))}`
          );
        }
      }
    },
    capturePanel(state: CanvasState): () => boolean {
      const active = panelRequests(state);
      return () => active !== null && panels.get(state) === active;
    },
    begin(
      state: CanvasState,
      repo: string,
      branch: string,
      token: string,
      revision: string | undefined,
      skillHandoff: string,
      selectionIsCurrent: () => boolean,
      settled?: (promoted: boolean) => void
    ): string {
      const instanceId = state.canvasInstanceId;
      const workspace = state.workspacePath;
      const key = appModelTargetKey(repo, branch);
      const active = panelRequests(state);
      const current = () =>
        active !== null &&
        panels.get(state) === active &&
        !!instanceId &&
        deps.servers.get(instanceId)?.state === state &&
        state.workspacePath === workspace &&
        selectionIsCurrent() &&
        state.appModelAttemptTokens?.[key] === token;
      const { handoff, node, skillBase } =
        readCanvasAuthoringBootstrap(skillHandoff);
      // The packaged bootstrap carries a specific stop instruction for this case.
      if (node === null) {
        settled?.(false);
        return skillHandoff;
      }
      if (!active || !workspace || !revision || !node || !skillBase) {
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
        async (appFile, signal) => {
          try {
            await deps.process.runValidator(
              node,
              [
                join(skillBase, "scripts", "validate-bicep.mjs"),
                appFile,
                "--managed-final"
              ],
              {
                cwd: workspace,
                timeout: 120_000,
                signal,
                label: "Radius model validator"
              }
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
        },
        (promoted) => {
          active.delete(token);
          settled?.(promoted);
        }
      );
      active.add(token);
      return JSON.stringify({
        ...handoff,
        repoPath: workspace,
        managedAuthoring: { requestToken: token, stagingDir }
      });
    }
  };
}
