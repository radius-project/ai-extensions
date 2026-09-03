import {
  APP_GRAPH_PROVENANCE_PROPERTY,
  hashAppBicep
} from "@radius-project/adapter-shared";

export function isAppGraphCurrent(
  graphContent: string | null | undefined,
  bicepContent: string | null | undefined
): boolean {
  if (!graphContent || !bicepContent) return false;
  try {
    const graph: unknown = JSON.parse(graphContent);
    if (typeof graph !== "object" || graph === null || Array.isArray(graph)) {
      return false;
    }
    const provenance = (graph as Record<string, unknown>)[
      APP_GRAPH_PROVENANCE_PROPERTY
    ];
    if (
      typeof provenance !== "object" ||
      provenance === null ||
      Array.isArray(provenance)
    ) {
      return false;
    }
    return (
      (provenance as Record<string, unknown>).appBicepHash ===
      hashAppBicep(bicepContent)
    );
  } catch {
    return false;
  }
}
