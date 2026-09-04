import { describe, expect, it } from "vitest";
import {
  selectExpiredDirectoryObjects,
  selectExpiredEnvironments,
  selectExpiredFallbackBranches,
  selectExpiredFallbackPullRequests,
  selectTestResourceGroups,
} from "./cloud-cleanup.js";

const CUTOFF = "2026-08-31T12:00:00Z";
const OLD = "2026-08-31T05:59:59Z";
const NEW = "2026-08-31T12:00:00Z";
const APP = "radius-deploy-fixture-owner-fixture-repo";
const BRANCH_PREFIX = "radius/setup-";

describe("selectExpiredDirectoryObjects", () => {
  it("selects only exact-name objects with a provably old creation time", () => {
    expect(
      selectExpiredDirectoryObjects(
        [
          { id: "old", displayName: APP, createdDateTime: OLD },
          { id: "new", displayName: APP, createdDateTime: NEW },
          { id: "other", displayName: `${APP}-other`, createdDateTime: OLD },
        ],
        APP,
        CUTOFF,
      ),
    ).toEqual([{ id: "old" }]);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["malformed", "yesterday"],
    ["calendar-invalid", "2026-99-99T05:00:00Z"],
  ])("fails closed when createdDateTime is %s", (_label, createdDateTime) => {
    expect(
      selectExpiredDirectoryObjects(
        [{ id: "unsafe", displayName: APP, createdDateTime }],
        APP,
        CUTOFF,
      ),
    ).toEqual([]);
  });

  it("rejects an unreadable listing or invalid cutoff", () => {
    expect(() => selectExpiredDirectoryObjects({}, APP, CUTOFF)).toThrow(
      "did not return a JSON array",
    );
    expect(() => selectExpiredDirectoryObjects([], APP, "invalid")).toThrow(
      "not a valid UTC timestamp",
    );
  });
});

describe("selectExpiredEnvironments", () => {
  it("selects old prefixed environments from paginated API data", () => {
    expect(
      selectExpiredEnvironments(
        [
          {
            environments: [
              { name: "radtest-old", created_at: OLD },
              { name: "radtest-new", created_at: NEW },
              { name: "production", created_at: OLD },
            ],
          },
        ],
        "radtest-",
        CUTOFF,
      ),
    ).toEqual(["radtest-old"]);
  });

  it.each([
    ["missing", {}],
    ["null", { created_at: null }],
    ["malformed", { created_at: "not-a-date" }],
  ])(
    "does not select an environment with %s creation data",
    (_label, fields) => {
      expect(
        selectExpiredEnvironments(
          [{ environments: [{ name: "radtest-unsafe", ...fields }] }],
          "radtest-",
          CUTOFF,
        ),
      ).toEqual([]);
    },
  );

  it("ignores malformed pages and rejects a non-array response", () => {
    expect(
      selectExpiredEnvironments(
        [null, { environments: "invalid" }],
        "radtest-",
        CUTOFF,
      ),
    ).toEqual([]);
    expect(() => selectExpiredEnvironments(null, "radtest-", CUTOFF)).toThrow(
      "did not return a JSON array",
    );
  });
});

describe("selectTestResourceGroups", () => {
  it("selects tagged resource groups with the fixture prefix without waiting for age", () => {
    expect(
      selectTestResourceGroups(
        [
          {
            name: "radtest-canvas-old",
            tags: {
              "radius-canvas-e2e": "true",
            },
          },
          {
            name: "radtest-canvas-just-created",
            tags: {
              "radius-canvas-e2e": "true",
            },
          },
          {
            name: "radtest-canvas-untagged",
            tags: {},
          },
          {
            name: "radtest-other",
            tags: {
              "radius-canvas-e2e": "true",
            },
          },
        ],
        "radtest-canvas",
      ),
    ).toEqual(["radtest-canvas-old", "radtest-canvas-just-created"]);
  });

  it("does not select untagged resource groups even with the fixture prefix", () => {
    expect(
      selectTestResourceGroups(
        [
          { name: "radtest-canvas-missing-tags" },
          {
            name: "radtest-canvas-wrong-tag",
            tags: { "radius-canvas-e2e": "false" },
          },
        ],
        "radtest-canvas",
      ),
    ).toEqual([]);
  });

  it("rejects an unreadable listing", () => {
    expect(() => selectTestResourceGroups({}, "radtest-canvas")).toThrow(
      "did not return a JSON array",
    );
  });
});

describe("selectExpiredFallbackPullRequests", () => {
  it("selects only old pull requests whose head uses the fallback prefix", () => {
    expect(
      selectExpiredFallbackPullRequests(
        [
          [
            { number: 7, created_at: OLD, head: { ref: "radius/setup-old" } },
            { number: 8, created_at: NEW, head: { ref: "radius/setup-new" } },
            { number: 9, created_at: OLD, head: { ref: "feature/other" } },
          ],
        ],
        BRANCH_PREFIX,
        CUTOFF,
      ),
    ).toEqual([{ number: 7, headRef: "radius/setup-old" }]);
  });

  it("fails closed on malformed pull request identity or creation data", () => {
    expect(
      selectExpiredFallbackPullRequests(
        [
          { number: 0, created_at: OLD, head: { ref: "radius/setup-zero" } },
          {
            number: 1,
            created_at: null,
            head: { ref: "radius/setup-no-date" },
          },
          { number: 2, created_at: OLD, head: null },
        ],
        BRANCH_PREFIX,
        CUTOFF,
      ),
    ).toEqual([]);
  });
});

describe("selectExpiredFallbackBranches", () => {
  it("selects exact old fallback refs and normalizes the refs/heads prefix", () => {
    expect(
      selectExpiredFallbackBranches(
        [
          [
            { ref: "refs/heads/radius/setup-old", created_at: OLD },
            { ref: "refs/heads/radius/setup-new", created_at: NEW },
            { ref: "refs/heads/feature/other", created_at: OLD },
          ],
        ],
        BRANCH_PREFIX,
        CUTOFF,
      ),
    ).toEqual(["radius/setup-old"]);
  });

  it("does not select fallback refs without a valid commit creation time", () => {
    expect(
      selectExpiredFallbackBranches(
        [
          null,
          { ref: 42, created_at: OLD },
          { ref: "refs/heads/radius/setup-missing" },
          { ref: "refs/heads/radius/setup-invalid", created_at: "invalid" },
        ],
        BRANCH_PREFIX,
        CUTOFF,
      ),
    ).toEqual([]);
  });
});
