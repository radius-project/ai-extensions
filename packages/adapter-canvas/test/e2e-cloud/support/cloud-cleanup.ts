interface CleanupDirectoryObject {
  readonly id: string;
}

interface CleanupPullRequest {
  readonly number: number;
  readonly headRef: string;
}

interface CleanupApplication {
  readonly id: string;
  readonly appId: string;
}

interface CleanupServicePrincipal {
  readonly id: string;
  readonly appId: string;
}

interface CleanupResourceGroup {
  readonly name: string;
  readonly runId: string;
}

export interface CleanupRoleAssignment {
  readonly id: string;
  readonly roleDefinitionName: string;
  readonly scope: string;
}

export interface ExpectedRoleAssignment {
  readonly roleDefinitionName: string;
  readonly scope: string;
}

const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?Z$/;
const GENERATED_FALLBACK_BRANCH_PATTERN =
  /^radius\/setup-[a-z0-9][a-z0-9-]*-workflows-\d+$/;
const RADIUS_MANAGED_APP_TAG = "radius-managed";
const RADIUS_REPO_APP_TAG_PREFIX = "radius-repo:";
const RADIUS_ENVIRONMENT_APP_TAG_PREFIX = "radius-environment:";
const RADIUS_ENVIRONMENT_LABEL = "radapp.io/environment";
const RADIUS_APPLICATION_LABEL = "radapp.io/application";
// `radius-system` holds the control plane this suite installs, so an object
// mislabelled into it must be refused rather than reclaimed.
const SYSTEM_NAMESPACES = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "radius-system"
]);
// The writer appends the environment slug and twelve hex characters of the
// environment identity, so a package sharing only the prefix is not state.
const STATE_PACKAGE_SUFFIX = /^[a-z0-9-]+-[0-9a-f]{12}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : null;
}

function requireArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value))
    throw new Error(`${context} did not return a JSON array.`);
  return value;
}

function requireCutoff(cutoff: string): number {
  const milliseconds = parseInstant(cutoff);
  if (milliseconds === null)
    throw new Error(`Cleanup cutoff "${cutoff}" is not a valid UTC timestamp.`);
  return milliseconds;
}

function parseInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond = "0"] = match;
  const millisecondValue = Number(millisecond.padEnd(3, "0").slice(0, 3));
  const milliseconds = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    millisecondValue
  );
  const parsed = new Date(milliseconds);
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() !== Number(month) - 1 ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second) ||
    parsed.getUTCMilliseconds() !== millisecondValue
  )
    return null;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function requireString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hasRadiusAppProvenance(
  value: unknown,
  repository: string,
  environmentPrefix: string
): boolean {
  if (!Array.isArray(value)) return false;
  const tags = value.filter((tag): tag is string => typeof tag === "string");
  return (
    tags.includes(RADIUS_MANAGED_APP_TAG) &&
    tags.includes(`${RADIUS_REPO_APP_TAG_PREFIX}${repository}`) &&
    tags.some((tag) =>
      tag.startsWith(`${RADIUS_ENVIRONMENT_APP_TAG_PREFIX}${environmentPrefix}`)
    )
  );
}

function generatedFallbackBranch(value: string, prefix: string): boolean {
  return (
    value.startsWith(prefix) && GENERATED_FALLBACK_BRANCH_PATTERN.test(value)
  );
}

export function selectOpenPullRequestHeadRefs(
  payload: unknown,
  fixtureRepository: string
): string[] {
  const refs = new Set<string>();
  for (const entry of flattenPages(payload, "GitHub pull requests")) {
    const item = asRecord(entry);
    const head = asRecord(item?.head);
    const repo = asRecord(head?.repo);
    const ref = requireString(head?.ref);
    if (repo?.full_name === fixtureRepository && ref) refs.add(ref);
  }
  return [...refs];
}

function expired(value: unknown, cutoff: number): boolean {
  const milliseconds = parseInstant(value);
  return milliseconds !== null && milliseconds < cutoff;
}

function flattenPages(payload: unknown, context: string): unknown[] {
  return requireArray(payload, context).flatMap((page) =>
    Array.isArray(page) ? page : [page]
  );
}

