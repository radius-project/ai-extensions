import { resolveAzureAutoSetupApplication as resolveApplication } from "@radius-project/core";
import { createAzureApplicationPorts } from "./azure-setup-adapter.js";
import type { AzureAutoSetupApplicationInput } from "./azure-auto-setup-types.js";

export { ENTRA_APP_RETENTION_NOTICE } from "./azure-setup-presentation.js";

export function resolveAzureAutoSetupApplication({
  workflow,
  dependencies,
  ...facts
}: AzureAutoSetupApplicationInput) {
  return resolveApplication({
    ...facts,
    ports: createAzureApplicationPorts(workflow, dependencies)
  });
}
