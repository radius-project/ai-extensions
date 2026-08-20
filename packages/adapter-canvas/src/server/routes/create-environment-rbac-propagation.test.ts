import { describe, expect, it } from "vitest";
import {
  AZURE_RBAC_PROPAGATION_WINDOW_MS,
  shouldDeferAzureCredentialVerificationForRbacPropagation
} from "./create-environment-rbac-propagation.js";
import type { CreateEnvironmentOperation } from "./create-environment-types.js";

const NOW = Date.parse("2026-08-20T17:00:00.000Z");
const FRESH = new Date(NOW - 60_000).toISOString();

function operation(
  overrides: Partial<CreateEnvironmentOperation> = {}
): CreateEnvironmentOperation {
  return {
    operationId: "op-rbac",
    provider: "azure",
    state: "running",
    setupArtifacts: {
      servicePrincipal: {
        appId: "client-1",
        objectId: "principal-1"
      },
      roleAssignments: [
        {
          role: "Contributor",
          scope: "/subscriptions/sub-1/resourceGroups/rg-1",
          principalObjectId: "principal-1",
          createdAt: FRESH
        }
      ]
    },
    ...overrides
  };
}

function shouldDefer(
  op: CreateEnvironmentOperation,
  input: {
    clientId?: string;
    subscriptionId?: string;
    resourceGroup?: string;
    now?: number;
  } = {}
): boolean {
  return shouldDeferAzureCredentialVerificationForRbacPropagation({
    operation: op,
    clientId: input.clientId ?? "client-1",
    subscriptionId: input.subscriptionId ?? "sub-1",
    resourceGroup: input.resourceGroup ?? "rg-1",
    now: input.now ?? NOW
  });
}

