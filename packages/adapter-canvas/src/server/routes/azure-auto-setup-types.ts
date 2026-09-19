import type { IncomingMessage } from "node:http";
import type {
  AzureAutoSetupDependencies as SharedDependencies,
  AzureAutoSetupCredentialInput as SharedCredentialInput,
  AzureAutoSetupApplicationInput as SharedApplicationInput
} from "@radius-project/core/github-radius/environments/azure-auto-setup-types";

export * from "@radius-project/core/github-radius/environments/azure-auto-setup-types";
export interface AzureAutoSetupDependencies extends Omit<
  SharedDependencies,
  "deterministicProviderUuid" | "operationDomain"
> {
  isServerOwnedRequest(instanceId: string, request: IncomingMessage): boolean;
}
export interface AzureAutoSetupCredentialInput extends Omit<
  SharedCredentialInput,
  "dependencies"
> {
  dependencies: Omit<
    SharedCredentialInput["dependencies"],
    "deterministicProviderUuid" | "operationDomain"
  >;
}
export interface AzureAutoSetupApplicationInput extends Omit<
  SharedApplicationInput,
  "dependencies"
> {
  dependencies: Omit<SharedApplicationInput["dependencies"], "operationDomain">;
}
