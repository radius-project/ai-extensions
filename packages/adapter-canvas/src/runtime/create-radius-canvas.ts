// createRadiusCanvas — builds the "radius" canvas definition (metadata, the 2
// actions, open/onClose) from RADIUS_ACTION_DECLARATIONS plus a
// RadiusExtensionDependencies dependency object. No SDK import, no I/O at
// module load, and no joinSession: constructing the canvas only wires
// closures — every closure's first real I/O happens when the SDK later
// invokes a handler (after the production entry has attached a real session).

import {
  RADIUS_CANVAS_ID,
  RADIUS_CANVAS_DISPLAY_NAME,
  RADIUS_CANVAS_DESCRIPTION,
  RADIUS_ACTION_DECLARATIONS,
  buildRadiusCanvasInputSchema
} from "./declarations.js";
import { record, optionalString, errorMessage } from "./util.js";
import {
  GRAPH_PAGES,
  DEFAULT_CANVAS_PAGE,
  appBicepHandoffMessage,
  appModelRefreshMessage,
  appModelStaleNotice,
  appModelUnverifiedMessage
} from "./hooks.js";
import { reloadCanvasInstance } from "./canvas-lifecycle.js";
import { createGraphContextHelpers } from "./graph-context.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import type { CanvasServerEntry } from "../server.js";
import type { CanvasGraphResource, CanvasState } from "../shared.js";
import {
  asGraphModelingFailure,
  GraphModelingFailure
} from "../graph-modeling-failure.js";
import {
  beginGraphRepairAttempt,
  clearGraphRepairAttempt,
  graphRepairHandoffMessage
} from "../graph-model-repair.js";

const MAX_DEFERRED_ENVIRONMENT_CLOSE_MS = 46 * 60 * 1000;

interface CanvasContext {
  extensionId: string;
  canvasId: string;
  instanceId: string;
  input?: Record<string, unknown>;
}

// Mirrors server.ts's isCurrentSourceRefToken: true only when `token` is
// non-empty and still matches the view's live context token. Kept local
// (rather than injected) since it is pure logic over the CanvasState already
// in scope, with no I/O.
function isCurrentSourceRefToken(
  state: CanvasState,
  view: "graph" | "planned" | "diff",
  token: unknown
): boolean {
  return !!token && state?.sourceRefContexts?.[view]?.token === token;
}

