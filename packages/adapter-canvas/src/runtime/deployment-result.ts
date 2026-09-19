import type { DeployStartResult } from "../deploy-tools.js";

export function deploymentStartResult(result: {
  status: number;
  body: unknown;
}): DeployStartResult {
  const body = result.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("The deployment coordinator returned an invalid result.");
  }
  if (result.status < 200 || result.status >= 300 || "error" in body) {
    return {
      kind: "failed",
      error:
        "error" in body && typeof body.error === "string" ?
          body.error
        : `Deployment request failed (${result.status}).`
    };
  }
  if (!("ok" in body) || body.ok !== true) {
    throw new Error("The deployment coordinator did not confirm admission.");
  }
  return {
    kind: "started",
    ...("repairAttempt" in body && typeof body.repairAttempt === "number" ?
      { repairAttempt: body.repairAttempt }
    : {}),
    ...((
      "repairAttemptCap" in body && typeof body.repairAttemptCap === "number"
    ) ?
      { repairAttemptCap: body.repairAttemptCap }
    : {})
  };
}
