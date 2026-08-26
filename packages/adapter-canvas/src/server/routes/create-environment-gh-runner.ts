import { createHash } from "node:crypto";
import { toGhCommandResult } from "../services/gh-command-result.js";
import type {
  CreateEnvironmentCliExec,
  CreateEnvironmentCliOptions,
  CreateEnvironmentCommandResult
} from "./create-environment-types.js";
import type { SelectedGhExecutor } from "../../gh.js";
import { providerMutationRecord } from "../../operations.js";
import {
  executeRecoverableMutation,
  ProviderMutationRecoveryError
} from "../services/provider-mutation-recovery.js";

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
  mutationRecovery?: {
    operation: object & { operationId: string };
    persist(): Promise<void>;
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

  // An empty value is a no-op rather than an error: the route sets several
  // optional values unconditionally and relies on this to skip the absent ones.
  const setEnvironmentVariable = async (
    name: string,
    value: string | undefined
  ): Promise<boolean> => {
    if (!value) return false;
    const args = [
      "variable",
      "set",
      name,
      "--body",
      value,
      "--env",
      target.envName,
      "--repo",
      target.targetRepo
    ];
    if (!target.mutationRecovery) {
      await runGhOrThrow(
        args,
        `Failed to set ${name} on GitHub environment "${target.envName}"`
      );
      return true;
    }
    const mutationKind = "github_environment_variable.put";
    const mutationTarget = `${target.targetRepo}:${target.envName}:${name}`;
    const valueSha256 = createHash("sha256").update(value).digest("hex");
    const readVariable = async (): Promise<
      | { state: "absent" }
      | { state: "present"; valueSha256: string }
      | { state: "transient"; detail: string }
      | { state: "malformed"; detail: string }
    > => {
      const path =
        `/repos/${target.targetRepo}/environments/` +
        `${encodeURIComponent(target.envName)}/variables/${encodeURIComponent(name)}`;
      const current = await runGh(["api", path]);
      if (current.code !== 0 && current.code !== "0") {
        if (
          /(?:HTTP\s+404|\bNot Found\b)/i.test(
            `${current.stderr}\n${current.stdout}`
          )
        ) {
          const environment = await runGh([
            "api",
            `/repos/${target.targetRepo}/environments/${encodeURIComponent(target.envName)}`
          ]);
          if (environment.code === 0 || environment.code === "0") {
            return { state: "absent" };
          }
        }
        return {
          state: "transient",
          detail:
            current.stderr ||
            current.stdout ||
            "GitHub environment variable state could not be read."
        };
      }
      let body: { name?: unknown; value?: unknown };
      try {
        body = JSON.parse(current.stdout) as {
          name?: unknown;
          value?: unknown;
        };
      } catch {
        return {
          state: "malformed",
          detail: `GitHub returned unreadable state for environment variable "${name}".`
        };
      }
      if (body.name !== name || typeof body.value !== "string") {
        return {
          state: "malformed",
          detail: `GitHub did not report the exact identity and value of environment variable "${name}".`
        };
      }
      return {
        state: "present",
        valueSha256: createHash("sha256").update(body.value).digest("hex")
      };
    };
    const existing = providerMutationRecord(
      target.mutationRecovery.operation,
      mutationKind,
      mutationTarget
    );
    if (existing?.status === "not_applied") {
      const observed = await readVariable();
      if (
        observed.state === "present" &&
        observed.valueSha256 === valueSha256
      ) {
        return true;
      }
      if (observed.state === "present") {
        throw new ProviderMutationRecoveryError(
          `Environment variable "${name}" changed outside this setup. Radius will not overwrite the current value.`,
          "provider-mutation-manual-required"
        );
      }
      if (observed.state === "malformed") {
        throw new ProviderMutationRecoveryError(
          `${observed.detail} Radius will not overwrite it.`,
          "provider-mutation-manual-required"
        );
      }
      if (observed.state === "transient") {
        throw new ProviderMutationRecoveryError(
          `${observed.detail} Radius will not retry the write.`,
          "provider-mutation-outcome-unknown"
        );
      }
    }
    const mutation =
      await executeRecoverableMutation<CreateEnvironmentCommandResult>({
        operation: target.mutationRecovery.operation,
        kind: mutationKind,
        target: mutationTarget,
        intent: { name, valueSha256 },
        persist: target.mutationRecovery.persist,
        mutate: () => runGh(args),
        accept: (result) => result,
        reconcile: async () => {
          const observed = await readVariable();
          if (observed.state === "absent") {
            return {
              state: "not_applied" as const,
              evidence:
                "GitHub confirmed the environment exists and the variable is absent."
            };
          }
          if (observed.state === "malformed") {
            return {
              state: "manual_required" as const,
              guidance: `${observed.detail} Radius will not overwrite it.`
            };
          }
          if (observed.state === "transient") {
            throw new Error(observed.detail);
          }
          return observed.valueSha256 === valueSha256 ?
              {
                state: "applied" as const,
                value: { code: 0, stdout: "", stderr: "" },
                evidence:
                  "The exact environment, variable name, and value digest matched."
              }
            : {
                state: "manual_required" as const,
                guidance:
                  `Environment variable "${name}" changed outside this setup. ` +
                  "Radius will not overwrite the current value."
              };
        }
      });
    if (mutation.state === "cancelled") return false;
    if (mutation.state === "not_applied") {
      const detail = (
        mutation.result?.stderr ||
        mutation.result?.stdout ||
        ""
      ).trim();
      throw new Error(
        detail ?
          `Failed to set ${name} on GitHub environment "${target.envName}": ${detail}`
        : `Failed to set ${name} on GitHub environment "${target.envName}"`
      );
    }
    return true;
  };

  const runGhWorkflow = async (
    args: string[],
    stdin?: string
  ): Promise<CreateEnvironmentCommandResult> => runGh(args, stdin);

  return { runGh, runGhOrThrow, setEnvironmentVariable, runGhWorkflow };
}
