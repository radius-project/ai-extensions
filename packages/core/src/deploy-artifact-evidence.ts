import type { DeployStatus } from "./graph/index.js";

// Files the producer packs into the deploy-status artifact.
export const DEPLOY_STATUS_FILES = {
  progress: "deploy-progress.json",
  graph: "deploy-graph.json",
  state: "deploy-state.txt",
  controlPlane: "deploy-controlplane.log"
} as const;

// A run-scoped live-slot artifact name ends with `-live-<runId>-slot-<0..7>`.
// Live-slot sequences are only comparable within a single run, so a repo-wide
// read (which is not scoped to any run) has to exclude them; otherwise a
// cancelled run's higher-sequenced slot can beat a newer completed run's
// fixed-name terminal artifact.
const LIVE_SLOT_NAME_PATTERN = /-live-\d+-slot-\d+$/;

export function isLiveSlotArtifactName(name?: string | null): boolean {
  return typeof name === "string" && LIVE_SLOT_NAME_PATTERN.test(name);
}

// The literal prefix every deploy-status artifact name starts with. The
// producer appends a sanitized "<environment>-<app>".
export const DEPLOY_STATUS_ARTIFACT_PREFIX = "radius-deploy-status-";

// The schema version of deploy-progress.json this reader understands. A payload
// declaring anything else is rejected as malformed rather than guessed at.
export const DEPLOY_PROGRESS_SCHEMA_VERSION = 1;

// How many artifacts a single read will download before giving up. Each one
// costs a `gh run download` subprocess, so an uncapped candidate list turns one
// HTTP request into a long serial fan-out.
export const MAX_ARTIFACT_CANDIDATES = 9;

// Repo-wide artifact listing: page size, and how many pages a single read will
// walk before giving up. One page covers the newest 100 artifacts in the whole
// repository, which a busy CI can burn through between two deploys, so the
// deploy-status artifact has to be searched for past the first page. The budget
// keeps a repo with no such artifact from walking its entire history.
export const ARTIFACT_PAGE_SIZE = 100;
export const MAX_ARTIFACT_PAGES = 5;

// Share these budgets across all candidate starts, not per suffix scan.
const GRAPH_SCAN_BUDGET_MULTIPLIER = 2;
const MAX_FAILED_GRAPH_PARSE_ATTEMPTS = 64;

export interface DeployProgressResource {
  id?: string;
  name: string;
  type: string;
  outputResourceIds?: string[];
  provisioningState?: string;
  status?: DeployStatus;
  message?: string;
}

export interface DeployProgress {
  schemaVersion: number;
  application: string;
  environment: string;
  runId?: number;
  sequence: number;
  updatedAt?: string;
  state?: string;
  resources: DeployProgressResource[];
  /**
   * Set only when the artifact carried resource entries this parser could not
   * read. Consumers that merely annotate a graph can ignore a dropped entry,
   * but a consumer that presents the list as a complete inventory must not:
   * a silently shortened list would undercount a destructive action.
   */
  resourcesDiscarded?: true;
}

export interface WorkflowArtifact {
  id: number;
  name: string;
  expired?: boolean;
  created_at?: string;
  workflow_run?: { id?: number } | null;
}

export type ArtifactFiles = Record<string, string>;

export type ListArtifacts = (
  repo: string,
  runId?: number | string | null,
  namePrefix?: string
) => Promise<WorkflowArtifact[]>;

export type DownloadArtifact = (
  repo: string,
  artifact: WorkflowArtifact
) => Promise<ArtifactFiles | null>;

export type ReaderStatus =
  "ok" | "missing" | "malformed" | "auth" | "error" | "stale";

interface ReadResult {
  status: ReaderStatus;
  progressRevalidated?: boolean;
  progress: DeployProgress | null;
  graph: unknown | null;
  files: ArtifactFiles | null;
  artifact: WorkflowArtifact | null;
  error: unknown;
}

export interface DeployStatusReaderOptions {
  repo: string;
  environment?: string;
  application?: string;
  /** Canvas may only know a guessed app name during repo-wide discovery. */
  allowApplicationFallback?: boolean;
  runId?: number | string | null;
  listArtifacts: ListArtifacts;
  downloadArtifact: DownloadArtifact;
  ttlMs?: number;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  if (!isRecord(error)) return "";
  return typeof error.code === "string" ? error.code : "";
}

