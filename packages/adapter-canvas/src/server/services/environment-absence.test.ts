import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_PAGE_SIZE,
  environmentListingArgs,
  environmentNameFromApiPath,
  environmentsApiPath,
  isNotFoundResponse,
  proveEnvironmentAbsent
} from "./environment-absence.js";
import type { ListingReadResult } from "./resource-absence.js";

const REPO = "octo/app";
const NAME = "dev";
const PATH = `/repos/${REPO}/environments/${NAME}`;

function response(
  overrides: Partial<ListingReadResult> = {}
): ListingReadResult {
  return { code: 0, stdout: "", stderr: "", ...overrides };
}

function page(names: string[], totalCount = names.length): ListingReadResult {
  return response({
    stdout: JSON.stringify({
      total_count: totalCount,
      environments: names.map((name) => ({ name }))
    })
  });
}

const NOT_FOUND = response({ code: 1, stderr: "HTTP 404: Not Found" });

function prove(
  pages: ListingReadResult[],
  readEnvironment: () => Promise<ListingReadResult> = async () => NOT_FOUND,
  maxPages?: number
) {
  const listed: number[] = [];
  const reads: number[] = [];
  return {
    listed,
    reads,
    run: () =>
      proveEnvironmentAbsent({
        repo: REPO,
        name: NAME,
        ports: {
          listEnvironments: async (index) => {
            listed.push(index);
            return pages[index - 1] ?? pages.at(-1) ?? page([]);
          },
          readEnvironment: async () => {
            reads.push(reads.length + 1);
            return readEnvironment();
          }
        },
        ...(maxPages === undefined ? {} : { maxPages })
      })
  };
}

describe("deriving the environments listing a delete path belongs to", () => {
  it("names the listing and the environment the path targets", () => {
    expect(environmentsApiPath(PATH)).toBe(`/repos/${REPO}/environments`);
    expect(environmentNameFromApiPath(PATH)).toBe(NAME);
  });

  it("decodes the environment back to the name a listing reports", () => {
    expect(
      environmentNameFromApiPath("/repos/octo/app/environments/needs%20space")
    ).toBe("needs space");
  });

  it("refuses a name it cannot decode rather than comparing the escaped form", () => {
    expect(
      environmentNameFromApiPath("/repos/octo/app/environments/%E0%A4%A")
    ).toBeNull();
  });

  it.each([
    ["a repository path with no environment", "/repos/octo/app"],
    ["the listing path itself", "/repos/octo/app/environments"],
    ["a nested path below the environment", "/repos/octo/app/environments/a/b"],
    ["an unrelated path", "/user/repos"],
    ["an empty path", ""]
  ])("returns null for %s", (_label, path) => {
    expect(environmentsApiPath(path)).toBeNull();
    expect(environmentNameFromApiPath(path)).toBeNull();
  });

  it("asks for one bounded page at a time", () => {
    expect(environmentListingArgs(`/repos/${REPO}/environments`, 3)).toEqual([
      "api",
      `/repos/${REPO}/environments?per_page=${ENVIRONMENT_PAGE_SIZE}&page=3`
    ]);
  });

  it.each([
    ["a 404 status", { stderr: "HTTP 404: Not Found" }],
    ["a not-found message", { stdout: "gh: Not Found" }]
  ])("recognises %s", (_label, result) => {
    expect(isNotFoundResponse(result)).toBe(true);
  });

  it("does not treat a refusal as a not-found", () => {
    expect(isNotFoundResponse({ stderr: "HTTP 403: Forbidden" })).toBe(false);
  });
});

