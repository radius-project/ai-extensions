import { describe, it, expect } from "vitest";
import {
  appRegistrationName,
  clusterName,
  cloudE2ELeaseCommitMessage,
  CLOUD_E2E_LEASE_OWNER_PREFIX,
  CLOUD_E2E_LEASE_REF,
  describeUnprovisionedFixtureRepository,
  ENVIRONMENT_NAME_PREFIX,
  environmentName,
  findUnprovisionedFixtureFields,
  FIXTURE_APPLICATION_NAME,
  FIXTURE_AWS_BASELINE_SHA,
  FIXTURE_AWS_FAILED_DEPLOY_SHA,
  FIXTURE_BASELINE_SHA,
  FIXTURE_KUBERNETES_NAMESPACE,
  FIXTURE_RADIUS_ENVIRONMENT_NAMESPACE,
  FIXTURE_REPO_DEFAULT_BRANCH,
  FIXTURE_REPOSITORY,
  FIXTURE_REPOSITORY_PIN,
  FIXTURE_OVERRIDE_VARIABLES,
  isContinuousIntegration,
  isFixtureRepositoryProvisioned,
  parseCloudE2ELeaseOwnerRunId,
  PINNED_FIXTURE,
  RESOURCE_GROUP_PREFIX,
  resolveFixtureSelection,
  resolveFixtureClusterTarget,
  resolveFixtureLocation,
  resourceGroupName,
  resourceGroupScope,
  shortenUniqueId,
  WORKFLOW_FALLBACK_BRANCH_PREFIX
} from "./fixture-repository.js";

describe("pinned baseline constants", () => {
  it("pins three different 40-character commits", () => {
    const pins = [
      FIXTURE_BASELINE_SHA,
      FIXTURE_AWS_BASELINE_SHA,
      FIXTURE_AWS_FAILED_DEPLOY_SHA
    ];
    for (const sha of pins) expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(new Set(pins).size).toBe(3);
  });

  it("selects the pinned commits in the shared repository by default", () => {
    expect(PINNED_FIXTURE).toEqual({
      repository: FIXTURE_REPOSITORY,
      baselineSha: FIXTURE_BASELINE_SHA,
      awsBaselineSha: FIXTURE_AWS_BASELINE_SHA,
      awsFailedDeploySha: FIXTURE_AWS_FAILED_DEPLOY_SHA,
      overridden: false
    });
  });

  it("names a default branch and a composed owner/name repository", () => {
    expect(FIXTURE_REPO_DEFAULT_BRANCH).not.toBe("");
    expect(FIXTURE_REPOSITORY.split("/")).toHaveLength(2);
  });

  it("derives the fixture Radius namespace from the selected Kubernetes namespace and application", () => {
    expect(FIXTURE_RADIUS_ENVIRONMENT_NAMESPACE).toBe(
      `${FIXTURE_KUBERNETES_NAMESPACE}-${FIXTURE_APPLICATION_NAME}`
    );
  });

  it("uses a resource group prefix the Radius purge job still sweeps as a safety net", () => {
    expect(RESOURCE_GROUP_PREFIX.startsWith("radtest-")).toBe(true);
  });

  it("knows the branch prefix used after a protected-branch commit failure", () => {
    expect(WORKFLOW_FALLBACK_BRANCH_PREFIX).toBe("radius/setup-");
  });

  it("exports the repository-scoped lease ref used by runs and cleanup", () => {
    expect(CLOUD_E2E_LEASE_REF).toBe("refs/heads/radius/cloud-e2e-lease");
  });

  // The cleanup workflow deletes GitHub Environments matching this prefix, so
  // it has to be the same string environmentName actually produces rather than
  // a second copy that could drift into deleting the wrong things.
  it("exports the environment prefix environmentName actually applies", () => {
    expect(environmentName("abc123")).toBe(`${ENVIRONMENT_NAME_PREFIX}abc123`);
  });

  describe("cloud E2E lease ownership", () => {
    it("round-trips a GitHub Actions run id through the lease commit message", () => {
      const message = cloudE2ELeaseCommitMessage(" 123456 ");

      expect(message).toBe(
        `Radius Cloud E2E lease\n\n${CLOUD_E2E_LEASE_OWNER_PREFIX}123456`
      );
      expect(parseCloudE2ELeaseOwnerRunId(message)).toBe("123456");
    });

    it.each(["", "0", "-1", "local", "12.5"])(
      "rejects an unverifiable run id %j",
      (runId) => {
        expect(() => cloudE2ELeaseCommitMessage(runId)).toThrow(
          "must be a positive integer"
        );
      }
    );

    it.each([
      ["a non-string message", null],
      ["a message without an owner field", "ordinary commit"],
      ["a zero owner", `${CLOUD_E2E_LEASE_OWNER_PREFIX}0`],
      ["a non-numeric owner", `${CLOUD_E2E_LEASE_OWNER_PREFIX}local`]
    ])("fails closed for %s", (_label, message) => {
      expect(parseCloudE2ELeaseOwnerRunId(message)).toBeNull();
    });
  });
});

