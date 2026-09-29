import fs, {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ARTIFACT_PAGE_SIZE,
  MAX_ARTIFACT_PAGES,
  DEPLOY_STATUS_ARTIFACT_PREFIX,
  DEPLOY_STATUS_FILES,
  createDeployStatusReader,
  isLiveSlotArtifactName
} from "@radius-project/core";
import type {
  ArtifactFiles,
  DeployStatusReaderOptions,
  DownloadArtifact,
  ListArtifacts,
  WorkflowArtifact,
  WorkflowReadEvidence,
  WorkflowResponseMetadata
} from "@radius-project/core";
import type { WorkflowRunner } from "./workflow-reads.js";
import { readWorkflowApi } from "./workflow-read-response.js";

export class WorkflowArtifactReadError extends Error {
  constructor(
    readonly code:
      "GH_ARTIFACT_AUTH" | "GH_ARTIFACT_MALFORMED" | "GH_ARTIFACT_TRANSPORT",
    readonly evidence: readonly WorkflowReadEvidence[],
    message: string
  ) {
    super(message);
  }
}

export const MAX_ARTIFACT_FILE_BYTES = 8 * 1024 * 1024;

export type WorkflowArtifactReaderOptions = Omit<
  DeployStatusReaderOptions,
  "listArtifacts" | "downloadArtifact"
> &
  Partial<
    Pick<DeployStatusReaderOptions, "listArtifacts" | "downloadArtifact">
  >;

