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

const BICEP_DIAGNOSTIC_PATTERN = /\bBCP(?<code>\d{3})\b/gu;
const INFRASTRUCTURE_DIAGNOSTIC_PATTERNS = [
  /\bBCP204\b/u,
  /\bextension\s+["']?radius["']?\s+is not recognized\b/iu,
  /\b(?:failed|unable) to (?:download|resolve|restore)\b[^\r\n]*\bextension\b/iu
];
const MODEL_DIAGNOSTIC_PATTERNS = [
  /\b(?:invalid|unknown|unrecognized|unsupported)\s+resource type\b/iu,
  /\bresource type\b[^\r\n]*\b(?:invalid|not recognized|not supported|unknown)\b/iu,
  /\b(?:invalid|unknown|unsupported)\s+api(?: |-)?version\b/iu,
  /\bapi(?: |-)?version\b[^\r\n]*\b(?:invalid|not recognized|not supported|unknown)\b/iu,
  /\b(?:invalid|missing|unknown)\s+(?:required\s+)?propert(?:y|ies)\b/iu,
  /\bpropert(?:y|ies)\b[^\r\n]*\b(?:does not exist|is not allowed|is not permitted|is invalid)\b/iu,
  /\binvalid (?:resource )?reference\b/iu,
  /\breferenced (?:declaration|resource)\b[^\r\n]*\b(?:does not exist|invalid|not found|not valid)\b/iu,
  /\bcredentials?\b[^\r\n]*\b(?:expected|must be|required to be|should be)\b[^\r\n]*\b(?:array|map|object|string)\b/iu,
  /\bbicep\b[^\r\n]*\b(?:compilation|compile|parse|parsing)\b[^\r\n]*\b(?:error|failed|failure)\b/iu,
  /\b(?:failed|unable) to (?:compile|parse)\b[^\r\n]*\.bicep\b/iu
];

function isInfrastructureDiagnostic(stream: string): boolean {
  return INFRASTRUCTURE_DIAGNOSTIC_PATTERNS.some((pattern) =>
    pattern.test(stream)
  );
}

function isModelDiagnostic(stream: string): boolean {
  const bicepCodes = [...stream.matchAll(BICEP_DIAGNOSTIC_PATTERN)];
  if (bicepCodes.some((match) => match.groups?.code !== "204")) return true;
  return MODEL_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(stream));
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