describe("proving a GitHub environment absent", () => {
  it("reports absence from a complete listing confirmed by the environment", async () => {
    const test = prove([page(["prod", "staging"])]);

    await expect(test.run()).resolves.toMatchObject({
      state: "absent",
      evidence: expect.stringContaining("read every environment")
    });
    expect(test.listed).toEqual([1]);
    expect(test.reads).toEqual([1]);
  });

  it("reports the environment present when the listing still holds it", async () => {
    const test = prove([page(["dev", "prod"])]);

    await expect(test.run()).resolves.toMatchObject({ state: "present" });
    expect(test.reads).toEqual([]);
  });

  it("reports it present when the confirming read finds it back", async () => {
    const test = prove([page(["prod"])], async () =>
      response({ stdout: JSON.stringify({ name: NAME }) })
    );

    await expect(test.run()).resolves.toMatchObject({ state: "present" });
  });

  it.each([
    [
      "the Actions environments API is refused",
      response({ code: 1, stderr: "HTTP 403: Resource not accessible" })
    ],
    ["the listing answers 404", NOT_FOUND]
  ])("leaves the outcome unknown when %s", async (_label, refusal) => {
    const test = prove([refusal]);

    await expect(test.run()).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("masked access")
    });
    expect(test.reads).toEqual([]);
  });

  it("leaves the outcome unknown when the confirming read is refused", async () => {
    const test = prove([page(["prod"])], async () =>
      response({ code: 1, stderr: "HTTP 403: Forbidden" })
    );

    await expect(test.run()).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("confirming read")
    });
  });

  it("reads every page before reporting absence", async () => {
    const first = Array.from(
      { length: ENVIRONMENT_PAGE_SIZE },
      (_unused, index) => `env-${index}`
    );
    const second = Array.from(
      { length: 20 },
      (_unused, index) => `late-${index}`
    );
    const test = prove([page(first, 120), page(second, 120)]);

    await expect(test.run()).resolves.toMatchObject({ state: "absent" });
    expect(test.listed).toEqual([1, 2]);
  });

  it("refuses absence when the listing stops short of the count", async () => {
    const test = prove([page(["prod"], 9)]);

    await expect(test.run()).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("ended after 1 of 9 entries")
    });
  });

  it("refuses absence when the listing changed size while it was read", async () => {
    const first = Array.from(
      { length: ENVIRONMENT_PAGE_SIZE },
      (_unused, index) => `env-${index}`
    );
    const test = prove([page(first, 120), page(["late"], 118)]);

    await expect(test.run()).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("changed from 120 to 118 entries")
    });
  });

  it("never reports absence from a listing that will not end", async () => {
    const full = Array.from(
      { length: ENVIRONMENT_PAGE_SIZE },
      (_unused, index) => `env-${index}`
    );
    const test = prove([page(full, 10_000)], undefined, 2);

    await expect(test.run()).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("did not end within 2 pages")
    });
  });
});

describe("an environment whose name was reused after the delete", () => {
  const listing = (names: string[]) => ({
    code: 0,
    stdout: JSON.stringify({
      total_count: names.length,
      environments: names.map((name, index) => ({ name, id: 100 + index }))
    }),
    stderr: ""
  });

  it("reads a replacement under the same name as the targeted resource being gone", async () => {
    // The delete landed, then the customer recreated `dev`. Reporting the
    // replacement as "still present" would tell them to clean up a resource
    // Radius never made, and would quarantine the operation permanently.
    const proof = await proveEnvironmentAbsent({
      repo: "octo/app",
      name: "dev",
      recordedProviderId: "100",
      ports: {
        listEnvironments: async () => listing(["dev"]),
        readEnvironment: async () => ({
          code: 0,
          stdout: JSON.stringify({ name: "dev", id: 999 }),
          stderr: ""
        })
      }
    });

    expect(proof.state).toBe("absent");
  });

  it("still reports the targeted resource present when the id matches", async () => {
    const proof = await proveEnvironmentAbsent({
      repo: "octo/app",
      name: "dev",
      recordedProviderId: "100",
      ports: {
        listEnvironments: async () => listing(["dev"]),
        readEnvironment: async () => ({
          code: 0,
          stdout: JSON.stringify({ name: "dev", id: 100 }),
          stderr: ""
        })
      }
    });

    expect(proof.state).toBe("present");
  });

  it("refuses to conclude anything when the live id cannot be read", async () => {
    const proof = await proveEnvironmentAbsent({
      repo: "octo/app",
      name: "dev",
      recordedProviderId: "100",
      ports: {
        listEnvironments: async () => listing(["dev"]),
        readEnvironment: async () => ({
          code: 0,
          stdout: JSON.stringify({ name: "dev" }),
          stderr: ""
        })
      }
    });

    expect(proof.state).toBe("unknown");
  });
});