describe("isFixtureRepositoryProvisioned", () => {
  it("reports the checked-in fixture pin as provisioned", () => {
    expect(isFixtureRepositoryProvisioned()).toBe(true);
    expect(describeUnprovisionedFixtureRepository()).toBe(
      "The fixture repository is provisioned."
    );
  });
});

describe("findUnprovisionedFixtureFields", () => {
  const provisioned = {
    owner: "radius-project",
    name: "canvas-e2e-fixture",
    baselineSha: "a".repeat(40)
  };

  it("reports nothing missing once every constant is real", () => {
    expect(findUnprovisionedFixtureFields(provisioned)).toEqual([]);
    expect(isFixtureRepositoryProvisioned(provisioned)).toBe(true);
    expect(describeUnprovisionedFixtureRepository(provisioned)).toBe(
      "The fixture repository is provisioned."
    );
  });

  it.each([
    [{ ...provisioned, owner: "TODO-owner" }, ["FIXTURE_REPO_OWNER"]],
    [{ ...provisioned, name: "TODO-repo" }, ["FIXTURE_REPO_NAME"]],
    [{ ...provisioned, baselineSha: "0".repeat(40) }, ["FIXTURE_BASELINE_SHA"]]
  ] as const)(
    "reports only the field still holding a placeholder",
    (pin, expected) => {
      expect(findUnprovisionedFixtureFields(pin)).toEqual([...expected]);
      expect(isFixtureRepositoryProvisioned(pin)).toBe(false);
    }
  );

  it("does not mistake a real SHA that merely starts with zeros", () => {
    expect(
      findUnprovisionedFixtureFields({
        ...provisioned,
        baselineSha: `00000${"b".repeat(35)}`
      })
    ).toEqual([]);
  });

  it("does not mistake an owner that merely contains TODO", () => {
    expect(
      findUnprovisionedFixtureFields({
        ...provisioned,
        owner: "not-a-TODO-owner"
      })
    ).toEqual([]);
  });

  it("defaults to the module's own pinned constants", () => {
    expect(findUnprovisionedFixtureFields()).toEqual(
      findUnprovisionedFixtureFields(FIXTURE_REPOSITORY_PIN)
    );
    expect(FIXTURE_REPOSITORY_PIN.baselineSha).toBe(FIXTURE_BASELINE_SHA);
  });
});

