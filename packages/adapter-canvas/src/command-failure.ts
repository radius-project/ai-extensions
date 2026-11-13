import { redactCredentials } from "./credential-redaction.js";

export function boundedDiagnostic(
  value: string,
  credentials: readonly (string | undefined)[] = []
): string {
  const redacted = redactCredentials(value, credentials).replace(
    /(?:authorization|proxy-authorization)\s*:[^\r\n]*/gi,
    "[REDACTED HEADER]"
  );
  // A CLI must not turn a kubeconfig or private key into saved error output.
  if (
    /(?:^|\n)\s*(?:clusters|users|contexts):|"(?:clusters|users|contexts)"\s*:|kind:\s*Config\b|-----BEGIN [^\r\n]*PRIVATE KEY-----/i.test(
      redacted
    )
  )
    return "[REDACTED CONFIGURATION]";
  return redacted.length > 2000 ?
      `${redacted.slice(0, 2000)}[truncated]`
    : redacted;
}

export interface SubprocessFailure extends Error {
  readonly code?: string | number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly killed?: boolean;
}

export class CommandFailure extends Error {
  readonly code: string | number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stderr: string;

  constructor(
    cause: SubprocessFailure,
    stderr: string,
    timeout: number | undefined,
    credentials: readonly (string | undefined)[]
  ) {
    super(boundedDiagnostic(stderr || cause.message, credentials), {
      cause: Object.assign(
        new Error(boundedDiagnostic(cause.message, credentials)),
        {
          code: cause.code ?? null,
          signal: cause.signal ?? null,
          killed: cause.killed === true
        }
      )
    });
    this.name = "CommandFailure";
    this.code = cause.code ?? null;
    this.signal = cause.signal ?? null;
    this.timedOut =
      Boolean(timeout && cause.killed) &&
      cause.signal === "SIGTERM" &&
      cause.code == null;
    this.stderr = boundedDiagnostic(stderr, credentials);
  }
}