describe("shouldDeferAzureCredentialVerificationForRbacPropagation", () => {
  it("requires a fresh matching grant for the operation service principal", () => {
    expect(shouldDefer(operation())).toBe(true);
  });

  it.each([
    ["missing setup artifacts", operation({ setupArtifacts: undefined })],
    [
      "missing role assignments",
      operation({
        setupArtifacts: {
          servicePrincipal: { appId: "client-1", objectId: "principal-1" },
          roleAssignments: []
        }
      })
    ],
    [
      "different provider",
      operation({
        provider: "aws"
      })
    ],
    [
      "terminal operation",
      operation({
        state: "action_required"
      })
    ],
    [
      "missing service principal client id",
      operation({
        setupArtifacts: {
          servicePrincipal: { objectId: "principal-1" },
          roleAssignments: [
            {
              role: "Contributor",
              scope: "/subscriptions/sub-1/resourceGroups/rg-1",
              principalObjectId: "principal-1",
              createdAt: FRESH
            }
          ]
        }
      })
    ],
    [
      "missing service principal object id",
      operation({
        setupArtifacts: {
          servicePrincipal: { appId: "client-1" },
          roleAssignments: [
            {
              role: "Contributor",
              scope: "/subscriptions/sub-1/resourceGroups/rg-1",
              principalObjectId: "principal-1",
              createdAt: FRESH
            }
          ]
        }
      })
    ]
  ])("does not defer for %s", (_name, op) => {
    expect(shouldDefer(op)).toBe(false);
  });

  it("uses the client id matching the credentials being installed", () => {
    expect(shouldDefer(operation(), { clientId: "other-client" })).toBe(false);
  });

  it("requires a role assignment for the same principal", () => {
    expect(
      shouldDefer(
        operation({
          setupArtifacts: {
            servicePrincipal: { appId: "client-1", objectId: "principal-1" },
            roleAssignments: [
              {
                role: "Contributor",
                scope: "/subscriptions/sub-1/resourceGroups/rg-1",
                principalObjectId: "principal-2",
                createdAt: FRESH
              }
            ]
          }
        })
      )
    ).toBe(false);
  });

  it("requires the role assignment timestamp inside the propagation window", () => {
    const staleCreatedAt = new Date(
      NOW - AZURE_RBAC_PROPAGATION_WINDOW_MS - 1
    ).toISOString();

    expect(
      shouldDefer(
        operation({
          setupArtifacts: {
            servicePrincipal: { appId: "client-1", objectId: "principal-1" },
            roleAssignments: [
              {
                role: "Contributor",
                scope: "/subscriptions/sub-1/resourceGroups/rg-1",
                principalObjectId: "principal-1",
                createdAt: staleCreatedAt
              }
            ]
          }
        })
      )
    ).toBe(false);
  });

  it("does not defer without a recorded role assignment timestamp", () => {
    expect(
      shouldDefer(
        operation({
          setupArtifacts: {
            servicePrincipal: { appId: "client-1", objectId: "principal-1" },
            roleAssignments: [
              {
                role: "Contributor",
                scope: "/subscriptions/sub-1/resourceGroups/rg-1",
                principalObjectId: "principal-1"
              }
            ]
          }
        })
      )
    ).toBe(false);
  });

  it("rejects role, subscription and resource-group mismatches independently", () => {
    expect(
      shouldDefer(
        operation({
          setupArtifacts: {
            servicePrincipal: { appId: "client-1", objectId: "principal-1" },
            roleAssignments: [
              {
                role: "Reader",
                scope: "/subscriptions/sub-1/resourceGroups/rg-1",
                principalObjectId: "principal-1",
                createdAt: FRESH
              }
            ]
          }
        })
      )
    ).toBe(false);
    expect(shouldDefer(operation(), { subscriptionId: "sub-2" })).toBe(false);
    expect(shouldDefer(operation(), { resourceGroup: "rg-2" })).toBe(false);
    expect(shouldDefer(operation(), { subscriptionId: "" })).toBe(false);
    expect(shouldDefer(operation(), { resourceGroup: "" })).toBe(false);
  });

  it("matches Azure scopes case-insensitively after trimming trailing slashes", () => {
    expect(
      shouldDefer(
        operation({
          setupArtifacts: {
            servicePrincipal: { appId: "CLIENT-1", objectId: "PRINCIPAL-1" },
            roleAssignments: [
              {
                role: " contributor ",
                scope: " /SUBSCRIPTIONS/SUB-1/resourceGroups/RG-1/ ",
                principalObjectId: " PRINCIPAL-1 ",
                createdAt: FRESH
              }
            ]
          }
        }),
        { clientId: "client-1", subscriptionId: "sub-1", resourceGroup: "rg-1" }
      )
    ).toBe(true);
  });

  it("accepts subscription-scope Owner access for the same subscription", () => {
    expect(
      shouldDefer(
        operation({
          setupArtifacts: {
            servicePrincipal: { appId: "client-1", objectId: "principal-1" },
            roleAssignments: [
              {
                role: "Owner",
                scope: "/subscriptions/sub-1",
                principalObjectId: "principal-1",
                createdAt: FRESH
              }
            ]
          }
        })
      )
    ).toBe(true);
  });

  it("requires the effective resource group even for subscription-scope access", () => {
    expect(
      shouldDefer(
        operation({
          setupArtifacts: {
            servicePrincipal: { appId: "client-1", objectId: "principal-1" },
            roleAssignments: [
              {
                role: "Owner",
                scope: "/subscriptions/sub-1",
                principalObjectId: "principal-1",
                createdAt: FRESH
              }
            ]
          }
        }),
        { resourceGroup: "" }
      )
    ).toBe(false);
  });

  it("uses any matching role assignment when other assignments do not match", () => {
    expect(
      shouldDefer(
        operation({
          setupArtifacts: {
            servicePrincipal: { appId: "client-1", objectId: "principal-1" },
            roleAssignments: [
              {
                role: "Reader",
                scope: "/subscriptions/sub-1/resourceGroups/rg-1",
                principalObjectId: "principal-1",
                createdAt: FRESH
              },
              {
                role: "Contributor",
                scope: "/subscriptions/sub-1/resourceGroups/rg-1",
                principalObjectId: "principal-1",
                createdAt: FRESH
              }
            ]
          }
        })
      )
    ).toBe(true);
  });
});
