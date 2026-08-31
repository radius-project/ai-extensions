import { createHash } from "node:crypto";
import {
  providerMutationRecord,
  type SetupCleanupOutcome,
  type SetupCleanupResult
} from "../../operations.js";
import {
  executeRecoverableMutation,
  ProviderMutationRecoveryError
} from "./provider-mutation-recovery.js";

export interface GitHubEnvironmentVariableRollbackArtifact {
  repo: string;
  environment: string;
  environmentProviderId: string | null;
  name: string;
  valueSha256: string;
  previousValue: string | null;
  previousKnown: boolean;
  target: string;
  identity: string;
}

export interface GitHubVariableCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

export type GitHubVariableCommand = (
  args: string[]
) => Promise<GitHubVariableCommandResult>;

export interface GitHubEnvironmentVariableRollbackOutcome {
  results: SetupCleanupResult[];
  warnings: string[];
  steps: string[];
  blocked: boolean;
}

type VariableRead =
  | { state: "absent" }
  | { state: "present"; valueSha256: string }
  | { state: "unreadable" | "malformed"; detail: string };

type EnvironmentRead =
  | { state: "matched" }
  | { state: "replacement"; detail: string }
  | { state: "unreadable" | "malformed"; detail: string };

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function succeeded(result: GitHubVariableCommandResult): boolean {
  return result.code === 0 || result.code === "0";
}

function commandDetail(result: GitHubVariableCommandResult): string {
  return (
    result.stderr ||
    result.stdout ||
    "The GitHub API request failed."
  ).trim();
}

function environmentPath(
  artifact: GitHubEnvironmentVariableRollbackArtifact
): string {
  return `/repos/${artifact.repo}/environments/${encodeURIComponent(
    artifact.environment
  )}`;
}

function variablePath(
  artifact: GitHubEnvironmentVariableRollbackArtifact
): string {
  return `${environmentPath(artifact)}/variables/${encodeURIComponent(
    artifact.name
  )}`;
}

async function readVariable(
  artifact: GitHubEnvironmentVariableRollbackArtifact,
  run: GitHubVariableCommand
): Promise<VariableRead> {
  const response = await run(["api", variablePath(artifact)]);
  if (!succeeded(response)) {
    return (
        /(?:HTTP\s+404|\bNot Found\b)/i.test(
          `${response.stderr}\n${response.stdout}`
        )
      ) ?
        { state: "absent" }
      : { state: "unreadable", detail: commandDetail(response) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.stdout);
  } catch {
    return {
      state: "malformed",
      detail: `GitHub returned unreadable state for variable "${artifact.name}".`
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      state: "malformed",
      detail: `GitHub returned unreadable state for variable "${artifact.name}".`
    };
  }
  const body = parsed as { name?: unknown; value?: unknown };
  if (body.name !== artifact.name || typeof body.value !== "string") {
    return {
      state: "malformed",
      detail: `GitHub did not report the exact identity and value of variable "${artifact.name}".`
    };
  }
  return { state: "present", valueSha256: digest(body.value) };
}

async function verifyEnvironment(
  artifact: GitHubEnvironmentVariableRollbackArtifact,
  run: GitHubVariableCommand
): Promise<EnvironmentRead> {
  if (!artifact.environmentProviderId) {
    return {
      state: "malformed",
      detail:
        "Radius did not save the GitHub environment id that owns this variable."
    };
  }
  const response = await run(["api", environmentPath(artifact)]);
  if (!succeeded(response)) {
    return { state: "unreadable", detail: commandDetail(response) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.stdout);
  } catch {
    return {
      state: "malformed",
      detail: "GitHub returned unreadable environment identity."
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      state: "malformed",
      detail: "GitHub returned unreadable environment identity."
    };
  }
  const body = parsed as { id?: unknown; node_id?: unknown };
  const providerId =
    typeof body.id === "number" && Number.isFinite(body.id) ? String(body.id)
    : typeof body.id === "string" && body.id.trim() ? body.id.trim()
    : typeof body.node_id === "string" && body.node_id.trim() ?
      body.node_id.trim()
    : null;
  if (!providerId) {
    return {
      state: "malformed",
      detail: "GitHub did not report the environment id."
    };
  }
  return providerId === artifact.environmentProviderId ?
      { state: "matched" }
    : {
        state: "replacement",
        detail: `GitHub environment "${artifact.repo}:${artifact.environment}" now has id ${providerId}, not ${artifact.environmentProviderId}.`
      };
}

function cleanupResult(
  attempt: number,
  artifact: GitHubEnvironmentVariableRollbackArtifact,
  outcome: SetupCleanupOutcome,
  detail: string | null
): SetupCleanupResult {
  return {
    attempt,
    artifactType: "github_environment_variable",
    target: artifact.target,
    identity: artifact.identity,
    outcome,
    detail
  };
}

function desiredState(
  current: VariableRead,
  previousValue: string | null,
  previousSha256: string | null
): boolean {
  return (
    (current.state === "absent" && previousValue === null) ||
    (current.state === "present" &&
      previousSha256 !== null &&
      current.valueSha256 === previousSha256)
  );
}

