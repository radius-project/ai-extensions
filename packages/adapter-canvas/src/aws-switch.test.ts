import { describe, expect, it } from "vitest";
import { AWS_SWITCH_VARIABLE, readAwsSwitch } from "./aws-switch.js";

describe("readAwsSwitch", () => {
  it("is on only when the variable is exactly 1", () => {
    expect(readAwsSwitch({ [AWS_SWITCH_VARIABLE]: "1" })).toBe(true);
  });

  it.each([undefined, "", "0", "true", "yes", " 1", "1 "])(
    "stays off for %j",
    (value) => {
      expect(readAwsSwitch({ [AWS_SWITCH_VARIABLE]: value })).toBe(false);
    }
  );

  it("stays off when the variable is absent", () => {
    expect(readAwsSwitch({})).toBe(false);
  });
});