describe("run-scoped names", () => {
  it("prefixes the resource group so scheduled cleanup and the safety net can reclaim it", () => {
    expect(resourceGroupName("abc123")).toBe("radtest-canvas-abc123");
  });

  it("derives a distinct cluster and environment name from the same run id", () => {
    expect(clusterName("abc123")).toBe("aks-abc123");
    expect(environmentName("abc123")).toBe("radtest-abc123");
  });

  it.each([
    ["the resource group", resourceGroupName],
    ["the cluster", clusterName],
    ["the environment", environmentName]
  ])("gives two runs different names for %s", (_label, name) => {
    expect(name("run-one")).not.toBe(name("run-two"));
  });

  it.each([
    ["an empty id", ""],
    ["a whitespace-only id", "   "]
  ])("refuses to name a resource from %s", (_label, value) => {
    expect(() => resourceGroupName(value)).toThrow(
      "A run unique id is required"
    );
    expect(() => clusterName(value)).toThrow("A run unique id is required");
    expect(() => environmentName(value)).toThrow("A run unique id is required");
  });

  it("builds the resource-group scope the product assigns Contributor at", () => {
    expect(resourceGroupScope("sub-1", "radtest-canvas-abc")).toBe(
      "/subscriptions/sub-1/resourceGroups/radtest-canvas-abc"
    );
  });
});

describe("appRegistrationName", () => {
  it("mirrors the product's radius-deploy-<owner>-<repo> rule", () => {
    expect(appRegistrationName("octo/app")).toBe("radius-deploy-octo-app");
  });

  it("replaces only the separating slash, as the product does", () => {
    // The product calls String.replace with a string pattern, which replaces
    // the first occurrence only. Matching that exactly matters: a name built
    // differently would look for an app registration the product never created.
    expect(appRegistrationName("octo/app/extra")).toBe(
      "radius-deploy-octo-app/extra"
    );
  });

  it("is not run-scoped, so concurrent runs share one name", () => {
    expect(appRegistrationName("octo/app")).toBe(
      appRegistrationName("octo/app")
    );
  });

  it("defaults to the pinned fixture repository", () => {
    expect(appRegistrationName()).toBe(appRegistrationName(FIXTURE_REPOSITORY));
  });
});

describe("shortenUniqueId", () => {
  it("strips separators and lowercases so the id is safe in a resource name", () => {
    expect(shortenUniqueId("A1B2-C3D4-E5F6")).toBe("a1b2c3d4e5f6");
  });

  it("caps the length so composed names stay inside Azure's limits", () => {
    expect(shortenUniqueId("0123456789abcdef0123")).toBe("0123456789ab");
  });

  it("keeps a value already shorter than the cap", () => {
    expect(shortenUniqueId("abc")).toBe("abc");
  });

  it.each([
    ["an empty value", ""],
    ["punctuation only", "----"]
  ])("refuses %s, which would produce an unnamed resource", (_label, value) => {
    expect(() => shortenUniqueId(value)).toThrow(
      "must contain at least one alphanumeric character"
    );
  });
});

describe("resolveFixtureLocation", () => {
  it.each([
    ["an absent variable", undefined],
    ["an empty variable", ""],
    ["a whitespace-only variable", "   "]
  ])(
    "leaves the fixture's own default in place for %s",
    (_label, value: string | undefined) => {
      // undefined, not "": az group create --location "" fails in a way that
      // reads as an Azure fault rather than as an unset CI variable.
      expect(resolveFixtureLocation(value)).toBeUndefined();
    }
  );

  it("passes a region through unchanged", () => {
    expect(resolveFixtureLocation("westus3")).toBe("westus3");
  });

  it("normalizes surrounding whitespace and casing", () => {
    expect(resolveFixtureLocation("  WestUS3 ")).toBe("westus3");
  });

  it("accepts a region whose name ends in digits after letters", () => {
    expect(resolveFixtureLocation("eastus2euap")).toBe("eastus2euap");
  });

  it.each([
    ["a display name with a space", "West US 3"],
    ["a value starting with a digit", "3westus"],
    ["a value with punctuation", "west-us-3"]
  ])("rejects %s rather than passing it to az", (_label, value) => {
    expect(() => resolveFixtureLocation(value)).toThrow(
      "must be an Azure region"
    );
  });

  it("quotes the offending value so the failure names its own cause", () => {
    expect(() => resolveFixtureLocation("West US 3")).toThrow('"West US 3"');
  });
});

