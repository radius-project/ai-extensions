import type {
  CreateEnvironmentCliExec,
  CreateEnvironmentCliOptions,
  CreateEnvironmentCommandResult
} from "./create-environment-types.js";

// Seam 2 of the `POST /api/create-environment` slice: every `gh` invocation the
// route makes, including the workflow-scope retry.
//
// The host often injects GH_TOKEN (an OAuth app token) that lacks the `workflow`
// scope, which is required to create/update files under .github/workflows/ or to
// dispatch workflows. The user's stored gh credential (keyring) usually has that
// scope. For workflow-scoped commands, run normally first; if it fails while an
// injected token is present, retry with GH_TOKEN/GITHUB_TOKEN stripped so gh
// falls back to the keyring credential. (A missing `workflow` scope surfaces as
// either a 403 "without workflow scope" on updates or a bare 404 on creates, so
// we retry on any failure rather than pattern-matching.)
//
// `readProcessEnv` is invoked on the retry path, never at construction. The
// legacy arm spread the live global (`{ ...process.env }`) at call time, so a
// token the host injects mid-session must still be observed. The near-identical
// helper in `deployments.ts` is deliberately NOT shared with this one: it takes
// an injected environment, and collapsing the two would change which environment
// each route reads.

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
  target: WorkflowScopeGhRunnerTarget
): WorkflowScopeGhRunner {
  const runGh = (
    args: string[],
    stdin?: string,
    extraOpts: CreateEnvironmentCliOptions = {}
  ): Promise<CreateEnvironmentCommandResult> => {
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
  ): Promise<CreateEnvironmentCommandResult> => {
    const first = await runGh(args, stdin);
    if (first.code === 0) return first;
    // Read at call time, never snapshotted at construction.
    const env = ports.readProcessEnv();
    const hasInjectedToken = !!(env.GH_TOKEN || env.GITHUB_TOKEN);
    if (!hasInjectedToken) return first;
    const fallbackEnv = { ...env };
    delete fallbackEnv.GH_TOKEN;
    delete fallbackEnv.GITHUB_TOKEN;
    const retry = await runGh(args, stdin, { env: fallbackEnv });
    // Prefer the retry only if it actually succeeded; otherwise keep the
    // original error, which is usually the more meaningful one.
    return retry.code === 0 ? retry : first;
  };

  return { runGh, runGhOrThrow, setEnvironmentVariable, runGhWorkflow };
}
