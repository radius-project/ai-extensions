export class ProviderMutationRecoveryError extends Error {
  readonly code: string;

  constructor(message: string, code = "provider-mutation-recovery-failed") {
    super(message);
    this.name = "ProviderMutationRecoveryError";
    this.code = code;
  }
}
