import {
  graphSourceBranch,
  modelAuthoringTarget,
  requestModelAuthoring
} from "@radius-project/core/github-radius/graphs";
import type {
  AppModelStatus,
  GraphSource
} from "@radius-project/core/github-radius/graphs";
import type { AppSourceEvaluation } from "@radius-project/core";
import {
  appBicepHandoffMessage,
  appModelRefreshMessage,
  appModelStaleNotice,
  appModelUnverifiedMessage,
  refreshRequestKey
} from "./hooks.js";
import type { HandoffMessage } from "./hooks.js";
import type { CanvasState, GraphProgressView } from "../shared.js";
import type { MissingModelHandoffClaims } from "./missing-model-handoff-claims.js";
import { GRAPH_APP_BICEP_IDLE_TIMEOUT_MS } from "../graph-progress-contract.js";
import { appModelTargetKey } from "../app-model-authoring-failure.js";

export {
  appModelHandoffKey,
  MODELING_GRACE_WINDOW_MS,
  MODELING_GRACE_POLL_MS
} from "@radius-project/core/github-radius/graphs";

export interface AppModelHandoffRequest {
  repo: string;
  branches: ReadonlyArray<string | undefined>;
  page: string;
  progressView?: GraphProgressView;
  state?: CanvasState;
  isCurrent?: () => boolean;
}

export interface AppModelHandoffDependencies {
  resolveContext(): Promise<CanvasState>;
  resolveStatus(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<AppModelStatus>;
  evaluateSource(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<AppSourceEvaluation>;
  send(message: HandoffMessage): Promise<void>;
  modelingInFlight(
    repo: string,
    branches: ReadonlyArray<string>,
    context: CanvasState,
    waitStartedAtMs?: number
  ): Promise<boolean>;
  wait(ms: number): Promise<void>;
  log(message: string): void;
  shouldRequestRefresh(key: string): boolean;
  releaseRefreshMemo(key: string): void;
  missingModelHandoffs: MissingModelHandoffClaims;
}

export type AppModelHandoff = (
  request: AppModelHandoffRequest
) => Promise<void>;

/** Canvas owns view reservations and message formatting, not authoring policy. */
export function createAppModelHandoff(
  deps: AppModelHandoffDependencies
): AppModelHandoff {
  return async ({ repo, branches, page, progressView, state, isCurrent }) => {
    const targets = branches.filter((branch): branch is string =>
      Boolean(branch)
    );
    if (!repo || !targets.length) return;
    const context = state ?? (await deps.resolveContext());
    const view = progressView ?? (page === "graph-diff" ? "diff" : "graph");
    const waitStartedAtMs =
      context.graphProgressRecords?.[view]?.graphProgressWaitStartedAtMs;
    const target = modelAuthoringTarget(repo, targets);
    const sources: GraphSource[] = targets.map((branch) =>
      (
        context.workspaceRepo === repo &&
        context.workspaceBranch === branch &&
        context.workspacePath
      ) ?
        {
          kind: "workspace",
          repo,
          branch,
          workspacePath: context.workspacePath
        }
      : { kind: "committed", repo, ref: branch }
    );
    await requestModelAuthoring(
      {
        repo,
        sources,
        waitStartedAtMs,
        recoveryDeadlineAtMs:
          waitStartedAtMs === undefined ? undefined : (
            waitStartedAtMs + GRAPH_APP_BICEP_IDLE_TIMEOUT_MS - 60_000
          ),
        isCurrent
      },
      {
        resolveStatus: (source) =>
          deps.resolveStatus(repo, graphSourceBranch(source), context),
        evaluateSource: (source) =>
          deps.evaluateSource(repo, graphSourceBranch(source), context),
        modelingInFlight: (selected, startedAt) =>
          deps.modelingInFlight(
            repo,
            selected.map(graphSourceBranch),
            context,
            startedAt
          ),
        wait: deps.wait,
        claims: deps.missingModelHandoffs,
        shouldRequestRefresh: deps.shouldRequestRefresh,
        releaseRefreshMemo: deps.releaseRefreshMemo,
        refreshKey: refreshRequestKey,
        staleNotice: (status) => deps.log(appModelStaleNotice(status)),
        async requestInteraction(interaction) {
          if (interaction.kind === "confirm-refresh") {
            await deps.send(appModelUnverifiedMessage(interaction.status));
          } else if (interaction.kind === "refresh") {
            await deps.send(appModelRefreshMessage(interaction.status));
          } else {
            await deps.send(
              appBicepHandoffMessage(
                repo,
                page,
                targets,
                state?.canvasInstanceId,
                interaction.attemptToken && state?.canvasInstanceId ?
                  {
                    attemptToken: interaction.attemptToken,
                    instanceId: state.canvasInstanceId,
                    branches: targets
                  }
                : undefined
              )
            );
          }
        },
        reservation: {
          has: (key) => state?.appBicepHandoffKeys?.[target] === key,
          reserve(key) {
            if (!state) return;
            state.appBicepHandoffKeys ??= {};
            state.appBicepHandoffKeys[target] = key;
            state.appBicepHandoffKey = key;
          },
          owns: (key) =>
            state === undefined ||
            (state.appBicepHandoffKeys?.[target] === key &&
              state.appBicepHandoffKey === key),
          release(key) {
            if (state?.appBicepHandoffKeys?.[target] === key)
              delete state.appBicepHandoffKeys[target];
            if (state?.appBicepHandoffKey === key)
              delete state.appBicepHandoffKey;
          },
          beginAttempt(selected) {
            if (!state?.canvasInstanceId) return undefined;
            state.appModelAttemptGeneration =
              (state.appModelAttemptGeneration ?? 0) + 1;
            const token = `${state.canvasInstanceId}::attempt-${state.appModelAttemptGeneration}`;
            state.appModelAttemptTokens ??= {};
            for (const source of selected) {
              state.appModelAttemptTokens[
                appModelTargetKey(repo, graphSourceBranch(source))
              ] = token;
            }
            return token;
          },
          releaseAttempt(selected, token) {
            for (const source of selected) {
              const key = appModelTargetKey(repo, graphSourceBranch(source));
              if (state?.appModelAttemptTokens?.[key] === token)
                delete state.appModelAttemptTokens[key];
            }
          }
        }
      }
    );
  };
}
