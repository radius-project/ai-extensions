import { describe, expect, it } from "vitest";
import {
  branchRefListingArgs,
  branchRefReadArgs,
  isNotFoundResponse,
  proveBranchAbsent,
  REF_PAGE_SIZE
} from "./branch-absence.js";
import type { ListingReadResult } from "./resource-absence.js";

const REPO = "octo/app";
const BRANCH = "radius/setup-dev-workflows-abc";

function response(
  overrides: Partial<ListingReadResult> = {}
): ListingReadResult {
  return { code: 0, stdout: "", stderr: "", ...overrides };
}

function refPage(...refs: string[]): ListingReadResult {
  return response({ stdout: JSON.stringify(refs.map((ref) => ({ ref }))) });
}

const NOT_FOUND = response({ code: 1, stderr: "HTTP 404: Not Found" });

function prove(
  pages: ListingReadResult[],
  readBranchRef: () => Promise<ListingReadResult> = async () => NOT_FOUND,
  maxPages?: number
) {
  const listed: number[] = [];
  const reads: number[] = [];
  return {
    listed,
    reads,
    run: () =>
      proveBranchAbsent({
        repo: REPO,
        branch: BRANCH,
        ports: {
          listBranchRefs: async (page) => {
            listed.push(page);
            return pages[page - 1] ?? pages.at(-1) ?? refPage();
          },
          readBranchRef: async () => {
            reads.push(reads.length + 1);
            return readBranchRef();
          }
        },
        ...(maxPages === undefined ? {} : { maxPages })
      })
  };
}

describe("the argv both branch-absence callers share", () => {
  it("lists refs matching the exact branch, one page at a time", () => {
    expect(branchRefListingArgs(REPO, BRANCH, 2)).toEqual([
      "api",
      `/repos/${REPO}/git/matching-refs/heads/${encodeURIComponent(BRANCH)}` +
        `?per_page=${REF_PAGE_SIZE}&page=2`
    ]);
  });

  it("reads the exact ref", () => {
    expect(branchRefReadArgs(REPO, BRANCH)).toEqual([
      "api",
      `/repos/${REPO}/git/ref/heads/${encodeURIComponent(BRANCH)}`
    ]);
  });

  it("escapes a branch name that would otherwise change the path", () => {
    expect(branchRefReadArgs(REPO, "feature/a b?c")[1]).toContain(
      encodeURIComponent("feature/a b?c")
    );
  });
});

describe("recognising the 404 that starts an absence proof", () => {
  it.each([
    ["a status on stderr", { stderr: "HTTP 404: Not Found" }],
    ["a message on stdout", { stdout: "gh: Not Found (HTTP 404)" }],
    ["mixed case", { stderr: "http 404" }]
  ])("recognises %s", (_label, result) => {
    expect(isNotFoundResponse(result)).toBe(true);
  });

  it.each([
    ["a server error", { stderr: "HTTP 500" }],
    ["a refusal", { stderr: "HTTP 403: Forbidden" }],
    ["nothing at all", {}]
  ])("does not recognise %s", (_label, result) => {
    expect(isNotFoundResponse(result)).toBe(false);
  });
});

describe("proving a setup branch absent", () => {
  it("reports absence from a complete listing confirmed by the ref itself", async () => {
    const test = prove([refPage("refs/heads/main")]);

    await expect(test.run()).resolves.toMatchObject({
      state: "absent",
      evidence: expect.stringContaining("read every branch")
    });
    expect(test.listed).toEqual([1]);
    expect(test.reads).toEqual([1]);
  });

  it("reports the branch present when the listing still holds it", async () => {
    const test = prove([refPage(`refs/heads/${BRANCH}`)]);

    await expect(test.run()).resolves.toMatchObject({ state: "present" });
    // The listing already answered, so the ref is not read again.
    expect(test.reads).toEqual([]);
  });

  it("reports the branch present when the confirming read finds it back", async () => {
    // The customer pushed the branch again between the listing and the
    // confirmation. Absence is no longer true, so it is not reported.
    const test = prove([refPage("refs/heads/main")], async () =>
      response({ stdout: JSON.stringify({ object: { sha: "abc" } }) })
    );

    await expect(test.run()).resolves.toMatchObject({ state: "present" });
  });

  it.each([
    ["forbidden", response({ code: 1, stderr: "HTTP 403: Forbidden" })],
    ["a server error", response({ code: 1, stderr: "HTTP 500" })]
  ])(
    "leaves the outcome unknown when the confirming read is %s",
    async (_label, confirmation) => {
      const test = prove(
        [refPage("refs/heads/main")],
        async () => confirmation
      );

      await expect(test.run()).resolves.toMatchObject({
        state: "unknown",
        detail: expect.stringContaining("confirming read")
      });
    }
  );

  it("leaves the outcome unknown when the ref listing is refused", async () => {
    const test = prove([
      response({ code: 1, stderr: "HTTP 403: Resource not accessible" })
    ]);

    await expect(test.run()).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("HTTP 403")
    });
    expect(test.reads).toEqual([]);
  });

  it("reads every page before reporting absence", async () => {
    const full = Array.from(
      { length: REF_PAGE_SIZE },
      (_unused, index) => `refs/heads/other-${index}`
    );
    const test = prove([refPage(...full), refPage("refs/heads/tail")]);

    await expect(test.run()).resolves.toMatchObject({ state: "absent" });
    expect(test.listed).toEqual([1, 2]);
  });

  it("never reports absence from a listing that will not end", async () => {
    const full = Array.from(
      { length: REF_PAGE_SIZE },
      (_unused, index) => `refs/heads/other-${index}`
    );
    const test = prove([refPage(...full)], undefined, 3);

    await expect(test.run()).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("did not end within 3 pages")
    });
    expect(test.reads).toEqual([]);
  });
});
