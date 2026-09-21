import { describe, expect, it } from "vitest";
import { successfulSelectedGhExecutor } from "../test/support/server/selected-gh.js";
import {
  acceptAzureAppCreateContinuationPrompt,
  AZURE_APP_CREATE_CONTINUATION_SCHEMA_VERSION,
  AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT,
  createAzureAppCreateContinuation,
  matchAzureAppCreateContinuation,
  normalizeAzureAppCreateContinuation,
  type AzureAppCreateContinuationRequest,
  type AzureAppCreateContinuationSeed
} from "./azure-app-create-continuation.js";

const SUBSCRIPTION = "22222222-2222-2222-2222-222222222222";
const TENANT = "11111111-1111-1111-1111-111111111111";
const CALLER_OBJECT_ID = "44444444-4444-4444-4444-444444444444";
const SMR = "99999999-9999-9999-9999-999999999999";
const REQUESTED_AT = "2026-09-11T20:00:00.000Z";
const prompt = {
  ...AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT,
  requestedAt: REQUESTED_AT
};

const request: AzureAppCreateContinuationRequest = {
  repo: "octo/app",
  environment: "dev",
  operationEnvironment: "dev",
  requestedSubscriptionId: SUBSCRIPTION,
  requestedTenantId: TENANT,
  resourceGroup: "rg-radius",
  clusterResourceGroup: "rg-aks",
  clusterName: "aks-radius",
  explicitAppId: "",
  createNewApp: false,
  appNameProvided: false,
  requestedAppName: "",
  requestedClientId: ""
};

const seed: AzureAppCreateContinuationSeed = {
  operationId: "op_resume",
  request,
  githubExecutor: {
    login: "octocat",
    credentialSource: "keyring",
    requiresKeyringSwitch: true,
    scopes: ["repo", "workflow", "write:packages"]
  },
  resolved: {
    subscriptionId: SUBSCRIPTION,
    tenantId: TENANT,
    oidcSuffix: "environment:dev",
    callerIdentity: { kind: "user" },
    oidc: {
      fullName: "octo/app",
      ownerId: 7,
      repoId: 5,
      subjectConfig: { useDefault: true },
      federatedCredentials: [
        {
          name: "dev",
          subject: "repo:octo/app:environment:dev"
        }
      ]
    }
  }
};

function continuation() {
  const value = createAzureAppCreateContinuation(
    seed,
    "radius-deploy-octo-app",
    CALLER_OBJECT_ID,
    REQUESTED_AT
  );
  if (!value) throw new Error("Expected a valid continuation fixture.");
  return value;
}

