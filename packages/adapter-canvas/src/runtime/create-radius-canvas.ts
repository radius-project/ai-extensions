// createRadiusCanvas — builds the "radius" canvas definition (metadata, the 6
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
  appBicepHandoffMessage
} from "./hooks.js";
import { reloadCanvasInstance } from "./canvas-lifecycle.js";
import { createGraphContextHelpers } from "./graph-context.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import type { CanvasServerEntry } from "../server.js";
import type { CanvasGraphResource, CanvasState } from "../shared.js";

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

function graphResources(value: unknown): CanvasGraphResource[] {
  if (!Array.isArray(value)) return [];
  return value.map((resource) => {
    const fields = record(resource);
    return {
      ...fields,
      id: optionalString(fields.id),
      name: optionalString(fields.name),
      type: optionalString(fields.type)
    };
  });
}

// Everything below this line is created by createRadiusCanvas so it can close
// over `deps` instead of module-level imports of server.ts/gh.ts/workspace.ts.
export function createRadiusCanvas(deps: RadiusExtensionDependencies) {
  const { workspaceState, fetchBicepForBranch } =
    createGraphContextHelpers(deps);

  // When a graph canvas is opened but no .radius/app.bicep exists, hand the
  // work off to the agent/skill. Fire-and-forget, guarded so we send at most
  // once per repo+branch combination (mirrors the original extension.ts).
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

      const key = `${repo}::${branches.join(",")}`;
      if (state.appBicepHandoffKey === key) return;
      state.appBicepHandoffKey = key;

      const found = await Promise.all(
        branches.map(async (branch) => {
          try {
            return !!(await fetchBicepForBranch(repo, branch as string, state));
          } catch {
            return false;
          }
        })
      );
      if (found.some(Boolean)) return;

      try {
        const session = deps.session.get();
        Promise.resolve(
          session.send(appBicepHandoffMessage(repo, page, branches))
        ).catch(() => {});
      } catch {
        /* session.send unavailable → ignore */
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
      ...declarationByName.get("configure_oidc")!,
      handler: async (ctx: CanvasContext) => {
        const entry = await deps.getOrCreateServer(
          ctx.instanceId,
          "credentials"
        );
        const data = record(ctx.input);
        const result =
          data.provider === "azure" ?
            deps.infra.generateAzureOIDC(data)
          : deps.infra.generateAWSOIDC(data);
        if (data.provider === "azure") {
          entry.state.oidcAzure = {
            ...result,
            tenantId: optionalString(data.tenantId),
            tenantName: optionalString(data.tenantName),
            subscriptionId: optionalString(data.subscriptionId),
            subscriptionName: optionalString(data.subscriptionName),
            clientId: optionalString(data.clientId),
            clientName: optionalString(data.clientName)
          };
        } else {
          entry.state.oidcAws = {
            ...result,
            accountId: optionalString(data.accountId),
            accountName: optionalString(data.accountName),
            region: optionalString(data.region)
          };
        }
        entry.url = `${entry.baseUrl}/?page=environment`;
        return { message: result.message, url: entry.url };
      }
    },
    {
      ...declarationByName.get("render_graph")!,
      handler: async (ctx: CanvasContext) => {
        const entry = await deps.getOrCreateServer(ctx.instanceId, "graph");
        const input = record(ctx.input);
        Object.assign(entry.state, await workspaceState());
        if (Array.isArray(input.resources)) {
          const context = {
            repo: entry.state.contextRepo || entry.state.workspaceRepo || "",
            branch:
              entry.state.contextBranch || entry.state.workspaceBranch || ""
          };
          const resources = deps.core.filterGraphVisualizationResources(
            graphResources(input.resources)
          );
          deps.sourceRefs.setSourceRefResources(
            entry,
            "graph",
            resources,
            context
          );
          deps.sourceRefs.setSourceRefResources(
            entry,
            "planned",
            resources,
            context
          );
          entry.state.graphLoaded = true;
          delete entry.state.graphFromWorkspace;
          delete entry.state.plannedFromWorkspace;
        }
        entry.state.activeGraphView = "graph";
        entry.url = `${entry.baseUrl}/?page=graph`;
        return { message: "Graph rendered", url: entry.url };
      }
    },
    {
      ...declarationByName.get("render_graph_diff")!,
      handler: async (ctx: CanvasContext) => {
        const entry = await deps.getOrCreateServer(
          ctx.instanceId,
          "graph-diff"
        );
        const input = record(ctx.input);
        if (
          Array.isArray(input.baseResources) &&
          Array.isArray(input.headResources)
        ) {
          const baseResources = deps.core.filterGraphVisualizationResources(
            graphResources(input.baseResources)
          );
          const headResources = deps.core.filterGraphVisualizationResources(
            graphResources(input.headResources)
          );
          const diffResources = deps.core.computeGraphDiff(
            baseResources,
            headResources
          );
          deps.sourceRefs.setSourceRefResources(entry, "diff", diffResources, {
            repo: optionalString(input.repo),
            baseBranch: optionalString(input.baseBranch),
            headBranch: optionalString(input.headBranch)
          });
          entry.state.diffTargetRepo = optionalString(input.repo);
          entry.state.diffBase = optionalString(input.baseBranch);
          entry.state.diffHead = optionalString(input.headBranch);
        }
        entry.state.activeGraphView = "diff";
        entry.url = `${entry.baseUrl}/?page=graph-diff`;
        return { message: "Diff graph rendered", url: entry.url };
      }
    },
    {
      ...declarationByName.get("create_environment")!,
      handler: async (ctx: CanvasContext) => {
        const entry = await deps.getOrCreateServer(
          ctx.instanceId,
          "environment"
        );
        const data = record(ctx.input);
        try {
          const provider = optionalString(data.provider);
          const required =
            provider === "azure" ?
              [
                "clientId",
                "tenantId",
                "subscriptionId",
                "resourceGroup",
                "cluster"
              ]
            : ["roleArn", "accountId", "region", "cluster"];
          const missing = required.filter((name) => !data[name]);
          if (missing.length > 0) {
            throw new Error(
              `Missing required ${provider} environment inputs: ${missing.join(", ")}.`
            );
          }
          const response = await deps.deploy.fetch(
            `${entry.baseUrl}/api/create-environment`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...data,
                environment: optionalString(data.name)
              })
            }
          );
          const result = record(await response.json());
          if (!response.ok && !result.error) {
            result.error = `Environment setup failed with HTTP ${response.status}.`;
          }
          entry.state.envResult = result;
        } catch (e) {
          entry.state.envResult = { error: errorMessage(e) };
        }
        entry.url = `${entry.baseUrl}/?page=environment`;
        return entry.state.envResult;
      }
    },
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
      if (inputRepo) {
        entry.state.contextRepo = inputRepo;
        if (inputRepo === workspace.workspaceRepo) {
          entry.state.contextBranch = workspace.workspaceBranch;
        } else {
          entry.state.contextBranch = optionalString(input.branch) || "main";
        }
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
          const baseResources = await deps.rad.buildGraphViaRad(
            baseContent || "",
            ".radius/app.bicep",
            {
              log,
              radArtifactsDir: baseRadArtifactsDir,
              cleanupRadArtifactsDir: baseRadArtifactsRemote
            }
          );
          const headResources = await deps.rad.buildGraphViaRad(
            headContent || "",
            ".radius/app.bicep",
            {
              log,
              radArtifactsDir: headRadArtifactsDir,
              cleanupRadArtifactsDir: headRadArtifactsRemote
            }
          );
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
        deps.servers.delete(ctx.instanceId);
        await new Promise<void>((resolve) =>
          entry.server.close(() => resolve())
        );
      }
    }
  };
}

export type RadiusCanvas = ReturnType<typeof createRadiusCanvas>;
