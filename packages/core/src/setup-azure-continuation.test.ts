import { describe, expect, it } from "vitest";
import {
  AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT,
  matchesAzureAppCreateContinuation,
  type AzureAppCreateContinuation
} from "./setup-azure-continuation.js";

const continuation: AzureAppCreateContinuation = {
  schemaVersion: 1,
  operationId: "setup-1",
  prompt: {
    ...AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT,
    requestedAt: "2026-10-14T10:00:00.000Z"
  },
  request: {
    repo: "owner/repo",
    environment: "dev",
    operationEnvironment: "dev",
    requestedSubscriptionId: "11111111-1111-1111-1111-111111111111",
    requestedTenantId: "",
    resourceGroup: "resources",
    clusterResourceGroup: "",
    clusterName: "cluster",
    explicitAppId: "",
    createNewApp: true,
    appNameProvided: false,
    requestedAppName: "",
    requestedClientId: ""
  },
  githubExecutor: {
    login: "owner",
    credentialSource: "keyring",
    requiresKeyringSwitch: false,
    scopes: ["repo", "workflow"]
  },
  resolved: {
    subscriptionId: "11111111-1111-1111-1111-111111111111",
    tenantId: "22222222-2222-2222-2222-222222222222",
    oidcSuffix: "environment:dev",
    callerIdentity: { kind: "user" },
    callerObjectId: "33333333-3333-3333-3333-333333333333",
    appName: "radius-deploy-owner-repo",
    oidc: {
      federatedCredentials: [],
      fullName: "owner/repo",
      ownerId: 1,
      repoId: 2,
      subjectConfig: { useDefault: true }
    }
  }
};

describe("matchesAzureAppCreateContinuation", () => {
  const matching = {
    operationId: continuation.operationId,
    prompt: continuation.prompt,
    request: continuation.request,
    githubExecutor: continuation.githubExecutor
  };

  it("accepts the exact normalized operation, prompt, request and account", () => {
    expect(matchesAzureAppCreateContinuation(continuation, matching)).toBe(
      true
    );
  });

  it.each([
    { operationId: "other" },
    {
      prompt: {
        ...continuation.prompt,
        requestedAt: "2026-10-14T11:00:00.000Z"
      }
    },
    { request: { ...continuation.request, environment: "production" } },
    { githubExecutor: { ...continuation.githubExecutor, login: "other" } },
    {
      githubExecutor: {
        ...continuation.githubExecutor,
        scopes: ["workflow", "repo"]
      }
    }
  ])("rejects a changed fingerprint: %j", (patch) => {
    expect(
      matchesAzureAppCreateContinuation(continuation, { ...matching, ...patch })
    ).toBe(false);
  });
});
