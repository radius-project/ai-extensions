import {
  commitSchema,
  definitionPathSchema,
  fingerprintSchema,
  gitRefSchema,
  handleSchema,
  repositorySchema,
  type DefinitionInput,
  type ResolvedSource
} from "./contracts/common.js";
import {
  portCancelled,
  portFailure,
  portSuccess,
  portUnavailable,
  type PortResult
} from "./errors.js";
import type {
  CancellationSignal,
  EffectiveInputManifest,
  ReadonlyData,
  SourceSelection
} from "./ports.js";

export const EFFECTIVE_INPUT_FINGERPRINT_VERSION =
  "github-radius/effective-inputs/v1";

export interface SourceManifestInput {
  readonly definition: string;
  /** Explicit effective dependencies, not a directory listing of adjacent/generated files. */
  readonly inputs: readonly ReadonlyData<DefinitionInput>[];
  readonly closure: "complete" | "incomplete";
}
/** Hash the supplied canonical text's exact UTF-8 bytes as sha256:<64 lowercase hex digits>. */
export type ManifestHasher = (canonical: string) => string;
export type SourcePolicyCancellation = Readonly<
  Pick<CancellationSignal, "aborted">
>;
export interface ManifestMatch {
  readonly status: "unchanged";
  readonly fingerprint: string;
}
export interface SourceExpectationMatch {
  readonly status: "matched";
  readonly fingerprint: string;
}

const pathPattern = new RegExp(definitionPathSchema.pattern, "u");
const fingerprintPattern = new RegExp(fingerprintSchema.pattern, "u");
const repositoryPattern = new RegExp(repositorySchema.pattern, "u");
const refPattern = new RegExp(gitRefSchema.pattern, "u");
const handlePattern = new RegExp(handleSchema.pattern, "u");
const commitPattern = new RegExp(commitSchema.pattern, "u");
const deviceSegmentPattern =
  /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

function matchesEntire(pattern: RegExp, value: string): boolean {
  // Require the entire value even if a pattern could match only a prefix.
  return pattern.exec(value)?.[0] === value;
}

function safePath(path: string): boolean {
  return (
    path.length <= definitionPathSchema.maxLength &&
    matchesEntire(pathPattern, path) &&
    !path.split("/").some((segment) => deviceSegmentPattern.test(segment))
  );
}

/** Lexical preflight only; the source adapter must still confine symlinks/junctions before I/O. */
export function validateSourcePath(path: string): PortResult<string> {
  return safePath(path) ? portSuccess(path) : portFailure("INVALID_REQUEST");
}

interface PreparedManifest {
  readonly inputs: readonly ReadonlyData<DefinitionInput>[];
  readonly canonical: string;
  readonly incomplete: boolean;
}

function prepareManifest(
  definition: string,
  inputs: readonly ReadonlyData<DefinitionInput>[]
): PortResult<PreparedManifest> {
  if (!safePath(definition)) return portFailure("INVALID_REQUEST");
  const paths = new Set<string>();
  const copied: DefinitionInput[] = [];
  let hasDefinition = false;
  let missingHash = false;
  for (const entry of inputs) {
    // Preserve exact path spelling in identity, but reject aliases that cannot
    // be captured independently on supported case-insensitive filesystems.
    const key = entry.path.toLowerCase();
    if (!safePath(entry.path) || paths.has(key))
      return portFailure("INVALID_REQUEST");
    paths.add(key);
    if (
      (!entry.existed && entry.contentHash !== null) ||
      (entry.contentHash !== null &&
        !matchesEntire(fingerprintPattern, entry.contentHash))
    )
      return portFailure("INVALID_REQUEST");
    if (entry.path === definition) {
      if (entry.kind !== "definition") return portFailure("INVALID_REQUEST");
      hasDefinition = true;
    }
    if (entry.existed && entry.contentHash === null) missingHash = true;
    copied.push({
      path: entry.path,
      kind: entry.kind,
      existed: entry.existed,
      contentHash: entry.contentHash
    });
  }
  copied.sort((left, right) => (left.path < right.path ? -1 : 1));
  return portSuccess({
    inputs: copied,
    incomplete: !hasDefinition || missingHash,
    canonical: JSON.stringify({
      version: EFFECTIVE_INPUT_FINGERPRINT_VERSION,
      definition,
      inputs: copied
    })
  });
}

function incompleteEvidence() {
  return portUnavailable("VALIDATION_INCOMPLETE", {
    quality: "unknown",
    evidence: "source",
    completeness: "unavailable",
    limitation: "The complete effective input closure has not been established."
  });
}

export function buildEffectiveInputManifest(
  input: SourceManifestInput,
  hash: ManifestHasher,
  cancellation?: SourcePolicyCancellation
): PortResult<EffectiveInputManifest> {
  if (cancellation?.aborted) return portCancelled("request_cancelled");
  const prepared = prepareManifest(input.definition, input.inputs);
  if (prepared.status !== "ok") return prepared;
  if (input.closure !== "complete" || prepared.value.incomplete) {
    return portSuccess({
      completeness: "incomplete",
      definition: input.definition,
      inputs: prepared.value.inputs,
      diagnostics: [
        {
          message:
            "The effective input closure, entry definition or an existing input hash is incomplete.",
          truncated: false,
          classification: "source.input_closure_incomplete"
        }
      ]
    });
  }
  let fingerprint: string;
  try {
    fingerprint = hash(prepared.value.canonical);
  } catch {
    if (cancellation?.aborted) return portCancelled("request_cancelled");
    return portUnavailable("SOURCE_UNAVAILABLE", {
      quality: "unknown",
      evidence: "source",
      completeness: "unavailable",
      limitation: "The effective input fingerprint could not be computed."
    });
  }
  if (cancellation?.aborted) return portCancelled("request_cancelled");
  if (!matchesEntire(fingerprintPattern, fingerprint))
    return portFailure("PRECONDITION_FAILED");
  return portSuccess({
    completeness: "complete",
    definition: input.definition,
    inputs: prepared.value.inputs,
    fingerprint
  });
}

