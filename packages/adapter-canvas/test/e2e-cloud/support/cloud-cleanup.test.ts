import { describe, expect, it } from "vitest";
import {
  selectExpiredApplications,
  selectExpiredDirectoryObjects,
  selectExpiredEnvironments,
  selectExpiredFallbackBranches,
  selectExpiredFallbackPullRequests,
  selectExpiredServicePrincipals,
  selectOpenPullRequestHeadRefs,
  selectTestResourceGroups
} from "./cloud-cleanup.js";

const CUTOFF = "2026-08-31T12:00:00Z";
const OLD = "2026-08-31T05:59:59Z";
const NEW = "2026-08-31T12:00:00Z";
const APP = "radius-deploy-fixture-owner-fixture-repo";
const REPOSITORY = "fixture-owner/fixture-repo";
const DEFAULT_BRANCH = "main";
const ENVIRONMENT_PREFIX = "radtest-";
const BRANCH_PREFIX = "radius/setup-";
const GENERATED_BRANCH = "radius/setup-radtestabc-workflows-1788177600000";
const APP_TAGS = [
  "radius-managed",
  `radius-repo:${REPOSITORY}`,
  "radius-environment:radtest-abc"
];

describe("selectExpiredDirectoryObjects", () => {
  it("selects only exact-name objects with a provably old creation time", () => {
    expect(
      selectExpiredDirectoryObjects(
        [
          { id: "old", displayName: APP, createdDateTime: OLD },
          { id: "new", displayName: APP, createdDateTime: NEW },
          { id: "other", displayName: `${APP}-other`, createdDateTime: OLD }
        ],
        APP,
        CUTOFF
      )
    ).toEqual([{ id: "old" }]);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["malformed", "yesterday"],
    ["calendar-invalid", "2026-02-30T05:00:00Z"]
  ])("fails closed when createdDateTime is %s", (_label, createdDateTime) => {
    expect(
      selectExpiredDirectoryObjects(
        [{ id: "unsafe", displayName: APP, createdDateTime }],
        APP,
        CUTOFF
      )
    ).toEqual([]);
  });

  it("rejects an unreadable listing or invalid cutoff", () => {
    expect(() => selectExpiredDirectoryObjects({}, APP, CUTOFF)).toThrow(
      "did not return a JSON array"
    );
    expect(() => selectExpiredDirectoryObjects([], APP, "invalid")).toThrow(
      "not a valid UTC timestamp"
    );
  });
});

describe("selectExpiredApplications", () => {
  it("selects only old applications with Radius provenance for the fixture repository", () => {
    expect(
      selectExpiredApplications(
        [
          {
            id: "object-old",
            appId: "client-old",
            displayName: APP,
            createdDateTime: OLD,
            tags: APP_TAGS
          },
          {
            id: "object-new",
            appId: "client-new",
            displayName: APP,
            createdDateTime: NEW,
            tags: APP_TAGS
          },
          {
            id: "object-unowned",
            appId: "client-unowned",
            displayName: APP,
            createdDateTime: OLD,
            tags: ["radius-managed", "radius-repo:other/repo"]
          },
          {
            id: "object-name-only",
            appId: "client-name-only",
            displayName: APP,
            createdDateTime: OLD
          }
        ],
        APP,
        REPOSITORY,
        ENVIRONMENT_PREFIX,
        CUTOFF
      )
    ).toEqual([{ id: "object-old", appId: "client-old" }]);
  });
});

describe("selectExpiredServicePrincipals", () => {
  it("selects only old service principals linked to a proven application", () => {
    expect(
      selectExpiredServicePrincipals(
        [
          {
            id: "principal-old",
            appId: "client-old",
            displayName: APP,
            createdDateTime: OLD
          },
          {
            id: "principal-new",
            appId: "client-old",
            displayName: APP,
            createdDateTime: NEW
          },
          {
            id: "principal-unlinked",
            appId: "client-other",
            displayName: APP,
            createdDateTime: OLD
          }
        ],
        APP,
        ["client-old"],
        CUTOFF
      )
    ).toEqual([{ id: "principal-old" }]);
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
              { name: "production", created_at: OLD }
            ]
          }
        ],
        "radtest-",
        CUTOFF
      )
    ).toEqual(["radtest-old"]);
  });

  it.each([
    ["missing", {}],
    ["null", { created_at: null }],
    ["malformed", { created_at: "not-a-date" }]
  ])(
    "does not select an environment with %s creation data",
    (_label, fields) => {
      expect(
        selectExpiredEnvironments(
          [{ environments: [{ name: "radtest-unsafe", ...fields }] }],
          "radtest-",
          CUTOFF
        )
      ).toEqual([]);
    }
  );

  it("rejects malformed pages and non-array responses", () => {
    expect(() => selectExpiredEnvironments([null], "radtest-", CUTOFF)).toThrow(
      "GitHub Environments page did not include an environments array"
    );
    expect(() => selectExpiredEnvironments(null, "radtest-", CUTOFF)).toThrow(
      "did not return a JSON array"
    );
  });
});

