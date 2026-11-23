import type { CanvasGraphResource, CanvasState } from "../../shared.js";
import { appModelAuthoringFailure } from "../../app-model-authoring-failure.js";
import {
  prepareGraph,
  compilePreparedGraph,
  type GraphSourceRead,
  type StagedGraphArtifacts
} from "@radius-project/core";

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

export class GraphRequestSuperseded extends Error {}

export class BlankModelAuthoringFailed extends Error {
  constructor(
    message: string,
    readonly verifyWorkspaceBranch?: AppBicepSelection["verifyWorkspaceBranch"]
  ) {
    super(message);
  }
}

export function requireNonblankGraphModel(
  selection: AppBicepSelection,
  state: CanvasState,
  repo: string,
  branch: string
): void {
  if (selection.content === null || selection.content.trim()) return;
  const failure =
    selection.fromWorkspace && appModelAuthoringFailure(state, repo, branch);
  if (failure)
    throw new BlankModelAuthoringFailed(
      `Model generation failed and left ${selection.bicepPath || DEFAULT_APP_BICEP_PATH} empty. Fix or remove the file, then select Refresh. Diagnostic: ${failure.error}`,
      selection.verifyWorkspaceBranch
    );
  throw new Error(
    `${repo}@${branch}:${selection.bicepPath || DEFAULT_APP_BICEP_PATH} is empty; the graph is unavailable.`
  );
}

export function graphArtifactHandle(
  staged: StagedRadArtifacts,
  remove: (dir: string) => void | Promise<void>
): StagedGraphArtifacts {
  return (
    staged.handle ?? {
      dir: staged.dir,
      owned: staged.remote,
      fingerprint: "",
      dispose: async () => {
        if (staged.remote && staged.dir) await remove(staged.dir);
      }
    }
  );
}

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
  fromWorkspace: boolean;
  branch: string;
  bicepPath: string;
  sourceRead?: GraphSourceRead;
  verifyWorkspaceBranch?: () => Promise<boolean>;
}

// `remote` is true only when `dir` is a staged temp directory this process must
// remove after the compile. The workspace `.radius/` directory is never removed.
export interface StagedRadArtifacts {
  dir: string;
  remote: boolean;
  handle?: StagedGraphArtifacts;
}

export interface RadArtifactsRequest {
  selection: GraphSourceRead;
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

// Eight narrow seams for the whole pipeline. `github` is deliberately absent:
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
  canvasGraphResources(values: unknown[]): CanvasGraphResource[];
  workspaceGraphJsonPath(
    state: CanvasState,
    bicepRepoPath: string | null | undefined
  ): string;
  graphDefinitionHash(content: string, artifactsFingerprint: string): string;
  // The owning orchestration scope reports disposal failures without replacing
  // the primary graph result.
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
}

export interface CompileResourcesInput {
  selection: AppBicepSelection;
  staged: StagedRadArtifacts;
  log?: (message: string) => void;
  saveGraphJsonTo?: string;
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
    staged: StagedRadArtifacts
  ): string;
  modelRevisionFor(selection: AppBicepSelection): string;
  discardStagedArtifacts(staged: StagedRadArtifacts): void | Promise<void>;
}

export function graphSourceForSelection(
  selection: AppBicepSelection,
  repo = "",
  branch = selection.branch
): GraphSourceRead {
  if (selection.sourceRead) return selection.sourceRead;
  const source = {
    kind:
      selection.fromWorkspace ? ("workspace" as const) : ("github" as const),
    repo,
    ref: branch,
    definitionPath: selection.bicepPath || DEFAULT_APP_BICEP_PATH
  };
  return selection.content === null ?
      { status: "absent", source }
    : { status: "present", source, content: selection.content };
}

export function createGraphPipeline<TEntry extends GraphInstanceEntry>(
  dependencies: GraphPipelineDependencies<TEntry>
): GraphPipeline<TEntry> {
  function bicepPathOf(selection: AppBicepSelection): string {
    // `||` not `??`: an empty `bicepPath` means "not resolved from the
    // workspace" and must fall back, which `??` would not do.
    return selection.bicepPath || DEFAULT_APP_BICEP_PATH;
  }

  return {
    async selectAppBicep(entry, repo, branch) {
      const selection = await dependencies.fetchBicepSelection(
        entry,
        repo,
        branch
      );
      requireNonblankGraphModel(selection, entry.state, repo, branch);
      return selection;
    },

    bicepPathOf,

    async stageArtifacts({ entry, selection, repo, branch, log }) {
      const selected = graphSourceForSelection(selection, repo, branch);
      let staged: StagedRadArtifacts = { dir: "", remote: false };
      const prepared = await prepareGraph(selected, async () => {
        staged = await dependencies.resolveRadArtifactsDir({
          selection: selected,
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
        return (
          staged.handle ?? {
            dir: staged.dir,
            owned: staged.remote,
            fingerprint: "",
            dispose: async () => {
              if (staged.remote && staged.dir)
                dependencies.removeDirectory(staged.dir);
            }
          }
        );
      });
      return { ...staged, handle: prepared.staged };
    },

    compileResources({ selection, staged, log, saveGraphJsonTo }) {
      if (selection.content === null) return Promise.resolve([]);
      if (!selection.content.trim()) {
        return Promise.reject(
          new Error(
            `${bicepPathOf(selection)} is empty; the graph is unavailable.`
          )
        );
      }
      return compilePreparedGraph(
        {
          selection: graphSourceForSelection(selection),
          staged: graphArtifactHandle(staged, dependencies.removeDirectory)
        },
        (content, definitionPath, options) =>
          dependencies
            .buildGraphViaRad(content, definitionPath, {
              log,
              saveGraphJsonTo,
              ...options
            })
            .then((values) => dependencies.canvasGraphResources(values))
      );
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

    definitionHashFor(selection, staged) {
      // The hash covers the artifacts as well as the Bicep, so editing a local
      // recipe or extension invalidates a cached graph the Bicep alone would
      // have matched.
      return dependencies.graphDefinitionHash(
        selection.content || "",
        staged.handle?.fingerprint ?? ""
      );
    },

    modelRevisionFor(selection) {
      return dependencies.graphDefinitionHash(selection.content || "", "");
    },

    discardStagedArtifacts(staged) {
      if (staged.handle) return staged.handle.dispose();
      if (staged.remote && staged.dir) dependencies.removeDirectory(staged.dir);
    }
  };
}
