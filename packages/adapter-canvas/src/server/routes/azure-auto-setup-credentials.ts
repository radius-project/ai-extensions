import { configureAzureAutoSetupCredentials as configureCredentials } from "@radius-project/core";
import { createAzureCredentialPorts } from "./azure-setup-adapter.js";
import type { AzureAutoSetupCredentialInput } from "./azure-auto-setup-types.js";

export {
  isRetryableAzureReadFailure,
  azureRetryDelayMs,
  isReplicationLagError,
  buildRoleAssignmentArgs,
  findFederatedCredentialNameCollision,
  pickAksResourceGroup,
  federatedCredentialIdFrom,
  readFederatedCredentialId
} from "@radius-project/core";

export function configureAzureAutoSetupCredentials({
  workflow,
  dependencies,
  ...facts
}: AzureAutoSetupCredentialInput) {
  return configureCredentials({
    ...facts,
    ports: createAzureCredentialPorts(workflow, dependencies)
  });
}
