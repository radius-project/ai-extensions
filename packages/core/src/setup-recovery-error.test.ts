import { describe, expect, it } from "vitest";
import {
  assertSetupExecutionActive,
  isSetupExecutionInterrupted,
  ProviderMutationRecoveryError
} from "./setup-recovery-error.js";

describe("setup execution interruption", () => {
  it("allows independent execution without a setup shutdown scope", () => {
    expect(() => assertSetupExecutionActive()).not.toThrow();
    expect(() => assertSetupExecutionActive(() => false)).not.toThrow();
  });

  it("distinguishes interruption from provider failures", () => {
    expect(() => assertSetupExecutionActive(() => true)).toThrow(
      expect.objectContaining({ code: "setup-execution-interrupted" })
    );
    expect(
      isSetupExecutionInterrupted(
        new ProviderMutationRecoveryError(
          "stopped",
          "setup-execution-interrupted"
        )
      )
    ).toBe(true);
    expect(
      isSetupExecutionInterrupted(
        new ProviderMutationRecoveryError("provider failed")
      )
    ).toBe(false);
    expect(isSetupExecutionInterrupted(new Error("failed"))).toBe(false);
  });
});
