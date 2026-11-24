import type { GraphSourceBindings } from "@radius-project/adapter-shared";
import { GraphSourceError } from "@radius-project/core";
import type { CanvasState } from "../shared.js";
import { GraphRequestSuperseded } from "./routes/graph-pipeline.js";
import type {
  AppBicepSelection,
  RadArtifactsRequest,
  StagedRadArtifacts
} from "./routes/graph-pipeline.js";

export function createCanvasGraphSources(
  sources: GraphSourceBindings,
  recoveryWorkspaceAuthorized: (
    state: CanvasState,
    repo: string,
    branch: string
  ) => boolean,
  currentBranch: (workspacePath: string) => Promise<string>
) {
  return {
    async select(
      entry: { state: CanvasState },
      repo: string,
      branch: string,
      definitionPath?: string
    ): Promise<AppBicepSelection> {
      const { state } = entry;
      const workspacePath = state.workspacePath;
      const workspaceRepo = state.workspaceRepo;
      const eligible =
        !!workspacePath && !!workspaceRepo && workspaceRepo === repo;
      const liveBranch =
        eligible ? await currentBranch(workspacePath).catch(() => "") : "";
      const ownsWorkspace = () =>
        entry.state === state &&
        state.workspacePath === workspacePath &&
        state.workspaceRepo === workspaceRepo;
      if (eligible && (!liveBranch || !ownsWorkspace()))
        throw new GraphRequestSuperseded();
      const local = eligible && liveBranch === branch;
      const verifyWorkspaceBranch = async () =>
        ownsWorkspace() &&
        (await currentBranch(workspacePath || "").catch(() => "")) === branch &&
        ownsWorkspace();
      const selected = await sources.read({
        repo,
        ref: branch,
        definitionPath,
        workspace: {
          repo: workspaceRepo || "",
          ref: liveBranch,
          path: workspacePath || "",
          authorized: local
        }
      });
      if (local && !(await verifyWorkspaceBranch()))
        throw new GraphRequestSuperseded();
      if (selected.status === "unavailable")
        throw new GraphSourceError(
          "unavailable",
          `${selected.source.repo}@${selected.source.ref}:${selected.source.definitionPath}: ${selected.diagnostic}`,
          selected.source
        );
      return {
        content: selected.status === "present" ? selected.content : null,
        fromWorkspace: selected.source.kind === "workspace",
        branch,
        bicepPath: selected.source.definitionPath,
        sourceRead: selected,
        ...(local ? { verifyWorkspaceBranch } : {})
      };
    },
    async readForRecovery(
      entry: { state: CanvasState },
      repo: string,
      branch: string,
      definitionPath: string
    ) {
      const local = recoveryWorkspaceAuthorized(entry.state, repo, branch);
      const assertBranch = async () => {
        if (
          local &&
          (await currentBranch(entry.state.workspacePath || "")) !== branch
        ) {
          throw new Error(
            "The captured workspace branch changed; the planned graph is unavailable."
          );
        }
      };
      await assertBranch();
      const selected = await sources.read({
        repo,
        ref: branch,
        definitionPath,
        workspace: {
          repo: entry.state.workspaceRepo || "",
          ref: entry.state.workspaceBranch || "",
          path: entry.state.workspacePath || "",
          authorized: local
        }
      });
      await assertBranch();
      return selected;
    },
    async stage(request: RadArtifactsRequest): Promise<StagedRadArtifacts> {
      if (request.selection.status !== "present")
        return { dir: "", remote: false };
      const handle = await sources.stage(request.selection);
      return { dir: handle.dir, remote: handle.owned, handle };
    }
  };
}