export async function rollbackGitHubEnvironmentVariables(input: {
  attempt: number;
  operation: object & { operationId: string };
  persist(): Promise<void>;
  variables: readonly GitHubEnvironmentVariableRollbackArtifact[];
  run: GitHubVariableCommand;
}): Promise<GitHubEnvironmentVariableRollbackOutcome> {
  const results: SetupCleanupResult[] = [];
  const warnings: string[] = [];
  const steps: string[] = [];
  let blocked = false;

  const block = (
    variable: GitHubEnvironmentVariableRollbackArtifact,
    outcome: "warning" | "skipped",
    message: string
  ): void => {
    warnings.push(message);
    steps.push(`⚠️ ${message}`);
    results.push(cleanupResult(input.attempt, variable, outcome, message));
    blocked = true;
  };

  for (const variable of input.variables) {
    const previousSha256 =
      variable.previousValue === null ? null : digest(variable.previousValue);
    const desiredOutcome: SetupCleanupOutcome =
      variable.previousValue === null ? "deleted" : "restored";
    const mutationKind = "github_environment_variable.cleanup_delete";
    const journaled = providerMutationRecord(
      input.operation,
      mutationKind,
      variable.identity
    );
    const reconciling =
      journaled?.status === "prepared" ||
      journaled?.status === "outcome_unknown" ||
      journaled?.status === "confirmed" ||
      journaled?.status === "manual_required";

    if (!reconciling) {
      const environment = await verifyEnvironment(variable, input.run);
      if (environment.state !== "matched") {
        block(
          variable,
          environment.state === "replacement" ? "skipped" : "warning",
          `${environment.detail} Radius left ${variable.target} unchanged.`
        );
        continue;
      }
      if (!variable.previousKnown) {
        block(
          variable,
          "skipped",
          `Radius did not save the value that preceded ${variable.target}, so it left the variable unchanged.`
        );
        continue;
      }
      const current = await readVariable(variable, input.run);
      if (current.state === "unreadable" || current.state === "malformed") {
        block(
          variable,
          "warning",
          `Radius could not verify ${variable.target}, so it left the variable unchanged. ${current.detail}`
        );
        continue;
      }
      if (desiredState(current, variable.previousValue, previousSha256)) {
        const outcome =
          variable.previousValue === null ? "not_found" : "restored";
        if (variable.previousValue === null) {
          steps.push(`ℹ️ ${variable.target} is already absent.`);
        } else {
          steps.push(
            `ℹ️ ${variable.target} already contains its previous value.`
          );
        }
        results.push(cleanupResult(input.attempt, variable, outcome, null));
        continue;
      }
      if (
        current.state !== "present" ||
        current.valueSha256 !== variable.valueSha256
      ) {
        block(
          variable,
          "skipped",
          `${variable.target} changed after Radius configured it, so Radius left the current value unchanged.`
        );
        continue;
      }
    }

    try {
      const mutation = await executeRecoverableMutation<SetupCleanupOutcome>({
        operation: input.operation,
        kind: mutationKind,
        target: variable.identity,
        providerIdempotencyKey: variable.identity,
        persist: input.persist,
        validateBeforeMutation: async () => {
          const environment = await verifyEnvironment(variable, input.run);
          if (environment.state !== "matched") {
            if (environment.state === "replacement") {
              throw new ProviderMutationRecoveryError(
                environment.detail,
                "provider-mutation-manual-required"
              );
            }
            throw new Error(environment.detail);
          }
          const current = await readVariable(variable, input.run);
          if (
            current.state !== "present" ||
            current.valueSha256 !== variable.valueSha256
          ) {
            throw new ProviderMutationRecoveryError(
              `${variable.target} no longer contains the value Radius configured.`,
              "provider-mutation-manual-required"
            );
          }
        },
        mutate: () =>
          variable.previousValue === null ?
            input.run([
              "variable",
              "delete",
              variable.name,
              "--env",
              variable.environment,
              "--repo",
              variable.repo
            ])
          : input.run([
              "variable",
              "set",
              variable.name,
              "--body",
              variable.previousValue,
              "--env",
              variable.environment,
              "--repo",
              variable.repo
            ]),
        accept: () => desiredOutcome,
        reconcile: async () => {
          const environment = await verifyEnvironment(variable, input.run);
          if (environment.state === "replacement") {
            return {
              state: "manual_required" as const,
              guidance: `${environment.detail} Radius will not repeat the variable deletion.`
            };
          }
          if (environment.state !== "matched") {
            throw new Error(environment.detail);
          }
          const current = await readVariable(variable, input.run);
          if (desiredState(current, variable.previousValue, previousSha256)) {
            return {
              state: "applied" as const,
              value: desiredOutcome,
              evidence:
                "The exact environment variable reached its saved predecessor state."
            };
          }
          if (current.state === "unreadable" || current.state === "malformed") {
            throw new Error(current.detail);
          }
          return {
            state: "manual_required" as const,
            guidance:
              (
                current.state === "present" &&
                current.valueSha256 === variable.valueSha256
              ) ?
                `${variable.target} is still present after Radius's single deletion request. Radius will not repeat the mutation. ${
                  variable.previousValue === null ?
                    "Delete it manually."
                  : "Restore its previous value manually."
                }`
              : `${variable.target} changed during deletion. Radius will not overwrite the current value.`
          };
        }
      });
      if (mutation.state === "not_applied") {
        block(
          variable,
          "warning",
          (mutation.result?.stderr || mutation.result?.stdout || "").trim() ||
            `GitHub rejected deletion of ${variable.target}.`
        );
        continue;
      }
      if (mutation.value === "deleted") {
        steps.push(`✅ Removed ${variable.target}.`);
      } else {
        steps.push(`✅ Restored the previous value of ${variable.target}.`);
      }
      results.push(
        cleanupResult(input.attempt, variable, mutation.value, null)
      );
    } catch (error) {
      if (
        error instanceof ProviderMutationRecoveryError &&
        error.code === "provider-mutation-recovery-persistence-failed"
      ) {
        throw error;
      }
      block(
        variable,
        (
          error instanceof ProviderMutationRecoveryError &&
            error.code === "provider-mutation-manual-required"
        ) ?
          "skipped"
        : "warning",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  return { results, warnings, steps, blocked };
}
