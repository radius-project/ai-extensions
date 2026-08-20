import type {
  CreateEnvironmentCliExec,
  CreateEnvironmentCliOptions,
  CreateEnvironmentCommandResult
} from "./create-environment-types.js";
import type { SelectedGhExecutor } from "../../gh.js";

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

// Pure predicate, exported so both this module and the workflow committer can
// distinguish a missing token scope (which a pull request cannot fix) from a
// protected-branch refusal (which it can).
export function needsWorkflowScope(stderr?: string): boolean {
  return (
    /workflow.{0,20}scope/i.test(stderr || "") ||
    /without .?workflow.? scope/i.test(stderr || "")
  );
}

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
          resolve({
            code: err ? err.code || 1 : 0,
            stdout: stdout || "",
            stderr: stderr || ""
          });
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

  // An empty value is a no-op rather than an error: the route sets several
  // optional values unconditionally and relies on this to skip the absent ones.
  const setEnvironmentVariable = async (
    name: string,
    value: string | undefined
  ): Promise<boolean> => {
    if (!value) return false;
    await runGhOrThrow(
      [
        "variable",
        "set",
        name,
        "--body",
        value,
        "--env",
        target.envName,
        "--repo",
        target.targetRepo
      ],
      `Failed to set ${name} on GitHub environment "${target.envName}"`
    );
    return true;
  };

  const runGhWorkflow = async (
    args: string[],
    stdin?: string
  ): Promise<CreateEnvironmentCommandResult> => runGh(args, stdin);

  return { runGh, runGhOrThrow, setEnvironmentVariable, runGhWorkflow };
}
