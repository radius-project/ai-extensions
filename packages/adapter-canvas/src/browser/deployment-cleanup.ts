import { isRecord, readRecord, readString } from "./json.js";
import { parseDeploymentListing, type DeploymentInfo } from "./repositories.js";
import type { BrowserContext } from "./ports.js";

export async function loadCleanupDetails(
  context: BrowserContext,
  repo: string,
  environment: string,
  mutationNonce: string,
  selected?: DeploymentInfo
): Promise<{ deployment: DeploymentInfo | undefined; prepared: boolean }> {
  const response = await context.net.fetch("/api/deployment-cleanup-details", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Radius-Mutation-Nonce": mutationNonce
    },
    body: JSON.stringify({ repo, environment, ...selected?.cleanupSelection })
  });
  const payload: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      readString(payload, "error") || "Cleanup details could not be verified."
    );
  if (
    !isRecord(payload) ||
    typeof payload.prepared !== "boolean" ||
    !(payload.deployment === null || isRecord(payload.deployment))
  )
    throw new Error("Invalid cleanup details response. Refresh and retry.");
  const deployment = readRecord(payload, "deployment");
  const parsed = parseDeploymentListing({
    deployments: [
      {
        ...deployment,
        cleanupSelection: readRecord(payload, "selection")
      }
    ]
  })[0];
  const prepared = payload.prepared;
  if (payload.deployment !== null && parsed?.environment !== environment)
    throw new Error("The cleanup target changed. Refresh and retry.");
  if (
    prepared &&
    (!selected?.cleanupSelection ||
      !parsed?.recovery?.canMarkCleanupComplete ||
      parsed.recovery.runId !== selected.cleanupSelection.runId ||
      parsed.recovery.runAttempt !== selected.cleanupSelection.runAttempt ||
      parsed.runUrl !== selected?.runUrl ||
      parsed.deploymentId !== selected.deploymentId ||
      parsed.cleanupSelection?.runId !== selected.cleanupSelection.runId ||
      parsed.cleanupSelection.runAttempt !==
        selected.cleanupSelection.runAttempt ||
      parsed.cleanupSelection.deploymentId !== selected.deploymentId ||
      parsed.cleanupSelection.runUrl !== selected.runUrl)
  )
    throw new Error("The cleanup target changed. Refresh and retry.");
  return { deployment: parsed, prepared };
}
