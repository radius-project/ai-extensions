import type { CanvasGraphResource, CanvasState } from "../../shared.js";
import { isAppGraphCurrent } from "../../app-graph-artifact.js";

// The one modeling pipeline behind every `graphs-planning` write route.
//
// `/api/load-graph`, `/api/plan-graph` and `/api/diff-branches` are near-clones
// of a single sequence: resolve the app.bicep for a (repo, branch) selection,
// stage the `.radius/` artifacts that selection compiles against, compile the
// Bicep through `rad`, and normalize the result into canvas resources. They
// differ only in what they do *between* those stages — load-graph fingerprints
// the artifacts for its reuse cache, plan-graph resolves recipes afterwards, and
// diff-branches runs the whole thing twice and subtracts.
//
// The stages are therefore exposed individually rather than as one call: each
// route needs a different intermediate value, and collapsing them into a single
// entry point would force a flag argument per caller and hide the exact
// ordering that the migration has to preserve. Every stage is pure composition
// over injected seams — this module spawns nothing, reads no module-level state
// and owns no cache.

export const DEFAULT_APP_BICEP_PATH = ".radius/app.bicep";

// The instance entry as the graph routes see it. Only `state` is declared: the
// entry indirection is kept rather than flattened to a state reader because a
// missing entry and an entry with empty state must stay distinguishable, and
// every one of these routes answers 503 on the former.
//
// The pipeline is generic over the entry so a composition root can supply a
// wider entry — `server.ts` passes the live `CanvasServerEntry`, which some of
// its seams require — without this module widening to match, and without
// relying on TypeScript's bivariant method parameters to paper over the gap.
export interface GraphInstanceEntry {
  state: CanvasState;
}

// Shaped exactly like `fetchBicepSelection` in `server.ts` returns. `content` is
// nullable: a branch with no committed `.radius/app.bicep` is a normal state
// that each route handles differently, not an error.
export interface AppBicepSelection {
  content: string | null;
  graphContent?: string | null;
  fromWorkspace: boolean;
  branch: string;
  bicepPath: string;
}

// `remote` is true only when `dir` is a staged temp directory this process must
// remove after the compile. The workspace `.radius/` directory is never removed.
export interface StagedRadArtifacts {
  dir: string;
  remote: boolean;
}

export interface RadArtifactsRequest {
  isLocal: boolean;
  state?: CanvasState;
  repo: string;
  branch: string;
  bicepRepoPath: string;
  log?: (message: string) => void;
}

export interface GraphCompileOptions {
  log?: (message: string) => void;
  saveGraphJsonTo?: string;
  radArtifactsDir?: string;
  cleanupRadArtifactsDir?: boolean;
}

// Narrow seams for the whole pipeline. `github` is deliberately absent:
// the composition root binds it into `resolveRadArtifactsDir` so this module
// never holds a GitHub client, and `rad` is reached only through the injected
// `buildGraphViaRad`.
export interface GraphPipelineDependencies<
  TEntry extends GraphInstanceEntry = GraphInstanceEntry
> {
  fetchBicepSelection(
    entry: TEntry,
    repo: string,
    branch: string
  ): Promise<AppBicepSelection>;
  resolveRadArtifactsDir(
    request: RadArtifactsRequest
  ): Promise<StagedRadArtifacts>;
  buildGraphViaRad(
    content: string,
    definitionFile: string,
    options: GraphCompileOptions
  ): Promise<unknown[]>;
  applicationGraphToResources(
    appGraph: unknown,
    definitionFile: string,
    definitionContent: string
  ): unknown[];
  filterGraphVisualizationResources(
    resources: CanvasGraphResource[]
  ): CanvasGraphResource[];
  canvasGraphResources(values: unknown[]): CanvasGraphResource[];
  workspaceGraphJsonPath(
    state: CanvasState,
    bicepRepoPath: string | null | undefined
  ): string;
  graphDefinitionHash(content: string, artifactsFingerprint: string): string;
  radArtifactsFingerprint(dir?: string): string;
  // Removes a staged artifacts directory. Allowed to throw: one caller wraps it
  // best-effort and another deliberately lets the failure surface, and the two
  // are observably different.
  removeDirectory(dir: string): void;
}

export interface StageArtifactsInput<
  TEntry extends GraphInstanceEntry = GraphInstanceEntry
> {
  entry: TEntry;
  selection: AppBicepSelection;
  repo: string;
  branch: string;
  log?: (message: string) => void;
  preferGraphArtifact?: boolean;
}

export interface CompileResourcesInput {
  selection: AppBicepSelection;
  staged: StagedRadArtifacts;
  log?: (message: string) => void;
  saveGraphJsonTo?: string;
  preferGraphArtifact?: boolean;
}

