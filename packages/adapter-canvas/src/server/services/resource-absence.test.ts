import { describe, expect, it } from "vitest";
import {
  parseEnvironmentListingPage,
  parseRefListingPage,
  proveAbsentFromListing,
  type ListingPage,
  type ListingReadResult
} from "./resource-absence.js";

const PER_PAGE = 4;

function ok(body: unknown): ListingReadResult {
  return { code: 0, stdout: JSON.stringify(body), stderr: "" };
}

function refs(...names: string[]): ListingReadResult {
  return ok(names.map((ref) => ({ ref })));
}

function environments(
  names: string[],
  totalCount = names.length
): ListingReadResult {
  return ok({
    total_count: totalCount,
    environments: names.map((name) => ({ name }))
  });
}

function prove(
  pages: Array<ListingReadResult | (() => never)>,
  overrides: Partial<Parameters<typeof proveAbsentFromListing>[0]> = {}
) {
  const requested: number[] = [];
  return {
    requested,
    run: () =>
      proveAbsentFromListing({
        target: "wanted",
        resource: "branch",
        scope: "octo/app",
        readPage: async (page) => {
          requested.push(page);
          const entry = pages[page - 1] ?? pages.at(-1)!;
          return typeof entry === "function" ? entry() : entry;
        },
        parsePage: (stdout) => parseRefListingPage(stdout, PER_PAGE),
        ...overrides
      })
  };
}

describe("proving a resource absent from a listing it can read", () => {
  it("reports absence once the whole listing came back without the target", async () => {
    const harness = prove([refs("refs/heads/main")]);

    await expect(harness.run()).resolves.toEqual({
      state: "absent",
      evidence: expect.stringContaining("read every branch in octo/app")
    });
    expect(harness.requested).toEqual([1]);
  });

  it("reports the target present the moment a page holds it", async () => {
    const harness = prove([
      { code: 0, stdout: JSON.stringify([{ ref: "wanted" }]), stderr: "" }
    ]);

    await expect(harness.run()).resolves.toEqual({
      state: "present",
      detail: expect.stringContaining('branch "wanted" is still present')
    });
  });

  it.each([
    [
      "the listing is refused",
      { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" },
      "HTTP 403"
    ],
    [
      "the listing answers 404",
      { code: 1, stdout: "", stderr: "HTTP 404: Not Found" },
      "HTTP 404"
    ],
    [
      "the failure carries no detail",
      { code: 1, stdout: "", stderr: "" },
      "the request was refused"
    ]
  ])("leaves the outcome unknown when %s", async (_label, page, expected) => {
    const harness = prove([page as ListingReadResult]);

    const proof = await harness.run();

    expect(proof).toMatchObject({ state: "unknown" });
    expect(proof.state === "unknown" && proof.detail).toContain(expected);
    expect(proof.state === "unknown" && proof.detail).toContain(
      "masked access rather than a completed delete"
    );
  });

  it("leaves the outcome unknown for a body it cannot read", async () => {
    const harness = prove([{ code: 0, stdout: "<html>", stderr: "" }]);

    await expect(harness.run()).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("could not read")
    });
  });

  it("keeps reading while pages come back full", async () => {
    const harness = prove([
      refs("a", "b", "c", "d"),
      refs("e", "f", "g", "h"),
      refs("i")
    ]);

    await expect(harness.run()).resolves.toMatchObject({ state: "absent" });
    expect(harness.requested).toEqual([1, 2, 3]);
  });

  it("finds a target that only appears on a later page", async () => {
    const harness = prove([refs("a", "b", "c", "d"), refs("wanted")]);

    await expect(harness.run()).resolves.toMatchObject({ state: "present" });
    expect(harness.requested).toEqual([1, 2]);
  });

  it("never concludes absence from a listing that will not end", async () => {
    const harness = prove([refs("a", "b", "c", "d")], { maxPages: 3 });

    await expect(harness.run()).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("did not end within 3 pages")
    });
    expect(harness.requested).toEqual([1, 2, 3]);
  });

  it("never concludes absence from a listing that stopped short of its count", async () => {
    const harness = prove([], {
      parsePage: (): ListingPage => ({
        names: ["a"],
        hasMore: false,
        totalCount: 9
      }),
      readPage: async () => refs("a")
    });

    await expect(harness.run()).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("ended after 1 of 9 entries")
    });
  });

  it("accepts a listing whose count it reached exactly", async () => {
    const proof = await proveAbsentFromListing({
      target: "wanted",
      resource: "environment",
      scope: "octo/app",
      readPage: async (page) =>
        page === 1 ?
          environments(["a", "b", "c", "d"], 6)
        : environments(["e", "f"], 6),
      parsePage: (stdout) => parseEnvironmentListingPage(stdout, PER_PAGE)
    });

    expect(proof).toMatchObject({ state: "absent" });
  });

  it("leaves the outcome unknown when a page cannot be reached at all", async () => {
    const harness = prove([
      () => {
        throw new Error("the token was revoked");
      }
    ]);

    await expect(harness.run()).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("the token was revoked")
    });
  });

  it("names a non-Error read failure rather than dropping it", async () => {
    const harness = prove([
      () => {
        throw "spawn failed";
      }
    ]);

    await expect(harness.run()).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("spawn failed")
    });
  });

  it("accepts a string-zero page status", async () => {
    const harness = prove([{ code: "0", stdout: "[]", stderr: "" }]);

    await expect(harness.run()).resolves.toMatchObject({ state: "absent" });
  });
});