describe("resolveFixtureClusterTarget", () => {
  it("normalizes a complete precreated cluster target", () => {
    expect(
      resolveFixtureClusterTarget(
        " ai_extensions_test ",
        " ai_extensions_aks ",
        true
      )
    ).toEqual({
      resourceGroup: "ai_extensions_test",
      clusterName: "ai_extensions_aks"
    });
  });

  it("allows local runs to omit a precreated cluster", () => {
    expect(resolveFixtureClusterTarget(undefined, " ", false)).toBeUndefined();
  });

  it("requires the precreated cluster in CI", () => {
    expect(() =>
      resolveFixtureClusterTarget(undefined, undefined, true)
    ).toThrow("must identify the precreated CI cluster");
  });

  it.each([
    ["resource group", "resource-group", undefined],
    ["cluster name", undefined, "cluster"]
  ])("rejects a partial target missing the %s", (_label, group, cluster) => {
    expect(() => resolveFixtureClusterTarget(group, cluster, false)).toThrow(
      "must be set together"
    );
  });

  it.each([
    ["an invalid resource group", "bad/resource", "cluster", "RESOURCE_GROUP"],
    [
      "a resource group ending in a period",
      "bad.",
      "cluster",
      "RESOURCE_GROUP"
    ],
    [
      "an invalid cluster name",
      "resource-group",
      "_cluster",
      "AKS_CLUSTER_NAME"
    ]
  ])("rejects %s", (_label, group, cluster, variable) => {
    expect(() => resolveFixtureClusterTarget(group, cluster, false)).toThrow(
      variable
    );
  });

  it("accepts exact Azure resource-group and AKS name length limits", () => {
    expect(
      resolveFixtureClusterTarget(
        `a${"b".repeat(89)}`,
        `a${"b".repeat(61)}z`,
        true
      )
    ).toEqual({
      resourceGroup: `a${"b".repeat(89)}`,
      clusterName: `a${"b".repeat(61)}z`
    });
  });

  it.each([
    ["resource group", `a${"b".repeat(90)}`, "cluster", "RESOURCE_GROUP"],
    ["AKS cluster", "resource-group", `a${"b".repeat(62)}z`, "AKS_CLUSTER_NAME"]
  ])(
    "rejects a %s one character over its limit",
    (_label, group, cluster, variable) => {
      expect(() => resolveFixtureClusterTarget(group, cluster, true)).toThrow(
        variable
      );
    }
  );
});

