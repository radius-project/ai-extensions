import { describe, expect, it, vi } from "vitest";
import type { AzureSetupFailure } from "@radius-project/core";
import { createAzureSetupPresentation } from "./azure-setup-presentation.js";
import type { AzureAutoSetupWorkflow } from "./azure-auto-setup-types.js";

describe("Azure setup failure presentation", () => {
  it("preserves the upstream credential retry narration in request-local steps", () => {
    const steps = ["Existing request-local progress"];
    const fail = vi.fn<AzureAutoSetupWorkflow["fail"]>();
    const presentation = createAzureSetupPresentation({ steps, fail });

    presentation.progress({
      kind: "retry-federated-credential",
      values: ["dev", 2, 6]
    });

    expect(steps).toEqual([
      "Existing request-local progress",
      'Retrying federated credential "dev" after Azure propagation or throttling (attempt 2/6)...'
    ]);
    expect(fail).not.toHaveBeenCalled();
  });

  it.each<{
    event: AzureSetupFailure;
    status: number;
    code: string;
    message: string;
  }>([
    {
      event: {
        kind: "app-create-failed",
        values: ["", "stdout denial"],
        evidence: {}
      },
      status: 400,
      code: "app-create-failed",
      message: "Failed to create App Registration: stdout denial"
    },
    {
      event: { kind: "app-create-failed", values: ["", ""], evidence: {} },
      status: 400,
      code: "app-create-failed",
      message: "Failed to create App Registration: The request was rejected."
    },
    {
      event: {
        kind: "federated-credential-list-failed",
        values: ["", ""],
        evidence: {}
      },
      status: 400,
      code: "federated-credential-list-failed",
      message:
        "Could not read the App Registration federated credentials: Azure CLI request failed."
    },
    {
      event: {
        kind: "app-object-id-failed",
        values: ["application-id"],
        evidence: {}
      },
      status: 400,
      code: "app-object-id-failed",
      message:
        "Could not resolve the Entra object id for App Registration application-id."
    },
    {
      event: {
        kind: "app-tag-verify-failed",
        values: ["radius-managed"],
        evidence: {}
      },
      status: 400,
      code: "app-tag-verify-failed",
      message:
        "The new App Registration is missing required Radius provenance tags: radius-managed."
    },
    {
      event: {
        kind: "federated-credential-identity-incomplete",
        values: ["dev"],
        evidence: {}
      },
      status: 400,
      code: "federated-credential-identity-incomplete",
      message:
        'Could not verify the complete Entra identity for federated credential "dev".'
    },
    {
      event: {
        kind: "created-federated-credential-identity-incomplete",
        values: ["dev"],
        evidence: {}
      },
      status: 400,
      code: "federated-credential-identity-incomplete",
      message:
        'Could not verify the complete Entra identity for federated credential "dev".'
    },
    {
      event: {
        kind: "provider-reconciliation-pending",
        values: [],
        evidence: {}
      },
      status: 409,
      code: "provider-reconciliation-pending",
      message:
        "Provider reconciliation is still pending. Radius will not complete setup or start another provider mutation."
    },
    {
      event: { kind: "rollback-after-cluster-admin", values: [], evidence: {} },
      status: 409,
      code: "provider-rollback-pending",
      message:
        "Radius reconciled the interrupted AKS role assignment and must delete the setup resources before setup can complete."
    },
    {
      event: {
        kind: "credential-provenance-write-failed",
        values: ["dev", false],
        evidence: {}
      },
      status: 500,
      code: "credential-provenance-write-failed",
      message:
        'Federated credential "dev" was found, but Radius could not save the ownership record needed for safe cleanup.'
    }
  ])(
    "maps $event.kind to its exact terminal contract",
    async ({ event, status, code, message }) => {
      const steps = ["Existing request-local progress"];
      const fail = vi
        .fn<AzureAutoSetupWorkflow["fail"]>()
        .mockResolvedValue(undefined);
      const presentation = createAzureSetupPresentation({ steps, fail });
      event.evidence = {
        clientId: "application-id",
        appName: "deploy",
        azError: "original diagnostic"
      };
      await presentation.finalizeFailure(event);
      expect(fail).toHaveBeenCalledExactlyOnceWith(status, message, code, {
        steps,
        ...event.evidence
      });
      expect(fail.mock.calls[0][3]?.steps).toBe(steps);
      expect(steps).toEqual(["Existing request-local progress"]);
    }
  );

  it("propagates the original finalization rejection without emitting another response", async () => {
    const original = new Error("operation persistence failed");
    const fail = vi
      .fn<AzureAutoSetupWorkflow["fail"]>()
      .mockRejectedValue(original);
    const presentation = createAzureSetupPresentation({ steps: [], fail });
    await expect(
      presentation.finalizeFailure({
        kind: "provider-reconciliation-pending",
        values: [],
        evidence: {}
      })
    ).rejects.toBe(original);
    expect(fail).toHaveBeenCalledTimes(1);
  });
});
