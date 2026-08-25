import {
  parseRefListingPage,
  proveAbsentFromListing,
  type ExactResourceRead,
  type ListingReadResult,
  type ResourceAbsenceProof
} from "./resource-absence.js";

// The one proof that a setup branch is gone rather than merely invisible.
//
// Two paths ask this question — the recovery that settles an unresolved
// `github_branch.delete` after a restart, and the in-process delete the workflow
// committer issues when it recovers a branch mid-run — and they must not answer
// it differently. A 404 from the ref endpoint is not an answer at all: GitHub
// returns it both for a ref that does not exist and for one the token is not
// allowed to see, and it decides that per resource, so reading the repository
// says nothing about it.
//
// So both go through here: list the refs the account can actually enumerate,
// require the branch to be missing from all of them, and confirm against the
// ref's own endpoint one last time. Anything less leaves the outcome unknown,
// and unknown never settles a deletion as done.

/** The page size the ref listing is requested with, and read back against. */
export const REF_PAGE_SIZE = 100;

export interface BranchAbsencePorts {
  /** `GET /repos/{repo}/git/matching-refs/heads/{branch}`, one page at a time. */
  listBranchRefs(page: number): Promise<ListingReadResult>;
  /** `GET /repos/{repo}/git/ref/heads/{branch}`, read once more at the end. */
  readBranchRef(): Promise<ListingReadResult>;
}

/** Whether a `gh api` answer is the 404 that means "no such ref, maybe". */
export function isNotFoundResponse(result: {
  stdout?: string;
  stderr?: string;
}): boolean {
  return /(?:HTTP\s+404|\bNot Found\b)/i.test(
    `${result.stderr || ""}\n${result.stdout || ""}`
  );
}

function exactRefRead(result: ListingReadResult): ExactResourceRead {
  if (result.code === 0 || result.code === "0") return "present";
  return isNotFoundResponse(result) ? "absent" : "unreadable";
}

/**
 * Prove a setup branch absent through the ref listing, or refuse to say.
 *
 * `maxPages` exists for tests that need to reach the never-ending-listing
 * refusal without building a hundred pages of fixtures.
 */
export async function proveBranchAbsent(input: {
  repo: string;
  branch: string;
  ports: BranchAbsencePorts;
  maxPages?: number;
}): Promise<ResourceAbsenceProof> {
  return proveAbsentFromListing({
    target: `refs/heads/${input.branch}`,
    resource: "branch",
    scope: input.repo,
    readPage: (page) => input.ports.listBranchRefs(page),
    parsePage: (stdout) => parseRefListingPage(stdout, REF_PAGE_SIZE),
    confirmExactAbsence: async () =>
      exactRefRead(await input.ports.readBranchRef()),
    ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages })
  });
}

/** The `gh api` argv that lists one page of refs matching an exact branch. */
export function branchRefListingArgs(
  repo: string,
  branch: string,
  page: number
): string[] {
  return [
    "api",
    `/repos/${repo}/git/matching-refs/heads/${encodeURIComponent(branch)}` +
      `?per_page=${REF_PAGE_SIZE}&page=${page}`
  ];
}

/** The `gh api` argv that reads one exact branch ref. */
export function branchRefReadArgs(repo: string, branch: string): string[] {
  return ["api", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`];
}
