import {
  nameSchema,
  timestampSchema,
  portCancelled,
  portFailure,
  portSuccess,
  portUnavailable,
  type ApplicationInspection,
  type ApplicationPage,
  type AuthorizedScope,
  type PortResult,
  type RequestControl
} from "@radius-project/core/lifecycle";
import { readObject, type GitHubDiscoveryRead } from "./environment-read.js";

export function createDeployedApplicationRead(deps: GitHubDiscoveryRead) {
  if (typeof deps?.get !== "function" || typeof deps.clock?.now !== "function")
    throw new Error("Deployed reads require GitHub and clock ports.");
  const validName = new RegExp(nameSchema.pattern);
  const validTimestamp = new RegExp(timestampSchema.pattern);
  return async (
    scope: AuthorizedScope<"application.list" | "application.inspect">,
    control: RequestControl
  ): Promise<PortResult<Pick<ApplicationPage, "items" | "observation">>> => {
    const environment =
      "environment" in scope.target ? scope.target.environment : undefined;
    if (!environment) return portFailure("INVALID_REQUEST");
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const result = await deps.get(
      `/repos/${scope.target.repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=100`,
      control,
      scope
    );
    if (result.status !== "ok") return result;
    if (!Array.isArray(result.value)) return portFailure("EVIDENCE_MISMATCH");
    const items: ApplicationInspection[] = [];
    const names = new Set<string>();
    for (const row of result.value) {
      if (!readObject(row) || row.environment !== environment)
        return portFailure("EVIDENCE_MISMATCH");
      if (
        !readObject(row.payload) ||
        typeof row.payload.application !== "string" ||
        !row.payload.application
      ) {
        return portUnavailable("RESULT_UNAVAILABLE", {
          quality: "unknown",
          completeness: "partial",
          evidence: "workflow",
          limitation:
            "GitHub deployment metadata does not identify its Radius application; no application name is inferred."
        });
      }
      if (
        row.payload.application.length > nameSchema.maxLength ||
        !validName.test(row.payload.application)
      )
        return portFailure("EVIDENCE_MISMATCH");
      if (names.has(row.payload.application)) continue;
      names.add(row.payload.application);
      const observedAt =
        (
          typeof row.updated_at === "string" &&
          validTimestamp.test(row.updated_at)
        ) ?
          row.updated_at
        : undefined;
      const observation = {
        quality: observedAt ? ("stale" as const) : ("unknown" as const),
        completeness: "partial" as const,
        evidence: "workflow" as const,
        ...(observedAt ? { observedAt } : {}),
        limitation:
          "GitHub deployment metadata is bounded to 100 records and is not current Radius state."
      };
      items.push({
        target: {
          repo: scope.target.repo,
          application: row.payload.application
        },
        deployed: [{ environment, observation }],
        observation
      });
    }
    return portSuccess({
      items,
      observation: {
        quality: "current",
        completeness: result.value.length < 100 ? "complete" : "partial",
        evidence: "workflow",
        observedAt: deps.clock.now(),
        limitation:
          "GitHub deployment metadata is not proof of current Radius state; at most 100 records are observed."
      }
    });
  };
}
