import { deploymentRunId, redactCredentials } from "@radius-project/core";
import type { DeploymentRow } from "./deployment-resolver.js";

interface CleanupDetailsDependencies {
  isValidRepoSlug(value: unknown): boolean;
  resolveEnvDeployment(
    repo: string,
    environment: string,
    application: string
  ): Promise<DeploymentRow | null>;
}

export async function prepareDeploymentCleanup(
  payload: unknown,
  dependencies: CleanupDetailsDependencies
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return { status: 400, body: { error: "A cleanup target is required." } };
  const data = Object.fromEntries(Object.entries(payload));
  const { repo, environment } = data;
  if (
    !dependencies.isValidRepoSlug(repo) ||
    typeof repo !== "string" ||
    typeof environment !== "string" ||
    !environment.trim()
  )
    return {
      status: 400,
      body: { error: "A repository and environment are required." }
    };
  const selected = ["runId", "runAttempt", "deploymentId", "runUrl"].some(
    (field) => Object.hasOwn(data, field)
  );
  if (
    selected &&
    (typeof data.runId !== "number" ||
      !Number.isSafeInteger(data.runId) ||
      data.runId <= 0 ||
      typeof data.runAttempt !== "number" ||
      !Number.isSafeInteger(data.runAttempt) ||
      data.runAttempt <= 0 ||
      typeof data.deploymentId !== "string" ||
      !data.deploymentId.trim() ||
      typeof data.runUrl !== "string" ||
      !data.runUrl.trim())
  )
    return {
      status: 400,
      body: { error: "A complete workflow run selection is required." }
    };
  let current: DeploymentRow | null;
  try {
    current = await dependencies.resolveEnvDeployment(repo, environment, "");
  } catch (error) {
    return {
      status: 503,
      body: {
        error: redactCredentials(
          `Cleanup history could not be verified. Refresh and retry; tracking was not changed. ${error instanceof Error ? error.message : String(error)}`
        )
      }
    };
  }
  const recovery = current?.recovery;
  const selection =
    current && recovery ?
      {
        runId: recovery.runId,
        runAttempt: recovery.runAttempt,
        deploymentId: current.deploymentId,
        runUrl: current.runUrl
      }
    : undefined;
  if (selected) {
    if (
      !current ||
      !recovery?.canMarkCleanupComplete ||
      deploymentRunId(repo, current.runUrl) !== data.runId ||
      recovery.runId !== data.runId ||
      recovery.runAttempt !== data.runAttempt ||
      current.deploymentId !== data.deploymentId ||
      current.runUrl !== data.runUrl
    )
      return {
        status: 409,
        body: {
          error:
            "The cleanup target changed or is not eligible. Refresh and select the current run."
        }
      };
    return {
      status: 200,
      body: { deployment: current, selection, prepared: true }
    };
  }
  const deployment = current ? { ...current } : null;
  if (deployment) delete deployment.recovery;
  return { status: 200, body: { deployment, selection, prepared: false } };
}
