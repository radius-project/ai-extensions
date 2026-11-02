import { describe, expect, it } from "vitest";
import { defaultAwsDeployRoleName } from "./aws-deploy-role-name.js";

// Digests computed independently with `shasum -a 256`.
const LONG_A = `contoso/${"a".repeat(60)}`;
const LONG_A_DIGEST = "baeeb7";
const LONG_B = `contoso/${"a".repeat(59)}b`;
const LONG_B_DIGEST = "f6cb13";
const PREFIX = `radius-deploy-contoso-${"a".repeat(35)}`;

describe("defaultAwsDeployRoleName", () => {
  it("keeps a short name without a hash", () => {
    expect(defaultAwsDeployRoleName("contoso/storefront")).toBe(
      "radius-deploy-contoso-storefront"
    );
  });

  it("ends a long name with the SHA-256 of owner/repo", () => {
    expect(defaultAwsDeployRoleName(LONG_A)).toBe(`${PREFIX}-${LONG_A_DIGEST}`);
  });

  it("gives two long repositories with the same prefix different roles", () => {
    expect(defaultAwsDeployRoleName(LONG_B)).toBe(`${PREFIX}-${LONG_B_DIGEST}`);
  });

  it("gives the same repository in another case the same hash", () => {
    expect(defaultAwsDeployRoleName(LONG_A.toUpperCase())).toBe(
      `${PREFIX.slice(0, 14)}${PREFIX.slice(14).toUpperCase()}-${LONG_A_DIGEST}`
    );
  });
});
