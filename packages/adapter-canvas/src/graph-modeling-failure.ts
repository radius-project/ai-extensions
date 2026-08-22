import { RadProcessError } from "@radius-project/adapter-shared";
import { GRAPH_MODELING_FAILURE_MESSAGE } from "./graph-progress-contract.js";

export class GraphModelingFailure extends Error {
  readonly diagnostic: string;

  constructor(cause: unknown, diagnostic: string) {
    super(graphModelingFailureMessage(diagnostic), { cause });
    this.name = "GraphModelingFailure";
    this.diagnostic = diagnostic;
  }
}

function bicepDiagnostic(error: RadProcessError): string | null {
  const diagnosticStreams = [error.stderr.trim(), error.stdout.trim()].filter(
    (stream) => /\bBCP\d{3}\b/u.test(stream)
  );
  return diagnosticStreams.length > 0 ? diagnosticStreams.join("\n") : null;
}

export function graphModelingDiagnostic(error: unknown): string | null {
  let current = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof RadProcessError) {
      const diagnostic = bicepDiagnostic(current);
      if (diagnostic !== null) return diagnostic;
    }
    visited.add(current);
    current = current.cause;
  }
  return null;
}

export function asGraphModelingFailure(error: unknown): unknown {
  const diagnostic = graphModelingDiagnostic(error);
  if (diagnostic !== null) return new GraphModelingFailure(error, diagnostic);
  return error;
}

export function graphModelingFailureMessage(diagnostic: string): string {
  const line = diagnostic
    .split(/\r?\n/u)
    .find((candidate) => /\bBCP\d{3}\b/u.test(candidate));
  if (!line) return GRAPH_MODELING_FAILURE_MESSAGE;
  const match =
    /(?:^|[\\/])(?<file>[^\\/()[\]\r\n]+\.bicep)\((?<line>\d+)(?:,\d+)?\)\s*:\s*(?:Error|Warning)\s+BCP\d{3}:\s*(?<detail>.*?)(?:\s+\[https?:\/\/.*)?$/iu.exec(
      line
    );
  if (!match?.groups) return GRAPH_MODELING_FAILURE_MESSAGE;
  const detail = match.groups.detail.trim();
  return `${GRAPH_MODELING_FAILURE_MESSAGE} ${match.groups.file} line ${match.groups.line}: ${detail}`;
}
