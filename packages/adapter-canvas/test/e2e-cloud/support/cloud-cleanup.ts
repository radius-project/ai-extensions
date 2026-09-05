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
}

interface CleanupResourceGroup {
  readonly name: string;
  readonly runId: string;
}

const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?Z$/;
const GENERATED_FALLBACK_BRANCH_PATTERN =
  /^radius\/setup-[a-z0-9][a-z0-9-]*-workflows-\d+$/;
const RADIUS_MANAGED_APP_TAG = "radius-managed";
const RADIUS_REPO_APP_TAG_PREFIX = "radius-repo:";
const RADIUS_ENVIRONMENT_APP_TAG_PREFIX = "radius-environment:";

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
  const milliseconds = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond.padEnd(3, "0"))
  );
  const parsed = new Date(milliseconds);
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() !== Number(month) - 1 ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second) ||
    parsed.getUTCMilliseconds() !== Number(millisecond.padEnd(3, "0"))
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
      principals.push({ id: item.id });
  }
  return principals;
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
  prefix: string
): CleanupResourceGroup[] {
  const groups: CleanupResourceGroup[] = [];
  for (const entry of requireArray(payload, "Azure resource groups")) {
    const item = asRecord(entry);
    const tags = asRecord(item?.tags);
    const runId = requireString(tags?.["github-run-id"]);
    if (
      typeof item?.name === "string" &&
      item.name.startsWith(prefix) &&
      tags?.["radius-canvas-e2e"] === "true" &&
      /^\d+$/.test(runId)
    )
      groups.push({ name: item.name, runId });
  }
  return groups;
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