describe("resolveFixtureSelection", () => {
  const OVERRIDE = {
    RADIUS_CLOUD_E2E_FIXTURE_REPOSITORY: "octo-cat/my.fixture_copy",
    RADIUS_CLOUD_E2E_FIXTURE_BASELINE_SHA: "A".repeat(40),
    RADIUS_CLOUD_E2E_FIXTURE_AWS_BASELINE_SHA: "b".repeat(40),
    RADIUS_CLOUD_E2E_FIXTURE_AWS_FAILED_DEPLOY_SHA: "c".repeat(40)
  };

  it("uses the pinned fixture when no override is set", () => {
    expect(resolveFixtureSelection({})).toBe(PINNED_FIXTURE);
  });

  it("uses the pinned fixture in CI when no override is set", () => {
    expect(resolveFixtureSelection({ CI: "true" })).toBe(PINNED_FIXTURE);
  });

  it("treats whitespace-only values as unset", () => {
    expect(
      resolveFixtureSelection(
        Object.fromEntries(
          FIXTURE_OVERRIDE_VARIABLES.map((name) => [name, " "])
        )
      )
    ).toBe(PINNED_FIXTURE);
  });

  it("selects a developer's copy when all four are set", () => {
    expect(
      resolveFixtureSelection({
        ...OVERRIDE,
        RADIUS_CLOUD_E2E_FIXTURE_REPOSITORY: " octo-cat/my.fixture_copy "
      })
    ).toEqual({
      repository: "octo-cat/my.fixture_copy",
      baselineSha: "a".repeat(40),
      awsBaselineSha: "b".repeat(40),
      awsFailedDeploySha: "c".repeat(40),
      overridden: true
    });
  });

  // A half-set override is a hard failure, never a partial override: a copy's
  // commits are not the pinned ones.
  it.each(
    FIXTURE_OVERRIDE_VARIABLES.flatMap((name) => [
      [`only ${name}`, { [name]: OVERRIDE[name] }],
      [
        `all but ${name}`,
        Object.fromEntries(
          Object.entries(OVERRIDE).filter(([key]) => key !== name)
        )
      ]
    ])
  )("refuses %s", (_label, env) => {
    const missing = FIXTURE_OVERRIDE_VARIABLES.filter((name) => !(name in env));
    expect(() => resolveFixtureSelection(env)).toThrow(
      `Set ${FIXTURE_OVERRIDE_VARIABLES.join(", ")} together. Missing: ${missing.join(", ")}.`
    );
  });

  // Refused rather than ignored: ignoring would let a developer believe they
  // were testing their copy while they used the shared repository.
  it.each(["true", "1", "false"])(
    "refuses any override when CI is %j",
    (ci) => {
      expect(() => resolveFixtureSelection({ ...OVERRIDE, CI: ci })).toThrow(
        `${FIXTURE_OVERRIDE_VARIABLES.join(", ")} must not be set when CI is set.`
      );
      expect(() =>
        resolveFixtureSelection({
          RADIUS_CLOUD_E2E_FIXTURE_REPOSITORY:
            OVERRIDE.RADIUS_CLOUD_E2E_FIXTURE_REPOSITORY,
          CI: ci
        })
      ).toThrow(
        "RADIUS_CLOUD_E2E_FIXTURE_REPOSITORY must not be set when CI is set."
      );
    }
  );

  it.each(["owner", "owner/", "/name", "owner/name/extra", "own er/name"])(
    "refuses repository %j",
    (repository) => {
      expect(() =>
        resolveFixtureSelection({
          ...OVERRIDE,
          RADIUS_CLOUD_E2E_FIXTURE_REPOSITORY: repository
        })
      ).toThrow("RADIUS_CLOUD_E2E_FIXTURE_REPOSITORY must be owner/name");
    }
  );

  it.each(
    FIXTURE_OVERRIDE_VARIABLES.slice(1).flatMap((name) => [
      [name, "a".repeat(39)],
      [name, "a".repeat(41)],
      [name, "g".repeat(40)],
      [name, "main"]
    ])
  )("refuses %s %j", (name, sha) => {
    expect(() => resolveFixtureSelection({ ...OVERRIDE, [name]: sha })).toThrow(
      `${name} must be a full 40-character commit SHA`
    );
  });

  it.each([
    [
      "the two baselines",
      { RADIUS_CLOUD_E2E_FIXTURE_AWS_BASELINE_SHA: "A".repeat(40) }
    ],
    [
      "the AWS baseline and failed deploy",
      { RADIUS_CLOUD_E2E_FIXTURE_AWS_FAILED_DEPLOY_SHA: "b".repeat(40) }
    ]
  ])("refuses the same commit for %s", (_label, patch) => {
    expect(() => resolveFixtureSelection({ ...OVERRIDE, ...patch })).toThrow(
      "must name three different commits"
    );
  });
});

describe("isContinuousIntegration", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["  ", false],
    ["true", true],
    ["false", true]
  ])("treats CI=%j as %s", (ci, expected) => {
    expect(isContinuousIntegration({ CI: ci })).toBe(expected);
  });
});
