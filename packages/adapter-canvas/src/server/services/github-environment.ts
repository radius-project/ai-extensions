export * from "@radius-project/core/github-radius/environments/github-environment";
import { ensureGitHubEnvironment as ensureSharedEnvironment } from "@radius-project/core/github-radius/environments/github-environment";
import * as operationDomain from "../../operations.js";

export function ensureGitHubEnvironment(
  input: Omit<Parameters<typeof ensureSharedEnvironment>[0], "operationDomain">
) {
  return ensureSharedEnvironment({ ...input, operationDomain });
}
