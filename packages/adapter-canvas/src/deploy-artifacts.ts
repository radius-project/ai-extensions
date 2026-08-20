// Canvas adapter — deploy status from GitHub Actions workflow artifacts.
//
// The deploy workflow publishes the deployed application graph and a
// per-resource status map as a workflow artifact. This module finds that
// artifact, downloads it, validates the payload, and turns it into a status map
// the Deployed graph is painted with.
//
// Why artifacts and not logs: there is no GitHub API that exposes a running
// job's log output. `GET /actions/jobs/{id}/logs` returns 200 but withholds the
// currently-running step until the job completes, the web UI's live view is
// session-cookie-only, and `gh run watch` streams step status with no log
// content. Workflow artifacts, by contrast, are listable AND downloadable while
// a run is still in progress, which makes them the only transport that can
// carry live per-resource detail.
//
// During `rad deploy`, the producer rotates changed snapshots through eight
// run-scoped live artifacts. The fixed-name terminal artifact is uploaded after
// the deploy step and carries a greater sequence, so this reader treats payload
// sequence and identity as authoritative rather than artifact list order.
//
// Reads GitHub via the gh CLI (see ./gh.ts). Every I/O call is injectable so
// the whole module is testable without network, Docker, or gh.

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliExec } from "./gh.js";
import { deployStatusKeys, lookupDeployStatus } from "@radius-project/core";
import type { DeployStatus } from "@radius-project/core";

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

