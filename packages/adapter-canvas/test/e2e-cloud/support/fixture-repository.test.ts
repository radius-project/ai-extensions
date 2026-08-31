import { describe, it, expect } from "vitest";
import {
  appRegistrationName,
  clusterName,
  describeUnprovisionedFixtureRepository,
  environmentName,
  findUnprovisionedFixtureFields,
  FIXTURE_BASELINE_SHA,
  FIXTURE_REPO_DEFAULT_BRANCH,
  FIXTURE_REPOSITORY,
  FIXTURE_REPOSITORY_PIN,
  isFixtureRepositoryProvisioned,
  RESOURCE_GROUP_PREFIX,
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

  it("uses a resource group prefix the Radius purge job already sweeps", () => {
    expect(RESOURCE_GROUP_PREFIX.startsWith("radtest-")).toBe(true);
  });

  it("knows the branch prefix the product falls back to without workflow scope", () => {
    expect(WORKFLOW_FALLBACK_BRANCH_PREFIX).toBe("radius/setup-");
  });
});

describe("isFixtureRepositoryProvisioned", () => {
  // The repository is deliberately not provisioned on this branch. Asserting
  // the predicate reports that keeps a placeholder from ever reading as a real
  // cloud result, and this expectation is what fails loudly at the moment
  // someone bumps the constants without also updating the suite.
  it("reports the placeholder constants as unprovisioned", () => {
    expect(isFixtureRepositoryProvisioned()).toBe(false);
  });

  it("names every constant still holding a placeholder", () => {
    const description = describeUnprovisionedFixtureRepository();

    expect(description).toContain("FIXTURE_REPO_OWNER");
    expect(description).toContain("FIXTURE_REPO_NAME");
    expect(description).toContain("FIXTURE_BASELINE_SHA");
    expect(description).toContain("fixture-repository.ts");
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
  it("prefixes the resource group so the shared purge job reclaims it", () => {
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