// Everything below this line is created by createRadiusCanvas so it can close
// over `deps` instead of module-level imports of server.ts/gh.ts/workspace.ts.
export function createRadiusCanvas(deps: RadiusExtensionDependencies) {
  const closeGenerations = new Map<string, number>();
  const {
    workspaceState,
    fetchBicepForBranch,
    evaluateAppSourceForBranch,
    resolveAppModelStatus
  } = createGraphContextHelpers(deps);

  function sendToSession(message: {
    prompt: string;
    displayPrompt: string;
  }): void {
    try {
      const session = deps.session.get();
      Promise.resolve(session.send(message)).catch(() => {});
    } catch {
      /* session.send unavailable → ignore */
    }
  }

  function logToSession(message: string): void {
    try {
      deps.session.get().log?.(message);
    } catch {
      /* session.log unavailable → ignore */
    }
  }

  // When a graph canvas is opened, decide what the model on the target branch
  // needs: authoring (none exists), a conversation about refreshing it (it
  // exists but cannot be verified against current source), or just a note (it is
  // stale on a branch modeling is not allowed to rewrite). A model that is stale
  // AND safely refreshable never reaches here, because the pre-tool-use hook denies
  // the open and has it regenerated first. Fire-and-forget, guarded so we act at
  // most once per repo+branch combination.
  async function maybeHandoffAppBicep(
    entry: CanvasServerEntry,
    page: string,
    ctx: CanvasContext
  ): Promise<void> {
    try {
      if (!GRAPH_PAGES.has(page)) return;
      const state = entry.state;
      const input = record(ctx.input);
      const repo = state.contextRepo || optionalString(input.repo);
      if (!repo) return;

      let branches: Array<string | undefined>;
      if (page === "graph-diff") {
        branches = [
          optionalString(input.baseBranch),
          optionalString(input.headBranch)
        ].filter(Boolean);
        if (!branches.length) branches = [undefined];
      } else {
        branches = [optionalString(input.branch) || state.contextBranch];
      }
      branches = branches.map(
        (b) => b || deps.workspace.defaultBranchForState(state)
      );

      // resolveAppModelStatus already absorbs every read failure into a
      // "missing" classification, so a rejection here means the runtime itself
      // is broken; the outer guard abandons the handoff rather than acting on a
      // half-resolved picture.
      const statuses = await Promise.all(
        branches.map((branch) =>
          resolveAppModelStatus(repo, branch as string, entry.state)
        )
      );

      // Only send a message when there is something new to say. The key
      // includes what is wrong, not just which repo and branch, so an app model
      // that changes from stale to hand-edited between two opens is still
      // reported the second time.
      const key = [
        repo,
        branches.join(","),
        ...statuses.map((status) => {
          const origin = status.freshness.origin;
          return [
            status.branch,
            status.freshness.status,
            status.refreshable ? "local" : "remote",
            origin?.sourceCommit ?? "",
            origin?.skillVersion ?? ""
          ].join("/");
        })
      ].join("::");
      if (state.appBicepHandoffKey === key) return;
      const present = statuses.filter(
        (status) => status.freshness.status !== "missing"
      );

      if (!present.length) {
        const source = await Promise.all(
          branches.map((branch) =>
            evaluateAppSourceForBranch(repo, branch as string, state)
          )
        );
        // The app-modeling skill cannot author this repository. Do not consume
        // the dedupe key: adding a Dockerfile later must make the next open
        // eligible for the handoff.
        if (source.every((evaluation) => evaluation.status === "none")) return;
        if (state.appBicepHandoffKey === key) return;
        state.appBicepHandoffKey = key;
        sendToSession(appBicepHandoffMessage(repo, page, branches));
        return;
      }

      state.appBicepHandoffKey = key;
      const unverified = present.find(
        (status) => status.refreshable && status.freshness.requiresConfirmation
      );
      if (unverified) {
        sendToSession(appModelUnverifiedMessage(unverified));
        return;
      }

      // Normally the pre-tool-use hook has already denied the open and had this
      // refreshed, so nothing stale reaches here. It does reach here on the
      // paths the hook never sees (a programmatic reload, or the user opening
      // the panel directly), and leaving those silent would restore exactly the
      // bug this change exists to fix, just through a different door.
      const outdated = present.find(
        (status) => status.refreshable && status.freshness.stale
      );
      if (outdated) {
        sendToSession(appModelRefreshMessage(outdated));
        return;
      }

      for (const status of present) {
        if (!status.refreshable && status.freshness.stale) {
          logToSession(appModelStaleNotice(status));
        }
      }
    } catch {
      /* never block canvas open on handoff failure */
    }
  }

  const declarationByName = new Map(
    RADIUS_ACTION_DECLARATIONS.map((decl) => [decl.name, decl])
  );

  const actions = [
    {
      ...declarationByName.get("get_graph_resources")!,
      handler: async (ctx: CanvasContext) => {
        const entry = await deps.getOrCreateServer(ctx.instanceId);
        const input = record(ctx.input);
        const result = deps.sourceRefs.getSourceRefResources(
          entry,
          optionalString(input.view) || undefined
        );
        if (!result.ready) {
          return {
            ready: false,
            resources: [],
            message:
              "Graph has not been built yet. Open the graph page and wait for it to load, then try again."
          };
        }
        const missingOnly = input.missingOnly !== false;
        if (!result.context) {
          return {
            ready: false,
            resources: [],
            message: "Graph context is unavailable."
          };
        }
        const resources =
          missingOnly ?
            result.resources.filter(
              (r) =>
                !r.codeReference &&
                !r.type?.toLowerCase().includes("applications")
            )
          : result.resources;
        return {
          ready: true,
          view: result.view,
          contextToken: result.context.token,
          repo: result.context.repo,
          branch: result.context.branch || null,
          baseBranch: result.context.baseBranch || null,
          headBranch: result.context.headBranch || null,
          resources: resources.map((r) => ({
            name: r.name,
            type: r.type,
            id: r.id,
            codeReference: r.codeReference || null
          }))
        };
      }
    },
    {
      ...declarationByName.get("update_source_refs")!,
      handler: async (ctx: CanvasContext) => {
        const entry = await deps.getOrCreateServer(ctx.instanceId);
        const input = record(ctx.input);
        const contextToken = input.contextToken;
        if (!contextToken || typeof contextToken !== "string") {
          return {
            error: "contextToken is required",
            updated: 0,
            queued: 0,
            skipped: 0
          };
        }
        const refs = input.refs;
        if (!Array.isArray(refs) || refs.length === 0) {
          return {
            error: "refs array is required",
            updated: 0,
            queued: 0,
            skipped: 0
          };
        }
        const parsedRefs = refs.flatMap((value) => {
          const fields = record(value);
          const id = optionalString(fields.id);
          const codeReference = optionalString(fields.codeReference);
          return id && codeReference ? [{ id, codeReference }] : [];
        });
        const result = deps.sourceRefs.updateSourceRefs(
          entry,
          contextToken,
          parsedRefs
        );
        if (result.error) return result;
        const page = result.view === "diff" ? "graph-diff" : result.view;
        entry.url = `${entry.baseUrl}/?page=${page}&sourceRefs=${Date.now()}`;
        await reloadCanvasInstance(deps.session.get(), ctx, { page });
        return {
          ...result,
          message: `Updated ${result.updated} resource(s); queued ${result.queued}; skipped ${result.skipped}.`,
          url: entry.url
        };
      }
    }
  ];

  return {
    id: RADIUS_CANVAS_ID,
    displayName: RADIUS_CANVAS_DISPLAY_NAME,
    description: RADIUS_CANVAS_DESCRIPTION,
    inputSchema: buildRadiusCanvasInputSchema(DEFAULT_CANVAS_PAGE),
    actions,
    open: async (ctx: CanvasContext) => {
      closeGenerations.set(
        ctx.instanceId,
        (closeGenerations.get(ctx.instanceId) || 0) + 1
      );
      const input = record(ctx.input);
      const page = optionalString(input.page) || DEFAULT_CANVAS_PAGE;
      const entry = await deps.getOrCreateServer(ctx.instanceId, page);
      entry.state.activeGraphView =
        page === "graph-diff" ? "diff"
        : page === "planned" ? "planned"
        : page === "graph" ? "graph"
        : entry.state.activeGraphView;
      const workspace = await workspaceState();
      Object.assign(entry.state, workspace);
      const inputRepo = optionalString(input.repo);
      const inputBranch = optionalString(input.branch);
      if (inputRepo) {
        entry.state.contextRepo = inputRepo;
        // An explicit branch can name another branch of the workspace repository.
        // Only an omitted branch means "use the checked-out worktree branch".
        entry.state.contextBranch =
          inputBranch ||
          (inputRepo === workspace.workspaceRepo ?
            workspace.workspaceBranch
          : "main");
      } else if (!entry.state.contextRepo && deps.session.get().workspacePath) {
        try {
          const session = deps.session.get();
          const { stdout } = await deps.process.execFile(
            "git",
            [
              "-C",
              session.workspacePath as string,
              "remote",
              "get-url",
              "origin"
            ],
            { timeout: 5000, encoding: "utf8" }
          );
          const remoteUrl = stdout.trim();
          const repo = deps.workspace.parseRepoFromRemote(remoteUrl);
          if (repo) {
            entry.state.contextRepo = repo;
          }
        } catch (e) {
          /* ignore */
        }
      }

      if (page === "graph" || page === "planned") {
        deps.sourceRefs.prepareSourceRefResources(entry, page, {
          repo: entry.state.contextRepo || "",
          branch: entry.state.contextBranch || ""
        });
      }

      if (
        page === "graph-diff" &&
        optionalString(input.baseBranch) &&
        optionalString(input.headBranch)
      ) {
        const baseBranch = optionalString(input.baseBranch);
        const headBranch = optionalString(input.headBranch);
        const repo = entry.state.contextRepo || inputRepo;
        const sourceRefContext = deps.sourceRefs.prepareSourceRefResources(
          entry,
          "diff",
          { repo, baseBranch, headBranch }
        );
        entry.state.diffBase = baseBranch;
        entry.state.diffHead = headBranch;
        entry.state.diffTargetRepo = repo;
        delete entry.state.diffError;
        delete entry.state.diffModelingFailed;
        try {
          const [baseContent, headContent] = await Promise.all([
            fetchBicepForBranch(repo, baseBranch, entry.state),
            fetchBicepForBranch(repo, headBranch, entry.state)
          ]);

          const session = deps.session.get();
          const log = (m: string) => {
            try {
              session.log?.(m);
            } catch {}
          };

          const { dir: baseRadArtifactsDir, remote: baseRadArtifactsRemote } =
            await deps.rad.radArtifactsDirForSelection({
              isLocal: deps.workspace.isWorkspaceSelection(
                entry.state,
                repo,
                baseBranch
              ),
              state: entry.state,
              github: deps.github,
              repo,
              branch: baseBranch,
              bicepRepoPath: ".radius/app.bicep",
              log
            });
          const { dir: headRadArtifactsDir, remote: headRadArtifactsRemote } =
            await deps.rad.radArtifactsDirForSelection({
              isLocal: deps.workspace.isWorkspaceSelection(
                entry.state,
                repo,
                headBranch
              ),
              state: entry.state,
              github: deps.github,
              repo,
              branch: headBranch,
              bicepRepoPath: ".radius/app.bicep",
              log
            });
          let baseResources: CanvasGraphResource[];
          let headResources: CanvasGraphResource[];
          try {
            baseResources = await deps.rad.buildGraphViaRad(
              baseContent || "",
              ".radius/app.bicep",
              {
                log,
                radArtifactsDir: baseRadArtifactsDir,
                cleanupRadArtifactsDir: baseRadArtifactsRemote
              }
            );
            headResources = await deps.rad.buildGraphViaRad(
              headContent || "",
              ".radius/app.bicep",
              {
                log,
                radArtifactsDir: headRadArtifactsDir,
                cleanupRadArtifactsDir: headRadArtifactsRemote
              }
            );
          } catch (error) {
            const failure = asGraphModelingFailure(error);
            if (!(failure instanceof GraphModelingFailure)) throw error;
            deps.logError(
              `[radius graph] modeling failed for ${repo}@${baseBranch}...${headBranch}: ${failure.diagnostic}`
            );
            const request = {
              view: "diff" as const,
              repo: repo || "",
              branches: [baseBranch, headBranch],
              diagnostic: failure.diagnostic
            };
            if (
              !isCurrentSourceRefToken(
                entry.state,
                "diff",
                sourceRefContext.token
              )
            ) {
              throw failure;
            }
            const attempt = beginGraphRepairAttempt(entry.state, request);
            entry.state.diffModelingFailed = true;
            if (attempt.repairing) {
              try {
                await deps.session
                  .get()
                  .send(graphRepairHandoffMessage(request, attempt));
              } catch (handoffError) {
                deps.logError(
                  `[radius graph] failed to hand repair attempt ${attempt.attempt} to the agent: ${errorMessage(handoffError)}`
                );
              }
            }
            throw failure;
          }
          const diffResources = deps.core.computeGraphDiff(
            baseResources,
            headResources
          );
          const committed = deps.sourceRefs.setSourceRefResources(
            entry,
            "diff",
            diffResources,
            { repo, baseBranch, headBranch },
            sourceRefContext.token
          );
          if (committed) {
            clearGraphRepairAttempt(entry.state, "diff");
            delete entry.state.diffModelingFailed;
            const hasChanges = diffResources.some(
              (r) => r.diffStatus !== "unchanged"
            );
            entry.state.diffNoChanges = !hasChanges;
          }
        } catch (e) {
          if (
            isCurrentSourceRefToken(entry.state, "diff", sourceRefContext.token)
          ) {
            entry.state.diffError = errorMessage(e);
          }
        }
      }

      await maybeHandoffAppBicep(entry, page, {
        extensionId: ctx.extensionId,
        canvasId: ctx.canvasId,
        instanceId: ctx.instanceId,
        input
      });

      return { title: "Radius", url: entry.url };
    },
    onClose: async (ctx: CanvasContext) => {
      const entry = deps.servers.get(ctx.instanceId);
      if (entry) {
        if (deps.operations.hasActiveEnvironmentTasks(ctx.instanceId)) {
          const closeGeneration = closeGenerations.get(ctx.instanceId) || 0;
          let closeTimer: ReturnType<typeof setTimeout> | undefined;
          const closeEntry = () => {
            stopListening();
            if (closeTimer) clearTimeout(closeTimer);
            if (closeGenerations.get(ctx.instanceId) !== closeGeneration)
              return;
            if (deps.servers.get(ctx.instanceId) !== entry) return;
            deps.operations.markEnvironmentInstanceShuttingDown(ctx.instanceId);
            deps.servers.delete(ctx.instanceId);
            closeGenerations.delete(ctx.instanceId);
            entry.server.close();
          };
          const stopListening = deps.operations.onEnvironmentTasksSettled(
            ctx.instanceId,
            () => {
              closeEntry();
            }
          );
          closeTimer = setTimeout(
            closeEntry,
            MAX_DEFERRED_ENVIRONMENT_CLOSE_MS
          );
          closeTimer.unref?.();
          return;
        }
        deps.operations.markEnvironmentInstanceShuttingDown(ctx.instanceId);
        deps.servers.delete(ctx.instanceId);
        closeGenerations.delete(ctx.instanceId);
        await new Promise<void>((resolve) =>
          entry.server.close(() => resolve())
        );
      }
    }
  };
}

export type RadiusCanvas = ReturnType<typeof createRadiusCanvas>;
