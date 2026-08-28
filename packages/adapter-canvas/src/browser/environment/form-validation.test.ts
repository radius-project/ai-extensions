import { describe, expect, it } from "vitest";
import { validateEnvironmentName } from "./form-validation.js";

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