/**
 * sanitizeArtifactSegment - mirror the producer's name sanitization:
 *
 *   LC_ALL=C tr '[:upper:]' '[:lower:]'
 *     | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//'
 *     | cut -c1-80
 *
 * Byte-wise, so multi-byte characters collapse to '-' rather than surviving as
 * invalid name characters. Artifact names additionally forbid " : < > | * ? \ /
 * and CR/LF, all of which this rule already removes.
 *
 * The two implementations agree on multi-byte input even though sed counts
 * bytes and JS counts UTF-16 code units: every non-[a-z0-9._-] byte/unit is
 * outside the class, so a multi-byte character is one run either way and
 * collapses to a single '-'. The length cap is likewise safe, because by the
 * time it applies the string is pure ASCII and code units equal bytes.
 *
 * Correctness never depends on reproducing the producer's name exactly — see
 * selectDeployStatusArtifacts, which matches by prefix and confirms identity
 * from the payload. This is a narrowing filter, not an equality check.
 */
export function sanitizeArtifactSegment(value?: string | null): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 80);
}

/**
 * deployStatusArtifactPrefix - the preferred (tier 1) name filter for a given
 * environment: "radius-deploy-status-<sanitized-env>-". Returns the bare prefix
 * when the environment is empty or sanitizes away.
 */
export function deployStatusArtifactPrefix(
  environment?: string | null
): string {
  const env = sanitizeArtifactSegment(environment);
  return env ?
      `${DEPLOY_STATUS_ARTIFACT_PREFIX}${env}-`
    : DEPLOY_STATUS_ARTIFACT_PREFIX;
}

/**
 * selectDeployStatusArtifacts - pick the deploy-status artifacts worth trying,
 * newest first, from a repo or run artifact listing.
 *
 * Two tiers, because the producer's name is derived in bash and this side's in
 * TypeScript, and exact-match equality between two independent derivations is
 * precisely what broke the previous (GHCR) transport:
 *
 *   1. Names starting with "radius-deploy-status-<sanitized-env>-".
 *   2. When tier 1 matches nothing, names starting with the bare literal
 *      "radius-deploy-status-". This recovers the case where the producer's
 *      `cut -c1-80` truncated into or past the app segment (a long environment
 *      name), and any future divergence in the sanitizer.
 *
 * Identity is confirmed from the payload in both tiers — see
 * confirmArtifactIdentity. Expired artifacts are skipped: their bytes are gone.
 *
 * The result is capped, because every candidate the caller tries costs a
 * `gh run download` subprocess, a temp directory and an unzip. Tier 2 in a busy
 * repo can otherwise match every deploy-status artifact within the retention
 * window, and the caller downloads them in sequence inside an HTTP handler that
 * a 15s client poll re-enters.
 */
export function selectDeployStatusArtifacts(
  artifacts: WorkflowArtifact[] | null | undefined,
  environment?: string | null,
  limit = MAX_ARTIFACT_CANDIDATES
): WorkflowArtifact[] {
  if (!Array.isArray(artifacts)) return [];
  const live = artifacts.filter(
    (a) => a && typeof a.name === "string" && a.expired !== true
  );
  // Newest first. The listing endpoints already return newest-first, but sort
  // defensively so a caller merging pages cannot change the outcome.
  const byNewest = [...live].sort((a, b) => {
    const at = Date.parse(a.created_at || "") || 0;
    const bt = Date.parse(b.created_at || "") || 0;
    if (at !== bt) return bt - at;
    return b.id - a.id;
  });
  const scoped = deployStatusArtifactPrefix(environment);
  const tier1 = byNewest.filter((a) => a.name.startsWith(scoped));
  if (tier1.length > 0) return tier1.slice(0, limit);
  return byNewest
    .filter((a) => a.name.startsWith(DEPLOY_STATUS_ARTIFACT_PREFIX))
    .slice(0, limit);
}

/**
 * parseDeployProgressArtifact - validate and type deploy-progress.json.
 *
 * Returns null (the caller reports "malformed") when the payload is not JSON,
 * declares a schemaVersion this reader does not understand, or is missing a
 * required field. Guessing at an unknown schema is worse than reporting nothing:
 * a silently misread status map paints the graph with wrong colors.
 */
