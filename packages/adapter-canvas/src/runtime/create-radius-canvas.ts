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
import { record, optionalString } from "./util.js";
import { DEFAULT_CANVAS_PAGE } from "./hooks.js";
import { reloadCanvasInstance } from "./canvas-lifecycle.js";
import { createGraphContextHelpers } from "./graph-context.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import {
  createRadiusCanvasInstanceRegistry,
  type RadiusCanvasInstanceRegistry
} from "./canvas-instance-registry.js";
import type { CanvasState } from "../shared.js";
import { readCommittedGraphDiff, canvasResources } from "./graph-reader.js";
import { randomUUID } from "node:crypto";

const MAX_DEFERRED_ENVIRONMENT_CLOSE_MS = 46 * 60 * 1000;

interface CanvasContext {
  extensionId: string;
  canvasId: string;
  instanceId: string;
  // Host-supplied JSON of any shape; every consumer narrows it via record().
  input?: unknown;
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
export function createRadiusCanvas(
  deps: RadiusExtensionDependencies,
  canvasInstances: RadiusCanvasInstanceRegistry = createRadiusCanvasInstanceRegistry()
) {
  const closeGenerations = new Map<string, number>();
  const { workspaceState } = createGraphContextHelpers(deps);

  const declarationByName = new Map(
    RADIUS_ACTION_DECLARATIONS.map((decl) => [decl.name, decl])
  );

  const actions = [
    {
      ...declarationByName.get("get_graph_resources")!,
      handler: async (ctx: CanvasContext) => {
        const generation = closeGenerations.get(ctx.instanceId);
        const entry = await deps.getOrCreateServer(ctx.instanceId);
        if (
          generation !== closeGenerations.get(ctx.instanceId) ||
          deps.servers.get(ctx.instanceId) !== entry
        )
          return {
            ready: false,
            resources: [],
            message: "The graph context changed."
          };
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
        const generation = closeGenerations.get(ctx.instanceId);
        const entry = await deps.getOrCreateServer(ctx.instanceId);
        if (
          generation !== closeGenerations.get(ctx.instanceId) ||
          deps.servers.get(ctx.instanceId) !== entry
        )
          return {
            error: "The graph context changed.",
            updated: 0,
            queued: 0,
            skipped: 0
          };
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
        if (
          deps.servers.get(ctx.instanceId) !== entry ||
          (result.view !== "graph" &&
            result.view !== "planned" &&
            result.view !== "diff") ||
          !isCurrentSourceRefToken(entry.state, result.view, contextToken)
        )
          return {
            error: "The graph context changed.",
            updated: 0,
            queued: 0,
            skipped: 0
          };
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
      const activeInstanceId = canvasInstances.claim(ctx.instanceId);
      if (activeInstanceId !== ctx.instanceId) {
        throw new Error(
          `Radius canvas instance ${activeInstanceId} is already open; reuse it instead of opening ${ctx.instanceId}.`
        );
      }
      closeGenerations.set(
        ctx.instanceId,
        (closeGenerations.get(ctx.instanceId) || 0) + 1
      );
      const openGeneration = closeGenerations.get(ctx.instanceId);
      const input = record(ctx.input);
      const page = optionalString(input.page) || DEFAULT_CANVAS_PAGE;
      let entry;
      try {
        entry = await deps.getOrCreateServer(ctx.instanceId, page);
        if (
          closeGenerations.get(ctx.instanceId) !== openGeneration ||
          deps.servers.get(ctx.instanceId) !== entry
        )
          throw new Error("The canvas context changed while opening.");
      } catch (error) {
        if (!deps.servers.has(ctx.instanceId)) {
          canvasInstances.release(ctx.instanceId);
        }
        throw error;
      }
      entry.state.canvasInstanceId = ctx.instanceId;
      entry.state.activeGraphView =
        page === "graph-diff" ? "diff"
        : page === "planned" ? "planned"
        : page === "graph" ? "graph"
        : entry.state.activeGraphView;
      const previousExplicitContext =
        entry.state.contextBranchSource === "explicit" ?
          {
            repo: entry.state.contextRepo,
            branch: entry.state.contextBranch
          }
        : undefined;
      const workspace = await workspaceState();
      if (
        closeGenerations.get(ctx.instanceId) !== openGeneration ||
        deps.servers.get(ctx.instanceId) !== entry
      )
        throw new Error("The canvas context changed while opening.");
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
        entry.state.contextBranchSource =
          !inputBranch && inputRepo === workspace.workspaceRepo ?
            "workspace"
          : "explicit";
      } else if (inputBranch) {
        // Omitting the repository selects the current context repository, but an
        // explicitly named branch still identifies the remote selection to use.
        entry.state.contextBranch = inputBranch;
        entry.state.contextBranchSource = "explicit";
      } else if (previousExplicitContext) {
        entry.state.contextRepo = previousExplicitContext.repo;
        entry.state.contextBranch = previousExplicitContext.branch;
        entry.state.contextBranchSource = "explicit";
      } else {
        entry.state.contextBranchSource = "workspace";
      }
      if (
        !inputRepo &&
        !entry.state.contextRepo &&
        deps.session.get().workspacePath
      ) {
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
        const previous = entry.state.sourceRefContexts?.[page];
        const sameSelection =
          previous?.repo === entry.state.contextRepo &&
          previous?.branch === entry.state.contextBranch;
        deps.sourceRefs.prepareSourceRefResources(entry, page, {
          repo: entry.state.contextRepo || "",
          branch: entry.state.contextBranch || "",
          ...(sameSelection ? previous : { requestId: randomUUID() })
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
          { repo, baseBranch, headBranch, requestId: randomUUID() }
        );
        entry.state.diffBase = baseBranch;
        entry.state.diffHead = headBranch;
        entry.state.diffTargetRepo = repo;
        delete entry.state.diffError;
        delete entry.state.diffModelingFailed;
        try {
          const result = await readCommittedGraphDiff(
            deps.lifecycle,
            repo,
            baseBranch,
            headBranch
          );
          if (
            !isCurrentSourceRefToken(
              entry.state,
              "diff",
              sourceRefContext.token
            ) ||
            deps.servers.get(ctx.instanceId) !== entry
          )
            return { title: "Radius", url: entry.url };
          entry.state.graphReadEvidence ??= {};
          if (result.status !== "ok") {
            delete entry.state.diffResources;
            delete entry.state.diffNoChanges;
            entry.state.graphReadEvidence.diff = {
              unavailable: true,
              reason: result.error.code,
              message: result.error.message
            };
            entry.state.diffError = `${result.error.code}: ${result.error.message}`;
            return { title: "Radius", url: entry.url };
          }
          if (result.value.status === "unavailable") {
            delete entry.state.diffResources;
            delete entry.state.diffNoChanges;
            entry.state.graphReadEvidence.diff = {
              unavailable: true,
              reason: result.value.reason,
              message: result.value.message,
              source: result.value.source
            };
            entry.state.diffError = `${result.value.reason}: ${result.value.message}`;
            return { title: "Radius", url: entry.url };
          }
          const diffResources = canvasResources(result.value.graph);
          const committed = deps.sourceRefs.setSourceRefResources(
            entry,
            "diff",
            diffResources,
            {
              ...sourceRefContext,
              provenance: { base: result.value.base, head: result.value.head }
            },
            sourceRefContext.token
          );
          if (committed) {
            entry.state.graphReadEvidence.diff = {
              unavailable: false,
              result: result.value
            };
            delete entry.state.diffModelingFailed;
            const hasChanges = diffResources.some(
              (r) => r.diffStatus !== "unchanged"
            );
            entry.state.diffNoChanges = !hasChanges;
          }
        } catch (e) {
          if (
            deps.servers.get(ctx.instanceId) === entry &&
            isCurrentSourceRefToken(entry.state, "diff", sourceRefContext.token)
          ) {
            delete entry.state.diffResources;
            delete entry.state.diffNoChanges;
            entry.state.diffError =
              "The selected graph comparison is unavailable.";
            entry.state.graphReadEvidence ??= {};
            entry.state.graphReadEvidence.diff = {
              unavailable: true,
              reason: "RESULT_UNAVAILABLE",
              message: entry.state.diffError
            };
          }
        }
      }

      return { title: "Radius", url: entry.url };
    },
    onClose: async (ctx: CanvasContext) => {
      const entry = deps.servers.get(ctx.instanceId);
      if (entry) {
        delete entry.state.sourceRefContexts;
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
            canvasInstances.release(ctx.instanceId);
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
        canvasInstances.release(ctx.instanceId);
        await new Promise<void>((resolve) =>
          entry.server.close(() => resolve())
        );
      }
    }
  };
}

export type RadiusCanvas = ReturnType<typeof createRadiusCanvas>;