function malformed(message: string): Error {
  return Object.assign(new Error(message), { code: "GH_ARTIFACT_MALFORMED" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function artifactPage(
  value: unknown,
  evidence: readonly WorkflowReadEvidence[]
): WorkflowArtifact[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > ARTIFACT_PAGE_SIZE
  ) {
    throw new WorkflowArtifactReadError(
      "GH_ARTIFACT_MALFORMED",
      evidence,
      "GitHub returned an invalid artifact listing."
    );
  }
  return value.artifacts.map((artifact: unknown) => {
    if (
      !isRecord(artifact) ||
      typeof artifact.id !== "number" ||
      !Number.isSafeInteger(artifact.id) ||
      artifact.id <= 0 ||
      typeof artifact.name !== "string" ||
      !artifact.name ||
      (artifact.expired !== undefined &&
        typeof artifact.expired !== "boolean") ||
      (artifact.created_at != null && typeof artifact.created_at !== "string")
    ) {
      throw new WorkflowArtifactReadError(
        "GH_ARTIFACT_MALFORMED",
        evidence,
        "GitHub returned invalid artifact metadata."
      );
    }
    const run = artifact.workflow_run;
    if (
      run != null &&
      (!isRecord(run) ||
        (run.id != null &&
          (typeof run.id !== "number" ||
            !Number.isSafeInteger(run.id) ||
            run.id <= 0)))
    ) {
      throw new WorkflowArtifactReadError(
        "GH_ARTIFACT_MALFORMED",
        evidence,
        "GitHub returned an invalid artifact execution identity."
      );
    }
    return {
      id: artifact.id,
      name: artifact.name,
      ...(typeof artifact.expired === "boolean" ?
        { expired: artifact.expired }
      : {}),
      ...(typeof artifact.created_at === "string" ?
        { created_at: artifact.created_at }
      : {}),
      ...(isRecord(run) && typeof run.id === "number" ?
        { workflow_run: { id: run.id } }
      : {})
    };
  });
}

function readArtifactDir(
  directory: string,
  artifactName: string
): ArtifactFiles {
  const files: ArtifactFiles = {};
  // Only producer-owned documents are evidence. Do not follow archive links or
  // read arbitrary files that happen to be present in the download directory.
  const names =
    artifactName === "rad-delete-result" ?
      ["rad-delete-result.json"]
    : Object.values(DEPLOY_STATUS_FILES);
  for (const name of names) {
    const full = path.join(directory, name);
    try {
      if (!lstatSync(full).isFile()) {
        throw malformed(`Artifact document is not a regular file: ${name}`);
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue;
      throw error;
    }
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_FILE_BYTES) {
        throw malformed(
          `Artifact document exceeds the safe file limit: ${name}`
        );
      }
      files[name] = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }
  return files;
}

/** Node binding shared by Canvas and direct callers; the host owns execution. */
export function createWorkflowArtifactReads(run: WorkflowRunner) {
  async function command(args: string[], timeout: number): Promise<string> {
    const result = await run(args, { timeout });
    if (Number(result.code) !== 0) {
      const text =
        result.stderr || `GitHub artifact command failed (${result.code}).`;
      throw Object.assign(new Error(text), {
        code:
          /HTTP 40[13]\b/.test(text) || /\bForbidden\b/i.test(text) ?
            "GH_ARTIFACT_AUTH"
          : "GH_ARTIFACT_TRANSPORT"
      });
    }
    return result.stdout;
  }

  const listWorkflowArtifactsWithMetadata = async (
    repo: string,
    runId?: number | string | null,
    namePrefix?: string
  ) => {
    const found: WorkflowArtifact[] = [];
    const evidence: WorkflowReadEvidence[] = [];
    const prefix = namePrefix || DEPLOY_STATUS_ARTIFACT_PREFIX;
    for (let page = 1; page <= (runId ? 1 : MAX_ARTIFACT_PAGES); page++) {
      const endpoint =
        runId ?
          `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=${ARTIFACT_PAGE_SIZE}`
        : `/repos/${repo}/actions/artifacts?per_page=${ARTIFACT_PAGE_SIZE}&page=${page}`;
      const response = await readWorkflowApi(run, endpoint, { timeout: 20000 });
      evidence.push({ phase: "artifacts", response: response.metadata });
      if (!response.ok) {
        const status =
          response.metadata.source === "gh-api-include" ?
            response.metadata.status
          : null;
        throw new WorkflowArtifactReadError(
          (
            status === 401 ||
              status === 403 ||
              response.commandAuthorizationFailure
          ) ?
            "GH_ARTIFACT_AUTH"
          : response.failure === "json" ? "GH_ARTIFACT_MALFORMED"
          : "GH_ARTIFACT_TRANSPORT",
          evidence,
          response.failure === "json" ?
            "GitHub returned malformed artifact listing JSON."
          : response.diagnostic || "GitHub artifact listing could not be read."
        );
      }
      const batch = artifactPage(response.value, evidence);
      found.push(...batch);
      if (
        batch.some(
          (artifact) =>
            artifact.expired !== true &&
            artifact.name.startsWith(prefix) &&
            !isLiveSlotArtifactName(artifact.name)
        ) ||
        batch.length < ARTIFACT_PAGE_SIZE
      )
        break;
    }
    return { value: found, evidence };
  };
  const listWorkflowArtifacts: ListArtifacts = async (...args) =>
    (await listWorkflowArtifactsWithMetadata(...args)).value;

  const downloadWorkflowArtifact: DownloadArtifact = async (repo, artifact) => {
    const runId = artifact.workflow_run?.id;
    if (!runId || !artifact.name) return null;
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "rad-deploy-artifact-")
    );
    try {
      await command(
        [
          "run",
          "download",
          String(runId),
          "--name",
          artifact.name,
          "--dir",
          directory,
          "--repo",
          repo
        ],
        60000
      );
      return readArtifactDir(directory, artifact.name);
    } finally {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        console.warn(
          "Could not remove temporary workflow artifact directory:",
          directory,
          error
        );
      }
    }
  };
  async function downloadWorkflowArtifactWithMetadata(
    repo: string,
    artifact: WorkflowArtifact
  ): Promise<{
    value: ArtifactFiles | null;
    metadata: WorkflowResponseMetadata;
  }> {
    return {
      value: await downloadWorkflowArtifact(repo, artifact),
      metadata: { source: "unavailable", reason: "opaque-command" }
    };
  }
  return {
    listWorkflowArtifacts,
    listWorkflowArtifactsWithMetadata,
    downloadWorkflowArtifact,
    downloadWorkflowArtifactWithMetadata
  };
}

export function createWorkflowArtifactReader(
  options: WorkflowArtifactReaderOptions,
  run: WorkflowRunner
) {
  const reads = createWorkflowArtifactReads(run);
  return createDeployStatusReader({
    ...options,
    listArtifacts: options.listArtifacts ?? reads.listWorkflowArtifacts,
    downloadArtifact: options.downloadArtifact ?? reads.downloadWorkflowArtifact
  });
}