export function parseDeployProgressArtifact(
  text?: string | null
): DeployProgress | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (parsed.schemaVersion !== DEPLOY_PROGRESS_SCHEMA_VERSION) return null;
  if (typeof parsed.application !== "string" || !parsed.application)
    return null;
  if (typeof parsed.environment !== "string" || !parsed.environment)
    return null;
  if (!Array.isArray(parsed.resources)) return null;
  // The producer contract starts sequences at 1 and increments by 1. Rejecting
  // missing, non-numeric, zero, negative, and fractional values keeps a
  // malformed payload from winning the greatest-sequence selection against a
  // legitimate terminal artifact (which publishes sequence 1 at minimum).
  if (
    typeof parsed.sequence !== "number" ||
    !Number.isSafeInteger(parsed.sequence) ||
    parsed.sequence < 1
  )
    return null;
  if (
    parsed.runId !== undefined &&
    (typeof parsed.runId !== "number" ||
      !Number.isSafeInteger(parsed.runId) ||
      parsed.runId < 0)
  )
    return null;
  const sequence = parsed.sequence;
  const resources: DeployProgressResource[] = [];
  let discarded = false;
  for (const raw of parsed.resources) {
    if (!isRecord(raw)) {
      discarded = true;
      continue;
    }
    const name = typeof raw.name === "string" ? raw.name : "";
    if (!name) {
      discarded = true;
      continue;
    }
    resources.push({
      id: typeof raw.id === "string" ? raw.id : undefined,
      name,
      type: typeof raw.type === "string" ? raw.type : "",
      outputResourceIds:
        Array.isArray(raw.outputResourceIds) ?
          raw.outputResourceIds
            .filter(
              (value): value is string =>
                typeof value === "string" && value.trim() !== ""
            )
            .map((value) => value.trim())
        : undefined,
      provisioningState:
        typeof raw.provisioningState === "string" ?
          raw.provisioningState
        : undefined,
      status: normalizeDeployStatusField(raw.status),
      message: typeof raw.message === "string" ? raw.message : undefined
    });
  }
  return {
    schemaVersion: DEPLOY_PROGRESS_SCHEMA_VERSION,
    application: parsed.application,
    environment: parsed.environment,
    // runId 0 means the producer had no GITHUB_RUN_ID (it ran outside a
    // runner), so it identifies nothing. Normalize it away rather than letting
    // two unrelated runs both look like "run 0".
    runId:
      (
        typeof parsed.runId === "number" &&
        Number.isFinite(parsed.runId) &&
        parsed.runId > 0
      ) ?
        parsed.runId
      : undefined,
    sequence,
    updatedAt:
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    state: typeof parsed.state === "string" ? parsed.state : undefined,
    resources,
    ...(discarded ? { resourcesDiscarded: true as const } : {})
  };
}

/**
 * Rad may write build progress to stdout before emitting the graph JSON. The
 * deploy workflow redirects that combined stream into deploy-graph.json, so
 * locate a complete graph document within a bounded amount of work. Malformed
 * output may exhaust that budget before a later graph can be recovered.
 */
export function parseDeployGraphArtifact(text?: string | null): unknown | null {
  if (!text) return null;
  let arrayGraph: unknown[] | null = null;
  let remainingScan = text.length * GRAPH_SCAN_BUDGET_MULTIPLIER;
  let failedParseAttempts = 0;
  const findGraph = (document: unknown): unknown | null => {
    const pending: unknown[] = [document];
    while (pending.length > 0) {
      const value = pending.pop();
      if (isRecord(value) && isGraphResourceArray(value.resources))
        return value;
      if (isGraphResourceArray(value) && arrayGraph === null)
        arrayGraph = value;
      const children =
        Array.isArray(value) ? value
        : isRecord(value) ? Object.values(value)
        : [];
      for (let index = children.length - 1; index >= 0; index--)
        pending.push(children[index]);
    }
    return null;
  };
  for (let start = 0; start < text.length; start++) {
    if (remainingScan === 0) return arrayGraph;
    const first = text[start];
    if (first !== "{" && first !== "[") {
      remainingScan--;
      continue;
    }
    const expectedClosers: string[] = [];
    let inString = false;
    let escaped = false;
    let invalidCharacter = false;
    let end = -1;
    for (let index = start; index < text.length; index++) {
      if (remainingScan === 0) return arrayGraph;
      remainingScan--;
      const character = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        expectedClosers.push("}");
      } else if (character === "[") {
        expectedClosers.push("]");
      } else if (character === "}" || character === "]") {
        if (expectedClosers.pop() !== character) break;
        if (expectedClosers.length === 0) {
          end = index + 1;
          break;
        }
      } else if (!/[\s\d+\-.,:eEtrufalsn]/.test(character)) {
        // Skip non-JSON characters in tags such as [INFO], not JSON-like tags.
        invalidCharacter = true;
      }
    }
    if (end < 0 || invalidCharacter) continue;
    let parsed: unknown;
    try {
      // Decoding and walking this document cost at most its already charged
      // scan length. Do not scan its nested candidates again after decoding.
      parsed = JSON.parse(text.slice(start, end));
    } catch {
      if (++failedParseAttempts === MAX_FAILED_GRAPH_PARSE_ATTEMPTS)
        return arrayGraph;
      continue;
    }
    const graph = findGraph(parsed);
    if (graph) return graph;
    start = end - 1;
  }
  return arrayGraph;
}

