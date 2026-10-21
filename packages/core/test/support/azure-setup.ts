import type {
  AzureApplicationPorts,
  AzureCredentialPorts
} from "../../src/setup-azure-contracts.js";
import type {
  AzureAppCreateContinuation,
  AzureAppCreateContinuationRequest,
  AzureAppCreateContinuationSeed
} from "../../src/setup-azure-continuation.js";
import { AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT } from "../../src/setup-azure-continuation.js";
import type { ProviderMutationCommandResult } from "../../src/setup-azure-recovery.js";

export const subscriptionId = "11111111-1111-1111-1111-111111111111";
export const tenantId = "22222222-2222-2222-2222-222222222222";
export const clientId = "33333333-3333-3333-3333-333333333333";
export const callerId = "44444444-4444-4444-4444-444444444444";
export const request: AzureAppCreateContinuationRequest = {
  repo: "owner/repo",
  environment: "dev",
  operationEnvironment: "dev",
  requestedSubscriptionId: subscriptionId,
  requestedTenantId: tenantId,
  resourceGroup: "resources",
  clusterResourceGroup: "",
  clusterName: "cluster",
  explicitAppId: "",
  createNewApp: false,
  appNameProvided: false,
  requestedAppName: "",
  requestedClientId: clientId
};
export const resolved: AzureAppCreateContinuationSeed["resolved"] = {
  subscriptionId,
  tenantId,
  oidcSuffix: "environment:dev",
  callerIdentity: { kind: "user" },
  oidc: {
    fullName: "owner/repo",
    ownerId: 1,
    repoId: 2,
    subjectConfig: { useDefault: true },
    federatedCredentials: [
      { name: "dev", subject: "repo:owner/repo:environment:dev" }
    ]
  }
};
export const continuation: AzureAppCreateContinuation = {
  schemaVersion: 1,
  operationId: "setup-1",
  request,
  prompt: {
    ...AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT,
    requestedAt: "2026-10-14T10:00:00.000Z"
  },
  githubExecutor: {
    login: "owner",
    credentialSource: "keyring",
    requiresKeyringSwitch: false,
    scopes: ["repo"]
  },
  resolved: {
    ...resolved,
    callerIdentity: { kind: "user" },
    callerObjectId: callerId,
    appName: "radius-deploy-owner-repo"
  }
};
export const liveCredential = {
  id: "credential-id",
  name: "dev",
  subject: resolved.oidc.federatedCredentials[0].subject,
  issuer: "https://token.actions.githubusercontent.com",
  audiences: ["api://AzureADTokenExchange"]
};
export function command(
  stdout = "",
  code: number | string = 0,
  stderr = ""
): ProviderMutationCommandResult {
  return { code, stdout, stderr };
}
export function azurePorts(runAz: AzureApplicationPorts["runAz"]) {
  const events: unknown[] = [];
  const base = {
    operationId: "setup-1",
    environment: "dev",
    runAz,
    sleep: async (milliseconds: number) => {
      events.push(["sleep", milliseconds]);
    },
    stopBoundary: async (boundary: string) => {
      events.push(["stop", boundary]);
      return true;
    },
    checkpoint: async (boundary: string) => {
      events.push(["checkpoint", boundary]);
      return true;
    },
    haltKind: (): "failed" | "stopped" | "input-required" => "failed",
    progress: (event: Parameters<AzureApplicationPorts["progress"]>[0]) => {
      events.push(event);
    },
    finalizeFailure: async (
      event: Parameters<AzureApplicationPorts["finalizeFailure"]>[0]
    ) => {
      events.push(event);
    },
    recovery: {
      find: () => null,
      willWrite: () => true,
      unresolved: () => [],
      execute: async <T>(): Promise<T> => {
        throw new Error("Unexpected provider mutation");
      }
    }
  };
  const application: AzureApplicationPorts = {
    ...base,
    runGitHubJson: async (path) => {
      events.push(["github", path]);
      if (path === "/repos/owner/repo")
        return {
          ok: true,
          json: { full_name: "owner/repo", id: 2, owner: { id: 1 } }
        };
      if (path.includes("/oidc/customization/sub"))
        return {
          ok: true,
          json: {
            use_default: false,
            include_claim_keys: ["repo", "context"],
            use_immutable_subject: false
          }
        };
      if (path.endsWith("/variables/AZURE_CLIENT_ID"))
        return { ok: false, status: 404 };
      throw new Error(`Unexpected GitHub path ${path}`);
    },
    persist: async () => {
      events.push("persist");
    },
    persistenceFailure: (error) => {
      events.push(["persistence-failure", error]);
    },
    getApplicationArtifact: () => undefined,
    recordAzureApp: (patch) => {
      events.push(["application", patch]);
    }
  };
  const credentials: AzureCredentialPorts = {
    ...base,
    isRollbackPending: () => false,
    deterministicUuid: (seed) => `id:${seed}`,
    ensureServicePrincipal: async () => ({
      ok: true,
      state: "reused",
      origin: "pre_existing",
      objectId: "principal-id"
    }),
    tempFile: {
      createPath: () => "credential.json",
      write: (_path, contents) => {
        events.push(["write", contents]);
      },
      remove: (path) => {
        events.push(["remove", path]);
      }
    },
    withCredentialProvenanceLock: async (work) => {
      events.push("lock");
      try {
        return await work();
      } finally {
        events.push("unlock");
      }
    },
    recordServicePrincipal: (patch) => {
      events.push(["principal", patch]);
    },
    recordCreatedFederatedCredential: (entry) => {
      events.push(["credential", entry]);
    },
    recordFederatedCredentialProvenance: async (entry) => {
      events.push(["provenance", entry]);
    },
    recordCreatedRoleAssignment: (entry) => {
      events.push(["role", entry]);
    }
  };
  return { application, credentials, events };
}

export async function existingIdentityAz(
  args: string[]
): Promise<ProviderMutationCommandResult> {
  const call = args.slice(0, 3).join(" ");
  if (call === "account set --subscription") return command();
  if (call === "account show --output")
    return command(
      JSON.stringify({ id: subscriptionId, tenantId, user: { type: "user" } })
    );
  if (call === "ad app show") return command("application-object");
  if (call === "ad signed-in-user show") return command(callerId);
  if (call === "ad app owner") return command(callerId);
  if (call === "ad app federated-credential")
    return command(JSON.stringify([liveCredential]));
  if (call === "rest --method GET") return command("[]");
  if (call === "role assignment create") return command();
  throw new Error(`Unexpected Azure command: ${args.join(" ")}`);
}