describe("Azure App Registration create continuation", () => {
  it("rejects a non-object continuation", () => {
    expect(normalizeAzureAppCreateContinuation(null)).toBeNull();
  });

  it("creates the strict normalized context needed to resume creation", () => {
    expect(continuation()).toEqual({
      schemaVersion: AZURE_APP_CREATE_CONTINUATION_SCHEMA_VERSION,
      operationId: "op_resume",
      prompt,
      request,
      githubExecutor: seed.githubExecutor,
      resolved: {
        ...seed.resolved,
        callerObjectId: CALLER_OBJECT_ID,
        appName: "radius-deploy-octo-app"
      }
    });
  });

  it("preserves validated service-principal and custom OIDC context", () => {
    const value = continuation();
    const normalized = normalizeAzureAppCreateContinuation({
      ...value,
      resolved: {
        ...value.resolved,
        callerIdentity: {
          kind: "servicePrincipal",
          appId: "55555555-5555-5555-5555-555555555555"
        },
        oidc: {
          ...value.resolved.oidc,
          subjectConfig: {
            useDefault: false,
            includeClaimKeys: ["repo", "context"],
            useImmutableSubject: true,
            subClaimPrefix: "repo:octo@7/app@5"
          }
        }
      }
    });

    expect(normalized?.resolved).toMatchObject({
      callerIdentity: {
        kind: "servicePrincipal",
        appId: "55555555-5555-5555-5555-555555555555"
      },
      oidc: {
        subjectConfig: {
          useDefault: false,
          includeClaimKeys: ["repo", "context"],
          useImmutableSubject: true,
          subClaimPrefix: "repo:octo@7/app@5"
        }
      }
    });
  });

  it("binds an explicitly requested App Registration name", () => {
    const value = createAzureAppCreateContinuation(
      {
        ...seed,
        request: {
          ...seed.request,
          appNameProvided: true,
          requestedAppName: "radius-custom"
        }
      },
      "radius-custom",
      CALLER_OBJECT_ID,
      REQUESTED_AT
    );

    expect(value?.resolved.appName).toBe("radius-custom");
  });

  it("drops credentials, raw output, and unknown fields while normalizing", () => {
    const value: Record<string, unknown> = {
      ...structuredClone(continuation())
    };
    value.clientSecret = "discarded-value";
    value.rawOutput = "provider output";
    value.githubExecutor = {
      ...(value.githubExecutor as Record<string, unknown>),
      token: "discarded-value"
    };

    const normalized = normalizeAzureAppCreateContinuation(value);

    expect(normalized).toEqual(continuation());
    expect(JSON.stringify(normalized)).not.toContain("discarded-value");
    expect(JSON.stringify(normalized)).not.toContain("provider output");
  });

  it.each([
    ["an obsolete schema", { schemaVersion: 0 }],
    ["a future schema", { schemaVersion: 2 }],
    [
      "an invalid prompt timestamp",
      { prompt: { ...prompt, requestedAt: "not-a-timestamp" } }
    ],
    [
      "a different accepted prompt instance",
      {
        acceptedPrompt: {
          ...prompt,
          requestedAt: "2026-09-11T20:00:01.000Z"
        }
      }
    ],
    ["a malformed request", { request: { repo: "octo/app" } }],
    ["a missing request object", { request: null }],
    [
      "a non-string optional request field",
      { request: { ...request, clusterResourceGroup: 42 } }
    ],
    [
      "an overlong optional request field",
      { request: { ...request, clusterResourceGroup: "r".repeat(91) } }
    ],
    [
      "a malformed GitHub executor",
      {
        githubExecutor: {
          login: "octocat",
          credentialSource: "keyring",
          scopes: "repo"
        }
      }
    ],
    [
      "a malformed GitHub scope",
      {
        githubExecutor: {
          ...continuation().githubExecutor,
          scopes: ["repo", ""]
        }
      }
    ],
    [
      "a non-array custom subject claim list",
      {
        resolved: {
          ...continuation().resolved,
          oidc: {
            ...continuation().resolved.oidc,
            subjectConfig: {
              useDefault: false,
              includeClaimKeys: "repo"
            }
          }
        }
      }
    ],
    [
      "a mismatched resolved subscription",
      { resolved: { ...continuation().resolved, subscriptionId: TENANT } }
    ],
    [
      "an empty required resolved identifier",
      { resolved: { ...continuation().resolved, tenantId: "" } }
    ],
    [
      "a malformed required resolved identifier",
      { resolved: { ...continuation().resolved, callerObjectId: "not-a-guid" } }
    ],
    [
      "a mismatched OIDC repository",
      {
        resolved: {
          ...continuation().resolved,
          oidc: { ...continuation().resolved.oidc, fullName: "octo/other" }
        }
      }
    ],
    [
      "a missing OIDC subject configuration",
      {
        resolved: {
          ...continuation().resolved,
          oidc: {
            ...continuation().resolved.oidc,
            subjectConfig: null
          }
        }
      }
    ],
    [
      "a non-positive OIDC repository id",
      {
        resolved: {
          ...continuation().resolved,
          oidc: { ...continuation().resolved.oidc, repoId: 0 }
        }
      }
    ],
    [
      "an unsupported caller identity",
      {
        resolved: {
          ...continuation().resolved,
          callerIdentity: { kind: "unsupported", reason: "unsupported" }
        }
      }
    ],
    [
      "a mismatched derived app name",
      { resolved: { ...continuation().resolved, appName: "radius-other" } }
    ],
    [
      "a missing resolved app name",
      { resolved: { ...continuation().resolved, appName: "" } }
    ],
    [
      "malformed custom subject claims",
      {
        resolved: {
          ...continuation().resolved,
          oidc: {
            ...continuation().resolved.oidc,
            subjectConfig: {
              useDefault: false,
              includeClaimKeys: ["repo", ""]
            }
          }
        }
      }
    ],
    [
      "a malformed subject setting",
      {
        resolved: {
          ...continuation().resolved,
          oidc: {
            ...continuation().resolved.oidc,
            subjectConfig: {
              useDefault: false,
              useImmutableSubject: "yes"
            }
          }
        }
      }
    ],
    [
      "a malformed federated credential",
      {
        resolved: {
          ...continuation().resolved,
          oidc: {
            ...continuation().resolved.oidc,
            federatedCredentials: [{ name: "dev", subject: "" }]
          }
        }
      }
    ]
  ])("rejects %s", (_label, patch) => {
    expect(
      normalizeAzureAppCreateContinuation({
        ...continuation(),
        ...patch
      })
    ).toBeNull();
  });

  it("matches the exact live prompt, request, operation, executor, and SMR answer", () => {
    expect(
      matchAzureAppCreateContinuation(continuation(), {
        operationId: "op_resume",
        operationState: "input_required",
        inputRequired: prompt,
        request,
        serviceManagementReference: SMR,
        githubExecutor: successfulSelectedGhExecutor()
      })
    ).toEqual(continuation());
  });

  it("matches the exact prompt accepted by the public resume route", () => {
    const accepted = acceptAzureAppCreateContinuationPrompt(
      continuation(),
      prompt
    );

    expect(
      matchAzureAppCreateContinuation(accepted, {
        operationId: "op_resume",
        operationState: "running",
        inputRequired: null,
        request,
        serviceManagementReference: SMR,
        githubExecutor: successfulSelectedGhExecutor()
      })
    ).toEqual({
      ...continuation(),
      acceptedPrompt: prompt
    });
  });

  it("does not accept a changed prompt for a scheduled resume", () => {
    expect(
      acceptAzureAppCreateContinuationPrompt(continuation(), {
        ...prompt,
        message: "Choose an App Registration."
      })
    ).toBeNull();
  });

  it("does not match a scheduled resume without a valid continuation", () => {
    expect(
      matchAzureAppCreateContinuation(null, {
        operationId: "op_resume",
        operationState: "running",
        inputRequired: null,
        request,
        serviceManagementReference: SMR,
        githubExecutor: successfulSelectedGhExecutor()
      })
    ).toBeNull();
  });

  it.each([
    [
      "operation",
      {
        operationId: "op_other",
        operationState: "input_required",
        inputRequired: prompt,
        request,
        serviceManagementReference: SMR,
        githubExecutor: successfulSelectedGhExecutor()
      }
    ],
    [
      "operation state",
      {
        operationId: "op_resume",
        operationState: "running",
        inputRequired: prompt,
        request,
        serviceManagementReference: SMR,
        githubExecutor: successfulSelectedGhExecutor()
      }
    ],
    [
      "prompt",
      {
        operationId: "op_resume",
        operationState: "input_required",
        inputRequired: {
          ...prompt,
          message: "Choose an App Registration."
        },
        request,
        serviceManagementReference: SMR,
        githubExecutor: successfulSelectedGhExecutor()
      }
    ],
    [
      "prompt instance",
      {
        operationId: "op_resume",
        operationState: "input_required",
        inputRequired: {
          ...prompt,
          requestedAt: "2026-09-11T20:00:01.000Z"
        },
        request,
        serviceManagementReference: SMR,
        githubExecutor: successfulSelectedGhExecutor()
      }
    ],
    [
      "request",
      {
        operationId: "op_resume",
        operationState: "input_required",
        inputRequired: prompt,
        request: { ...request, clusterName: "aks-other" },
        serviceManagementReference: SMR,
        githubExecutor: successfulSelectedGhExecutor()
      }
    ],
    [
      "executor",
      {
        operationId: "op_resume",
        operationState: "input_required",
        inputRequired: prompt,
        request,
        serviceManagementReference: SMR,
        githubExecutor: successfulSelectedGhExecutor({ login: "other" })
      }
    ],
    [
      "SMR answer",
      {
        operationId: "op_resume",
        operationState: "input_required",
        inputRequired: prompt,
        request,
        serviceManagementReference: "",
        githubExecutor: successfulSelectedGhExecutor()
      }
    ]
  ])("refuses a changed %s", (_label, input) => {
    expect(matchAzureAppCreateContinuation(continuation(), input)).toBeNull();
  });
});