function isGraphResourceArray(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.every(
      (resource) =>
        isRecord(resource) &&
        ("id" in resource ||
          "name" in resource ||
          "type" in resource ||
          "connections" in resource ||
          "outputResources" in resource)
    )
  );
}

function normalizeDeployStatusField(value: unknown): DeployStatus | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (
    v === "pending" ||
    v === "in_progress" ||
    v === "success" ||
    v === "failed"
  )
    return v;
  return undefined;
}

/**
 * confirmArtifactIdentity - true when a payload describes the application and
 * environment the caller asked for. Compared after sanitization and
 * case-insensitively, since the two sides derive these names independently.
 *
 * An unspecified expectation matches anything, so a caller that only knows the
 * environment is not forced to guess the app name.
 */
export function confirmArtifactIdentity(
  progress: DeployProgress | null | undefined,
  expected: { environment?: string | null; application?: string | null } = {}
): boolean {
  if (!progress) return false;
  const wantEnv = sanitizeArtifactSegment(expected.environment);
  if (wantEnv && sanitizeArtifactSegment(progress.environment) !== wantEnv)
    return false;
  const wantApp = sanitizeArtifactSegment(expected.application);
  if (wantApp && sanitizeArtifactSegment(progress.application) !== wantApp)
    return false;
  return true;
}

/**
 * createDeployStatusReader - read deploy status and the deployed graph from
 * workflow artifacts, cached with a short TTL and de-duplicated so concurrent
 * callers (the monitor loop and an /api/deployed-graph request) share one fetch.
 *
 * Scope the read to a run with `runId` while a deploy is being monitored; omit
 * it to find the newest deploy repo-wide, which is what a fresh canvas session
 * with no run in flight needs.
 *
 * Payloads are accepted in monotonic `sequence` order per run, so a stale read
 * (an artifact listing served just after an overwrite, or a response arriving
 * out of order) can never roll the graph backwards.
 */
