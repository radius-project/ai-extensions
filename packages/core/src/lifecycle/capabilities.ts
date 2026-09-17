import {
  operationSchemas,
  type LifecycleResponseFor
} from "./contracts/catalog.js";

const LIFECYCLE_API_VERSION =
  operationSchemas["capabilities.get"].request.properties.apiVersion.const;

type Capabilities = LifecycleResponseFor<"capabilities.get">["result"];
export type LifecycleReadCapability = Omit<
  Capabilities["capabilities"][number],
  "apiVersion"
>;

export function getLifecycleCapabilities(
  target: Capabilities["target"],
  capabilities: readonly LifecycleReadCapability[]
): Capabilities {
  return {
    target: { ...target },
    capabilities: [
      {
        operation: "capabilities.get",
        apiVersion: LIFECYCLE_API_VERSION,
        contexts: ["session"],
        providers: [],
        requiresAgent: false,
        limitations: []
      },
      ...capabilities.map((capability) => ({
        ...capability,
        apiVersion: LIFECYCLE_API_VERSION,
        contexts: [...capability.contexts],
        providers: [...capability.providers],
        limitations: [...capability.limitations]
      }))
    ],
    limitations: [
      "Capability availability is not authorization; each read verifies caller and target.",
      "Agent approval and mutation capabilities are not provided by discovery."
    ]
  };
}
