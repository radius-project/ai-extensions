import { describe, it, expect } from "vitest";
import {
  classifyVerifyFailure,
  extractMissingPermissions,
  type VerifyFailureInput
} from "./verify-failure-classification.js";

function input(
  overrides: Partial<VerifyFailureInput> = {}
): VerifyFailureInput {
  return {
    failedSteps: [],
    log: "",
    oidcHelp: "",
    noSubscriptionsHelp: "",
    ...overrides
  };
}

describe("classifyVerifyFailure", () => {
  it("classifies an OIDC enterprise-claim rejection as oidc-trust with detail", () => {
    const result = classifyVerifyFailure(
      input({
        oidcHelp:
          "Azure Login (OIDC) was rejected because of the enterprise claim.",
        failedSteps: [{ name: "Azure Login (OIDC)" }],
        log: "AADSTS7002381"
      })
    );
    expect(result.category).toBe("oidc-trust");
    expect(result.detail).toContain("enterprise claim");
  });

  it("classifies a no-subscriptions login as permissions and carries the help text", () => {
    const result = classifyVerifyFailure(
      input({
        noSubscriptionsHelp: "No subscriptions found for the identity.",
        failedSteps: [{ name: "Azure Login (OIDC)" }],
        log: "No subscriptions found"
      })
    );
    expect(result.category).toBe("permissions");
    expect(result.detail).toContain("No subscriptions");
  });

  it("classifies a reachable-but-forbidden AKS access step as permissions", () => {
    const result = classifyVerifyFailure(
      input({
        failedSteps: [{ name: "Verify AKS Access" }],
        log: "Error from server (Forbidden): pods is forbidden: User cannot list resource"
      })
    );
    expect(result.category).toBe("permissions");
  });

  it("classifies an unreachable EKS cluster as cluster-unreachable", () => {
    const result = classifyVerifyFailure(
      input({
        failedSteps: [{ name: "Verify EKS Access" }],
        log: "Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout"
      })
    );
    expect(result.category).toBe("cluster-unreachable");
    expect(result.component).toBe("Kubernetes cluster");
  });

  it("returns generic when a cluster step fails with no reachability or authorization signal", () => {
    const result = classifyVerifyFailure(
      input({
        failedSteps: [{ name: "Verify AKS Access" }],
        log: "some unexpected kubectl output"
      })
    );
    expect(result.category).toBe("generic");
  });

  it("classifies a rejected AWS OIDC login (trust evidence, no reachability) as oidc-trust", () => {
    const result = classifyVerifyFailure(
      input({
        failedSteps: [{ name: "Configure AWS Credentials" }],
        log: "Error: Not authorized to perform sts:AssumeRoleWithWebIdentity"
      })
    );
    expect(result.category).toBe("oidc-trust");
  });

  it("returns generic when a login step fails with neither reachability nor trust evidence", () => {
    const result = classifyVerifyFailure(
      input({
        failedSteps: [{ name: "Azure Login (OIDC)" }],
        log: "unexpected login failure with no recognizable cause"
      })
    );
    expect(result.category).toBe("generic");
  });

  it("classifies an OIDC login that cannot reach the provider as cloud-unreachable", () => {
    const result = classifyVerifyFailure(
      input({
        failedSteps: [{ name: "Azure Login (OIDC)" }],
        log: "connection timed out while contacting login.microsoftonline.com"
      })
    );
    expect(result.category).toBe("cloud-unreachable");
    expect(result.component).toBe("cloud provider");
  });

  it("classifies a post-login credential check that cannot reach the endpoint as cloud-unreachable", () => {
    const result = classifyVerifyFailure(
      input({
        failedSteps: [{ name: "Verify AWS Credentials" }],
        log: "Could not connect to the endpoint URL: no such host"
      })
    );
    expect(result.category).toBe("cloud-unreachable");
  });

  it("classifies a denied post-login credential check as permissions", () => {
    const result = classifyVerifyFailure(
      input({
        failedSteps: [{ name: "Verify AWS Credentials" }],
        log: "AccessDenied: User is not authorized to perform sts:GetCallerIdentity"
      })
    );
    expect(result.category).toBe("permissions");
  });

  it("returns generic when a credential check fails without a recognizable signal", () => {
    const result = classifyVerifyFailure(
      input({
        failedSteps: [{ name: "Verify Azure Credentials" }],
        log: "unexpected"
      })
    );
    expect(result.category).toBe("generic");
  });

  it("classifies a failed GHCR package-push check with an authorization denial as permissions", () => {
    const result = classifyVerifyFailure(
      input({
        failedSteps: [{ name: "Verify GHCR package push permission" }],
        log: "denied: 403 Forbidden"
      })
    );
    expect(result.category).toBe("permissions");
  });

  it("returns generic for a GHCR package-push failure with no authorization evidence (operational outage)", () => {
    const result = classifyVerifyFailure(
      input({
        failedSteps: [{ name: "Verify GHCR package push permission" }],
        log: "ghcr.io returned 503 Service Unavailable"
      })
    );
    expect(result.category).toBe("generic");
  });

  it("returns generic when no step matches any known category", () => {
    const result = classifyVerifyFailure(
      input({ failedSteps: [{ name: "Some unrelated step" }], log: "boom" })
    );
    expect(result.category).toBe("generic");
  });

  it("returns generic when there are no failed steps and no signals", () => {
    expect(classifyVerifyFailure(input()).category).toBe("generic");
  });

  it("prefers cluster-unreachable over authorization when both signals appear", () => {
    const result = classifyVerifyFailure(
      input({
        failedSteps: [{ name: "Verify AKS Access" }],
        log: "Forbidden earlier, then connection timed out contacting the API server"
      })
    );
    expect(result.category).toBe("cluster-unreachable");
  });

  it("tolerates a step with no name", () => {
    const result = classifyVerifyFailure(
      input({ failedSteps: [{ conclusion: "failure" }], log: "" })
    );
    expect(result.category).toBe("generic");
  });
});

describe("extractMissingPermissions", () => {
  it("returns an empty array for empty input", () => {
    expect(extractMissingPermissions("")).toEqual([]);
  });

  it("extracts and de-duplicates AWS action tokens", () => {
    const perms = extractMissingPermissions(
      "denied eks:DescribeCluster and eks:DescribeCluster and sts:AssumeRole"
    );
    expect(perms).toContain("eks:DescribeCluster");
    expect(perms).toContain("sts:AssumeRole");
    expect(perms.filter((p) => p === "eks:DescribeCluster")).toHaveLength(1);
  });

  it("extracts Azure RBAC data-action tokens", () => {
    const perms = extractMissingPermissions(
      "AuthorizationFailed on 'Microsoft.ContainerService/managedClusters/read'"
    );
    expect(perms).toContain("Microsoft.ContainerService/managedClusters/read");
  });

  it("returns an empty array when no tokens are present", () => {
    expect(extractMissingPermissions("nothing recognizable here")).toEqual([]);
  });
});
