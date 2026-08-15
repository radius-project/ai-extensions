import type { CanvasGraphResource, CanvasState } from "../../shared.js";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";

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

export interface BicepSelection {
  content: string | null;
  fromWorkspace: boolean;
  branch: string;
  bicepPath: string;
}

export interface RadArtifactsDir {
  dir: string;
  remote: boolean;
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
  fetchBicepSelection(
    entry: PlannedGraphInstanceEntry,
    repo: string,
    branch: string
  ): Promise<BicepSelection>;
  // `github` is bound at the composition root rather than threaded through
  // here, so this port stays a narrow typed description of what the stage
  // needs instead of carrying a client object.
  radArtifactsDirForSelection(input: {
    isLocal: boolean;
    state: CanvasState | undefined;
    repo: string;
    branch: string;
    bicepRepoPath: string;
    log(message: string): void;
  }): Promise<RadArtifactsDir>;
  buildGraphViaRad(
    content: string,
    bicepPath: string,
    options: {
      log(message: string): void;
      radArtifactsDir: string;
      cleanupRadArtifactsDir: boolean;
    }
  ): Promise<unknown[]>;
  fetchRecipePack(provider: string): Promise<unknown>;
  resolveRecipeOutputs(
    parsed: CanvasGraphResource[],
    recipes: unknown,
    provider: string
  ): Promise<unknown[]>;
  canvasGraphResources(values: unknown[]): CanvasGraphResource[];
  errorMessage(error: unknown): string;
}

export interface PlannedGraphRecoveryRequest {
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
    "fetchBicepSelection",
    "radArtifactsDirForSelection",
    "buildGraphViaRad",
    "fetchRecipePack",
    "resolveRecipeOutputs",
    "canvasGraphResources",
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
    async recover({ entry, repo, branch, provider, log }) {
      log("Resolving planned application graph for " + repo + "...");
      const sourceRefContext = dependencies.prepareSourceRefResources(
        entry,
        "planned",
        { repo, branch }
      );
      try {
        const selection = await dependencies.fetchBicepSelection(
          entry,
          repo,
          branch
        );
        const content = selection.content;
        if (!content) {
          log(
            "⚠ .radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill to show the planned graph."
          );
          return null;
        }
        const { dir: radArtifactsDir, remote: radArtifactsRemote } =
          await dependencies.radArtifactsDirForSelection({
            isLocal: !!(entry && selection.fromWorkspace),
            state: entry?.state,
            repo,
            branch,
            bicepRepoPath: selection.bicepPath || ".radius/app.bicep",
            log
          });
        const parsed = dependencies.canvasGraphResources(
          await dependencies.buildGraphViaRad(
            content,
            selection.bicepPath || ".radius/app.bicep",
            {
              log,
              radArtifactsDir,
              cleanupRadArtifactsDir: radArtifactsRemote
            }
          )
        );
        const recipes = await dependencies.fetchRecipePack(provider);
        const planned = dependencies.canvasGraphResources(
          await dependencies.resolveRecipeOutputs(parsed, recipes, provider)
        );
        planned.forEach((r) => {
          r.deployStatus = "pending";
          if (r.outputResources)
            r.outputResources.forEach((o) => {
              o.deployStatus = "pending";
            });
        });
        const committed = dependencies.setSourceRefResources(
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
