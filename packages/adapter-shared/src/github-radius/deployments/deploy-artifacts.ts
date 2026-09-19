import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import path from "node:path";
import {
  ARTIFACT_PAGE_SIZE,
  MAX_ARTIFACT_PAGES,
  DEPLOY_STATUS_ARTIFACT_PREFIX,
  isLiveSlotArtifactName,
  type ArtifactFiles,
  type WorkflowArtifact,
  type ListArtifacts,
  type DownloadArtifact
} from "@radius-project/core/github-radius/deployments/deploy-artifacts";

export interface ArtifactExecutionPorts {
  runGh(args: string[], timeout: number): Promise<string>;
  scratchDirectory: string;
}

function artifactError(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  const classified: Error & { code?: string } = new Error(text);
  if (/HTTP 40[13]\b/.test(text) || /\bForbidden\b/i.test(text))
    classified.code = "GH_ARTIFACT_AUTH";
  return classified;
}

function artifacts(value: unknown): WorkflowArtifact[] {
  if (
    value === null ||
    typeof value !== "object" ||
    !("artifacts" in value) ||
    !Array.isArray(value.artifacts)
  ) {
    throw new Error("GitHub returned an invalid artifact listing.");
  }
  return value.artifacts.map((item: unknown) => {
    if (
      item === null ||
      typeof item !== "object" ||
      !("id" in item) ||
      typeof item.id !== "number" ||
      !("name" in item) ||
      typeof item.name !== "string"
    )
      throw new Error("GitHub returned an invalid artifact record.");
    const run = "workflow_run" in item ? item.workflow_run : null;
    return {
      id: item.id,
      name: item.name,
      ...("expired" in item && typeof item.expired === "boolean" ?
        { expired: item.expired }
      : {}),
      ...("created_at" in item && typeof item.created_at === "string" ?
        { created_at: item.created_at }
      : {}),
      ...((
        run &&
        typeof run === "object" &&
        "id" in run &&
        typeof run.id === "number"
      ) ?
        { workflow_run: { id: run.id } }
      : {})
    };
  });
}

export function createArtifactExecution(ports: ArtifactExecutionPorts): {
  listWorkflowArtifacts: ListArtifacts;
  downloadWorkflowArtifact: DownloadArtifact;
} {
  if (typeof ports.runGh !== "function" || !ports.scratchDirectory)
    throw new Error(
      "Artifact execution requires GitHub execution and a scratch directory."
    );
  const listWorkflowArtifacts: ListArtifacts = async (
    repo,
    runId,
    namePrefix
  ) => {
    const read = async (endpoint: string): Promise<WorkflowArtifact[]> => {
      try {
        return artifacts(
          JSON.parse(await ports.runGh(["api", endpoint], 20000))
        );
      } catch (error) {
        throw artifactError(error);
      }
    };
    if (runId)
      return read(
        `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=${ARTIFACT_PAGE_SIZE}`
      );
    const found: WorkflowArtifact[] = [];
    const prefix = namePrefix || DEPLOY_STATUS_ARTIFACT_PREFIX;
    for (let page = 1; page <= MAX_ARTIFACT_PAGES; page++) {
      const batch = await read(
        `/repos/${repo}/actions/artifacts?per_page=${ARTIFACT_PAGE_SIZE}&page=${page}`
      );
      found.push(...batch);
      if (
        batch.some(
          (artifact) =>
            artifact.name.startsWith(prefix) &&
            !isLiveSlotArtifactName(artifact.name)
        ) ||
        batch.length < ARTIFACT_PAGE_SIZE
      )
        break;
    }
    return found;
  };
  const downloadWorkflowArtifact: DownloadArtifact = async (repo, artifact) => {
    const runId = artifact.workflow_run?.id;
    if (!runId || !artifact.name) return null;
    const dir = mkdtempSync(
      path.join(ports.scratchDirectory, "rad-deploy-artifact-")
    );
    try {
      try {
        await ports.runGh(
          [
            "run",
            "download",
            String(runId),
            "--name",
            artifact.name,
            "--dir",
            dir,
            "--repo",
            repo
          ],
          60000
        );
      } catch (error) {
        throw artifactError(error);
      }
      const files: ArtifactFiles = {};
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        try {
          const info = statSync(file);
          if (info.isFile() && info.size <= 8 * 1024 * 1024)
            files[name] = readFileSync(file, "utf8");
        } catch {
          /* An unreadable optional file must not hide readable evidence. */
        }
      }
      return files;
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Cleanup must not replace the primary execution failure. */
      }
    }
  };
  return { listWorkflowArtifacts, downloadWorkflowArtifact };
}
