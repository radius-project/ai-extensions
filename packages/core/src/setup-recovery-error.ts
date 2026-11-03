export class ProviderMutationRecoveryError extends Error {
  readonly code: string;

  constructor(message: string, code = "provider-mutation-recovery-failed") {
    super(message);
    this.name = "ProviderMutationRecoveryError";
    this.code = code;
  }
}

export function assertSetupExecutionActive(isStopped?: () => boolean): void {
  if (isStopped?.()) {
    throw new ProviderMutationRecoveryError(
      "Setup execution was interrupted before the next provider request.",
      "setup-execution-interrupted"
    );
  }
}

export function isSetupExecutionInterrupted(error: unknown): boolean {
  return (
    error instanceof ProviderMutationRecoveryError &&
    error.code === "setup-execution-interrupted"
  );
}
