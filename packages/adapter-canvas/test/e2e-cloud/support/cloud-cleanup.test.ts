import { describe, expect, it } from "vitest";
import {
  selectExpiredApplications,
  selectExpiredDirectoryObjects,
  selectExpiredEnvironments,
  selectExpiredFallbackBranches,
  selectExpiredFallbackPullRequests,
  selectExpiredServicePrincipals,
  selectAppIdsWithUnprocessedServicePrincipals,
  selectExpectedRoleAssignments,
  selectLeakedClusterWorkloads,
  selectOpenPullRequestHeadRefs,
  selectStaleStatePackages,
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

  it("accepts fractional-second timestamps (up to 7 digits)", () => {
    expect(
      selectExpiredDirectoryObjects(
        [
          {
            id: "fractional",
            displayName: APP,
            createdDateTime: "2026-08-31T05:59:59.1234567Z"
          }
        ],
        APP,
        CUTOFF
      )
    ).toEqual([{ id: "fractional" }]);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["malformed", "yesterday"],
    ["calendar-invalid", "2026-02-30T05:00:00Z"],
    ["excess fractional precision", "2026-08-31T05:59:59.12345678Z"]
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
    ).toEqual([{ id: "principal-old", appId: "client-old" }]);
  });
});

describe("selectAppIdsWithUnprocessedServicePrincipals", () => {
  const principals = [
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
    }
  ];

  it("blocks an application whose matching principal was not selected", () => {
    expect(
      selectAppIdsWithUnprocessedServicePrincipals(
        principals,
        APP,
        ["client-old"],
        [{ id: "principal-old", appId: "client-old" }]
      )
    ).toEqual(["client-old"]);
  });

  it("blocks an application whose principal has no usable creation time", () => {
    expect(
      selectAppIdsWithUnprocessedServicePrincipals(
        [{ id: "principal-undated", appId: "client-old", displayName: APP }],
        APP,
        ["client-old"],
        []
      )
    ).toEqual(["client-old"]);
  });

  it("does not block when every matching principal was selected", () => {
    expect(
      selectAppIdsWithUnprocessedServicePrincipals(
        [principals[0]],
        APP,
        ["client-old"],
        [{ id: "principal-old", appId: "client-old" }]
      )
    ).toEqual([]);
  });

  it("ignores principals belonging to another application or display name", () => {
    expect(
      selectAppIdsWithUnprocessedServicePrincipals(
        [
          { id: "other-app", appId: "client-other", displayName: APP },
          {
            id: "other-name",
            appId: "client-old",
            displayName: "unrelated-app"
          }
        ],
        APP,
        ["client-old"],
        []
      )
    ).toEqual([]);
  });

  it("rejects a non-array service principal response", () => {
    expect(() =>
      selectAppIdsWithUnprocessedServicePrincipals(null, APP, [], [])
    ).toThrow("Microsoft Graph service principals");
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

  it("never selects the configured shared resource group", () => {
    expect(
      selectTestResourceGroups(
        [
          {
            name: "radtest-canvas-shared",
            tags: {
              "github-run-id": "1234",
              "radius-canvas-e2e": "true"
            }
          },
          {
            name: "radtest-canvas-disposable",
            tags: {
              "github-run-id": "5678",
              "radius-canvas-e2e": "true"
            }
          }
        ],
        "radtest-canvas",
        "RADTEST-CANVAS-SHARED"
      )
    ).toEqual([{ name: "radtest-canvas-disposable", runId: "5678" }]);
  });

  it("rejects an unreadable listing", () => {
    expect(() => selectTestResourceGroups({}, "radtest-canvas")).toThrow(
      "did not return a JSON array"
    );
  });
});

describe("selectExpectedRoleAssignments", () => {
  const scope = "/subscriptions/sub/resourceGroups/shared";
  const clusterScope = `${scope}/providers/Microsoft.ContainerService/managedClusters/aks`;
  const expected = [
    { roleDefinitionName: "Contributor", scope },
    {
      roleDefinitionName: "Azure Kubernetes Service RBAC Cluster Admin",
      scope: clusterScope
    }
  ];

  it("selects only allowlisted assignments for the exact principal", () => {
    expect(
      selectExpectedRoleAssignments(
        [
          {
            id: "assignment-1",
            principalId: "SP-1",
            roleDefinitionName: "Contributor",
            scope
          },
          {
            id: "assignment-2",
            principalId: "sp-1",
            roleDefinitionName: "Azure Kubernetes Service RBAC Cluster Admin",
            scope: clusterScope
          },
          {
            id: "baseline",
            principalId: "cluster-identity",
            roleDefinitionName: "Contributor",
            scope
          }
        ],
        "sp-1",
        expected
      )
    ).toEqual([
      {
        id: "assignment-1",
        roleDefinitionName: "Contributor",
        scope
      },
      {
        id: "assignment-2",
        roleDefinitionName: "Azure Kubernetes Service RBAC Cluster Admin",
        scope: clusterScope
      }
    ]);
  });

  it("refuses an unexpected role for the target principal", () => {
    expect(() =>
      selectExpectedRoleAssignments(
        [
          {
            id: "assignment-owner",
            principalId: "sp-1",
            roleDefinitionName: "Owner",
            scope
          }
        ],
        "sp-1",
        expected
      )
    ).toThrow(/Refusing to delete unexpected role assignment "Owner"/);
  });

  it.each([
    ["missing principal", "", "service-principal id"],
    [
      "malformed assignment",
      "sp-1",
      "did not include id, roleDefinitionName, and scope"
    ]
  ])("rejects %s input", (_label, principalId, message) => {
    expect(() =>
      selectExpectedRoleAssignments(
        principalId ?
          [{ id: "", principalId, roleDefinitionName: "Contributor", scope }]
        : [],
        principalId,
        expected
      )
    ).toThrow(message);
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

describe("selectStaleStatePackages", () => {
  const prefix = "ai-extensions-fixture-radius-state-";
  const cutoff = "2026-09-17T12:00:00Z";
  const stale = "2026-09-17T07:54:10Z";
  const fresh = "2026-09-17T17:30:33Z";

  it("selects every state package the fixture has left behind", () => {
    // Cleanup restores a pristine fixture and nothing shares it, so a package
    // whose environment is long gone is reclaimed rather than stranded.
    const packages = [
      [
        {
          name: `${prefix}radtest-6fe9780807f4-53cf5e9d4628`,
          updated_at: stale
        },
        {
          name: `${prefix}radtest-f471e24d92f0-181627bff61c`,
          updated_at: stale
        }
      ]
    ];

    expect(selectStaleStatePackages(packages, prefix, cutoff)).toEqual([
      `${prefix}radtest-6fe9780807f4-53cf5e9d4628`,
      `${prefix}radtest-f471e24d92f0-181627bff61c`
    ]);
  });

  it("leaves a package that is younger than the cutoff", () => {
    // The age check is the only thing standing between this sweep and a run
    // that is still writing its state.
    const packages = [
      [
        {
          name: `${prefix}radtest-f471e24d92f0-181627bff61c`,
          updated_at: fresh
        }
      ]
    ];

    expect(selectStaleStatePackages(packages, prefix, cutoff)).toEqual([]);
  });

  it("ignores packages outside the fixture's state prefix", () => {
    const packages = [
      [
        { name: "radius-project-canvas", updated_at: stale },
        {
          name: "some-other-repo-radius-state-radtest-1-aaaaaaaaaaaa",
          updated_at: stale
        }
      ]
    ];

    expect(selectStaleStatePackages(packages, prefix, cutoff)).toEqual([]);
  });

  it("ignores a package that shares the prefix but is not state", () => {
    // The writer always appends an environment slug and twelve hex characters,
    // so a package that merely starts with the prefix belongs to someone else.
    const packages = [
      [
        { name: `${prefix}radtest-1-not-hex-here`, updated_at: stale },
        { name: `${prefix}radtest-1-53cf5e9d462`, updated_at: stale },
        { name: `${prefix}53cf5e9d4628`, updated_at: stale }
      ]
    ];

    expect(selectStaleStatePackages(packages, prefix, cutoff)).toEqual([]);
  });

  it("keeps a package whose timestamp cannot be read", () => {
    // An unreadable timestamp must fail towards keeping data, never towards
    // deleting state that might still be in use.
    const packages = [
      [
        {
          name: `${prefix}radtest-1-aaaaaaaaaaaa`,
          updated_at: "not-a-timestamp"
        },
        { name: `${prefix}radtest-2-bbbbbbbbbbbb` }
      ]
    ];

    expect(selectStaleStatePackages(packages, prefix, cutoff)).toEqual([]);
  });

  it("flattens paginated pages", () => {
    const packages = [
      [{ name: `${prefix}radtest-1-aaaaaaaaaaaa`, updated_at: stale }],
      [{ name: `${prefix}radtest-2-bbbbbbbbbbbb`, updated_at: stale }]
    ];

    expect(selectStaleStatePackages(packages, prefix, cutoff)).toEqual([
      `${prefix}radtest-1-aaaaaaaaaaaa`,
      `${prefix}radtest-2-bbbbbbbbbbbb`
    ]);
  });

  it("refuses an empty prefix rather than matching every package", () => {
    expect(() => selectStaleStatePackages([], "  ", cutoff)).toThrow(
      /state package prefix is required/
    );
  });

  it("refuses a payload that is not an array", () => {
    expect(() =>
      selectStaleStatePackages({ packages: [] }, prefix, cutoff)
    ).toThrow(/GHCR packages did not return a JSON array/);
  });
});

describe("selectLeakedClusterWorkloads", () => {
  const prefix = "radtest-";
  const application = "cloud-e2e";
  const cutoff = "2026-09-17T12:00:00Z";
  const stale = "2026-09-16T21:41:02Z";
  const fresh = "2026-09-17T17:30:33Z";

  const workload = (
    kind: string,
    name: string,
    namespace: string,
    environment: string,
    creationTimestamp = stale
  ) => ({
    kind,
    metadata: {
      name,
      namespace,
      creationTimestamp,
      labels: {
        "radapp.io/application": application,
        "radapp.io/environment": environment
      }
    }
  });

  it("reclaims a workload the fixture left running", () => {
    // Observed leak: a Deployment still running 14 hours after its run, rolled
    // by every later run instead of being noticed as new.
    const payload = {
      items: [
        workload("Deployment", "sleeper", "default", "radtest-f471e24d92f0")
      ]
    };

    expect(
      selectLeakedClusterWorkloads(payload, prefix, application, cutoff)
    ).toEqual([
      {
        kind: "Deployment",
        name: "sleeper",
        namespace: "default",
        environment: "radtest-f471e24d92f0"
      }
    ]);
  });

  it("leaves a workload a run may still be using", () => {
    // A reused object keeps the creation timestamp of the run that first
    // rendered it, so only a genuinely new object is protected here.
    const payload = {
      items: [
        workload("Deployment", "sleeper", "default", "radtest-live", fresh)
      ]
    };

    expect(
      selectLeakedClusterWorkloads(payload, prefix, application, cutoff)
    ).toEqual([]);
  });

  it("keeps a workload whose creation timestamp cannot be read", () => {
    const payload = {
      items: [
        workload("Deployment", "sleeper", "default", "radtest-1", "not-a-time"),
        {
          kind: "Deployment",
          metadata: {
            name: "undated",
            namespace: "default",
            labels: {
              "radapp.io/application": application,
              "radapp.io/environment": "radtest-2"
            }
          }
        }
      ]
    };

    expect(
      selectLeakedClusterWorkloads(payload, prefix, application, cutoff)
    ).toEqual([]);
  });

  it("ignores objects that carry no fixture environment label", () => {
    const payload = {
      items: [
        workload("Deployment", "someone-else", "default", "prod-environment"),
        { kind: "Deployment", metadata: { name: "bare", namespace: "default" } }
      ]
    };

    expect(
      selectLeakedClusterWorkloads(payload, prefix, application, cutoff)
    ).toEqual([]);
  });

  it("ignores an object belonging to a different application", () => {
    // The environment prefix alone does not make somebody else's workload ours
    // to delete.
    const payload = {
      items: [workload("Deployment", "theirs", "default", "radtest-1")]
    };
    payload.items[0].metadata.labels["radapp.io/application"] = "other-app";

    expect(
      selectLeakedClusterWorkloads(payload, prefix, application, cutoff)
    ).toEqual([]);
  });

  it("ignores an object carrying no application label", () => {
    const payload = {
      items: [
        {
          kind: "Deployment",
          metadata: {
            name: "unlabelled",
            namespace: "default",
            creationTimestamp: stale,
            labels: { "radapp.io/environment": "radtest-1" }
          }
        }
      ]
    };

    expect(
      selectLeakedClusterWorkloads(payload, prefix, application, cutoff)
    ).toEqual([]);
  });

  it("collects every kind the sweep is given", () => {
    const payload = {
      items: [
        workload("Deployment", "sleeper", "default", "radtest-1"),
        workload("HorizontalPodAutoscaler", "sleeper", "default", "radtest-1"),
        workload("Service", "sleeper", "default", "radtest-1")
      ]
    };

    expect(
      selectLeakedClusterWorkloads(payload, prefix, application, cutoff).map(
        (item) => item.kind
      )
    ).toEqual(["Deployment", "HorizontalPodAutoscaler", "Service"]);
  });

  it("refuses the control-plane namespace as well as Kubernetes' own", () => {
    // Nothing this suite creates belongs in one, so a match there means the
    // label is being misread and deleting would be destructive.
    for (const namespace of [
      "kube-system",
      "kube-public",
      "kube-node-lease",
      "radius-system"
    ]) {
      const payload = {
        items: [workload("Deployment", "sleeper", namespace, "radtest-1")]
      };

      expect(() =>
        selectLeakedClusterWorkloads(payload, prefix, application, cutoff)
      ).toThrow(new RegExp(`system namespace "${namespace}"`));
    }
  });

  it("refuses an object that is missing its identity", () => {
    const payload = {
      items: [
        {
          kind: "Deployment",
          metadata: {
            creationTimestamp: stale,
            labels: {
              "radapp.io/environment": "radtest-1",
              "radapp.io/application": application
            }
          }
        }
      ]
    };

    expect(() =>
      selectLeakedClusterWorkloads(payload, prefix, application, cutoff)
    ).toThrow(/is missing a kind, name or namespace/);
  });

  it("refuses an empty prefix rather than matching every environment", () => {
    expect(() =>
      selectLeakedClusterWorkloads({ items: [] }, " ", application, cutoff)
    ).toThrow(/environment prefix is required/);
  });

  it("refuses an empty application rather than matching every workload", () => {
    expect(() =>
      selectLeakedClusterWorkloads({ items: [] }, prefix, " ", cutoff)
    ).toThrow(/application name is required/);
  });

  it("refuses a payload that is not a kubectl list", () => {
    expect(() =>
      selectLeakedClusterWorkloads([], prefix, application, cutoff)
    ).toThrow(/Kubernetes objects did not return a JSON array/);
  });
});