export interface DeployProgressResource {
  id?: string;
  name: string;
  type: string;
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
  runId?: number | string | null;
  listArtifacts?: ListArtifacts;
  downloadArtifact?: DownloadArtifact;
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
    return (b.id || 0) - (a.id || 0);
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
    !Number.isInteger(parsed.sequence) ||
    parsed.sequence < 1
  )
    return null;
  const sequence = parsed.sequence;
  const resources: DeployProgressResource[] = [];
  for (const raw of parsed.resources) {
    if (!isRecord(raw)) continue;
    const name = typeof raw.name === "string" ? raw.name : "";
    if (!name) continue;
    resources.push({
      id: typeof raw.id === "string" ? raw.id : undefined,
      name,
      type: typeof raw.type === "string" ? raw.type : "",
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
    resources
  };
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
 * normalizeProvisioningState - map a raw Radius provisioningState onto the
 * canvas status vocabulary.
 *
 * Anything unrecognized — including a state a future Radius release adds — maps
 * to in_progress, never failed. A new provisioning state must not be able to
 * paint the graph red.
 */
export function normalizeProvisioningState(
  value?: string | null
): DeployStatus {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (v === "succeeded") return "success";
  if (v === "failed" || v === "canceled" || v === "cancelled") return "failed";
  return "in_progress";
}

/**
 * resolveResourceStatus - the status for one entry: the producer's normalized
 * `status` when present and valid, else its raw `provisioningState` normalized
 * here, else in_progress.
 *
 * Both fields are carried deliberately. `status` keeps the mapping decision with
 * the producer, which knows the Radius version it ran against; `provisioningState`
 * lets this side recover when the producer's mapping is stale.
 */
export function resolveResourceStatus(
  resource: DeployProgressResource
): DeployStatus {
  return (
    resource.status || normalizeProvisioningState(resource.provisioningState)
  );
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
 * buildDeployStatusMap - index a progress payload by every key a modeled
 * resource might be matched on, so lookupDeployStatus can resolve in priority
 * order.
 *
 * The keys come from `deployStatusKeys`, the same function the lookup side uses.
 * That shared derivation is load-bearing: if the two ever computed keys
 * differently, this map would be populated with keys the lookup never queries
 * and every node would silently fall back to pending.
 *
 * A later entry never overwrites an earlier one for the same key. A duplicate
 * key means two resources collide on that (weaker) key, in which case the first
 * wins rather than the last silently taking over.
 */
export function buildDeployStatusMap(
  progress: DeployProgress | null | undefined
): Map<string, DeployStatus> {
  const map = new Map<string, DeployStatus>();
  if (!progress || !Array.isArray(progress.resources)) return map;
  for (const resource of progress.resources) {
    const status = resolveResourceStatus(resource);
    for (const key of deployStatusKeys(resource)) {
      if (!map.has(key)) map.set(key, status);
    }
  }
  return map;
}

/**
 * buildDeployMessageMap - index the payload's per-resource `message` strings by
 * the same keys as the status map.
 *
 * Kept separate from the status map rather than folded into it because the
 * status merge is a lattice (`failed` is terminal, a miss preserves the current
 * value) while a message is just the most recent explanatory text. Blending the
 * two would make the merge rules apply to prose.
 *
 * Empty messages are skipped: the producer emits `""` for a healthy resource,
 * and an empty string is not a message.
 */
export function buildDeployMessageMap(
  progress: DeployProgress | null | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  if (!progress || !Array.isArray(progress.resources)) return map;
  for (const resource of progress.resources) {
    const message = (resource.message || "").trim();
    if (!message) continue;
    for (const key of deployStatusKeys(resource)) {
      if (!map.has(key)) map.set(key, message);
    }
  }
  return map;
}

/**
 * applyDeployMessages - attach each resource's status message so the node popup
 * can explain WHY a node is red. Without this the graph reports that something
 * failed but never what went wrong, which is the moment the user most needs
 * detail. Resources with no message are left untouched.
 */
export function applyDeployMessages(
  resources: Array<{
    id?: string;
    name?: string;
    type?: string;
    deployMessage?: string;
  }>,
  messageMap: Map<string, string>
): void {
  if (!Array.isArray(resources) || messageMap.size === 0) return;
  for (const resource of resources) {
    for (const key of deployStatusKeys(resource)) {
      const message = messageMap.get(key);
      if (message) {
        resource.deployMessage = message;
        break;
      }
    }
  }
}

const STATUS_RANK: Record<DeployStatus, number> = {
  pending: 0,
  in_progress: 1,
  success: 2,
  failed: 3
};

/**
 * applyDeployStatusToResources - merge a status map into resources that are
 * already on screen, in place, returning the resources that changed.
 *
 * The merge is deliberately conservative because updates arrive as independent
 * snapshots, not as a stream of transitions:
 *
 *   - `failed` is terminal within a run and is never downgraded by a later tick.
 *   - `success` regresses only on an explicit `failed`.
 *   - A resource missing from the map keeps its current status. A payload that
 *     simply does not mention a resource carries no information about it, and
 *     must never reset a node that has already advanced.
 */
export function applyDeployStatusToResources(
  resources: Array<{
    id?: string;
    name?: string;
    type?: string;
    deployStatus?: DeployStatus;
  }>,
  statusMap: Map<string, DeployStatus>
): Array<{ name?: string; from: DeployStatus; to: DeployStatus }> {
  const changes: Array<{
    name?: string;
    from: DeployStatus;
    to: DeployStatus;
  }> = [];
  if (!Array.isArray(resources) || statusMap.size === 0) return changes;
  for (const resource of resources) {
    const next = lookupDeployStatus(resource, statusMap);
    if (!next) continue;
    const current: DeployStatus = resource.deployStatus || "pending";
    if (current === next) continue;
    if (current === "failed") continue;
    if (STATUS_RANK[next] <= STATUS_RANK[current] && next !== "failed")
      continue;
    resource.deployStatus = next;
    changes.push({ name: resource.name, from: current, to: next });
  }
  return changes;
}

/**
 * settleDeployStatuses - apply the run's terminal conclusion to the graph.
 *
 * On success every node is forced green: the run concluded successfully, so
 * every resource provisioned, whatever the last snapshot happened to say. This
 * deliberately overrides a resource the producer positively reported as
 * `failed` (and discards its deployMessage): the run conclusion is authoritative
 * for the overall outcome, so a partially-failed-yet-succeeded run shows all
 * green rather than a stale per-resource failure.
 * On any other conclusion, nodes still pending or in progress become failed,
 * while nodes already terminal keep the status the producer reported — the run
 * conclusion decides the overall label, not an individual resource's outcome
 * that was already observed.
 */
export function settleDeployStatuses(
  resources: Array<{ deployStatus?: DeployStatus }>,
  conclusion?: string | null
): void {
  if (!Array.isArray(resources)) return;
  const succeeded = conclusion === "success";
  for (const resource of resources) {
    if (succeeded) {
      resource.deployStatus = "success";
      continue;
    }
    const current = resource.deployStatus || "pending";
    if (current === "pending" || current === "in_progress")
      resource.deployStatus = "failed";
  }
}

// ── gh-backed I/O ───────────────────────────────────────────────────────────

function ghJsonArray(args: string[], timeout = 20000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    cliExec("gh", args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        const text = String(stderr || err.message || "");
        const error: Error & { code?: string } = new Error(text);
        // 403/401 on an artifact read means the credential cannot see this
        // repo's Actions data; retrying will not fix it, so classify it apart
        // from a transient failure.
        if (/HTTP 40[13]\b/.test(text) || /\bForbidden\b/i.test(text))
          error.code = "GH_ARTIFACT_AUTH";
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || "null"));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * listWorkflowArtifacts - list artifacts for one run when `runId` is given, else
 * the newest artifacts across the repo.
 *
 * The per-run endpoint is what makes live status possible: it is readable while
 * the run is still in progress. The repo-wide endpoint returns newest-first and
 * is how a fresh canvas session finds the last deploy without knowing a run id.
 *
 * The repo-wide read is paginated, which matters more than it looks. A single
 * page covers the newest 100 artifacts in the ENTIRE repository, and a repo
 * whose CI uploads test reports or build output on every push can easily produce
 * that many between two deploys. Reading only the first page would push the
 * deploy-status artifact off the end and render "Nothing deployed yet" for an
 * application that is in fact deployed — the exact symptom this transport
 * exists to eliminate.
 *
 * Paging stops as soon as a page yields an artifact matching `namePrefix`,
 * because the listing is newest-first and nothing better can appear later; it
 * also stops at a short page (end of the list) or the page budget, so a repo
 * with no deploy-status artifact at all costs a bounded number of calls rather
 * than walking its entire artifact history.
 */
export const listWorkflowArtifacts: ListArtifacts = async (
  repo,
  runId,
  namePrefix
) => {
  // A single run has few artifacts, so one page always covers it.
  if (runId) {
    const data = await ghJsonArray([
      "api",
      `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=${ARTIFACT_PAGE_SIZE}`
    ]);
    if (!isRecord(data) || !Array.isArray(data.artifacts)) return [];
    return data.artifacts.filter((a): a is WorkflowArtifact => isRecord(a));
  }

  const found: WorkflowArtifact[] = [];
  const prefix = namePrefix || DEPLOY_STATUS_ARTIFACT_PREFIX;
  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page++) {
    const data = await ghJsonArray([
      "api",
      `/repos/${repo}/actions/artifacts?per_page=${ARTIFACT_PAGE_SIZE}&page=${page}`
    ]);
    if (!isRecord(data) || !Array.isArray(data.artifacts)) break;
    const batch = data.artifacts.filter((a): a is WorkflowArtifact =>
      isRecord(a)
    );
    found.push(...batch);
    if (
      batch.some((a) => typeof a.name === "string" && a.name.startsWith(prefix))
    )
      break;
    if (batch.length < ARTIFACT_PAGE_SIZE) break; // end of the listing
  }
  return found;
};

/**
 * downloadWorkflowArtifact - download an artifact and return its files keyed by
 * name.
 *
 * Uses `gh run download`, which handles the redirect to blob storage, the auth
 * header, and the unzip. Reaching for the REST zip endpoint directly would mean
 * carrying a ZIP decoder in this repo for no benefit — Node has none built in.
 *
 * Only text files are read back; a file too large to be a status document is
 * skipped rather than loaded into memory.
 */
export const downloadWorkflowArtifact: DownloadArtifact = async (
  repo,
  artifact
) => {
  const runId = artifact?.workflow_run?.id;
  if (!runId || !artifact?.name) return null;
  const dir = mkdtempSync(path.join(os.tmpdir(), "rad-deploy-artifact-"));
  try {
    await new Promise<void>((resolve, reject) => {
      cliExec(
        "gh",
        [
          "run",
          "download",
          String(runId),
          "--name",
          artifact.name,
          "--dir",
          dir,
          "--repo",
          repo
        ],
        { timeout: 60000 },
        (err, _stdout, stderr) => {
          if (err) {
            const text = String(stderr || err.message || "");
            const error: Error & { code?: string } = new Error(text);
            if (/HTTP 40[13]\b/.test(text) || /\bForbidden\b/i.test(text))
              error.code = "GH_ARTIFACT_AUTH";
            reject(error);
            return;
          }
          resolve();
        }
      );
    });
    return readArtifactDir(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
};

const MAX_ARTIFACT_FILE_BYTES = 8 * 1024 * 1024;

function readArtifactDir(dir: string): ArtifactFiles {
  const files: ArtifactFiles = {};
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const info = statSync(full);
      if (!info.isFile() || info.size > MAX_ARTIFACT_FILE_BYTES) continue;
      files[name] = readFileSync(full, "utf8");
    } catch {
      /* skip unreadable entries */
    }
  }
  return files;
}

// ── reader ──────────────────────────────────────────────────────────────────

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
    runId = null,
    listArtifacts = listWorkflowArtifacts,
    downloadArtifact = downloadWorkflowArtifact,
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
      return empty(errorCode(e) === "GH_ARTIFACT_AUTH" ? "auth" : "error", e);
    }
    let candidates = selectDeployStatusArtifacts(artifacts, environment);
    if (candidates.length === 0) return empty("missing");

    const expectedRunId = Number(runId);
    const hasExpectedRunId =
      Number.isFinite(expectedRunId) && expectedRunId > 0;
    // A repo-wide read is not scoped to any run, and `sequence` restarts at 1
    // for every run. Live-slot artifacts must therefore be excluded from that
    // path — otherwise a cancelled run's higher-sequenced slot could beat a
    // newer completed run's fixed-name terminal artifact.
    if (!hasExpectedRunId) {
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
    let exactMatch: ReadResult | null = null;
    let envOnlyMatch: ReadResult | null = null;
    for (const artifact of candidates) {
      let result =
        hasExpectedRunId ? inspectedArtifacts.get(artifact.id) : undefined;
      if (!result) {
        let files: ArtifactFiles | null;
        try {
          files = await downloadArtifact(repo, artifact);
        } catch (e) {
          if (errorCode(e) === "GH_ARTIFACT_AUTH") return empty("auth", e);
          // A single unreadable artifact should not hide an older readable one.
          continue;
        }
        if (!files) continue;
        const progress = parseDeployProgressArtifact(
          files[DEPLOY_STATUS_FILES.progress]
        );
        if (!progress) {
          sawMalformed = true;
          if (hasExpectedRunId)
            inspectedArtifacts.set(artifact.id, empty("malformed"));
          continue;
        }
        let graph: unknown | null = null;
        const graphText = files[DEPLOY_STATUS_FILES.graph];
        if (graphText) {
          try {
            graph = JSON.parse(graphText);
          } catch {
            sawMalformed = true;
          }
        }
        result = {
          status: "ok",
          progress,
          graph,
          files,
          artifact,
          error: null
        };
        if (hasExpectedRunId) inspectedArtifacts.set(artifact.id, result);
      }
      const progress = result.progress;
      if (!progress) {
        sawMalformed = true;
        continue;
      }
      // Confirm identity from the payload rather than from the derived name.
      if (!confirmArtifactIdentity(progress, { environment })) continue;
      if (
        hasExpectedRunId &&
        progress.runId !== undefined &&
        progress.runId !== expectedRunId
      )
        continue;
      if (confirmArtifactIdentity(progress, { environment, application })) {
        // Within an active run, sequences are comparable and pick the freshest
        // snapshot regardless of artifact list order. Across runs (repo-wide),
        // sequences restart at 1, so the first (newest by list order) match
        // wins instead.
        if (!exactMatch) {
          exactMatch = result;
        } else if (
          hasExpectedRunId &&
          progress.sequence > (exactMatch.progress?.sequence ?? -1)
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
      if (!envOnlyMatch) {
        envOnlyMatch = result;
      } else if (
        hasExpectedRunId &&
        progress.sequence > (envOnlyMatch.progress?.sequence ?? -1)
      ) {
        envOnlyMatch = result;
      }
    }
    if (exactMatch) return exactMatch;
    if (envOnlyMatch) return envOnlyMatch;
    return empty(sawMalformed ? "malformed" : "missing");
  }

  // read - fetch (cached, single-flight) and enforce monotonic sequencing.
  async function read(): Promise<ReadResult> {
    if (cache && now() - cache.at < ttlMs) return cache.result;
    if (inflight) return inflight;
    inflight = (async () => {
      let result: ReadResult;
      try {
        result = await fetchOnce();
      } catch (e) {
        result = empty("error", e);
      }
      if (result.status === "ok" && result.progress) {
        const incomingRun = result.progress.runId ?? null;
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
          // An older snapshot of the run we are already tracking. Keep what we
          // have; regressing the graph would flicker resources back to pending.
          result = { ...lastGood, status: "stale" };
        } else {
          hasAccepted = true;
          acceptedRunId = incomingRun;
          acceptedSequence = result.progress.sequence;
          lastGood = result;
        }
      }
      cache = { at: now(), result };
      inflight = null;
      return result;
    })();
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
