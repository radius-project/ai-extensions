import { describe, expect, it } from "vitest";
import {
  validateAwsRoleArn,
  validateAzureClientId,
  validateEnvironmentName
} from "./form-validation.js";

describe("validateEnvironmentName", () => {
  it("rejects an empty name", () => {
    expect(validateEnvironmentName("  ")).toBe(
      "Please enter an environment name."
    );
  });

  it("rejects a name that is too long", () => {
    expect(validateEnvironmentName("a".repeat(64))).toContain(
      "63 characters or fewer"
    );
  });

  it("rejects a name with disallowed characters", () => {
    expect(validateEnvironmentName("my env")).toContain("only letters");
  });

  it("rejects a name that does not start alphanumeric", () => {
    expect(validateEnvironmentName("-dev")).toContain("only letters");
  });

  it("accepts a well-formed name", () => {
    expect(validateEnvironmentName("dev-1.prod_2")).toBe("");
  });
});

describe("validateAzureClientId", () => {
  it("accepts an empty value", () => {
    expect(validateAzureClientId("")).toBe("");
  });

  it("rejects a non-GUID value", () => {
    expect(validateAzureClientId("not-a-guid")).toContain("must be a GUID");
  });

  it("accepts a valid GUID", () => {
    expect(validateAzureClientId("12345678-1234-1234-1234-1234567890ab")).toBe(
      ""
    );
  });
});

describe("validateAwsRoleArn", () => {
  it("accepts an empty value", () => {
    expect(validateAwsRoleArn("")).toBe("");
  });

  it("rejects a malformed ARN", () => {
    expect(validateAwsRoleArn("arn:aws:iam::abc:role/x")).toContain(
      "must look like"
    );
  });

  it("accepts a valid role ARN", () => {
    expect(validateAwsRoleArn("arn:aws:iam::123456789012:role/deployer")).toBe(
      ""
    );
  });

  it("accepts a partitioned role ARN with a pathed role name", () => {
    expect(
      validateAwsRoleArn("arn:aws-us-gov:iam::123456789012:role/team/deployer")
    ).toBe("");
  });
});