export function selectExpiredDirectoryObjects(
  payload: unknown,
  displayName: string,
  cutoff: string
): CleanupDirectoryObject[] {
  const cutoffMilliseconds = requireCutoff(cutoff);
  const candidates: CleanupDirectoryObject[] = [];
  for (const entry of requireArray(payload, "Microsoft Graph")) {
    const item = asRecord(entry);
    if (
      item?.displayName === displayName &&
      typeof item.id === "string" &&
      item.id !== "" &&
      expired(item.createdDateTime, cutoffMilliseconds)
    )
      candidates.push({ id: item.id });
  }
  return candidates;
}

export function selectExpiredApplications(
  payload: unknown,
  displayName: string,
  repository: string,
  environmentPrefix: string,
  cutoff: string
): CleanupApplication[] {
  const cutoffMilliseconds = requireCutoff(cutoff);
  const applications: CleanupApplication[] = [];
  for (const entry of requireArray(payload, "Microsoft Graph applications")) {
    const item = asRecord(entry);
    if (
      item?.displayName === displayName &&
      typeof item.id === "string" &&
      item.id !== "" &&
      typeof item.appId === "string" &&
      item.appId !== "" &&
      hasRadiusAppProvenance(item.tags, repository, environmentPrefix) &&
      expired(item.createdDateTime, cutoffMilliseconds)
    )
      applications.push({ id: item.id, appId: item.appId });
  }
  return applications;
}

export function selectExpiredServicePrincipals(
  payload: unknown,
  displayName: string,
  applicationAppIds: readonly string[],
  cutoff: string
): CleanupServicePrincipal[] {
  const cutoffMilliseconds = requireCutoff(cutoff);
  const allowedAppIds = new Set(applicationAppIds);
  const principals: CleanupServicePrincipal[] = [];
  for (const entry of requireArray(
    payload,
    "Microsoft Graph service principals"
  )) {
    const item = asRecord(entry);
    if (
      item?.displayName === displayName &&
      typeof item.id === "string" &&
      item.id !== "" &&
      typeof item.appId === "string" &&
      allowedAppIds.has(item.appId) &&
      expired(item.createdDateTime, cutoffMilliseconds)
    )
      principals.push({ id: item.id, appId: item.appId });
  }
  return principals;
}

/**
 * The appIds whose application must not be deleted because a matching service
 * principal was never selected for deletion.
 *
 * `selectExpiredServicePrincipals` deliberately excludes a principal whose own
 * creation time is newer than the cutoff or was not returned by Graph. Deleting
 * the parent application anyway cascade-deletes that principal, which strands
 * its role assignments with no object left to match them against. Fail closed
 * on the raw inventory rather than on the selection.
 */
export function selectAppIdsWithUnprocessedServicePrincipals(
  payload: unknown,
  displayName: string,
  applicationAppIds: readonly string[],
  selectedPrincipals: readonly CleanupServicePrincipal[]
): string[] {
  const candidateAppIds = new Set(applicationAppIds);
  const selectedIds = new Set(selectedPrincipals.map((entry) => entry.id));
  const blocked = new Set<string>();
  for (const entry of requireArray(
    payload,
    "Microsoft Graph service principals"
  )) {
    const item = asRecord(entry);
    if (
      item?.displayName === displayName &&
      typeof item.id === "string" &&
      item.id !== "" &&
      typeof item.appId === "string" &&
      candidateAppIds.has(item.appId) &&
      !selectedIds.has(item.id)
    )
      blocked.add(item.appId);
  }
  return [...blocked];
}

export function selectExpiredEnvironments(
  payload: unknown,
  prefix: string,
  cutoff: string
): string[] {
  const cutoffMilliseconds = requireCutoff(cutoff);
  const names: string[] = [];
  for (const page of requireArray(payload, "GitHub Environments")) {
    const environments = asRecord(page)?.environments;
    if (!Array.isArray(environments))
      throw new Error(
        "GitHub Environments page did not include an environments array."
      );
    for (const entry of environments) {
      const item = asRecord(entry);
      if (
        typeof item?.name === "string" &&
        item.name.startsWith(prefix) &&
        expired(item.created_at, cutoffMilliseconds)
      )
        names.push(item.name);
    }
  }
  return names;
}

