import { describe, expect, it } from "vitest";
import { discoverStatusText, formatServesReposLabel } from "./azure-oidc.js";
import * as compatibility from "./azure-oidc.js";
import * as platforms from "@radius-project/core/platforms";

describe("browser-safe Azure identity compatibility exports", () => {
  it.each([
    "isUuid",
    "parseCallerIdentity",
    "resolveOidcSubject",
    "decideAppSelection",
    "decideRadiusAppOwnership",
    "buildRadiusAppProvenanceTags",
    "selectEnvironmentFederatedCredentials"
  ] as const)("forwards %s without a second implementation", (name) => {
    expect(compatibility[name]).toBe(platforms[name]);
  });
});
describe("discoverStatusText", () => {
  it("azure: summarizes counts on success", () => {
    expect(
      discoverStatusText({ clusters: [1, 2], resourceGroups: [1] }, "azure")
    ).toBe("Found 2 cluster(s), 1 resource group(s)");
  });

  it("azure: prefers the resourceGroups error over a clusters error", () => {
    expect(
      discoverStatusText(
        {
          clusters: [],
          resourceGroups: [],
          errors: { clusters: "aks boom", resourceGroups: "rg boom" }
        },
        "azure"
      )
    ).toBe("Discovery failed: rg boom");
  });

  it("azure: surfaces a clusters error when only that failed", () => {
    expect(
      discoverStatusText(
        {
          clusters: [],
          resourceGroups: [{}],
          errors: { clusters: "token not acquirable" }
        },
        "azure"
      )
    ).toBe("Discovery failed: token not acquirable");
  });

  it("azure: surfaces a namespace error when resource enumeration succeeded", () => {
    expect(
      discoverStatusText(
        {
          clusters: [{}],
          resourceGroups: [{}],
          errors: { namespaces: "selected cluster unavailable" }
        },
        "azure"
      )
    ).toBe("Discovery failed: selected cluster unavailable");
  });

  it("azure: top-level error wins", () => {
    expect(
      discoverStatusText(
        { error: "outer fail", errors: { resourceGroups: "inner" } },
        "azure"
      )
    ).toBe("Discovery failed: outer fail");
  });

  it("aws: summarizes counts on success", () => {
    expect(discoverStatusText({ clusters: [1], vpcs: [1, 2, 3] }, "aws")).toBe(
      "Found 1 cluster(s), 3 VPC(s)"
    );
  });

  it("aws: prefers the vpcs error", () => {
    expect(
      discoverStatusText(
        {
          clusters: [],
          vpcs: [],
          subnets: [],
          errors: {
            clusters: "eks boom",
            vpcs: "vpc boom",
            subnets: "subnet boom"
          }
        },
        "aws"
      )
    ).toBe("Discovery failed: vpc boom");
  });

  it("defaults to azure summary with empty input", () => {
    expect(discoverStatusText()).toBe(
      "Found 0 cluster(s), 0 resource group(s)"
    );
  });
});

describe("formatServesReposLabel", () => {
  it("returns empty string for no repos", () => {
    expect(formatServesReposLabel([])).toBe("");
    expect(formatServesReposLabel(undefined)).toBe("");
    expect(formatServesReposLabel(null)).toBe("");
  });

  it("lists up to three repos inline", () => {
    expect(formatServesReposLabel(["a/b"])).toBe("Serves: a/b");
    expect(formatServesReposLabel(["a/b", "c/d", "e/f"])).toBe(
      "Serves: a/b, c/d, e/f"
    );
  });

  it("truncates with a +N more suffix past three", () => {
    expect(formatServesReposLabel(["a/b", "c/d", "e/f", "g/h", "i/j"])).toBe(
      "Serves: a/b, c/d, e/f +2 more"
    );
  });
});
