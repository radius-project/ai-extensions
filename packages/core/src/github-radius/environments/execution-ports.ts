import type { CreateEnvironmentCommandResult } from "./create-environment-types.js";

/** Commands stay pinned to the authorized account for the entire operation. */
export interface SelectedGhExecutor {
  readonly login: string;
  readonly credentialSource: "injected" | "keyring";
  readonly requiresKeyringSwitch: boolean;
  readonly scopes: readonly string[];
  run(
    args: string[],
    options?: {
      timeout?: number;
      env?: Record<string, string | undefined>;
      stdin?: string;
    }
  ): Promise<CreateEnvironmentCommandResult>;
  runOrThrow(
    args: string[],
    message: string,
    options?: {
      timeout?: number;
      env?: Record<string, string | undefined>;
      stdin?: string;
    }
  ): Promise<CreateEnvironmentCommandResult>;
  verifyIdentity(): Promise<void>;
  packageCredentials(): {
    username: string;
    token: string;
    source: "injected-token" | "keyring";
    scopes?: readonly string[];
  };
  redact(value: string): string;
  errorMessage(error: unknown): string;
}

export interface EnvironmentSetupResult {
  outcome:
    | "completed"
    | "action_required"
    | "input_required"
    | "cancelled"
    | "reconciling"
    | "failed";
  status: number;
  body: Record<string, unknown>;
}

export interface EnvironmentSetupCompletion {
  complete(status: number, body: Record<string, unknown>): void;
}
