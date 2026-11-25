import { isAbsolute, join } from "node:path";
import { redactCredentials } from "@radius-project/core";
import { appModelTargetKey } from "../app-model-authoring-failure.js";
import type { CanvasState } from "../shared.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import { createModelAuthoringOwner } from "./model-authoring-owner.js";
import { errorMessage } from "./util.js";
import type {
  CommittedModelIdentity,
  ObservedModelFile
} from "../app-model-staging.js";

// How the agent finishes a run that the Canvas started. The skill's own
// instructions start and publish a run themselves; this replaces those steps.
export const MANAGED_RUN_INSTRUCTION =
  'The Canvas already started this run in stagingDir. Do not run the begin or abort commands of model.mjs. Write only in stagingDir, and run model.mjs check with stagingDir until it reports no problems. The check does not publish this run. Then call radius_complete_app_authoring with requestToken and outcome "complete": the Canvas checks the run again and publishes it. Only kind "promoted" means that the model was published. If gitError is not empty, tell the user that the files are written but not staged in git. If the tool refuses, report its error, and do not publish the model another way. If the error says that recovery files remain, report their path and do not start another run. To stop without a model, for example when the model already exists or the user declines, call radius_complete_app_authoring with outcome "cancel". When a modeling failure must be reported with radius_report_modeling_failure, report it first: that also ends the run.';

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
    selectionChanged(state: CanvasState): void {
      for (const token of panels.get(state) ?? []) owner.retireStale(token);
    },
    openPanel(state: CanvasState): void {
      if (panels.get(state) === null) panels.set(state, new Set());
    },
    closePanel(state: CanvasState): void {
      const active = panelRequests(state);
      panels.set(state, null);
      for (const token of active ?? []) {
        try {
          owner.retire(token);
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
      settled?: (promoted: boolean, identity?: CommittedModelIdentity) => void,
      mode?: "missing" | "refresh",
      observed?: readonly ObservedModelFile[]
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
        // Final validation runs the Stage 1 check on a copy of the run. The
        // run's `run.json` stops the check from publishing it.
        async (runDir, signal) => {
          try {
            await deps.process.runValidator(
              node,
              [join(skillBase, "scripts", "model.mjs"), "check", runDir],
              {
                cwd: workspace,
                timeout: 300_000,
                signal,
                label: "Radius model check"
              }
            );
          } catch (error) {
            // The check prints its problems last, on stdout.
            const output = (name: string) => {
              const text =
                error instanceof Error ? Reflect.get(error, name) : undefined;
              return typeof text === "string" ? text.trim() : "";
            };
            const stdout = output("stdout");
            const diagnostic =
              stdout.slice(Math.max(0, stdout.indexOf("Problems:"))) ||
              output("stderr") ||
              errorMessage(error);
            throw new Error(
              `The Radius model check failed: ${redactCredentials(diagnostic).slice(0, 4000)}`,
              { cause: error }
            );
          }
        },
        (promoted, identity) => {
          active.delete(token);
          if (identity) settled?.(promoted, identity);
          else settled?.(promoted);
        },
        mode,
        observed
      );
      active.add(token);
      return JSON.stringify({
        ...handoff,
        repoPath: workspace,
        managedAuthoring: {
          requestToken: token,
          stagingDir,
          instruction: MANAGED_RUN_INSTRUCTION
        }
      });
    }
  };
}
