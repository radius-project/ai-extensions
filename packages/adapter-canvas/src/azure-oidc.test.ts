import { describe, expect, it } from "vitest";
import { discoverStatusText, formatServesReposLabel } from "./azure-oidc.js";
import * as compatibility from "./azure-oidc.js";
import * as platforms from "@radius-project/core/platforms";
import type { AwsCliErrorKind } from "@radius-project/core/platforms";

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

  describe("aws", () => {
    const usable = { id: "a", usable: true };
    const configMap = { id: "b", usable: false, unusableReason: "config-map" };
    const lostSession = {
      id: "c",
      usable: false,
      unusableReason: "not-described",
      describeErrorKind: "credentials"
    };
    const aws = (data: Parameters<typeof discoverStatusText>[0]) =>
      discoverStatusText(data, "aws", "us-west-2");

    it("counts the clusters it found", () => {
      expect(aws({ clusters: [usable, usable] })).toBe(
        "Found 2 EKS clusters in us-west-2."
      );
      expect(aws({ clusters: [usable] })).toBe(
        "Found 1 EKS cluster in us-west-2."
      );
      expect(aws({ clusters: [usable, configMap, configMap] })).toBe(
        "Found 3 EKS clusters in us-west-2. 1 can be used."
      );
      expect(aws({ clusters: [configMap, "junk"] })).toBe(
        "Found 1 EKS cluster in us-west-2. None can be used."
      );
    });

    it("says when the region has no clusters", () => {
      expect(discoverStatusText({ clusters: [] }, "aws", "us-east-1")).toBe(
        "No EKS clusters in us-east-1."
      );
      expect(aws({})).toBe("No EKS clusters in us-west-2.");
    });

    it.each<[AwsCliErrorKind, string]>([
      [
        "credentials",
        "The AWS CLI has no valid session. Sign in, then select Refresh."
      ],
      [
        "rejected",
        "AWS rejected the credentials in us-west-2. The region may not be enabled for this account, or the credentials may not be valid."
      ],
      [
        "denied",
        "The signed-in identity can't list EKS clusters (eks:ListClusters)."
      ],
      [
        "other",
        "Can't list EKS clusters: Error when retrieving credentials from custom-process: helper failed"
      ]
    ])("reports a cluster list error of kind %s", (kind, text) => {
      expect(
        aws({
          clusters: [],
          errors: {
            clusters:
              "Error when retrieving credentials from custom-process: helper failed",
            subnets: "ignored"
          },
          errorKinds: { clusters: kind, subnets: "denied" }
        })
      ).toBe(text);
    });

    it("reports a cluster list error without a kind as another error", () => {
      expect(aws({ errors: { clusters: "boom" } })).toBe(
        "Can't list EKS clusters: boom"
      );
      expect(aws({ errorKinds: { clusters: "other" } })).toBe(
        "Can't list EKS clusters: "
      );
    });

    it("adds a sentence for a failed subnet list", () => {
      expect(
        aws({
          clusters: [usable],
          errors: { subnets: "denied text" },
          errorKinds: { subnets: "denied" }
        })
      ).toBe(
        "Found 1 EKS cluster in us-west-2. The signed-in identity can't list subnets (ec2:DescribeSubnets)."
      );
      expect(
        aws({
          clusters: [usable],
          errors: { subnets: "throttled" },
          errorKinds: { subnets: "other" }
        })
      ).toBe("Found 1 EKS cluster in us-west-2. Can't list subnets: throttled");
      expect(aws({ clusters: [usable], errors: { subnets: "boom" } })).toBe(
        "Found 1 EKS cluster in us-west-2. Can't list subnets: boom"
      );
    });

    it("adds no sentence for route-table, VPC, zone, or namespace failures", () => {
      expect(
        aws({
          clusters: [usable],
          errors: {
            routeTables: "denied",
            vpcs: "denied",
            zones: "denied",
            namespaces: "denied"
          },
          errorKinds: {
            routeTables: "denied",
            vpcs: "other",
            zones: "denied",
            namespaces: "other"
          }
        })
      ).toBe("Found 1 EKS cluster in us-west-2.");
    });

    it("has one session sentence when the session ended after the cluster list", () => {
      expect(
        aws({
          clusters: [usable, lostSession],
          errors: { subnets: "expired", routeTables: "expired" },
          errorKinds: { subnets: "credentials", routeTables: "credentials" }
        })
      ).toBe(
        "Found 2 EKS clusters in us-west-2. 1 can be used. The AWS CLI session ended during discovery. Sign in, then select Refresh."
      );
      expect(aws({ clusters: [lostSession] })).toBe(
        "Found 1 EKS cluster in us-west-2. None can be used. The AWS CLI session ended during discovery. Sign in, then select Refresh."
      );
    });

    it("reports a request the server refused", () => {
      expect(aws({ error: "Invalid AWS region" })).toBe(
        "Discovery failed: Invalid AWS region"
      );
    });
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
