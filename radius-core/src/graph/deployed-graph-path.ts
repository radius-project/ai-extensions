// Addressing helper for the durable deployed-application-graph artifact.
//
// After a successful `rad deploy` the workflow captures the concrete deployed
// graph with `rad app graph -a "$APP" --preview --include-icons` and publishes
// it to the `radius-graph` orphan branch on the app repo, keyed by the tuple
// (sourceBranch, scope, env). Each (sourceBranch, scope, env) has exactly one
// current graph — a redeploy overwrites the same path. Structured live
// snapshots produced by the same command during a deploy live on
// `radius-deploy-status` and are addressed by LIVE_GRAPH_FILE below.
//
// This module is pure path math — no I/O — so it's usable from both the
// canvas HTTP reader (adapters/canvas/src/deploy.mjs) and the workflow-side
// publisher (in radius-project/radius). Keeping the layout in one place is
// what lets the reader and writer stay in sync without a shared runtime dep.

/** Orphan branch that stores the durable per-deployment graph artifacts. */
export const RADIUS_GRAPH_BRANCH = "radius-graph";

/** Orphan branch used for streaming deploy signal (logs + live snapshot). */
export const RADIUS_DEPLOY_STATUS_BRANCH = "radius-deploy-status";

/**
 * Repository-root file on `radius-deploy-status` where the deploy workflow
 * publishes structured `rad app graph --preview` snapshots on a loop while
 * `rad deploy` runs. Read priority is durable → live → legacy → scaffold.
 */
export const LIVE_GRAPH_FILE = "deploy-graph-live.json";

/**
 * Legacy single-file location the older deploy workflow force-pushed the
 * final graph to. Kept as a fallback so the reader keeps working against
 * repos that haven't migrated to the per-(branch, scope, env) layout yet.
 */
export const LEGACY_DEPLOY_GRAPH_FILE = "deploy-graph.json";

/**
 * Radius resource-group scope every deploy currently lands in. Matches
 * `rad deploy`'s default group and the `MODELED_GRAPH_DEFAULTS.resourceGroup`
 * constant used to synthesize modeled resource IDs. Threaded as a constant
 * so both sides of the (reader, writer) contract stay in sync; can be lifted
 * to a per-deployment value later without changing the addressing shape.
 */
export const DEFAULT_RADIUS_SCOPE = "default";

/** Inputs to {@link deployedGraphPath}. */
export interface DeployedGraphKey {
  /** Repo branch whose `.radius/app.bicep` was deployed. */
  sourceBranch: string;
  /** Radius resource-group (scope) the app was deployed into. */
  scope: string;
  /** GitHub environment name the deploy targeted. */
  environment: string;
}

// Restrict a single path segment (scope, env) to characters that are safe as
// one filesystem-level directory name on `radius-graph`. Anything else is
// lowercased and coalesced to '-'; leading/trailing '-' are stripped. This
// keeps `feature/x` from smuggling extra path levels through {scope} or {env}
// (source branch is a separate, structured prefix — see below).
function slugSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Normalize a git ref for use as the top-level directory prefix. Branch names
// legitimately contain '/', so we preserve internal '/'-separated segments
// while forbidding '..', empty segments (which produce '//' in the URL), and
// backslashes. Casing is preserved because git refs are case-sensitive.
function normalizeSourceBranch(sourceBranch: string): string {
  const raw = sourceBranch.trim();
  if (!raw) {
    throw new Error("sourceBranch is required to address a deployed graph.");
  }
  if (raw.includes("\\") || raw.startsWith("/") || raw.endsWith("/")) {
    throw new Error(`Invalid sourceBranch "${sourceBranch}".`);
  }
  const segments = raw.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Invalid sourceBranch "${sourceBranch}".`);
    }
  }
  return segments.join("/");
}

/**
 * Return the repo-relative path (on the `radius-graph` orphan branch) of the
 * durable deployed application graph for one (sourceBranch, scope, env)
 * deployment.
 *
 * Layout: `<sourceBranch>/.radius/deployments/<scope>-<env>/app-graph.json`.
 * `sourceBranch` preserves its `/`-separated identity (a `feature/x` branch
 * stays `feature/x/...`) so the top of the tree tells you which branch each
 * artifact came from. `scope` and `env` are slugged and joined into a single
 * directory so a valid tuple always yields exactly one legal file path.
 */
export function deployedGraphPath(key: DeployedGraphKey): string {
  const branch = normalizeSourceBranch(key.sourceBranch);
  const scope = slugSegment(key.scope);
  const environment = slugSegment(key.environment);
  if (!scope) {
    throw new Error("scope must contain at least one alphanumeric character.");
  }
  if (!environment) {
    throw new Error(
      "environment must contain at least one alphanumeric character.",
    );
  }
  return `${branch}/.radius/deployments/${scope}-${environment}/app-graph.json`;
}
