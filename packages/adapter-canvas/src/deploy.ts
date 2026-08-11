// Canvas adapter — deploy monitoring + log parsing.
// Polls GitHub Actions runs and the orphan radius-deploy-status branch for live
// deploy/activity/control-plane logs and the deployed graph, then parses rad
// deploy output into per-resource progress/status the deployingPage renders.
// Reads GitHub via the gh CLI; portal links come from ./infra.ts.

import { ghApiGetContent, cliExec } from "./gh.js";
import { generatePortalUrl } from "./infra.js";
import {
  pullOciArtifactFiles,
  loadGhKeyringCredentials,
  DEPLOY_STATUS_ARTIFACT_TYPE
} from "./ghcr.js";
import type {
  FetchImplementation,
  GhCredentials,
  PullOciOptions
} from "./ghcr.js";
import type { CanvasState } from "./shared.js";

type DeployStatus = "pending" | "in_progress" | "success" | "failed";

export interface DeployedConnection {
  id?: string;
  name?: string;
  direction?: string;
}

export interface DeployedOutputResource {
  id?: string;
  name?: string;
  type?: string;
  displayType?: string;
  deployStatus?: DeployStatus;
  portalUrl?: string;
}

export interface DeployedResource {
  id?: string;
  name?: string;
  type?: string;
  connections?: DeployedConnection[];
  outputResources?: DeployedOutputResource[];
  deployStatus?: DeployStatus;
}