export function selectTestResourceGroups(
  payload: unknown,
  prefix: string,
  excludedResourceGroup?: string
): CleanupResourceGroup[] {
  const excluded = excludedResourceGroup?.trim().toLowerCase();
  const groups: CleanupResourceGroup[] = [];
  for (const entry of requireArray(payload, "Azure resource groups")) {
    const item = asRecord(entry);
    const tags = asRecord(item?.tags);
    const runId = requireString(tags?.["github-run-id"]);
    if (
      typeof item?.name === "string" &&
      item.name.startsWith(prefix) &&
      item.name.toLowerCase() !== excluded &&
      tags?.["radius-canvas-e2e"] === "true" &&
      /^\d+$/.test(runId)
    )
      groups.push({ name: item.name, runId });
  }
  return groups;
}

export function selectExpectedRoleAssignments(
  payload: unknown,
  principalId: string,
  expected: readonly ExpectedRoleAssignment[]
): CleanupRoleAssignment[] {
  const normalizedPrincipalId = principalId.trim().toLowerCase();
  if (!normalizedPrincipalId)
    throw new Error("A service-principal id is required for RBAC cleanup.");
  const expectedKeys = new Set(
    expected.map(
      (assignment) =>
        `${assignment.scope.toLowerCase()}\n${assignment.roleDefinitionName.toLowerCase()}`
    )
  );
  const assignments: CleanupRoleAssignment[] = [];
  for (const [index, entry] of requireArray(
    payload,
    "Azure role assignments"
  ).entries()) {
    const item = asRecord(entry);
    if (
      requireString(item?.principalId).toLowerCase() !== normalizedPrincipalId
    )
      continue;
    const assignment = {
      id: requireString(item?.id),
      roleDefinitionName: requireString(item?.roleDefinitionName),
      scope: requireString(item?.scope)
    };
    if (!assignment.id || !assignment.roleDefinitionName || !assignment.scope)
      throw new Error(
        `Azure role assignment ${index} did not include id, roleDefinitionName, and scope.`
      );
    const key = `${assignment.scope.toLowerCase()}\n${assignment.roleDefinitionName.toLowerCase()}`;
    if (!expectedKeys.has(key))
      throw new Error(
        `Refusing to delete unexpected role assignment "${assignment.roleDefinitionName}" at ${assignment.scope} for principal ${principalId}.`
      );
    assignments.push(assignment);
  }
  return assignments;
}

export function selectExpiredFallbackPullRequests(
  payload: unknown,
  branchPrefix: string,
  fixtureRepository: string,
  defaultBranch: string,
  cutoff: string
): CleanupPullRequest[] {
  const cutoffMilliseconds = requireCutoff(cutoff);
  const pulls: CleanupPullRequest[] = [];
  for (const entry of flattenPages(payload, "GitHub pull requests")) {
    const item = asRecord(entry);
    const head = asRecord(item?.head);
    const headRepo = asRecord(head?.repo);
    const base = asRecord(item?.base);
    const baseRepo = asRecord(base?.repo);
    const headRef = requireString(head?.ref);
    if (
      typeof item?.number === "number" &&
      Number.isInteger(item.number) &&
      item.number > 0 &&
      generatedFallbackBranch(headRef, branchPrefix) &&
      headRepo?.full_name === fixtureRepository &&
      baseRepo?.full_name === fixtureRepository &&
      base?.ref === defaultBranch &&
      expired(item.created_at, cutoffMilliseconds)
    )
      pulls.push({ number: item.number, headRef });
  }
  return pulls;
}

