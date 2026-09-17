import { describe, expect, it } from "vitest";
import { validateEnvironmentName } from "./form-validation.js";

describe("validateEnvironmentName", () => {
  it("rejects an empty name", () => {
    expect(validateEnvironmentName("  ")).toBe(
      "Please enter an environment name."
    );
  });

  it("rejects a name that exceeds GitHub's 255-character limit", () => {
    expect(validateEnvironmentName("a".repeat(256))).toContain(
      "255 characters or fewer"
    );
  });

  it("accepts a name at the 255-character limit", () => {
    expect(validateEnvironmentName("a".repeat(255))).toBe("");
  });

  it("rejects a name containing a control character", () => {
    expect(validateEnvironmentName("dev\tprod")).toContain(
      "control characters"
    );
  });

  it("accepts a name containing ':' (escaped as %3A in the OIDC subject)", () => {
    expect(validateEnvironmentName("team:dev")).toBe("");
  });

  it("accepts a name with spaces, mixed case, dots, hyphens and underscores", () => {
    expect(validateEnvironmentName("Dev Env-1.prod_2")).toBe("");
  });
});
