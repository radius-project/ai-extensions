import { RadProcessError } from "@radius-project/adapter-shared";
import { GRAPH_MODELING_FAILURE_MESSAGE } from "./graph-progress-contract.js";
import {
  INFRASTRUCTURE_FAILURE_PATTERNS,
  MODEL_FAILURE_PATTERNS
} from "./model-failure-policy.js";

export class GraphModelingFailure extends Error {
  readonly diagnostic: string;

  constructor(cause: unknown, diagnostic: string) {
    super(graphModelingFailureMessage(diagnostic), { cause });
    this.name = "GraphModelingFailure";
    this.diagnostic = diagnostic;
  }
}

const BICEP_DIAGNOSTIC_PATTERN = /\bBCP(?<code>\d{3})\b/gu;

function isInfrastructureDiagnostic(stream: string): boolean {
  return INFRASTRUCTURE_FAILURE_PATTERNS.some((pattern) =>
    pattern.test(stream)
  );
}

function isModelDiagnostic(stream: string): boolean {
  const bicepCodes = [...stream.matchAll(BICEP_DIAGNOSTIC_PATTERN)];
  if (bicepCodes.some((match) => match.groups?.code !== "204")) return true;
  return MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(stream));
}

function modelingDiagnostic(error: RadProcessError): string | null {
  const streams = [error.stderr.trim(), error.stdout.trim()].filter(Boolean);
  if (streams.some(isInfrastructureDiagnostic)) return null;
  const diagnosticStreams = streams.filter(isModelDiagnostic);
  return diagnosticStreams.length > 0 ? diagnosticStreams.join("\n") : null;
}

export function graphModelingDiagnostic(error: unknown): string | null {
  let current = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof RadProcessError) {
      const diagnostic = modelingDiagnostic(current);
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