export function createDeployStatusReader(options: DeployStatusReaderOptions) {
  const {
    repo,
    environment = "",
    application = "",
    allowApplicationFallback = false,
    runId = null,
    listArtifacts,
    downloadArtifact,
    ttlMs = 10000,
    now = () => Date.now()
  } = options;

  let cache: { at: number; result: ReadResult } | null = null;
  let inflight: Promise<ReadResult> | null = null;
  let hasAccepted = false;
  let acceptedRunId: number | null = null;
  let acceptedSequence = -1;
  let lastGood: ReadResult | null = null;
  const inspectedArtifacts = new Map<number, ReadResult>();
  // A run-scoped read follows one in-flight deployment through its rotating
  // live slots; a repo-wide read looks for the newest terminal artifact and is
  // not tied to any run.
  const isRunScoped = Number.isFinite(Number(runId)) && Number(runId) > 0;

  const empty = (status: ReaderStatus, error: unknown = null): ReadResult => ({
    status,
    progress: null,
    graph: null,
    files: null,
    artifact: null,
    error
  });

  async function fetchOnce(): Promise<ReadResult> {
    if (!repo) return empty("missing");
    let artifacts: WorkflowArtifact[];
    try {
      // Pass the environment-scoped prefix so a paginated repo-wide listing can
      // stop as soon as it reaches the artifact we are looking for.
      artifacts = await listArtifacts(
        repo,
        runId,
        deployStatusArtifactPrefix(environment)
      );
    } catch (e) {
      return empty(
        errorCode(e) === "GH_ARTIFACT_AUTH" ? "auth"
        : errorCode(e) === "GH_ARTIFACT_MALFORMED" ? "malformed"
        : "error",
        e
      );
    }
    let candidates = selectDeployStatusArtifacts(artifacts, environment);
    if (candidates.length === 0) return empty("missing");

    const expectedRunId = Number(runId);
    // A repo-wide read is not scoped to any run, and `sequence` restarts at 1
    // for every run. Live-slot artifacts must therefore be excluded from that
    // path — otherwise a cancelled run's higher-sequenced slot could beat a
    // newer completed run's fixed-name terminal artifact.
    if (!isRunScoped) {
      candidates = candidates.filter((a) => !isLiveSlotArtifactName(a.name));
      if (candidates.length === 0) return empty("missing");
    }
    // Ring slots overwrite by uploading with new artifact IDs, so an ID that
    // dropped out of the listing never comes back. Prune the cache to the
    // current listing so a long-running deploy cannot accumulate payloads that
    // will never be referenced again.
    if (inspectedArtifacts.size > 0) {
      const listedIds = new Set(candidates.map((c) => c.id));
      for (const cachedId of [...inspectedArtifacts.keys()]) {
        if (!listedIds.has(cachedId)) inspectedArtifacts.delete(cachedId);
      }
    }

    let sawMalformed = false;
    // A candidate that could not be read proves nothing about whether this
    // deployment still exists, so it must not be reported as an absence: the
    // reader retires its cached graph on a repo-wide "missing", and doing that
    // for a transient download failure would blank a perfectly valid Deployed
    // view. Tracked separately from `sawMalformed`, which describes an artifact
    // that *was* read and turned out to be unusable.
    let sawUnreadable = false;
    let readError: unknown = null;
    let exactMatch: ReadResult | null = null;
    let envOnlyMatch: ReadResult | null = null;
    for (const artifact of candidates) {
      const artifactRunId = artifact.workflow_run?.id;
      if (
        isRunScoped &&
        artifactRunId !== undefined &&
        artifactRunId !== expectedRunId
      )
        continue;
      let result =
        isRunScoped ? inspectedArtifacts.get(artifact.id) : undefined;
      if (!result) {
        let files: ArtifactFiles | null;
        try {
          files = await downloadArtifact(repo, artifact);
        } catch (e) {
          if (errorCode(e) === "GH_ARTIFACT_AUTH") return empty("auth", e);
          // A single unreadable artifact should not hide an older readable one.
          if (errorCode(e) === "GH_ARTIFACT_MALFORMED") sawMalformed = true;
          else sawUnreadable = true;
          readError = e;
          continue;
        }
        if (!files) {
          sawUnreadable = true;
          continue;
        }
        const progress = parseDeployProgressArtifact(
          files[DEPLOY_STATUS_FILES.progress]
        );
        if (!progress) {
          sawMalformed = true;
          if (isRunScoped)
            inspectedArtifacts.set(artifact.id, empty("malformed"));
          continue;
        }
        const graphText = files[DEPLOY_STATUS_FILES.graph];
        const graph = parseDeployGraphArtifact(graphText);
        result = {
          status: "ok",
          progress,
          graph,
          files,
          artifact,
          error: null
        };
        if (isRunScoped) inspectedArtifacts.set(artifact.id, result);
      }
      const progress = result.progress;
      if (!progress) {
        sawMalformed = true;
        continue;
      }
      // Confirm identity from the payload rather than from the derived name.
      if (!confirmArtifactIdentity(progress, { environment })) continue;
      if (
        artifactRunId !== undefined &&
        progress.runId !== undefined &&
        artifactRunId !== progress.runId
      ) {
        sawMalformed = true;
        continue;
      }
      if (isRunScoped && (progress.runId ?? artifactRunId) !== expectedRunId)
        continue;
      if (confirmArtifactIdentity(progress, { environment, application })) {
        // Within an active run, sequences are comparable and pick the freshest
        // snapshot regardless of artifact list order. Across runs (repo-wide),
        // sequences restart at 1, so the first (newest by list order) match
        // wins instead.
        if (!exactMatch) {
          exactMatch = result;
        } else if (
          isRunScoped &&
          exactMatch.progress &&
          progress.sequence > exactMatch.progress.sequence
        ) {
          exactMatch = result;
        }
        continue;
      }
      // Right environment, different application. Hold it as a fallback rather
      // than selecting it immediately: an exact application match, if one
      // exists, must win.
      // But the caller's application name can itself be a guess (it falls back
      // to the repository's short name when app.bicep cannot be read), so
      // treating a mismatch as fatal would blank the tab over a name this side
      // never actually knew.
      if (!allowApplicationFallback || isRunScoped) continue;
      if (!envOnlyMatch) envOnlyMatch = result;
    }
    if (exactMatch) return exactMatch;
    if (envOnlyMatch) return envOnlyMatch;
    // "missing" is reserved for a confirmed absence: GitHub listed this
    // deployment's artifacts and none of them describe it. Candidates that
    // could not be downloaded are reported as an error instead, so a transient
    // failure never looks like a deletion.
    return empty(
      sawMalformed ? "malformed"
      : sawUnreadable ? "error"
      : "missing",
      readError
    );
  }

  // read - fetch (cached, single-flight) and enforce monotonic sequencing.
  async function read(): Promise<ReadResult> {
    if (cache && now() - cache.at < ttlMs) return cache.result;
    if (inflight) return inflight;
    inflight = (async () => {
      let result = await fetchOnce();
      if (result.status === "ok" && result.progress) {
        const incomingRun =
          result.progress.runId ?? result.artifact?.workflow_run?.id ?? null;
        // The sequence guard only applies when both snapshots positively
        // identify the SAME run. An unknown run id identifies nothing, and
        // since `sequence` restarts at 1 for every run, treating "unknown" as
        // a match would make a new deploy's first snapshot look like a stale
        // replay of the previous one — pinning the graph to an old deployment.
        // Accepting an out-of-order snapshot is the cheaper mistake: it
        // self-corrects on the next poll.
        const sameRun =
          hasAccepted && incomingRun !== null && incomingRun === acceptedRunId;
        if (
          sameRun &&
          lastGood &&
          result.progress.sequence <= acceptedSequence
        ) {
          // Preserve graph sequencing, but distinguish an identical successful
          // reread from a regression for consumers that require current proof.
          const progressRevalidated =
            result.progress.sequence === acceptedSequence &&
            JSON.stringify(result.progress) ===
              JSON.stringify(lastGood.progress);
          result = { ...lastGood, status: "stale", progressRevalidated };
        } else {
          hasAccepted = true;
          acceptedRunId = incomingRun;
          acceptedSequence = result.progress.sequence;
          lastGood = result;
        }
      } else if (result.status === "missing" && !isRunScoped) {
        // GitHub answered and this deployment has no artifact. Retire what was
        // read before instead of serving it from `lastGood`: deleting an
        // application deletes its deploy-status artifact, and a reader that
        // keeps falling back would render the deleted deployment for the rest
        // of the session. Only a repo-wide read is trusted this far — a
        // run-scoped read can momentarily list nothing while the producer
        // rotates a live slot, and blanking on that would flicker the graph
        // mid-deploy.
        hasAccepted = false;
        acceptedRunId = null;
        acceptedSequence = -1;
        lastGood = null;
      }
      cache = { at: now(), result };
      return result;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    read,
    status: async (): Promise<ReaderStatus> => (await read()).status,
    get sequence(): number {
      return acceptedSequence;
    },
    /** progress - the latest accepted per-resource payload, or null. */
    async progress(): Promise<DeployProgress | null> {
      const result = await read();
      return result.progress || lastGood?.progress || null;
    },
    /**
     * controlPlaneLog - the deploy-controlplane.log text from the latest
     * accepted artifact, or null. The producer ships it alongside the status
     * payload; it carries the precise recipe/terraform failure cause that the
     * run log only summarizes, so the failure block surfaces its tail.
     */
    async controlPlaneLog(): Promise<string | null> {
      const result = await read();
      const files = result.files ?? lastGood?.files ?? null;
      const text = files?.[DEPLOY_STATUS_FILES.controlPlane];
      return typeof text === "string" && text.trim() ? text : null;
    },
    /**
     * graph - the deployed application graph, with the status the read
     * resolved to. `graph` is null until the producer's final upload, which is
     * the only one that carries deploy-graph.json.
     */
    async graph(): Promise<{
      graph: unknown | null;
      status: ReaderStatus;
      artifact: WorkflowArtifact | null;
    }> {
      const result = await read();
      const graph = result.graph ?? lastGood?.graph ?? null;
      return {
        graph,
        status: result.status,
        artifact: result.artifact || lastGood?.artifact || null
      };
    }
  };
}
