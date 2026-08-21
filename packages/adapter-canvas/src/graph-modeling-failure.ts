import { RadProcessError } from "@radius-project/adapter-shared";
import { GRAPH_MODELING_FAILURE_MESSAGE } from "./graph-progress-contract.js";

export class GraphModelingFailure extends Error {
  constructor(cause: unknown) {
    super(GRAPH_MODELING_FAILURE_MESSAGE, { cause });
    this.name = "GraphModelingFailure";
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
  if (graphModelingDiagnostic(error) !== null) {
    return new GraphModelingFailure(error);
  }
  return error;
}