export function selectExpiredFallbackBranches(
  payload: unknown,
  branchPrefix: string,
  cutoff: string,
  protectedHeadRefs: readonly string[] = []
): string[] {
  const cutoffMilliseconds = requireCutoff(cutoff);
  const protectedRefs = new Set(protectedHeadRefs);
  const branches: string[] = [];
  for (const entry of flattenPages(payload, "GitHub fallback branches")) {
    const item = asRecord(entry);
    const ref =
      typeof item?.ref === "string" ?
        item.ref.replace(/^refs\/heads\//, "")
      : "";
    if (
      generatedFallbackBranch(ref, branchPrefix) &&
      !protectedRefs.has(ref) &&
      expired(item?.created_at, cutoffMilliseconds)
    )
      branches.push(ref);
  }
  return branches;
}

/**
 * GHCR state packages that no live environment can account for.
 *
 * Every other state sweep walks the fixture's GitHub Environments and derives
 * the package name from each one, so it can only ever see state whose
 * environment still exists. A journey deletes its environment during teardown
 * and can then fail before deleting the package, which leaves state that no
 * environment-driven sweep will ever reach again. Selecting by name closes that
 * gap.
 *
 * `livePackageNames` is the set derived from environments that are still
 * present and still inside the age threshold, so a package belonging to a run
 * that is mid-flight is never a candidate. A package with no readable
 * `updated_at` is skipped rather than deleted: an unparseable timestamp must
 * fail towards keeping data.
 */
export function selectOrphanedStatePackages(
  payload: unknown,
  prefix: string,
  livePackageNames: readonly string[],
  cutoff: string
): string[] {
  if (!prefix.trim())
    throw new Error(
      "A state package prefix is required to select orphaned packages."
    );
  const cutoffMilliseconds = requireCutoff(cutoff);
  const live = new Set(livePackageNames);
  const names: string[] = [];
  for (const entry of flattenPages(payload, "GHCR packages")) {
    const item = asRecord(entry);
    const name = requireString(item?.name);
    if (
      name.startsWith(prefix) &&
      STATE_PACKAGE_SUFFIX.test(name.slice(prefix.length)) &&
      !live.has(name) &&
      expired(item?.updated_at, cutoffMilliseconds)
    )
      names.push(name);
  }
  return names;
}

export interface LeakedClusterWorkload {
  readonly kind: string;
  readonly name: string;
  readonly namespace: string;
  readonly environment: string;
}

/**
 * Radius-rendered objects on the shared cluster whose environment is gone.
 *
 * Deleting the Radius application is meant to remove these, and when that
 * fails, nothing else does: no sweep reads the cluster, so a rendered workload
 * outlives its run indefinitely and keeps consuming shared capacity. Worse, a
 * later run rendering the same application reuses the same object, so a single
 * leak silently absorbs every subsequent run instead of showing up as a new
 * one.
 *
 * Selection is by the environment label rather than by age. A reused object
 * carries the label of the most recent run to render it, so an object whose
 * environment is still live belongs to work that may still be in flight, while
 * an object naming an environment that no longer exists cannot belong to
 * anyone. The fixture application must be named exactly as well: the sweep is
 * only entitled to the workloads this suite renders, and a stale environment
 * label alone does not make someone else's object ours. System namespaces are
 * refused outright; nothing this suite creates belongs in one, so a match there
 * means the label is being misread.
 */
export function selectLeakedClusterWorkloads(
  payload: unknown,
  environmentPrefix: string,
  application: string,
  liveEnvironments: readonly string[]
): LeakedClusterWorkload[] {
  if (!environmentPrefix.trim())
    throw new Error(
      "An environment prefix is required to select leaked cluster workloads."
    );
  if (!application.trim())
    throw new Error(
      "An application name is required to select leaked cluster workloads."
    );
  const live = new Set(liveEnvironments);
  const items = asRecord(payload)?.items;
  const leaked: LeakedClusterWorkload[] = [];
  for (const entry of requireArray(items, "Kubernetes objects")) {
    const item = asRecord(entry);
    const metadata = asRecord(item?.metadata);
    const labels = asRecord(metadata?.labels);
    const environment = requireString(labels?.[RADIUS_ENVIRONMENT_LABEL]);
    if (!environment.startsWith(environmentPrefix) || live.has(environment))
      continue;
    if (requireString(labels?.[RADIUS_APPLICATION_LABEL]) !== application)
      continue;

    const kind = requireString(item?.kind);
    const name = requireString(metadata?.name);
    const namespace = requireString(metadata?.namespace);
    if (!kind || !name || !namespace)
      throw new Error(
        `Kubernetes object labelled for environment "${environment}" is missing a kind, name or namespace.`
      );
    if (SYSTEM_NAMESPACES.has(namespace))
      throw new Error(
        `Refusing to reclaim ${kind} "${name}" from system namespace "${namespace}".`
      );
    leaked.push({ kind, name, namespace, environment });
  }
  return leaked;
}
