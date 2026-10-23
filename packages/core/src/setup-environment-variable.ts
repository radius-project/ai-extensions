import type { SetupWorkflowCommandResult } from "./setup-workflow-contracts.js";
import type { SetupWorkflowRecoveryPort } from "./setup-workflow-recovery.js";
import {
  assertSetupExecutionActive,
  isSetupExecutionInterrupted,
  ProviderMutationRecoveryError
} from "./setup-recovery-error.js";
export interface SetupEnvironmentVariableRecord {
  repo: string;
  environment: string;
  environmentProviderId: string;
  name: string;
  valueSha256: string;
  previousValue: string | null;
  previousKnown: boolean;
}
export async function setSetupEnvironmentVariable(
  input: {
    targetRepo: string;
    envName: string;
    environmentProviderId?: string | null;
  },
  name: string,
  value: string | undefined,
  ports: {
    run(args: string[]): Promise<SetupWorkflowCommandResult>;
    runOrThrow(
      args: string[],
      message: string
    ): Promise<SetupWorkflowCommandResult>;
    digest(value: string): string;
    isStopped?(): boolean;
    recovery?: SetupWorkflowRecoveryPort;
    recordVariable(entry: SetupEnvironmentVariableRecord): void;
  }
): Promise<boolean> {
  if (!value) return false;
  const assertActive = () => assertSetupExecutionActive(ports.isStopped);
  assertActive();
  const args = [
    "variable",
    "set",
    name,
    "--body",
    value,
    "--env",
    input.envName,
    "--repo",
    input.targetRepo
  ];
  if (!ports.recovery) {
    await ports.runOrThrow(
      args,
      `Failed to set ${name} on GitHub environment "${input.envName}"`
    );
    return true;
  }
  const environmentProviderId = input.environmentProviderId;
  if (!environmentProviderId) {
    throw new Error(
      `GitHub did not report an immutable id for environment "${input.envName}", so Radius did not write variable "${name}".`
    );
  }
  const mutationKind = "github_environment_variable.put";
  const mutationTarget = `${input.targetRepo}:${input.envName}:${name}`;
  const valueSha256 = ports.digest(value);
  const readEnvironmentIdentity = async (): Promise<
    | { state: "matched" }
    | { state: "transient" | "malformed" | "replacement"; detail: string }
  > => {
    const environment = await ports.run([
      "api",
      `/repos/${input.targetRepo}/environments/${encodeURIComponent(input.envName)}`
    ]);
    assertActive();
    if (environment.code !== 0 && environment.code !== "0") {
      return {
        state: "transient",
        detail:
          environment.stderr ||
          environment.stdout ||
          "GitHub environment identity could not be read."
      };
    }
    let environmentBody: { id?: unknown; node_id?: unknown };
    try {
      const parsed: unknown = JSON.parse(environment.stdout);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("expected an object");
      }
      environmentBody = parsed as { id?: unknown; node_id?: unknown };
    } catch {
      return {
        state: "malformed",
        detail: "GitHub returned unreadable environment identity."
      };
    }
    const liveProviderId =
      (
        typeof environmentBody.id === "number" &&
        Number.isFinite(environmentBody.id)
      ) ?
        String(environmentBody.id)
      : typeof environmentBody.id === "string" && environmentBody.id.trim() ?
        environmentBody.id.trim()
      : (
        typeof environmentBody.node_id === "string" &&
        environmentBody.node_id.trim()
      ) ?
        environmentBody.node_id.trim()
      : null;
    if (!liveProviderId) {
      return {
        state: "malformed",
        detail: "GitHub did not report the environment id."
      };
    }
    return liveProviderId === environmentProviderId ?
        { state: "matched" }
      : {
          state: "replacement",
          detail: `GitHub environment "${input.targetRepo}:${input.envName}" now has id ${liveProviderId}, not ${environmentProviderId}.`
        };
  };
  const readVariable = async (): Promise<
    | { state: "absent" }
    | { state: "present"; value: string; valueSha256: string }
    | { state: "transient"; detail: string }
    | { state: "malformed"; detail: string }
    | { state: "replacement"; detail: string }
  > => {
    const environment = await readEnvironmentIdentity();
    if (environment.state !== "matched") return environment;
    const path =
      `/repos/${input.targetRepo}/environments/` +
      `${encodeURIComponent(input.envName)}/variables/${encodeURIComponent(name)}`;
    const current = await ports.run(["api", path]);
    assertActive();
    if (current.code !== 0 && current.code !== "0") {
      if (
        /(?:HTTP\s+404|\bNot Found\b)/i.test(
          `${current.stderr}\n${current.stdout}`
        )
      ) {
        const environmentAfter404 = await readEnvironmentIdentity();
        if (environmentAfter404.state === "matched") {
          return { state: "absent" };
        }
        return environmentAfter404;
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
      value: body.value,
      valueSha256: ports.digest(body.value)
    };
  };
  const existing = ports.recovery.find(mutationKind, mutationTarget);
  const savedIntent =
    (
      existing?.status === "prepared" ||
      existing?.status === "outcome_unknown" ||
      existing?.status === "confirmed"
    ) ?
      existing.intent
    : null;
  let previousKnown =
    typeof savedIntent?.previousKnown === "boolean" ?
      savedIntent.previousKnown
    : false;
  let previousValue =
    savedIntent && "previousValue" in savedIntent ?
      typeof savedIntent.previousValue === "string" ?
        savedIntent.previousValue
      : null
    : null;
  if (!savedIntent) {
    const observed = await readVariable();
    if (
      existing?.status === "not_applied" &&
      observed.state === "present" &&
      observed.valueSha256 === valueSha256
    ) {
      return true;
    }
    if (existing?.status === "not_applied" && observed.state === "present") {
      throw new ProviderMutationRecoveryError(
        `Environment variable "${name}" changed outside this setup. Radius will not overwrite the current value.`,
        "provider-mutation-manual-required"
      );
    }
    if (observed.state === "replacement") {
      throw new ProviderMutationRecoveryError(
        `${observed.detail} Radius did not write the variable.`,
        "provider-mutation-manual-required"
      );
    }
    if (observed.state === "malformed") {
      throw new Error(`${observed.detail} Radius did not write the variable.`);
    }
    if (observed.state === "transient") {
      throw new Error(`${observed.detail} Radius did not write the variable.`);
    }
    previousKnown = true;
    previousValue = observed.state === "present" ? observed.value : null;
  }
  const recordVariable = (): void =>
    ports.recordVariable({
      repo: input.targetRepo,
      environment: input.envName,
      environmentProviderId,
      name,
      valueSha256,
      previousValue,
      previousKnown
    });
  const mutation = await ports.recovery.execute<SetupWorkflowCommandResult>({
    kind: mutationKind,
    target: mutationTarget,
    intent: { name, value, valueSha256, previousKnown, previousValue },
    assertActive,
    rethrowReconciliationError: isSetupExecutionInterrupted,
    validateBeforeMutation: async () => {
      const current = await readVariable();
      if (current.state === "replacement") {
        throw new ProviderMutationRecoveryError(
          `${current.detail} Radius did not write the variable.`,
          "provider-mutation-manual-required"
        );
      }
      if (current.state === "malformed" || current.state === "transient") {
        throw new Error(current.detail);
      }
      const predecessorMatches =
        previousKnown &&
        ((previousValue === null && current.state === "absent") ||
          (previousValue !== null &&
            current.state === "present" &&
            current.valueSha256 === ports.digest(previousValue)));
      if (!predecessorMatches) {
        throw new ProviderMutationRecoveryError(
          `Environment variable "${name}" changed after Radius recorded its previous value. Radius did not overwrite the current value.`,
          "provider-mutation-manual-required"
        );
      }
    },
    mutate: () => {
      assertActive();
      return ports.run(args);
    },
    accept: (result) => result,
    onConfirmed: recordVariable,
    reconcile: async () => {
      assertActive();
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
      if (observed.state === "replacement") {
        return {
          state: "manual_required" as const,
          guidance: `${observed.detail} Radius will not write the variable.`
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
  if (mutation.state === "not_applied") {
    const detail = (
      mutation.result?.stderr ||
      mutation.result?.stdout ||
      ""
    ).trim();
    throw new Error(
      detail ?
        `Failed to set ${name} on GitHub environment "${input.envName}": ${detail}`
      : `Failed to set ${name} on GitHub environment "${input.envName}"`
    );
  }
  return true;
}