export interface GraphPipeline<
  TEntry extends GraphInstanceEntry = GraphInstanceEntry
> {
  selectAppBicep(
    entry: TEntry,
    repo: string,
    branch: string
  ): Promise<AppBicepSelection>;
  bicepPathOf(selection: AppBicepSelection): string;
  canUseGraphArtifact(selection: AppBicepSelection): boolean;
  stageArtifacts(
    input: StageArtifactsInput<TEntry>
  ): Promise<StagedRadArtifacts>;
  compileResources(
    input: CompileResourcesInput
  ): Promise<CanvasGraphResource[]>;
  toCanvasResources(values: unknown[]): CanvasGraphResource[];
  graphJsonPathFor(entry: TEntry, selection: AppBicepSelection): string;
  definitionHashFor(
    selection: AppBicepSelection,
    staged: StagedRadArtifacts,
    preferGraphArtifact?: boolean
  ): string;
  discardStagedArtifacts(staged: StagedRadArtifacts): void;
}

export function createGraphPipeline<TEntry extends GraphInstanceEntry>(
  dependencies: GraphPipelineDependencies<TEntry>
): GraphPipeline<TEntry> {
  function bicepPathOf(selection: AppBicepSelection): string {
    // `||` not `??`: an empty `bicepPath` means "not resolved from the
    // workspace" and must fall back, which `??` would not do.
    return selection.bicepPath || DEFAULT_APP_BICEP_PATH;
  }

  function canUseGraphArtifact(selection: AppBicepSelection): boolean {
    return isAppGraphCurrent(selection.graphContent, selection.content);
  }

  return {
    selectAppBicep(entry, repo, branch) {
      return dependencies.fetchBicepSelection(entry, repo, branch);
    },

    bicepPathOf,

    canUseGraphArtifact,

    stageArtifacts({
      entry,
      selection,
      repo,
      branch,
      log,
      preferGraphArtifact
    }) {
      if (preferGraphArtifact && canUseGraphArtifact(selection)) {
        return Promise.resolve({ dir: "", remote: false });
      }
      return dependencies.resolveRadArtifactsDir({
        // The legacy branches guard this as `!!(entry && selection.fromWorkspace)`.
        // Every caller answers 503 before reaching here when the entry is
        // missing, so the `entry &&` conjunct is an equivalent mutant; the
        // required entry argument encodes that guarantee in the type instead.
        isLocal: !!selection.fromWorkspace,
        state: entry.state,
        repo,
        branch,
        bicepRepoPath: bicepPathOf(selection),
        log
      });
    },

    compileResources({
      selection,
      staged,
      log,
      saveGraphJsonTo,
      preferGraphArtifact
    }) {
      if (preferGraphArtifact && canUseGraphArtifact(selection)) {
        return Promise.resolve().then(() => {
          const appGraph = JSON.parse(selection.graphContent || "");
          return dependencies.filterGraphVisualizationResources(
            dependencies.canvasGraphResources(
              dependencies.applicationGraphToResources(
                appGraph,
                bicepPathOf(selection),
                selection.content || ""
              )
            )
          );
        });
      }
      return dependencies
        .buildGraphViaRad(selection.content || "", bicepPathOf(selection), {
          log,
          saveGraphJsonTo,
          radArtifactsDir: staged.dir,
          cleanupRadArtifactsDir: staged.remote
        })
        .then((values) => dependencies.canvasGraphResources(values));
    },

    toCanvasResources(values) {
      return dependencies.canvasGraphResources(values);
    },

    graphJsonPathFor(entry, selection) {
      // Only a workspace-sourced selection writes `app-graph.json` back beside
      // its Bicep; a branch fetched from GitHub has nowhere local to persist it.
      return selection.fromWorkspace ?
          dependencies.workspaceGraphJsonPath(entry.state, selection.bicepPath)
        : "";
    },

    definitionHashFor(selection, staged, preferGraphArtifact) {
      // The hash covers the artifacts as well as the Bicep, so editing a local
      // recipe or extension invalidates a cached graph the Bicep alone would
      // have matched.
      return dependencies.graphDefinitionHash(
        (preferGraphArtifact &&
          canUseGraphArtifact(selection) &&
          selection.graphContent) ||
          selection.content ||
          "",
        preferGraphArtifact && canUseGraphArtifact(selection) ? "" : (
          dependencies.radArtifactsFingerprint(staged.dir)
        )
      );
    },

    discardStagedArtifacts(staged) {
      if (staged.remote && staged.dir) dependencies.removeDirectory(staged.dir);
    }
  };
}
