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
  const confirmations: number[] = [];
  return {
    requested,
    confirmations,
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
        // The listing was assembled request by request, so absence is confirmed
        // once more against the resource itself. Most cases only care that it
        // agreed, so the default is the 404 that started the proof.
        confirmExactAbsence: async () => {
          confirmations.push(confirmations.length + 1);
          return "absent" as const;
        },
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
    expect(harness.confirmations).toEqual([]);
  });

  describe("an offset-paged listing that moved while it was read", () => {
    it.each([
      ["grew", 4, 6],
      ["shrank", 6, 4]
    ])(
      "refuses absence when the count %s between pages",
      async (_label, first, second) => {
        const counts = [first, second];
        let page = 0;
        const proof = await proveAbsentFromListing({
          target: "wanted",
          resource: "environment",
          scope: "octo/app",
          readPage: async () => ({ code: 0, stdout: "{}", stderr: "" }),
          parsePage: (): ListingPage => {
            const total = counts[page] ?? counts.at(-1)!;
            page += 1;
            return {
              names: page === 1 ? ["a", "b", "c", "d"] : ["e"],
              hasMore: page === 1,
              totalCount: total
            };
          },
          confirmExactAbsence: async () => "absent"
        });

        expect(proof).toMatchObject({
          state: "unknown",
          detail: expect.stringContaining(
            `changed from ${first} to ${second} entries`
          )
        });
      }
    );

    it("finds a target that slid onto a page already read", async () => {
      // The classic offset race: an entry ahead of the target is removed, the
      // target moves back onto page one, and a naive walk never sees it. The
      // count moving is the signal that the set is not the one Radius saw.
      let page = 0;
      const proof = await proveAbsentFromListing({
        target: "wanted",
        resource: "environment",
        scope: "octo/app",
        readPage: async () => ({ code: 0, stdout: "{}", stderr: "" }),
        parsePage: (): ListingPage => {
          page += 1;
          return page === 1 ?
              { names: ["a", "b", "c", "d"], hasMore: true, totalCount: 5 }
            : { names: [], hasMore: false, totalCount: 4 };
        },
        confirmExactAbsence: async () => "absent"
      });

      expect(proof).toMatchObject({ state: "unknown" });
    });

    it("accepts a listing whose count never moved", async () => {
      let page = 0;
      const proof = await proveAbsentFromListing({
        target: "wanted",
        resource: "environment",
        scope: "octo/app",
        readPage: async () => ({ code: 0, stdout: "{}", stderr: "" }),
        parsePage: (): ListingPage => {
          page += 1;
          return page === 1 ?
              { names: ["a", "b", "c", "d"], hasMore: true, totalCount: 5 }
            : { names: ["e"], hasMore: false, totalCount: 5 };
        },
        confirmExactAbsence: async () => "absent"
      });

      expect(proof).toMatchObject({ state: "absent" });
    });
  });

  describe("the confirming read of the resource itself", () => {
    it("runs only after the listing came back complete and clean", async () => {
      const harness = prove([refs("refs/heads/main")]);

      await expect(harness.run()).resolves.toMatchObject({ state: "absent" });
      expect(harness.confirmations).toEqual([1]);
    });

    it("does not run when the listing already found the target", async () => {
      const harness = prove([
        { code: 0, stdout: JSON.stringify([{ ref: "wanted" }]), stderr: "" }
      ]);

      await expect(harness.run()).resolves.toMatchObject({ state: "present" });
      expect(harness.confirmations).toEqual([]);
    });

    it("reports the target present when the confirming read finds it", async () => {
      const harness = prove([refs("refs/heads/main")], {
        confirmExactAbsence: async () => "present"
      });

      await expect(harness.run()).resolves.toMatchObject({
        state: "present",
        detail: expect.stringContaining("is still present")
      });
    });

    it("leaves the outcome unknown when the confirming read is forbidden", async () => {
      const harness = prove([refs("refs/heads/main")], {
        confirmExactAbsence: async () => "unreadable"
      });

      await expect(harness.run()).resolves.toMatchObject({
        state: "unknown",
        detail: expect.stringContaining(
          "confirming read of the resource itself"
        )
      });
    });

    it("leaves the outcome unknown when the confirming read throws", async () => {
      const harness = prove([refs("refs/heads/main")], {
        confirmExactAbsence: async () => {
          throw new Error("the token was revoked");
        }
      });

      await expect(harness.run()).resolves.toMatchObject({
        state: "unknown",
        detail: expect.stringContaining("the token was revoked")
      });
    });

    it("names a non-Error confirming-read failure rather than dropping it", async () => {
      const harness = prove([refs("refs/heads/main")], {
        confirmExactAbsence: async () => {
          throw "spawn failed";
        }
      });

      await expect(harness.run()).resolves.toMatchObject({
        state: "unknown",
        detail: expect.stringContaining("spawn failed")
      });
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
      parsePage: (stdout) => parseEnvironmentListingPage(stdout, PER_PAGE),
      confirmExactAbsence: async () => "absent"
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
