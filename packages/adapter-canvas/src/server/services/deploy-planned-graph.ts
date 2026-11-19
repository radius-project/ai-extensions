import type { CanvasGraphResource, CanvasState } from "../../shared.js";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";
import {
  createGraphOrchestrator,
  computeGraphDiff,
  type GraphSourceRead
} from "@radius-project/core";
import {
  graphArtifactHandle,
  type RadArtifactsRequest,
  type StagedRadArtifacts
} from "../routes/graph-pipeline.js";

// First runtime stage of a background deploy: rebuild the planned application
// graph when the deploy started before one was resolved, so the deploying page
// always has nodes to colour.
//
// Split out of the monitor because it is a distinct runtime responsibility with
// its own external surface (workspace-versus-remote bicep selection, `rad`
// graph building, the recipe pack) and its own safety rule: a result that
// arrives after the panel moved to another repo/branch is discarded rather than
// written, which `setSourceRefResources` decides from the token captured before
// the first await.

export interface PlannedGraphInstanceEntry {
  state: CanvasState;
}

export interface PlannedGraphRecoveryDependencies {
  // Captures the source-ref token for the "planned" view before any await, so a
  // stale result can be rejected on the way back in.
  prepareSourceRefResources(
    entry: PlannedGraphInstanceEntry,
    view: "planned",
    context: { repo: string; branch: string }
  ): { token: string };
  // Returns false when the panel's planned context changed while the graph was
  // being built, which is the stale-result rejection.
  setSourceRefResources(
    entry: PlannedGraphInstanceEntry,
    view: "planned",
    resources: CanvasGraphResource[],
    context: { repo: string; branch: string },
    expectedToken: string
  ): boolean;
  readModelForSelection(
    entry: PlannedGraphInstanceEntry,
    repo: string,
    branch: string,
    appFile: string
  ): Promise<GraphSourceRead>;
  // `github` is bound at the composition root rather than threaded through
  // here, so this port stays a narrow typed description of what the stage
  // needs instead of carrying a client object.
  radArtifactsDirForSelection(
    input: RadArtifactsRequest
  ): Promise<StagedRadArtifacts>;
  buildGraphViaRad(
    content: string,
    bicepPath: string,
    options: {
      log(message: string): void;
      radArtifactsDir: string;
      cleanupRadArtifactsDir: boolean;
    }
  ): Promise<unknown[]>;
  fetchRecipePack(provider: string): Promise<unknown[]>;
  resolveRecipeOutputs(
    parsed: CanvasGraphResource[],
    recipes: unknown,
    provider: string
  ): Promise<unknown[]>;
  canvasGraphResources(values: unknown[]): CanvasGraphResource[];
  removeDirectory(dir: string): void;
  errorMessage(error: unknown): string;
}

export interface PlannedGraphRecoveryRequest {
  appFile: string;
  entry: PlannedGraphInstanceEntry;
  repo: string;
  branch: string;
  provider: string;
  log(message: string): void;
}

export interface PlannedGraphRecoveryService {
  // Returns the planned resources it committed to the instance state, or null
  // when app.bicep was absent or the rebuild failed. Both are logged and
  // non-fatal: the deploy continues with an empty graph.
  recover(
    request: PlannedGraphRecoveryRequest
  ): Promise<CanvasGraphResource[] | null>;
}

const REQUIRED_DEPENDENCIES: readonly (keyof PlannedGraphRecoveryDependencies)[] =
  [
    "prepareSourceRefResources",
    "setSourceRefResources",
    "readModelForSelection",
    "radArtifactsDirForSelection",
    "buildGraphViaRad",
    "fetchRecipePack",
    "resolveRecipeOutputs",
    "canvasGraphResources",
    "removeDirectory",
    "errorMessage"
  ];

export function createPlannedGraphRecoveryService(
  dependencies: PlannedGraphRecoveryDependencies
): PlannedGraphRecoveryService {
  assertDeployDependencies(
    "createPlannedGraphRecoveryService",
    dependencies,
    REQUIRED_DEPENDENCIES
  );

  return {
    async recover({ entry, repo, branch, provider, appFile, log }) {
      log("Resolving planned application graph for " + repo + "...");
      // The planned view is keyed by repo/branch, not model path. Explicit and
      // repair selections must not replace that automatic-selection cache.
      const publishPlanned =
        entry.state.deployParams?.appFile === undefined &&
        entry.state.deployRepairing !== true;
      const sourceRefContext =
        publishPlanned ?
          dependencies.prepareSourceRefResources(entry, "planned", {
            repo,
            branch
          })
        : null;
      try {
        const selection = await dependencies.readModelForSelection(
          entry,
          repo,
          branch,
          appFile
        );
        if (selection.status === "unavailable")
          throw new Error(selection.diagnostic);
        if (selection.status === "absent") {
          log(`⚠ ${appFile} not present — the planned graph is unavailable.`);
          return null;
        }
        if (!selection.content.trim()) {
          throw new Error(
            `${appFile} is empty; the planned graph is unavailable.`
          );
        }
        const graph = createGraphOrchestrator<
          CanvasGraphResource,
          CanvasGraphResource[]
        >({
          stage: async (selected) =>
            graphArtifactHandle(
              await dependencies.radArtifactsDirForSelection({
                selection: selected,
                isLocal: selected.source.kind === "workspace",
                state: entry.state,
                repo,
                branch,
                bicepRepoPath: selected.source.definitionPath,
                log
              }),
              dependencies.removeDirectory
            ),
          compile: async (content, definitionPath, options) =>
            dependencies.canvasGraphResources(
              await dependencies.buildGraphViaRad(content, definitionPath, {
                ...options,
                log
              })
            ),
          diff: computeGraphDiff,
          diagnostic: (message) =>
            log(`Could not remove staged graph artifacts: ${message}`)
        });
        const authored = await graph.authored(selection);
        const enriched = await graph.enrich(authored.resources, provider, {
          fetchRecipePack: dependencies.fetchRecipePack,
          resolveRecipeOutputs: async (resources, recipes, selectedProvider) =>
            dependencies.canvasGraphResources(
              await dependencies.resolveRecipeOutputs(
                resources,
                recipes,
                selectedProvider
              )
            )
        });
        const planned = enriched.resources;
        planned.forEach((r) => {
          r.deployStatus = "pending";
          if (r.outputResources)
            r.outputResources.forEach((o) => {
              o.deployStatus = "pending";
            });
        });
        const committed =
          sourceRefContext &&
          dependencies.setSourceRefResources(
            entry,
            "planned",
            planned,
            { repo, branch },
            sourceRefContext.token
          );
        if (committed) entry.state.plannedRepo = repo;
        // Written here rather than by the caller so the visible mutation order
        // matches the legacy arm exactly: planned repo, then the deploying
        // graph, then the log line a status poll uses to notice.
        entry.state.deployingResources = planned;
        log("Planned " + planned.length + " resource(s).");
        return planned;
      } catch (e) {
        log(
          "⚠ Could not resolve planned graph: " + dependencies.errorMessage(e)
        );
        return null;
      }
    }
  };
}
