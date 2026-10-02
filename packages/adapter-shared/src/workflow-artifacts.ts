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
  WorkflowReadInterruptedError,
  WORKFLOW_READ_LIMITS,
  isLiveSlotArtifactName
} from "@radius-project/core";
import type {
  ArtifactFiles,
  DeployStatusReaderOptions,
  DownloadArtifact,
  ListArtifacts,
  WorkflowArtifact,
  WorkflowReadEvidence,
  WorkflowResponseMetadata,
  WorkflowReadContext,
  WorkflowReadDecision
} from "@radius-project/core";
import type { WorkflowRunner } from "./workflow-reads.js";
import { readWorkflowApiWithPolicy } from "./workflow-read-response.js";
import {
  createWorkflowReadBudget,
  createWorkflowReadSession
} from "./workflow-read-budget.js";

export class WorkflowArtifactReadError extends Error {
  constructor(
    readonly code:
      "GH_ARTIFACT_AUTH" | "GH_ARTIFACT_MALFORMED" | "GH_ARTIFACT_TRANSPORT",
    readonly evidence: readonly WorkflowReadEvidence[],
    message: string,
    readonly decision?: WorkflowReadDecision
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
  > & {
    signal?: AbortSignal;
    identity?: string;
    session?: ReturnType<typeof createWorkflowReadSession>;
  };

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
export function createWorkflowArtifactReads(
  run: WorkflowRunner,
  identity = "ambient",
  session = createWorkflowReadSession()
) {
  async function command(
    args: string[],
    timeout: number,
    context?: WorkflowReadContext
  ): Promise<string> {
    const controller = new AbortController();
    const limit = context ? Math.min(timeout, context.remaining()) : timeout;
    if (limit <= 0 || context?.check().state === "stopped")
      throw new WorkflowReadInterruptedError(
        context?.check().state === "stopped" ? "cancelled" : "elapsed"
      );
    const detach = context?.onStop?.(() => controller.abort());
    const timer =
      context ? setTimeout(() => controller.abort(), limit) : undefined;
    let result;
    try {
      result = await run(
        args,
        context ? { timeout: limit, signal: controller.signal } : { timeout }
      );
    } finally {
      clearTimeout(timer);
      detach?.();
    }
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
    namePrefix?: string,
    suppliedContext?: WorkflowReadContext
  ) => {
    const context =
      suppliedContext ??
      session.observe(
        runId ?
          WORKFLOW_READ_LIMITS.artifactRunMs
        : WORKFLOW_READ_LIMITS.artifactRepositoryMs
      );
    const listing = createWorkflowReadBudget(
      run,
      runId ? 20000 : 100000,
      (runId ? 1 : 5) * 10 * 1024 * 1024,
      context
    );
    const found: WorkflowArtifact[] = [];
    const evidence: WorkflowReadEvidence[] = [];
    const prefix = namePrefix || DEPLOY_STATUS_ARTIFACT_PREFIX;
    for (let page = 1; page <= (runId ? 1 : MAX_ARTIFACT_PAGES); page++) {
      const endpoint =
        runId ?
          `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=${ARTIFACT_PAGE_SIZE}`
        : `/repos/${repo}/actions/artifacts?per_page=${ARTIFACT_PAGE_SIZE}&page=${page}`;
      const pageDeadline = context.clock.monotonic() + 20000;
      const bounded = createWorkflowReadBudget(
        listing,
        20000,
        10 * 1024 * 1024,
        context
      );
      const response = await readWorkflowApiWithPolicy(
        bounded,
        endpoint,
        { timeout: 20000 },
        context,
        JSON.stringify([identity, repo, String(runId ?? ""), "artifacts"]),
        pageDeadline,
        (result) =>
          evidence.push({ phase: "artifacts", response: result.metadata })
      );
      if (
        response.metadata.source === "unavailable" &&
        response.metadata.reason === "deferred"
      )
        evidence.push({ phase: "artifacts", response: response.metadata });
      if (!response.ok) {
        const status =
          response.metadata.source === "gh-api-include" ?
            response.metadata.status
          : null;
        throw new WorkflowArtifactReadError(
          (
            response.metadata.source === "gh-api-include" ?
              status === 401 ||
              response.metadata.classification === "authorization"
            : response.commandAuthorizationFailure
          ) ?
            "GH_ARTIFACT_AUTH"
          : response.failure === "json" ? "GH_ARTIFACT_MALFORMED"
          : "GH_ARTIFACT_TRANSPORT",
          evidence,
          response.failure === "json" ?
            "GitHub returned malformed artifact listing JSON."
          : response.diagnostic || "GitHub artifact listing could not be read.",
          response.decision
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

  const downloadWorkflowArtifact: DownloadArtifact = async (
    repo,
    artifact,
    suppliedContext
  ) => {
    const context = suppliedContext?.limit(60000);
    const runId = artifact.workflow_run?.id;
    if (!runId || !artifact.name) return null;
    const work = async () => {
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
          60000,
          context
        );
        if (context && context.check().state !== "ready")
          throw new WorkflowReadInterruptedError(
            context.check().state === "stopped" ? "cancelled" : "elapsed"
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
    const pending = work();
    return context ? context.wait(pending) : pending;
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
  const session = options.session ?? createWorkflowReadSession();
  const reads = createWorkflowArtifactReads(run, options.identity, session);
  return createDeployStatusReader({
    ...options,
    createReadContext:
      options.createReadContext ??
      (() =>
        session.observe(
          options.runId ?
            WORKFLOW_READ_LIMITS.artifactRunMs
          : WORKFLOW_READ_LIMITS.artifactRepositoryMs,
          options.signal
        )),
    stopped: () => options.signal?.aborted === true,
    onStop: (listener) => {
      options.signal?.addEventListener("abort", listener, { once: true });
      return () => options.signal?.removeEventListener("abort", listener);
    },
    listArtifacts: options.listArtifacts ?? reads.listWorkflowArtifacts,
    downloadArtifact: options.downloadArtifact ?? reads.downloadWorkflowArtifact
  });
}
