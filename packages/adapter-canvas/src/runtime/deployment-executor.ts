import { WorkflowReadInterruptedError } from "@radius-project/core";
import type { SelectedGhExecutor } from "../gh.js";

export function bindDeploymentExecutor(
  executor: SelectedGhExecutor,
  isCurrent: () => boolean
): SelectedGhExecutor {
  const assertCurrent = () => {
    if (!isCurrent()) throw new WorkflowReadInterruptedError("cancelled");
  };
  const run: SelectedGhExecutor["run"] = async (args, options) => {
    assertCurrent();
    const result = await executor.run(args, options);
    assertCurrent();
    return result;
  };
  return {
    login: executor.login,
    credentialSource: executor.credentialSource,
    requiresKeyringSwitch: executor.requiresKeyringSwitch,
    scopes: executor.scopes,
    run,
    runOrThrow: async (args, message, options) => {
      assertCurrent();
      const result = await executor.runOrThrow(args, message, options);
      assertCurrent();
      return result;
    },
    verifyIdentity: async () => {
      assertCurrent();
      await executor.verifyIdentity();
      assertCurrent();
    },
    packageCredentials: () => {
      assertCurrent();
      return executor.packageCredentials();
    },
    redact: (value) => executor.redact(value),
    errorMessage: (error) => executor.errorMessage(error)
  };
}
