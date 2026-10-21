import { toGhCommandResult } from "../services/gh-command-result.js";
import type {
  CreateEnvironmentCliExec,
  CreateEnvironmentCliOptions,
  CreateEnvironmentCommandResult
} from "./create-environment-types.js";
import type { SelectedGhExecutor } from "../../gh.js";
import { setSetupEnvironmentVariable } from "@radius-project/core";
import { setupValueDigest } from "@radius-project/adapter-shared";
import { createSetupWorkflowRecoveryPort } from "../services/setup-workflow-recovery.js";

// Seam 2 of the `POST /api/create-environment` slice: every `gh` invocation the
// route makes. Create Environment supplies a selected-account executor, so every
// command uses one pinned credential and a failure is returned without retrying
// under ambient or keyring state. The legacy CLI port remains for callers that do
// not yet supply an executor.

export interface WorkflowScopeGhRunnerPorts {
  cliExec: CreateEnvironmentCliExec;
  readProcessEnv(): NodeJS.ProcessEnv;
}

export interface WorkflowScopeGhRunnerTarget {
  targetRepo: string;
  envName: string;
  environmentProviderId?: string | null;
  mutationRecovery?: {
    operation: object & { operationId: string };
    persist(): Promise<void>;
    recordVariable(entry: {
      repo: string;
      environment: string;
      environmentProviderId: string;
      name: string;
      valueSha256: string;
      previousValue: string | null;
      previousKnown: boolean;
    }): void;
  };
}

export interface WorkflowScopeGhRunner {
  runGh(
    args: string[],
    stdin?: string,
    extraOpts?: CreateEnvironmentCliOptions
  ): Promise<CreateEnvironmentCommandResult>;
  runGhOrThrow(
    args: string[],
    message: string,
    stdin?: string
  ): Promise<CreateEnvironmentCommandResult>;
  setEnvironmentVariable(
    name: string,
    value: string | undefined
  ): Promise<boolean>;
  runGhWorkflow(
    args: string[],
    stdin?: string
  ): Promise<CreateEnvironmentCommandResult>;
}

// Pure predicate, re-exported so the workflow committer and publisher keep
// importing it from this slice while the canonical implementation lives with
// the fallback decision it belongs to.
export { needsWorkflowScope } from "../services/workflow-credential-fallback.js";

export function createWorkflowScopeGhRunner(
  ports: WorkflowScopeGhRunnerPorts,
  target: WorkflowScopeGhRunnerTarget,
  selectedExecutor?: SelectedGhExecutor
): WorkflowScopeGhRunner {
  const runGh = (
    args: string[],
    stdin?: string,
    extraOpts: CreateEnvironmentCliOptions = {}
  ): Promise<CreateEnvironmentCommandResult> => {
    if (selectedExecutor) {
      return selectedExecutor.run(args, {
        timeout: 30000,
        ...extraOpts,
        ...(stdin === undefined ? {} : { stdin })
      });
    }
    return new Promise((resolve) => {
      const child = ports.cliExec(
        "gh",
        args,
        { timeout: 30000, ...(extraOpts || {}) },
        (err, stdout, stderr) => {
          resolve(toGhCommandResult(err, stdout, stderr));
        }
      );
      if (stdin !== undefined) child.stdin?.end(stdin);
    });
  };

  const runGhOrThrow = async (
    args: string[],
    message: string,
    stdin?: string
  ): Promise<CreateEnvironmentCommandResult> => {
    const result = await runGh(args, stdin);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      throw new Error(detail ? `${message}: ${detail}` : message);
    }
    return result;
  };

  const setEnvironmentVariable = (name: string, value: string | undefined) =>
    setSetupEnvironmentVariable(target, name, value, {
      run: runGh,
      runOrThrow: runGhOrThrow,
      digest: setupValueDigest,
      recovery:
        target.mutationRecovery ?
          createSetupWorkflowRecoveryPort(
            target.mutationRecovery.operation,
            target.mutationRecovery.persist
          )
        : undefined,
      recordVariable: (entry) => target.mutationRecovery?.recordVariable(entry)
    });

  const runGhWorkflow = async (
    args: string[],
    stdin?: string
  ): Promise<CreateEnvironmentCommandResult> => runGh(args, stdin);

  return { runGh, runGhOrThrow, setEnvironmentVariable, runGhWorkflow };
}