describe("reading one page of a ref listing", () => {
  it("takes the full ref names a comparison needs", () => {
    expect(
      parseRefListingPage(
        JSON.stringify([{ ref: "refs/heads/main" }, { ref: "refs/heads/dev" }]),
        PER_PAGE
      )
    ).toEqual({ names: ["refs/heads/main", "refs/heads/dev"], hasMore: false });
  });

  it("says more may follow when the page came back full", () => {
    expect(
      parseRefListingPage(
        JSON.stringify(
          Array.from({ length: PER_PAGE }, (_unused, index) => ({
            ref: `refs/heads/${index}`
          }))
        ),
        PER_PAGE
      )
    ).toMatchObject({ hasMore: true });
  });

  it.each([
    ["a body that is not JSON", "<html>"],
    ["an envelope instead of an array", "{}"],
    ["an entry that is not an object", JSON.stringify(["refs/heads/main"])],
    ["an entry with no ref", JSON.stringify([{}])],
    ["an entry whose ref is empty", JSON.stringify([{ ref: "" }])],
    ["an entry whose ref is not a string", JSON.stringify([{ ref: 7 }])],
    ["a null entry", JSON.stringify([null])]
  ])("refuses to read %s", (_label, stdout) => {
    expect(parseRefListingPage(stdout, PER_PAGE)).toBeNull();
  });
});

describe("reading one page of an environments listing", () => {
  it("takes the names and the count GitHub reports", () => {
    expect(
      parseEnvironmentListingPage(
        JSON.stringify({
          total_count: 5,
          environments: [{ name: "dev" }, { name: "prod" }]
        }),
        PER_PAGE
      )
    ).toEqual({ names: ["dev", "prod"], hasMore: false, totalCount: 5 });
  });

  it("says more may follow when the page came back full", () => {
    expect(
      parseEnvironmentListingPage(
        JSON.stringify({
          total_count: 9,
          environments: Array.from({ length: PER_PAGE }, (_u, index) => ({
            name: `env-${index}`
          }))
        }),
        PER_PAGE
      )
    ).toMatchObject({ hasMore: true, totalCount: 9 });
  });

  it("reports no count when GitHub does not send a usable one", () => {
    expect(
      parseEnvironmentListingPage(
        JSON.stringify({ environments: [{ name: "dev" }] }),
        PER_PAGE
      )
    ).toEqual({ names: ["dev"], hasMore: false, totalCount: null });
  });

  it.each([
    ["a body that is not JSON", "<html>"],
    ["an array instead of an envelope", "[]"],
    ["null", "null"],
    ["an envelope with no environments", JSON.stringify({ total_count: 0 })],
    [
      "an entry with no name",
      JSON.stringify({ total_count: 1, environments: [{}] })
    ],
    [
      "an entry whose name is empty",
      JSON.stringify({ total_count: 1, environments: [{ name: "" }] })
    ],
    [
      "an entry that is not an object",
      JSON.stringify({ total_count: 1, environments: ["dev"] })
    ]
  ])("refuses to read %s", (_label, stdout) => {
    expect(parseEnvironmentListingPage(stdout, PER_PAGE)).toBeNull();
  });
});
