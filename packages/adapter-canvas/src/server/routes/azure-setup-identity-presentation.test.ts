import { describe, expect, it, vi } from "vitest";
import { createAzureIdentityPresentation } from "./azure-setup-identity-presentation.js";
import type { AzureAutoSetupWorkflow } from "./azure-auto-setup-types.js";

describe("Azure identity failure presentation", () => {
  it("preserves incomplete-account guidance and the finalizer's promise", async () => {
    const steps = ["Checking Azure CLI login..."];
    const original = new Error("finalization failed");
    const completion = Promise.reject(original);
    const fail = vi
      .fn<AzureAutoSetupWorkflow["fail"]>()
      .mockReturnValue(completion);
    const presentation = createAzureIdentityPresentation({ steps, fail });
    const result = presentation.finalizeIdentityFailure({
      kind: "account-incomplete"
    });
    expect(result).toBe(completion);
    await expect(result).rejects.toBe(original);
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      400,
      'Could not determine a valid active Azure tenant. Run "az login" and "az account set --subscription <id>", then try again.',
      "az-account-incomplete",
      { steps }
    );
    expect(fail.mock.calls[0][3]?.steps).toBe(steps);
  });
});
