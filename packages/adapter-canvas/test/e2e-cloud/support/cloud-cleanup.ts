interface CleanupDirectoryObject {
  readonly id: string;
}

interface CleanupPullRequest {
  readonly number: number;
  readonly headRef: string;
}

interface CleanupResourceGroup {
  readonly name: string;
}

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value))
    return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function expired(value: unknown, cutoff: number): boolean {
  const milliseconds = parseInstant(value);
  return milliseconds !== null && milliseconds < cutoff;
}

function expiredEpochSeconds(value: unknown, cutoff: number): boolean {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const milliseconds = Number(value) * 1_000;
  return Number.isFinite(milliseconds) && milliseconds < cutoff;
}

function flattenPages(payload: unknown, context: string): unknown[] {
  return requireArray(payload, context).flatMap((page) =>
    Array.isArray(page) ? page : [page],
  );
}

export function selectExpiredDirectoryObjects(
  payload: unknown,
  displayName: string,
  cutoff: string,
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

export function selectExpiredEnvironments(
  payload: unknown,
  prefix: string,
  cutoff: string,
): string[] {
  const cutoffMilliseconds = requireCutoff(cutoff);
  const names: string[] = [];
  for (const page of requireArray(payload, "GitHub Environments")) {
    const environments = asRecord(page)?.environments;
    if (!Array.isArray(environments)) continue;
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

export function selectExpiredResourceGroups(
  payload: unknown,
  prefix: string,
  cutoff: string,
): CleanupResourceGroup[] {
  const cutoffMilliseconds = requireCutoff(cutoff);
  const groups: CleanupResourceGroup[] = [];
  for (const entry of requireArray(payload, "Azure resource groups")) {
    const item = asRecord(entry);
    const tags = asRecord(item?.tags);
    if (
      typeof item?.name === "string" &&
      item.name.startsWith(prefix) &&
      tags?.["radius-canvas-e2e"] === "true" &&
      expiredEpochSeconds(tags.creationTime, cutoffMilliseconds)
    )
      groups.push({ name: item.name });
  }
  return groups;
}

export function selectExpiredFallbackPullRequests(
  payload: unknown,
  branchPrefix: string,
  cutoff: string,
): CleanupPullRequest[] {
  const cutoffMilliseconds = requireCutoff(cutoff);
  const pulls: CleanupPullRequest[] = [];
  for (const entry of flattenPages(payload, "GitHub pull requests")) {
    const item = asRecord(entry);
    const head = asRecord(item?.head);
    if (
      typeof item?.number === "number" &&
      Number.isInteger(item.number) &&
      item.number > 0 &&
      typeof head?.ref === "string" &&
      head.ref.startsWith(branchPrefix) &&
      expired(item.created_at, cutoffMilliseconds)
    )
      pulls.push({ number: item.number, headRef: head.ref });
  }
  return pulls;
}

export function selectExpiredFallbackBranches(
  payload: unknown,
  branchPrefix: string,
  cutoff: string,
): string[] {
  const cutoffMilliseconds = requireCutoff(cutoff);
  const branches: string[] = [];
  for (const entry of flattenPages(payload, "GitHub fallback branches")) {
    const item = asRecord(entry);
    const ref =
      typeof item?.ref === "string"
        ? item.ref.replace(/^refs\/heads\//, "")
        : "";
    if (
      ref.startsWith(branchPrefix) &&
      expired(item?.created_at, cutoffMilliseconds)
    )
      branches.push(ref);
  }
  return branches;
}
