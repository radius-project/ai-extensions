export * from "@radius-project/core/github-radius/environments/environment-deletion";
import {
  runEnvironmentDeletion as runSharedDeletion,
  type EnvironmentDeletionPorts as SharedPorts
} from "@radius-project/core/github-radius/environments/environment-deletion";
import * as operationDomain from "../../operations.js";

export type EnvironmentDeletionPorts = Omit<SharedPorts, "operationDomain">;
export function runEnvironmentDeletion(
  operation: Parameters<typeof runSharedDeletion>[0],
  ports: EnvironmentDeletionPorts
) {
  return runSharedDeletion(operation, { ...ports, operationDomain });
}