interface WorkflowStep {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface WorkflowRun {
  databaseId?: number;
  createdAt?: string;
  status?: string;
  conclusion?: string | null;
}

interface WorkflowRunDetail extends WorkflowRun {
  jobs: WorkflowJob[];
  steps: WorkflowStep[];
}

interface ReaderPullResult {
  status: "unconfigured" | "missing" | "malformed" | "ok" | "auth" | "error";
  files: Record<string, string> | null;
  registry: string;
  tag: string;
  error: unknown;
}

interface DeployArtifact {
  files: Record<string, string>;
  artifactType?: string;
}

type PullArtifact = (options: PullOciOptions) => Promise<DeployArtifact | null>;

interface DeployStatusReaderOptions {
  repo: string;
  environment?: string;
  app?: string;
  stateRegistry?: string;
  graphRegistry?: string;
  graphTag?: string;
  credentials?: GhCredentials;
  loadCredentials?: () => Promise<GhCredentials>;
  fetchImpl?: FetchImplementation;
  registryOrigin?: string;
  pullArtifact?: PullArtifact;
  getBranchContent?: (
    apiPath: string,
    timeout?: number
  ) => Promise<string | Buffer | null>;
  ttlMs?: number;
  now?: () => number;
}

export interface ActivityEntry {
  status: Exclude<DeployStatus, "pending">;
  rid: string;
  op: string;
  type: string;
  name: string;
}

interface RepoPermissions {
  admin?: boolean;
  maintain?: boolean;
  push?: boolean;
  triage?: boolean;
  pull?: boolean;
}

interface RepoAccessInput {
  repo?: string;
  login?: string;
  readFailed?: boolean;
  permissions?: RepoPermissions | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorCode(error: unknown): string {
  if (!isRecord(error)) return "";
  return typeof error.code === "string" ? error.code : "";
}

function parseWorkflowRun(value: unknown): WorkflowRun | null {
  if (!isRecord(value)) return null;
  return {
    databaseId:
      typeof value.databaseId === "number" ? value.databaseId : undefined,
    createdAt: stringField(value.createdAt),
    status: stringField(value.status),
    conclusion:
      typeof value.conclusion === "string" || value.conclusion === null ?
        value.conclusion
      : undefined
  };
}

// File names the producer's publish-deploy-status action packs into the GHCR
// deploy-status artifact (radius-project/radius PR #12591). These double as the
// branch file names on the legacy radius-deploy-status orphan branch.
export const DEPLOY_STATUS_FILES = {
  graph: "deploy-graph.json",
  progress: "deploy-progress.log",
  activity: "deploy-activity.log",
  controlPlane: "deploy-controlplane.log",
  state: "deploy-state.txt"
};

// deriveGraphRegistry - mirror the producer's registry resolution so the reader
// pulls from the exact GHCR repo the deploy published to:
//   1. an explicit graph registry wins (RADIUS_GRAPH_REGISTRY on the producer),
//   2. else derive from the state registry: swap the first "radius-state" for
//      "radius-graph", or append "-graph" when the token is absent.
// Returns "" when neither input is available (GHCR read is then skipped).
export function deriveGraphRegistry(
  stateRegistry?: string,
  graphRegistryOverride?: string
): string {
  const override = (graphRegistryOverride || "").trim();
  if (override) return override;
  const state = (stateRegistry || "").trim();
  if (!state) return "";
  if (state.includes("radius-state"))
    return state.replace("radius-state", "radius-graph");
  return `${state}-graph`;
}

// deriveGraphTag - mirror the producer's tag derivation:
//   RADIUS_GRAPH_TAG wins; else "<environment>-<app>-latest", lowercased with
//   every run of characters outside [a-z0-9._-] collapsed to '-', leading and
//   trailing '-' stripped, capped at 80 chars (falling back to "deploy-status"
//   when the base sanitizes to empty).
export function deriveGraphTag(
  environment?: string,
  app?: string,
  tagOverride?: string
): string {
  const override = (tagOverride || "").trim();
  if (override) return override;
  const base = `${environment || ""}-${app || ""}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 80);
  return `${base || "deploy-status"}-latest`;
}

// appNameForGraphTag - replicate the producer's app-name extraction used to
// build the tag: the first `name: '...'` literal in the app bicep (single
// quotes, matching its `grep -oP "name:\\s*'\\K[^']+" | head -1`). Returns ""
// when no literal name is present.
export function appNameForGraphTag(source?: string | null): string {
  if (!source) return "";
  const match = source.match(/name:\s*'([^']+)'/);
  return match ? match[1] : "";
}

export function ghJson(
  args: string[],
  fallback: unknown = null,
  timeout = 15000
): Promise<unknown> {
  return new Promise((resolve) => {
    cliExec("gh", args, { timeout }, (err, stdout) => {
      if (err) {
        resolve(fallback);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        resolve(fallback);
      }
    });
  });
}

export async function findWorkflowRun(
  repo: string,
  workflowFile: string,
  sinceMs: number,
  knownId?: number | string | null
): Promise<number | string | null> {
  if (knownId) return knownId;
  const runs = await ghJson(
    [
      "run",
      "list",
      "--workflow=" + workflowFile,
      "--limit",
      "5",
      "--json",
      "databaseId,status,createdAt",
      "--repo",
      repo
    ],
    []
  );
  if (!Array.isArray(runs)) return null;
  // Newest first; accept the first run created within ~60s before dispatch
  // (clock skew tolerance) to avoid picking up stale prior runs.
  const cutoff = (sinceMs || 0) - 60000;
  for (const value of runs) {
    const r = parseWorkflowRun(value);
    if (!r) continue;
    const created = Date.parse(r.createdAt || "") || 0;
    if (created >= cutoff && r.databaseId !== undefined) return r.databaseId;
  }
  return null;
}

export async function getRunDetail(
  repo: string,
  runId: number | string
): Promise<WorkflowRunDetail | null> {
  let data = await ghJson(
    [
      "run",
      "view",
      String(runId),
      "--json",
      "status,conclusion,jobs",
      "--repo",
      repo
    ],
    null
  );
  // The jobs sub-resource (/actions/runs/<id>/jobs) is intermittently flaky
  // (HTTP 503) and, when included, fails the whole `gh run view` call — which
  // would otherwise report the run's status/conclusion just fine. The jobs
  // (steps) are only needed for progress/failure detail, not for detecting
  // completion, so fall back to a status-only read when the combined call
  // fails. This keeps completion detection (e.g. verify-status → success)
  // working even while the jobs endpoint is unavailable.
  if (!isRecord(data)) {
    data = await ghJson(
      [
        "run",
        "view",
        String(runId),
        "--json",
        "status,conclusion",
        "--repo",
        repo
      ],
      null
    );
    if (!isRecord(data)) return null;
    return {
      status: stringField(data.status),
      conclusion:
        typeof data.conclusion === "string" || data.conclusion === null ?
          data.conclusion
        : undefined,
      jobs: [],
      steps: []
    };
  }
  const jobs: WorkflowJob[] =
    Array.isArray(data.jobs) ?
      data.jobs.filter((job): job is WorkflowJob => isRecord(job))
    : [];
  const steps: WorkflowStep[] = [];
  for (const job of jobs) {
    for (const s of job.steps || []) {
      steps.push({ name: s.name, status: s.status, conclusion: s.conclusion });
    }
  }
  return {
    status: stringField(data.status),
    conclusion:
      typeof data.conclusion === "string" || data.conclusion === null ?
        data.conclusion
      : undefined,
    jobs,
    steps
  };
}

export function fetchRunLog(
  repo: string,
  runId: number | string
): Promise<string | null> {
  return new Promise((resolve) => {
    cliExec(
      "gh",
      ["run", "view", String(runId), "--log", "--repo", repo],
      { timeout: 30000, maxBuffer: 1024 * 1024 * 20 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export function fetchLiveDeployLog(repo: string): Promise<string | null> {
  return ghApiGetContent(
    `/repos/${repo}/contents/deploy-progress.log?ref=radius-deploy-status`,
    12000
  );
}

export function fetchLiveActivityLog(repo: string): Promise<string | null> {
  return ghApiGetContent(
    `/repos/${repo}/contents/deploy-activity.log?ref=radius-deploy-status`,
    12000
  );
}

export function fetchLiveControlPlaneLog(repo: string): Promise<string | null> {
  return ghApiGetContent(
    `/repos/${repo}/contents/deploy-controlplane.log?ref=radius-deploy-status`,
    12000
  );
}

export function fetchDeployState(repo: string): Promise<string | null> {
  return ghApiGetContent(
    `/repos/${repo}/contents/deploy-state.txt?ref=radius-deploy-status`,
    10000
  ).then((t) => (t ? t.trim() : null));
}

export function fetchDeployGraph(repo: string): Promise<unknown | null> {
  return ghApiGetContent(
    `/repos/${repo}/contents/deploy-graph.json?ref=radius-deploy-status`,
    12000
  ).then((t) => {
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch (e) {
      return null;
    }
  });
}

// createDeployStatusReader - GHCR-first reader for the deployed graph/status
// artifact, with a transparent fallback to the legacy radius-deploy-status
// branch files. The deployed graph (deploy-graph.json) is the real payload the
// producer publishes to GHCR; the reader pulls the OCI artifact once per TTL
// window (cached, single-flight) and, when the tag is missing/unconfigured/
// unauthorized/malformed, reads the same file from the branch instead.
//
// Only deploy-graph.json is treated as authoritative from GHCR — the sibling
// log files the producer packs there are status snapshots, so live-log/state
// reads stay on the branch (see graph() vs the branch fetch helpers above).
export function createDeployStatusReader(options: DeployStatusReaderOptions) {
  const {
    repo,
    environment = "",
    app = "",
    stateRegistry = "",
    graphRegistry = "",
    graphTag = "",
    credentials,
    loadCredentials = loadGhKeyringCredentials,
    fetchImpl,
    registryOrigin,
    pullArtifact = pullOciArtifactFiles,
    getBranchContent = ghApiGetContent,
    ttlMs = 5000,
    now = () => Date.now()
  } = options;

  const registry = deriveGraphRegistry(stateRegistry, graphRegistry);
  // Only derive a tag when we can build the producer's exact
  // "<environment>-<app>-latest" (both names present) or an explicit override
  // is given. A partial tag (e.g. "<environment>-latest") can never match the
  // producer and would cause repeated GHCR misses; leave it empty so the
  // reader reports "unconfigured" and cleanly uses the branch fallback.
  const tag =
    registry && (graphTag.trim() || (environment.trim() && app.trim())) ?
      deriveGraphTag(environment, app, graphTag)
    : "";

  let cache: { at: number; result: ReaderPullResult } | null = null;
  let inflight: Promise<ReaderPullResult> | null = null;
  let credPromise: Promise<GhCredentials> | null = null;

  function resolveCredentials(): Promise<GhCredentials> {
    if (credentials) return Promise.resolve(credentials);
    if (!credPromise)
      credPromise = Promise.resolve().then(() => loadCredentials());
    return credPromise;
  }

  // pull - fetch (and cache) the GHCR artifact, classifying the outcome:
  //   ok | missing | malformed | auth | error | unconfigured
  async function pull(): Promise<ReaderPullResult> {
    if (!registry || !tag) {
      return {
        status: "unconfigured",
        files: null,
        registry,
        tag,
        error: null
      };
    }
    if (cache && now() - cache.at < ttlMs) return cache.result;
    if (inflight) return inflight;
    inflight = (async () => {
      let result: ReaderPullResult;
      try {
        const resolvedCreds = await resolveCredentials();
        const artifact = await pullArtifact({
          registry,
          tag,
          credentials: resolvedCreds,
          fetchImpl,
          registryOrigin
        });
        if (!artifact) {
          result = {
            status: "missing",
            files: null,
            registry,
            tag,
            error: null
          };
        } else if (
          artifact.artifactType &&
          artifact.artifactType !== DEPLOY_STATUS_ARTIFACT_TYPE
        ) {
          // The tag resolved to an artifact of a different type (e.g. the
          // registry was misconfigured to a non-deploy-status package).
          // Treat it as malformed and fall back to the branch rather than
          // trusting an unexpected payload.
          result = {
            status: "malformed",
            files: artifact.files || {},
            registry,
            tag,
            error: null
          };
        } else if (
          !artifact.files ||
          typeof artifact.files[DEPLOY_STATUS_FILES.graph] !== "string"
        ) {
          result = {
            status: "malformed",
            files: artifact.files || {},
            registry,
            tag,
            error: null
          };
        } else {
          result = {
            status: "ok",
            files: artifact.files,
            registry,
            tag,
            error: null
          };
        }
      } catch (e) {
        result = {
          status: errorCode(e) === "GHCR_AUTH" ? "auth" : "error",
          files: null,
          registry,
          tag,
          error: e
        };
      }
      cache = { at: now(), result };
      inflight = null;
      return result;
    })();
    return inflight;
  }

  function branchGraph(): Promise<unknown | null> {
    return getBranchContent(
      `/repos/${repo}/contents/${DEPLOY_STATUS_FILES.graph}?ref=radius-deploy-status`,
      12000
    ).then((t: string | Buffer | null) => {
      if (!t) return null;
      try {
        return JSON.parse(t.toString());
      } catch (e) {
        return null;
      }
    });
  }

  return {
    registry,
    tag,
    pull,
    status: async () => (await pull()).status,
    // graph - return the deployed application graph, preferring the GHCR
    // artifact and falling back to the branch. Resolves
    // { graph, source: "ghcr"|"branch"|"none", status }.
    async graph() {
      const result = await pull();
      if (result.status === "ok" && result.files) {
        try {
          return {
            graph: JSON.parse(result.files[DEPLOY_STATUS_FILES.graph]),
            source: "ghcr",
            status: "ok"
          };
        } catch (e) {
          // Manifest advertised the file but its bytes weren't valid JSON.
          const graph = await branchGraph();
          return {
            graph,
            source: graph ? "branch" : "none",
            status: "malformed"
          };
        }
      }
      const graph = await branchGraph();
      return {
        graph,
        source: graph ? "branch" : "none",
        status: result.status
      };
    }
  };
}

export function normalizeDeployedGraph(
  resources: DeployedResource[] | null | undefined
): DeployedResource[] | null | undefined {
  if (!Array.isArray(resources) || resources.length < 2) return resources;
  const keyOf = (r: DeployedResource): string | undefined => r.id || r.name;
  const hasConn = (r: DeployedResource, otherKey?: string): boolean =>
    Array.isArray(r.connections) &&
    r.connections.some((c) => (c.id || c.name) === otherKey);
  for (let a = 0; a < resources.length; a++) {
    for (let b = a + 1; b < resources.length; b++) {
      const A = resources[a],
        B = resources[b];
      const aOut = Array.isArray(A.outputResources) ? A.outputResources : [];
      const bOut = Array.isArray(B.outputResources) ? B.outputResources : [];
      let shared = null;
      for (const oa of aOut) {
        if (!oa || !oa.id) continue;
        if (bOut.some((ob) => ob && ob.id === oa.id)) {
          shared = oa;
          break;
        }
      }
      if (!shared) continue;
      if (hasConn(A, keyOf(B)) || hasConn(B, keyOf(A))) continue;
      // Orient the edge toward the resource whose name matches the shared
      // concrete resource (its owner); else toward the one with fewer outputs.
      const sharedName = shared.name || "";
      let src = A,
        dst = B;
      if (B.name === sharedName && A.name !== sharedName) {
        src = A;
        dst = B;
      } else if (A.name === sharedName && B.name !== sharedName) {
        src = B;
        dst = A;
      } else if (aOut.length < bOut.length) {
        src = B;
        dst = A;
      }
      src.connections = Array.isArray(src.connections) ? src.connections : [];
      dst.connections = Array.isArray(dst.connections) ? dst.connections : [];
      src.connections.push({ id: keyOf(dst), direction: "Outbound" });
      dst.connections.push({ id: keyOf(src), direction: "Inbound" });
    }
  }
  return resources;
}

export function deployedResourceCategory(type?: string): string {
  const t = (type || "").toLowerCase();
  if (
    (t.includes("container") &&
      !t.includes("image") &&
      !t.includes("registry")) ||
    t.includes("compute")
  )
    return "compute";
  if (
    t.includes("redis") ||
    t.includes("cache") ||
    t.includes("elasticache") ||
    t.includes("memorydb")
  )
    return "cache";
  if (
    t.includes("mysql") ||
    t.includes("postgres") ||
    t.includes("/sql") ||
    t.includes("rds") ||
    t.includes("mongo") ||
    t.includes("cosmos") ||
    t.includes("documentdb") ||
    t.includes("docdb") ||
    t.includes("neo4j")
  )
    return "data";
  if (
    t.includes("secret") ||
    t.includes("keyvault") ||
    t.includes("secretsmanager")
  )
    return "secret";
  return "other";
}

export function rewireDeployedGraphChain(
  resources: DeployedResource[] | null | undefined
): DeployedResource[] | null | undefined {
  if (!Array.isArray(resources)) return resources;
  const byKey: Record<string, DeployedResource> = {};
  for (const r of resources) {
    const key = r.id || r.name;
    if (key) byKey[key] = r;
  }
  const keyOf = (r: DeployedResource): string => r.id || r.name || "";
  const catOf = (r: DeployedResource) => deployedResourceCategory(r.type);
  for (const c of resources) {
    if (catOf(c) !== "compute" || !Array.isArray(c.connections)) continue;
    const caches: DeployedResource[] = [],
      dbs: DeployedResource[] = [];
    for (const conn of c.connections) {
      if (conn.direction !== "Outbound") continue;
      const connectionKey = conn.id || conn.name;
      if (!connectionKey) continue;
      const dst = byKey[connectionKey];
      if (!dst) continue;
      if (catOf(dst) === "cache") caches.push(dst);
      else if (catOf(dst) === "data") dbs.push(dst);
    }
    if (caches.length === 0 || dbs.length === 0) continue;
    const cache = caches[0];
    const cKey = keyOf(c),
      cacheKey = keyOf(cache);
    for (const db of dbs) {
      const dbKey = keyOf(db);
      // Drop container → db (both directions).
      c.connections = c.connections.filter((x) => (x.id || x.name) !== dbKey);
      if (Array.isArray(db.connections))
        db.connections = db.connections.filter(
          (x) => (x.id || x.name) !== cKey
        );
      // Insert cache → db.
      cache.connections = cache.connections || [];
      if (!cache.connections.some((x) => (x.id || x.name) === dbKey))
        cache.connections.push({ id: dbKey, direction: "Outbound" });
      db.connections = db.connections || [];
      if (!db.connections.some((x) => (x.id || x.name) === cacheKey))
        db.connections.push({ id: cacheKey, direction: "Inbound" });
    }
  }
  return resources;
}

export function azureTypeFromResourceId(rid?: string): {
  type: string;
  name: string;
} {
  if (!rid) return { type: "", name: "" };
  const idx = rid.toLowerCase().indexOf("/providers/");
  if (idx < 0) return { type: "", name: "" };
  const segs = rid
    .slice(idx + "/providers/".length)
    .split("/")
    .filter(Boolean);
  if (segs.length < 2) return { type: "", name: "" };
  const ns = segs[0];
  const rest = segs.slice(1);
  const typeParts: string[] = [];
  let name = "";
  for (let i = 0; i < rest.length; i += 2) {
    typeParts.push(rest[i]);
    if (rest[i + 1] !== undefined) name = rest[i + 1];
  }
  return { type: ns + "/" + typeParts.join("/"), name };
}

export function reduceActivityLog(text?: string | null): ActivityEntry[] {
  if (!text) return [];
  const rank: Record<Exclude<DeployStatus, "pending">, number> = {
    in_progress: 1,
    success: 2,
    failed: 3
  };
  const map = new Map<string, ActivityEntry>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|");
    if (parts.length < 2) continue;
    const sRaw = (parts[0] || "").toLowerCase();
    const rid = parts[1] || "";
    const op = parts[2] || "";
    if (!rid) continue;
    let status: Exclude<DeployStatus, "pending"> = "in_progress";
    if (/succeed|resolv/.test(sRaw)) status = "success";
    else if (/fail|error|cancel|denied/.test(sRaw)) status = "failed";
    const { type, name } = azureTypeFromResourceId(rid);
    if (!type) continue;
    const prev = map.get(rid);
    if (!prev || rank[status] >= rank[prev.status])
      map.set(rid, { status, rid, op, type, name });
  }
  return [...map.values()];
}

export function applyActivityToResources(
  entries: ActivityEntry[],
  resources: DeployedResource[],
  provider: string,
  state: CanvasState
): string[] {
  const rank: Record<DeployStatus, number> = {
    pending: 0,
    in_progress: 1,
    success: 2,
    failed: 3
  };
  const changes: string[] = [];
  for (const e of entries) {
    const etype = e.type.toLowerCase();
    for (const r of resources) {
      if (!Array.isArray(r.outputResources)) continue;
      for (const o of r.outputResources) {
        if (!o.type) continue;
        const otype = o.type.toLowerCase();
        // Match exact type or activity type ending with the output type
        // (handles namespace/casing differences and nested types).
        if (
          etype === otype ||
          etype.endsWith("/" + otype) ||
          otype.endsWith(etype) ||
          etype.includes(otype)
        ) {
          const cur = o.deployStatus || "pending";
          // Never downgrade away from a terminal failure.
          if (cur === "failed" && e.status !== "failed") continue;
          if (
            rank[e.status] > rank[cur] ||
            (e.status === "failed" && cur !== "failed")
          ) {
            o.deployStatus = e.status;
            if (e.rid && !o.id) o.id = e.rid;
            if (e.status === "success") {
              const portalUrlKey =
                provider === "azure" ?
                  o.id || e.rid || o.type || o.displayType || ""
                : o.type || o.displayType || o.id || e.rid || "";
              o.portalUrl = generatePortalUrl(portalUrlKey, provider, state);
            }
            changes.push(
              (e.status === "failed" ? "✗"
              : e.status === "success" ? "✓"
              : "▷") +
                " " +
                (o.displayType || o.type) +
                (e.name ? ' "' + e.name + '"' : "") +
                " — " +
                e.status
            );
          }
        }
      }
    }
  }
  // Roll parent status up from its outputs (don't clobber a parent failure).
  for (const r of resources) {
    if (!Array.isArray(r.outputResources) || r.outputResources.length === 0)
      continue;
    const states = r.outputResources.map((o) => o.deployStatus || "pending");
    let parent: DeployStatus = "pending";
    if (states.some((s) => s === "failed")) parent = "failed";
    else if (states.every((s) => s === "success")) parent = "success";
    else if (states.some((s) => s === "in_progress" || s === "success"))
      parent = "in_progress";
    if (r.deployStatus === "failed" && parent !== "failed") continue;
    r.deployStatus = parent;
  }
  return changes;
}

export function extractErrorLines(logText?: string | null, max = 12): string[] {
  if (!logText) return [];
  const out: string[] = [];
  const re =
    /\b(error|errors|failed|failure|fatal|denied|unauthorized|forbidden|not\s+found|cannot|unable|panic|exception|invalid|timed?\s*out)\b/i;
  for (const raw of logText.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (re.test(line)) out.push(line.trim());
  }
  return out.slice(-max);
}

export function extractGitHubActionsStepLog(
  logText: string | null | undefined,
  stepName: string
): string {
  if (!logText || !stepName) return "";
  const lines = logText.split(/\r?\n/);
  const exact = lines.filter((line) => {
    const fields = line.split("\t");
    return fields.length >= 3 && fields[1] === stepName;
  });
  if (exact.length > 0) return exact.join("\n");

  // `gh run view --log` can label every row UNKNOWN STEP even though the jobs
  // API reports real step names. In that format action boundaries survive as
  // runner group markers. Recognize the Azure Login action itself, then retain
  // its group and the adjacent ungrouped CLI-login output until the next group.
  if (stepName !== "Azure Login (OIDC)") return "";
  const out: string[] = [];
  let capturing = false;
  let groupEnded = false;
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length < 3 || fields[1] !== "UNKNOWN STEP") continue;
    const message = fields.slice(2).join("\t");
    if (/##\[group\]Run azure\/login@/i.test(message)) {
      capturing = true;
      groupEnded = false;
    } else if (capturing && groupEnded && /##\[group\]/.test(message)) {
      break;
    }
    if (capturing) {
      out.push(line);
      if (/##\[endgroup\]/.test(message)) groupEnded = true;
    }
  }
  return out.join("\n");
}

// Detects the Entra "enterprise claim" rejection (AADSTS7002381) that GitHub
// Actions OIDC hits when a repo is NOT owned by an org in a GitHub Enterprise.
// Tenant-agnostic: the accepted enterprise values and the actual value are parsed
// out of the error text itself, so this works for any tenant policy, not just
// Microsoft's. Returns a friendly multi-line explanation, or '' if not applicable.
export function explainOidcEnterpriseClaim(logText?: string | null): string {
  if (!logText) return "";
  if (
    !/AADSTS7002381/.test(logText) &&
    !/must contain the enterprise claim/i.test(logText)
  )
    return "";
  // Parse: "...enterprise claim with value 'a', 'b' or 'c' but actual value is 'x'..."
  let accepted: string[] = [];
  let actual: string | null = null;
  const m =
    /enterprise claim with value\s+(.+?)\s+but actual value is\s+'([^']*)'/i.exec(
      logText
    );
  if (m) {
    accepted = (m[1].match(/'([^']*)'/g) || []).map((s) => s.replace(/'/g, ""));
    actual = m[2];
  }
  const acceptedLabel =
    accepted.length ?
      accepted.join(", ")
    : "a value required by the target Azure tenant";
  let leadLine: string, actualLabel: string;
  if (actual === "") {
    // Claim present in the issuer config but empty — the classic personal-repo case.
    leadLine =
      'Azure Login (OIDC) was rejected because this repository\u2019s GitHub OIDC token is missing the required "enterprise" claim.';
    actualLabel = "empty (this repository is not part of a GitHub Enterprise)";
  } else if (actual) {
    // Claim present but not one the tenant trusts.
    leadLine =
      'Azure Login (OIDC) was rejected because this repository\u2019s GitHub "enterprise" OIDC claim ("' +
      actual +
      '") is not trusted by the target Azure tenant.';
    actualLabel = '"' + actual + '"';
  } else {
    // Could not parse the actual value from the error text.
    leadLine =
      'Azure Login (OIDC) was rejected by the target Azure tenant over the GitHub OIDC "enterprise" claim.';
    actualLabel = "not reported";
  }
  return [
    leadLine,
    "The target Azure tenant only trusts GitHub Actions tokens whose enterprise claim is one of: " +
      acceptedLabel +
      " (actual: " +
      actualLabel +
      ").",
    "GitHub only includes the enterprise claim for repositories owned by an organization that belongs to a GitHub Enterprise \u2014 personal-account repositories cannot satisfy this policy.",
    "Fix: host this repository under an organization that is part of one of the accepted GitHub Enterprises (" +
      acceptedLabel +
      "), then re-run Create Environment so the federated credential is recreated for the new owner/repo."
  ].join("\n");
}

// Given the outcome of reading `gh api repos/{repo}` plus the acting gh login,
// return a clear, actionable error string, or '' when the account can read the
// repo AND has admin. Pure — no I/O, never throws. Catches the two bare-404
// failure modes GitHub returns for auth/permission problems during environment
// setup: (1) the wrong gh account is active (repo invisible → read 404), and
// (2) the account can read the repo but lacks the admin needed to create a
// deployment environment (PUT /repos/{repo}/environments → 404).
export function explainRepoAccessForEnvSetup({
  repo,
  login,
  readFailed,
  permissions
}: RepoAccessInput = {}): string {
  const who = login || "the active gh account";
  if (readFailed) {
    return (
      'Can\u2019t read repository "' +
      repo +
      '" as GitHub account "' +
      who +
      '". ' +
      "Either this account lacks access, or the wrong account is active (for example a personal account instead of your enterprise one). " +
      "Switch accounts with: gh auth switch --user <account>  (or sign in the account that has access), then retry. " +
      "Note: gh auth switch changes your machine\u2019s active GitHub account for every tool in this terminal until you switch back."
    );
  }
  if (permissions && permissions.admin === true) return "";
  // Read OK but not admin — report the current best role so the user knows
  // exactly what they have and what to ask for. When none of the role flags is
  // truthy (e.g. jq emitted `{admin:null,...}`) we don't actually know the
  // role, so we avoid claiming a specific "no direct access".
  let role = "";
  if (permissions) {
    if (permissions.maintain) role = "Maintain";
    else if (permissions.push) role = "Write";
    else if (permissions.triage) role = "Triage";
    else if (permissions.pull) role = "Read";
  }
  const account = login || "you";
  const haveClause =
    role ?
      'account "' + account + '" currently has ' + role + " access"
    : 'account "' +
      account +
      '" does not have Admin access (its exact role could not be determined)';
  return (
    'Environment setup needs Admin permission on "' +
    repo +
    '", but ' +
    haveClause +
    ". " +
    "Ask a repository or organization admin to grant you Admin (repo Settings \u2192 Collaborators and teams), then retry."
  );
}

// True when a gh error text indicates the repo/API path was Not Found (HTTP 404) —
// the signal that the active account can't see the repo. Pure, never throws.
//
// The bare `not found` alternate is INTENTIONAL, not an oversight: gh surfaces
// this condition with variable wording (e.g. "gh: Not Found (HTTP 404)" but also
// plain "the repository was not found"), and both must match. The match is
// deliberately allowed to be broad because the sole caller (server.ts, the repo
// preflight) is fail-open — a match only flips an advisory `readFailed` flag and
// GitHub still enforces real permissions server-side — so a false positive here
// costs nothing while a false negative would misdirect the preflight. Narrowing
// to `HTTP 404` only would drop the tested bare-phrase case (deploy.test.ts).
export function isRepoNotFoundError(errText?: string | null): boolean {
  if (!errText) return false;
  return /\bHTTP 404\b/i.test(errText) || /\bnot found\b/i.test(errText);
}

export function extractRadDeployError(
  logText?: string | null,
  maxChars = 4000
): string {
  if (!logText) return "";
  // Strip the "job\tstep\ttimestamp " prefix `gh run view --log` adds, if present,
  // so the structured block is detectable regardless of the log source.
  const lines = logText.split(/\r?\n/).map((raw) => {
    let l = raw.replace(/\s+$/, "");
    // gh run log prefix: tabs separate job/step, then "<ISO timestamp> <text>".
    const m = l.match(/^[^\t]*\t[^\t]*\t\S+\s(.*)$/);
    if (m) l = m[1];
    return l;
  });
  // Find the LAST structured rad error block ("Error: {").
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*Error:\s*\{/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start >= 0) {
    const block = [];
    for (let i = start; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*Error:\s*Process completed/.test(l)) break; // GitHub Actions wrapper line
      block.push(l);
      if (/^\s*TraceId:/.test(l)) break; // end of the rad error
    }
    const out = block.join("\n").trim();
    if (out) return out.slice(0, maxChars);
  }
  // Fallback: collect trailing error-ish lines.
  return extractErrorLines(lines.join("\n"), 20).join("\n").slice(0, maxChars);
}

export function parseResourceProgress(
  logText: string | null | undefined,
  resources: ReadonlyArray<{ name?: string }>
): Record<string, DeployStatus> {
  const result: Record<string, DeployStatus> = {};
  if (!logText) return result;
  const names = resources
    .map((r) => r.name)
    .filter((name): name is string => Boolean(name));
  const lines = logText.split(/\r?\n/);
  for (const line of lines) {
    const lower = line.toLowerCase();
    const isFail = /\b(failed|failure|error|errored)\b/.test(lower);
    const isDone =
      /\b(succeeded|completed|complete|created|provisioned|creation complete)\b/.test(
        lower
      );
    const isStart =
      /\b(creating|provisioning|processing|started|deploying|updating|accepted|in progress|inprogress|postponed|waiting|apply(ing)?)\b/.test(
        lower
      );
    if (!isFail && !isDone && !isStart) continue;
    for (const name of names) {
      const re = new RegExp(
        "(^|[^A-Za-z0-9_-])" +
          name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "([^A-Za-z0-9_-]|$)"
      );
      if (!re.test(line)) continue;
      if (isFail) result[name] = "failed";
      else if (isDone) {
        if (result[name] !== "failed") result[name] = "success";
      } else if (isStart) {
        if (!result[name]) result[name] = "in_progress";
      }
    }
  }
  return result;
}

export function parseRadDeployLog(
  logText: string | null | undefined,
  resources: ReadonlyArray<{ name?: string }>,
  opts: { stripPrefix?: boolean } = {}
): Record<string, DeployStatus> {
  const stripPrefix = opts.stripPrefix !== false;
  const result: Record<string, DeployStatus> = {};
  if (!logText) return result;
  const names = resources
    .map((r) => r.name)
    .filter((name): name is string => Boolean(name));
  const lines = logText.split(/\r?\n/);
  for (const raw of lines) {
    const line = stripPrefix ? raw.replace(/^\S+\s+\S+\s+/, "") : raw; // strip GH "job\tstep\t" prefix
    const lower = line.toLowerCase();
    const isDone = /\bcompleted\b/.test(lower) || /\bsucceeded\b/.test(lower);
    const isFail = /\bfailed\b/.test(lower) || /\berror\b/.test(lower);
    if (!isDone && !isFail) continue;
    for (const name of names) {
      // Match the resource name as a whole word in the status line
      const re = new RegExp(
        "(^|[^A-Za-z0-9_-])" +
          name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "([^A-Za-z0-9_-]|$)"
      );
      if (re.test(line)) {
        if (isFail) result[name] = "failed";
        else if (!result[name]) result[name] = "success";
      }
    }
  }
  return result;
}
