import { describe, it, expect } from "vitest";
import {
  appRegistrationName,
  clusterName,
  cloudE2ELeaseCommitMessage,
  CLOUD_E2E_LEASE_OWNER_PREFIX,
  CLOUD_E2E_LEASE_REF,
  describeUnprovisionedFixtureRepository,
  describePreservedFixtureState,
  ENVIRONMENT_NAME_PREFIX,
  environmentName,
  findUnprovisionedFixtureFields,
  FIXTURE_BASELINE_SHA,
  FIXTURE_REPO_DEFAULT_BRANCH,
  FIXTURE_REPOSITORY,
  FIXTURE_REPOSITORY_PIN,
  isFixtureRepositoryProvisioned,
  parseCloudE2ELeaseOwnerRunId,
  RESOURCE_GROUP_PREFIX,
  resolveFixtureClusterTarget,
  resolveFixtureLocation,
  resolveFixturePreserveState,
  resourceGroupName,
  resourceGroupScope,
  shortenUniqueId,
  WORKFLOW_FALLBACK_BRANCH_PREFIX
} from "./fixture-repository.js";

describe("pinned baseline constants", () => {
  it("pins the baseline commit as a single 40-character SHA", () => {
    expect(FIXTURE_BASELINE_SHA).toMatch(/^[0-9a-f]{40}$/);
  });

  it("names a default branch and a composed owner/name repository", () => {
    expect(FIXTURE_REPO_DEFAULT_BRANCH).not.toBe("");
    expect(FIXTURE_REPOSITORY.split("/")).toHaveLength(2);
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

describe("resolveFixturePreserveState", () => {
  it("reclaims by default, which is the state every scheduled run is in", () => {
    // GitHub supplies an empty string for an input the trigger never set, so
    // "absent" and "empty" must both mean reclaim.
    expect(resolveFixturePreserveState(undefined)).toBe(false);
    expect(resolveFixturePreserveState("")).toBe(false);
    expect(resolveFixturePreserveState("   ")).toBe(false);
  });

  it("accepts the values a boolean workflow input actually produces", () => {
    expect(resolveFixturePreserveState("true")).toBe(true);
    expect(resolveFixturePreserveState("false")).toBe(false);
    expect(resolveFixturePreserveState("1")).toBe(true);
    expect(resolveFixturePreserveState("0")).toBe(false);
    expect(resolveFixturePreserveState(" TRUE ")).toBe(true);
  });

  it.each(["yes", "no", "on", "preserve", "TRUEISH"])(
    "rejects %p rather than guessing which way it leans",
    (value) => {
      // A typo that read as "preserve" would strand a lease and a live
      // workload; one that read as "reclaim" would delete the evidence the
      // operator asked to keep. Neither is safe to infer.
      expect(() => resolveFixturePreserveState(value)).toThrow(
        /AIEXT_CLOUD_E2E_PRESERVE_STATE must be "true" or "false"/
      );
    }
  );
});

describe("describePreservedFixtureState", () => {
  const base = {
    repository: "radius-project/ai-extensions-fixture",
    environmentName: "radtest-abc123",
    resourceGroup: "ai_extensions_test",
    clusterName: "ai_extensions_aks"
  };

  it("names every surface the operator has to go look at", () => {
    const report = describePreservedFixtureState({
      ...base,
      application: "cloud-e2e",
      namespace: "default-cloud-e2e"
    });

    expect(report).toContain("radius-project/ai-extensions-fixture");
    expect(report).toContain("radtest-abc123");
    expect(report).toContain("ai_extensions_aks");
    expect(report).toContain("ai_extensions_test");
    expect(report).toContain("default-cloud-e2e");
  });

  it("spells out the commands that read the preserved cluster state", () => {
    const report = describePreservedFixtureState({
      ...base,
      application: "cloud-e2e",
      namespace: "default-cloud-e2e"
    });

    expect(report).toContain(
      "az aks get-credentials -g ai_extensions_test -n ai_extensions_aks"
    );
    expect(report).toContain(
      "kubectl get all -n default-cloud-e2e --show-labels"
    );
  });

  it("still reports the run when it failed before anything was deployed", () => {
    // The journey can fail in its first test, long before an application name
    // exists. The spec tracks that name as an empty string until then, so the
    // report must not print a half-formed namespace or "undefined".
    for (const state of [base, { ...base, application: "", namespace: "" }]) {
      const report = describePreservedFixtureState(state);

      expect(report).not.toContain("undefined");
      expect(report).not.toContain("kubectl");
      expect(report).toContain("radtest-abc123");
    }
  });

  it("states the cost so a preserved run is not mistaken for a clean one", () => {
    const report = describePreservedFixtureState(base);

    expect(report).toContain("Nothing was reclaimed");
    expect(report).toContain("clean-slate probe will fail");
  });
});