interface ComparableManifest {
  readonly canonical: string;
  readonly fingerprint: string;
}

function comparableManifest(
  manifest: EffectiveInputManifest
): PortResult<ComparableManifest> {
  const prepared = prepareManifest(manifest.definition, manifest.inputs);
  if (prepared.status !== "ok") return prepared;
  if (manifest.completeness !== "complete" || prepared.value.incomplete)
    return incompleteEvidence();
  if (!matchesEntire(fingerprintPattern, manifest.fingerprint))
    return portFailure("INVALID_REQUEST");
  return portSuccess({
    canonical: prepared.value.canonical,
    fingerprint: manifest.fingerprint
  });
}

export function compareEffectiveInputManifests(
  expected: EffectiveInputManifest,
  current: EffectiveInputManifest,
  cancellation?: SourcePolicyCancellation
): PortResult<ManifestMatch> {
  if (cancellation?.aborted) return portCancelled("request_cancelled");
  const before = comparableManifest(expected);
  if (before.status !== "ok") return before;
  const after = comparableManifest(current);
  if (after.status !== "ok") return after;
  if (
    before.value.fingerprint !== after.value.fingerprint ||
    before.value.canonical !== after.value.canonical
  )
    return portFailure("SOURCE_CHANGED");
  return portSuccess({
    status: "unchanged",
    fingerprint: before.value.fingerprint
  });
}

function validRepository(repo: string): boolean {
  return (
    repo.length <= repositorySchema.maxLength &&
    matchesEntire(repositoryPattern, repo)
  );
}

function validRef(ref: string): boolean {
  return ref.length <= gitRefSchema.maxLength && matchesEntire(refPattern, ref);
}

function validHandle(handle: string): boolean {
  return (
    handle.length <= handleSchema.maxLength &&
    matchesEntire(handlePattern, handle)
  );
}

function validSelection(selection: SourceSelection): boolean {
  if (!validRepository(selection.repo) || !safePath(selection.definition))
    return false;
  const source = selection.source;
  if (source.kind === "workspace") {
    return (
      validHandle(source.workspaceRef) &&
      validRef(source.branch) &&
      matchesEntire(fingerprintPattern, source.expectedFingerprint)
    );
  }
  return (
    validRef(source.ref) && matchesEntire(commitPattern, source.expectedCommit)
  );
}

export function validateSourceSelection(
  selection: SourceSelection,
  cancellation?: SourcePolicyCancellation
): PortResult<void> {
  if (cancellation?.aborted) return portCancelled("request_cancelled");
  return validSelection(selection) ?
      portSuccess(undefined)
    : portFailure("INVALID_REQUEST");
}

function validResolution(source: ReadonlyData<ResolvedSource>): boolean {
  if (
    !validRepository(source.repo) ||
    !matchesEntire(fingerprintPattern, source.fingerprint)
  )
    return false;
  if (source.kind === "workspace")
    return validHandle(source.workspaceRef) && validRef(source.branch);
  return validRef(source.ref) && matchesEntire(commitPattern, source.commit);
}

export function verifySourceExpectation(
  selection: SourceSelection,
  resolved: ReadonlyData<ResolvedSource>,
  manifest: EffectiveInputManifest,
  cancellation?: SourcePolicyCancellation
): PortResult<SourceExpectationMatch> {
  if (cancellation?.aborted) return portCancelled("request_cancelled");
  if (!validSelection(selection) || !validResolution(resolved))
    return portFailure("INVALID_REQUEST");
  const comparable = comparableManifest(manifest);
  if (comparable.status !== "ok") return comparable;
  if (
    selection.repo.toLowerCase() !== resolved.repo.toLowerCase() ||
    selection.definition !== manifest.definition ||
    resolved.fingerprint !== comparable.value.fingerprint
  )
    return portFailure("EVIDENCE_MISMATCH");
  const expected = selection.source;
  if (expected.kind === "workspace" && resolved.kind === "workspace") {
    if (expected.workspaceRef !== resolved.workspaceRef)
      return portFailure("EVIDENCE_MISMATCH");
    if (
      expected.branch !== resolved.branch ||
      expected.expectedFingerprint !== resolved.fingerprint
    )
      return portFailure("SOURCE_CHANGED");
  } else if (expected.kind === "git" && resolved.kind === "git") {
    if (expected.ref !== resolved.ref) return portFailure("EVIDENCE_MISMATCH");
    if (expected.expectedCommit.toLowerCase() !== resolved.commit.toLowerCase())
      return portFailure("SOURCE_CHANGED");
  } else {
    return portFailure("EVIDENCE_MISMATCH");
  }
  return portSuccess({
    status: "matched",
    fingerprint: comparable.value.fingerprint
  });
}
