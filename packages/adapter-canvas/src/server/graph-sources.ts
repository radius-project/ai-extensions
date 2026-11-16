import type { GraphSourceBindings } from "@radius-project/adapter-shared";
import { GraphSourceError } from "@radius-project/core";
import type { CanvasState } from "../shared.js";
import type {
  AppBicepSelection,
  RadArtifactsRequest,
  StagedRadArtifacts
} from "./routes/graph-pipeline.js";

export function createCanvasGraphSources(
  sources: GraphSourceBindings,
  workspaceAuthorized: (
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
      const selected = await sources.read({
        repo,
        ref: branch,
        definitionPath,
        workspace: {
          repo: state.workspaceRepo || "",
          ref: state.workspaceBranch || "",
          path: state.workspacePath || "",
          authorized: workspaceAuthorized(state, repo, branch)
        }
      });
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
        sourceRead: selected
      };
    },
    async readForRecovery(
      entry: { state: CanvasState },
      repo: string,
      branch: string,
      definitionPath: string
    ) {
      const local = workspaceAuthorized(entry.state, repo, branch);
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
