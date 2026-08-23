// Proving a resource is gone rather than merely invisible.
//
// GitHub answers 404 for a resource that does not exist and for one the token
// is not allowed to see, and it makes that decision per resource rather than
// per repository. A token can read repository metadata and still be refused
// refs, or refused the Actions environments API, so "the repository is
// readable" says nothing about whether the 404 in front of us is an absence.
//
// The only answer that separates the two is a successful read in the same
// permission family as the one that returned 404: if the account can list the
// resources of that kind, a listing that does not contain the target is proof
// the target is gone. Anything else — a refused listing, an unreadable body, a
// page that may have been cut short — leaves the outcome unknown, and unknown
// never authorizes a deletion or a claim that one succeeded.

export interface ListingReadResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

/** One page of a listing, as its own parser understood it. */
export interface ListingPage {
  /** The identities on this page, in whatever form the caller compares. */
  names: readonly string[];
  /** Whether another page may still hold the target. */
  hasMore: boolean;
  /**
   * The count GitHub says the whole listing holds, when it reports one. A
   * listing that ends before reaching it was truncated somewhere, so its
   * silence about the target is not evidence.
   */
  totalCount?: number | null;
}

export type ResourceAbsenceProof =
  | { state: "absent"; evidence: string }
  | { state: "present"; detail: string }
  | { state: "unknown"; detail: string };

// A listing that has not ended by here is either enormous or looping. Either
// way Radius stops reading and refuses to conclude anything from what it saw.
const MAX_LISTING_PAGES = 20;

function readFailureDetail(result: ListingReadResult): string {
  return (
    (result.stderr || result.stdout || "").trim() || "the request was refused"
  );
}

/**
 * Decide whether a listing the account can actually read proves a target gone.
 *
 * The listing is read to its end before absence is reported. A page that came
 * back full may have been followed by another holding the target, and a listing
 * that stopped short of the count GitHub advertised was cut off, so neither is
 * allowed to stand in for the whole set.
 */
export async function proveAbsentFromListing(input: {
  target: string;
  resource: string;
  scope: string;
  readPage(page: number): Promise<ListingReadResult>;
  parsePage(stdout: string): ListingPage | null;
  maxPages?: number;
}): Promise<ResourceAbsenceProof> {
  const limit = input.maxPages ?? MAX_LISTING_PAGES;
  const masked = (detail: string): ResourceAbsenceProof => ({
    state: "unknown",
    detail:
      `GitHub reported ${input.resource} "${input.target}" in ${input.scope} as absent, but the selected account could not read the ${input.resource} listing that would confirm it: ${detail}. ` +
      "That answer may be masked access rather than a completed delete."
  });
  let seen = 0;
  for (let page = 1; page <= limit; page++) {
    let result: ListingReadResult;
    try {
      result = await input.readPage(page);
    } catch (error) {
      return masked(error instanceof Error ? error.message : String(error));
    }
    if (result.code !== 0 && result.code !== "0") {
      return masked(readFailureDetail(result));
    }
    const parsed = input.parsePage(result.stdout);
    if (!parsed) {
      return masked("GitHub returned a listing Radius could not read");
    }
    if (parsed.names.includes(input.target)) {
      return {
        state: "present",
        detail: `${input.resource} "${input.target}" is still present in ${input.scope}.`
      };
    }
    seen += parsed.names.length;
    if (parsed.hasMore) continue;
    if (
      typeof parsed.totalCount === "number" &&
      Number.isFinite(parsed.totalCount) &&
      seen < parsed.totalCount
    ) {
      return masked(
        `the listing ended after ${seen} of ${parsed.totalCount} entries`
      );
    }
    return {
      state: "absent",
      evidence: `The selected account read every ${input.resource} in ${input.scope} and "${input.target}" is not among them.`
    };
  }
  return masked(`the listing did not end within ${limit} pages`);
}

/** One page of `GET /repos/{repo}/git/matching-refs/...`, as full ref names. */
export function parseRefListingPage(
  stdout: string,
  perPage: number
): ListingPage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const names: string[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return null;
    const ref = (entry as { ref?: unknown }).ref;
    if (typeof ref !== "string" || !ref) return null;
    names.push(ref);
  }
  return { names, hasMore: parsed.length >= perPage };
}

/** One page of `GET /repos/{repo}/environments`, as environment names. */
export function parseEnvironmentListingPage(
  stdout: string,
  perPage: number
): ListingPage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const body = parsed as { environments?: unknown; total_count?: unknown };
  if (!Array.isArray(body.environments)) return null;
  const names: string[] = [];
  for (const entry of body.environments) {
    if (!entry || typeof entry !== "object") return null;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== "string" || !name) return null;
    names.push(name);
  }
  const totalCount = Number(body.total_count);
  return {
    names,
    hasMore: body.environments.length >= perPage,
    totalCount: Number.isFinite(totalCount) ? totalCount : null
  };
}
