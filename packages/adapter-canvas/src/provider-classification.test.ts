import { describe, it, expect } from "vitest";
import { classifyProvider } from "./provider-classification.js";

describe("classifyProvider", () => {
  it("classifies Azure by the canonical AZURE_CLIENT_ID variable", () => {
    expect(classifyProvider({ AZURE_CLIENT_ID: "abc" })).toBe("azure");
  });

  it("classifies AWS by the canonical AWS_ROLE_ARN variable", () => {
    expect(classifyProvider({ AWS_ROLE_ARN: "arn:aws:iam::1:role/x" })).toBe(
      "aws"
    );
  });

  it("prefers Azure when both markers are present", () => {
    expect(
      classifyProvider({ AZURE_CLIENT_ID: "abc", AWS_ROLE_ARN: "arn" })
    ).toBe("azure");
  });

  it("returns empty when no canonical marker is present", () => {
    expect(classifyProvider({ RADIUS_MANAGED: "1" })).toBe("");
    expect(classifyProvider({})).toBe("");
  });

  it("does not misclassify a user-defined variable whose name merely contains AZURE", () => {
    expect(classifyProvider({ MY_AZURE_THING: "1" })).toBe("");
  });

  it("does not treat a non-canonical AWS variable as AWS", () => {
    expect(classifyProvider({ AWS_EKS_CLUSTER_NAME: "cluster" })).toBe("");
  });
});
