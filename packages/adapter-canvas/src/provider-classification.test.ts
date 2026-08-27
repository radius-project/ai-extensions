import { describe, it, expect } from "vitest";
import {
  classifyProvider,
  parseGitHubEnvironmentVariables
} from "./provider-classification.js";

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

describe("parseGitHubEnvironmentVariables", () => {
  it("parses tab-delimited name/value lines separated by LF", () => {
    expect(
      parseGitHubEnvironmentVariables(
        "AZURE_CLIENT_ID\tabc\nAZURE_TENANT_ID\txyz"
      )
    ).toEqual({ AZURE_CLIENT_ID: "abc", AZURE_TENANT_ID: "xyz" });
  });

  it("tolerates CRLF line endings without capturing a trailing carriage return", () => {
    // A Windows host may terminate `gh` output lines with CRLF; the parsed
    // values must not carry a trailing \r into downstream az commands.
    expect(
      parseGitHubEnvironmentVariables(
        "AZURE_CLIENT_ID\tabc\r\nAZURE_TENANT_ID\txyz\r\n"
      )
    ).toEqual({ AZURE_CLIENT_ID: "abc", AZURE_TENANT_ID: "xyz" });
  });

  it("treats a line with no tab as a variable with an empty value", () => {
    expect(parseGitHubEnvironmentVariables("RADIUS_MANAGED")).toEqual({
      RADIUS_MANAGED: ""
    });
  });

  it("preserves an explicitly empty value and a value containing tabs", () => {
    expect(parseGitHubEnvironmentVariables("EMPTY\t\nWITH_TAB\ta\tb")).toEqual({
      EMPTY: "",
      WITH_TAB: "a\tb"
    });
  });

  it("skips blank lines and returns an empty map for empty input", () => {
    expect(parseGitHubEnvironmentVariables("")).toEqual({});
    expect(parseGitHubEnvironmentVariables("\r\n\n")).toEqual({});
  });
});
