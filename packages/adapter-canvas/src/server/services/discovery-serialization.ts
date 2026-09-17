import type {
  ApplicationPage,
  LifecycleError,
  PortResult
} from "@radius-project/core/lifecycle";
import type { LegacyEnvironmentEvidence } from "./discovery-reader.js";

export function discoveryErrorMessage(result: PortResult<unknown>): string {
  return "error" in result ?
      formatDiscoveryError(result.error)
    : "Discovery did not complete.";
}
export function formatDiscoveryError(error: LifecycleError): string {
  return `${error.code}: ${error.message}`;
}
export function serializeLegacyApplications(
  repo: string,
  result: PortResult<ApplicationPage>
) {
  return result.status === "ok" ?
      {
        applications: result.value.items
          .slice(0, 1)
          .map((item) => ({ name: item.target.application })),
        ...(result.value.items.length > 1 ?
          {
            error:
              "Multiple authored definitions are available through radius_lifecycle; this legacy picker displays the first canonical application only."
          }
        : {})
      }
    : {
        applications: [{ name: repo.split("/").pop() || repo }],
        error: discoveryErrorMessage(result)
      };
}
export function projectLegacyEnvironment(evidence: LegacyEnvironmentEvidence) {
  return {
    id: evidence.metadata.id,
    name: evidence.inspection.target.environment,
    vars: { ...evidence.metadata.variables },
    provider: evidence.inspection.configuration?.provider ?? ""
  };
}