describe("selectTestResourceGroups", () => {
  it("selects tagged CI-owned resource groups with the fixture prefix without waiting for age", () => {
    expect(
      selectTestResourceGroups(
        [
          {
            name: "radtest-canvas-old",
            tags: {
              "github-run-id": "1234",
              "radius-canvas-e2e": "true"
            }
          },
          {
            name: "radtest-canvas-just-created",
            tags: {
              "github-run-id": "5678",
              "radius-canvas-e2e": "true"
            }
          },
          {
            name: "radtest-canvas-local",
            tags: {
              "radius-canvas-e2e": "true"
            }
          },
          {
            name: "radtest-other",
            tags: {
              "github-run-id": "9999",
              "radius-canvas-e2e": "true"
            }
          }
        ],
        "radtest-canvas"
      )
    ).toEqual([
      { name: "radtest-canvas-old", runId: "1234" },
      { name: "radtest-canvas-just-created", runId: "5678" }
    ]);
  });

  it("does not select untagged resource groups even with the fixture prefix", () => {
    expect(
      selectTestResourceGroups(
        [
          { name: "radtest-canvas-missing-tags" },
          {
            name: "radtest-canvas-wrong-tag",
            tags: { "github-run-id": "1234", "radius-canvas-e2e": "false" }
          },
          {
            name: "radtest-canvas-malformed-run",
            tags: { "github-run-id": "local", "radius-canvas-e2e": "true" }
          }
        ],
        "radtest-canvas"
      )
    ).toEqual([]);
  });

  it("rejects an unreadable listing", () => {
    expect(() => selectTestResourceGroups({}, "radtest-canvas")).toThrow(
      "did not return a JSON array"
    );
  });
});

describe("selectExpiredFallbackPullRequests", () => {
  it("selects only old fixture pull requests whose head uses the generated fallback shape", () => {
    expect(
      selectExpiredFallbackPullRequests(
        [
          [
            pull({ number: 7, createdAt: OLD, headRef: GENERATED_BRANCH }),
            pull({ number: 8, createdAt: NEW, headRef: GENERATED_BRANCH }),
            pull({
              number: 9,
              createdAt: OLD,
              headRef: "radius/setup-dev"
            }),
            pull({
              number: 10,
              createdAt: OLD,
              headRef: GENERATED_BRANCH,
              headRepository: "fork/repo"
            }),
            pull({
              number: 11,
              createdAt: OLD,
              headRef: GENERATED_BRANCH,
              baseRef: "feature"
            })
          ]
        ],
        BRANCH_PREFIX,
        REPOSITORY,
        DEFAULT_BRANCH,
        CUTOFF
      )
    ).toEqual([{ number: 7, headRef: GENERATED_BRANCH }]);
  });

  it("fails closed on malformed pull request identity or creation data", () => {
    expect(
      selectExpiredFallbackPullRequests(
        [
          { number: 0, created_at: OLD, head: { ref: GENERATED_BRANCH } },
          {
            number: 1,
            created_at: null,
            head: { ref: GENERATED_BRANCH }
          },
          { number: 2, created_at: OLD, head: null }
        ],
        BRANCH_PREFIX,
        REPOSITORY,
        DEFAULT_BRANCH,
        CUTOFF
      )
    ).toEqual([]);
  });
});

describe("selectOpenPullRequestHeadRefs", () => {
  it("selects open head refs from the fixture repository", () => {
    expect(
      selectOpenPullRequestHeadRefs(
        [
          [
            pull({ number: 1, createdAt: NEW, headRef: GENERATED_BRANCH }),
            pull({
              number: 2,
              createdAt: NEW,
              headRef: "radius/setup-fork-workflows-1",
              headRepository: "fork/repo"
            })
          ]
        ],
        REPOSITORY
      )
    ).toEqual([GENERATED_BRANCH]);
  });
});

describe("selectExpiredFallbackBranches", () => {
  it("selects exact old fallback refs and normalizes the refs/heads prefix", () => {
    expect(
      selectExpiredFallbackBranches(
        [
          [
            { ref: `refs/heads/${GENERATED_BRANCH}`, created_at: OLD },
            {
              ref: "refs/heads/radius/setup-new-workflows-1788177600000",
              created_at: NEW
            },
            { ref: "refs/heads/radius/setup-dev", created_at: OLD },
            { ref: "refs/heads/feature/other", created_at: OLD }
          ]
        ],
        BRANCH_PREFIX,
        CUTOFF
      )
    ).toEqual([GENERATED_BRANCH]);
  });

  it("does not select fallback refs without a valid commit creation time", () => {
    expect(
      selectExpiredFallbackBranches(
        [
          null,
          { ref: 42, created_at: OLD },
          { ref: `refs/heads/${GENERATED_BRANCH}` },
          { ref: `refs/heads/${GENERATED_BRANCH}`, created_at: "invalid" }
        ],
        BRANCH_PREFIX,
        CUTOFF
      )
    ).toEqual([]);
  });

  it("does not select fallback branches referenced by an open pull request", () => {
    expect(
      selectExpiredFallbackBranches(
        [{ ref: `refs/heads/${GENERATED_BRANCH}`, created_at: OLD }],
        BRANCH_PREFIX,
        CUTOFF,
        [GENERATED_BRANCH]
      )
    ).toEqual([]);
  });
});

function pull({
  number,
  createdAt,
  headRef,
  headRepository = REPOSITORY,
  baseRef = DEFAULT_BRANCH
}: {
  readonly number: number;
  readonly createdAt: string;
  readonly headRef: string;
  readonly headRepository?: string;
  readonly baseRef?: string;
}): unknown {
  return {
    number,
    created_at: createdAt,
    head: {
      ref: headRef,
      repo: { full_name: headRepository }
    },
    base: {
      ref: baseRef,
      repo: { full_name: REPOSITORY }
    }
  };
}
