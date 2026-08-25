import {
  parseEnvironmentListingPage,
  proveAbsentFromListing,
  type ExactResourceRead,
  type ListingReadResult,
  type ResourceAbsenceProof
} from "./resource-absence.js";

// The one proof that a GitHub environment is gone rather than merely invisible.
//
// Two paths ask this — the timed-out delete that has to decide whether its
// request landed, and the journal reconcile that has to settle it after a lost
// answer — and neither may take the environment endpoint's 404 at face value.
// GitHub returns that 404 both for an environment that does not exist and for
// one this token is not allowed to see, and it decides per resource: reading
// the repository, or reading the environment again, proves nothing about the
// Actions environments permission.
//
// So both go through here: enumerate the environments the account can actually
// list, require the target to be missing from all of them, and confirm once
// more against the environment's own endpoint.

/** The page size the environments listing is requested with, and read against. */
export const ENVIRONMENT_PAGE_SIZE = 100;

const ENVIRONMENT_API_PATH =
  /^\/repos\/([^/]+)\/([^/]+)\/environments\/([^/?#]+)$/;

export interface EnvironmentAbsencePorts {
  /** `GET /repos/{repo}/environments`, one page at a time. */
  listEnvironments(page: number): Promise<ListingReadResult>;
  /** `GET /repos/{repo}/environments/{name}`, read once more at the end. */
  readEnvironment(): Promise<ListingReadResult>;
}

/** Whether a `gh api` answer is the 404 that means "no such environment, maybe". */
export function isNotFoundResponse(result: {
  stdout?: string;
  stderr?: string;
}): boolean {
  return /(?:HTTP\s+404|\bNot Found\b)/i.test(
    `${result.stderr || ""}\n${result.stdout || ""}`
  );
}

/** The `/repos/{owner}/{repo}/environments` listing an environment path belongs to. */
export function environmentsApiPath(environmentApiPath: string): string | null {
  const match = ENVIRONMENT_API_PATH.exec(environmentApiPath);
  return match ? `/repos/${match[1]}/${match[2]}/environments` : null;
}

/** The environment an API path names, decoded back to its canonical name. */
export function environmentNameFromApiPath(
  environmentApiPath: string
): string | null {
  const match = ENVIRONMENT_API_PATH.exec(environmentApiPath);
  if (!match) return null;
  try {
    return decodeURIComponent(match[3]);
  } catch {
    // A path Radius cannot decode is one it cannot compare against a listing,
    // so it proves nothing rather than comparing the escaped form.
    return null;
  }
}

/** The `gh api` argv that lists one page of a repository's environments. */
export function environmentListingArgs(
  listingPath: string,
  page: number
): string[] {
  return [
    "api",
    `${listingPath}?per_page=${ENVIRONMENT_PAGE_SIZE}&page=${page}`
  ];
}

function exactEnvironmentRead(
  result: ListingReadResult,
  recordedProviderId?: string | null
): ExactResourceRead {
  if (result.code === 0 || result.code === "0") {
    // A name the customer can reuse says nothing on its own. When the delete
    // targeted a recorded id, the resource answering to that name now is only
    // the one Radius wrote if the id still matches; a different id means the
    // targeted resource is gone and a replacement holds the name.
    if (!recordedProviderId) return "present";
    const liveId = environmentProviderIdFrom(result.stdout);
    if (!liveId) return "unreadable";
    return liveId === recordedProviderId ? "present" : "absent";
  }
  return isNotFoundResponse(result) ? "absent" : "unreadable";
}

/** GitHub's own id for an environment, from a single-environment response. */
export function environmentProviderIdFrom(stdout: string | undefined): string {
  try {
    const parsed: unknown = JSON.parse((stdout || "").trim() || "null");
    if (!parsed || typeof parsed !== "object") return "";
    const body = parsed as { id?: unknown; node_id?: unknown };
    if (typeof body.id === "number" && Number.isFinite(body.id)) {
      return String(body.id);
    }
    if (typeof body.id === "string" && body.id.trim()) return body.id.trim();
    return typeof body.node_id === "string" && body.node_id.trim() ?
        body.node_id.trim()
      : "";
  } catch {
    return "";
  }
}

/** Prove a GitHub environment absent through its listing, or refuse to say. */
export async function proveEnvironmentAbsent(input: {
  repo: string;
  name: string;
  /** The immutable id the delete targeted, when one was recorded. */
  recordedProviderId?: string | null;
  ports: EnvironmentAbsencePorts;
  maxPages?: number;
}): Promise<ResourceAbsenceProof> {
  const proof = await proveAbsentFromListing({
    target: input.name,
    resource: "environment",
    scope: input.repo,
    readPage: (page) => input.ports.listEnvironments(page),
    parsePage: (stdout) =>
      parseEnvironmentListingPage(stdout, ENVIRONMENT_PAGE_SIZE),
    confirmExactAbsence: async () =>
      exactEnvironmentRead(
        await input.ports.readEnvironment(),
        input.recordedProviderId
      ),
    ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages })
  });
  // A listing answers by name, so it reports the name's current holder as
  // present without knowing whether that is the resource the delete targeted.
  // When an id was recorded, the name being taken is not yet an answer: the
  // holder has to be read and its id compared, or a replacement the customer
  // created would be reported as the resource Radius failed to remove.
  if (proof.state !== "present" || !input.recordedProviderId) return proof;
  const holder = await input.ports.readEnvironment();
  const succeeded = holder.code === 0 || holder.code === "0";
  const liveId = succeeded ? environmentProviderIdFrom(holder.stdout) : "";
  // Only a readable holder with a different id proves the targeted resource
  // gone. A refused or 404 read here contradicts the listing that just reported
  // the name present, and a contradiction is not evidence for a deletion.
  if (liveId && liveId !== input.recordedProviderId) {
    return {
      state: "absent",
      evidence: `The environment answering to "${input.name}" carries a different id than the one Radius deleted, so the resource it targeted is gone.`
    };
  }
  if (liveId) return proof;
  return {
    state: "unknown",
    detail: `Radius could not read the id of the environment now answering to "${input.name}", so it cannot tell it from the one it deleted.`
  };
}
