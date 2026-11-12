import type { DeploymentFileResult } from "@radius-project/adapter-shared";
import type { CanvasState } from "../../shared.js";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";

export type DeployModelSource =
  | { status: "available"; content: string; fromWorkspace: boolean }
  | { status: "missing" }
  | { status: "unavailable"; error: string };

export function createDeployModelSource(ports: {
  readWorkspace(
    state: CanvasState,
    repo: string,
    branch: string,
    path: string
  ): Promise<string | null>;
  readRepository(
    repo: string,
    path: string,
    branch: string
  ): Promise<DeploymentFileResult>;
  redactDiagnostic(value: string): string;
}) {
  assertDeployDependencies("createDeployModelSource", ports, [
    "readWorkspace",
    "readRepository",
    "redactDiagnostic"
  ]);
  return async (
    entry: { state: CanvasState },
    repo: string,
    branch: string,
    path: string
  ): Promise<DeployModelSource> => {
    try {
      const local = await ports.readWorkspace(entry.state, repo, branch, path);
      if (local !== null)
        return { status: "available", content: local, fromWorkspace: true };
      const remote = await ports.readRepository(repo, path, branch);
      if (remote.status === 404) return { status: "missing" };
      if (remote.error === null && remote.content !== null)
        return {
          status: "available",
          content: remote.content,
          fromWorkspace: false
        };
      if (
        remote.status === 200 &&
        remote.error === "empty response from gh api"
      )
        return { status: "available", content: "", fromWorkspace: false };
      return {
        status: "unavailable",
        error: ports.redactDiagnostic(
          remote.error || "The model source could not be read."
        )
      };
    } catch (error) {
      return {
        status: "unavailable",
        error: ports.redactDiagnostic(
          error instanceof Error ? error.message : String(error)
        )
      };
    }
  };
}
