import {
  buildRadiusAppProvenanceTags,
  type GitHubJsonResponse
} from "../../../src/azure-oidc.js";
import {
  configureCredentialProvenanceStore,
  recordCredentialProvenance,
  withCredentialProvenanceLock
} from "../../../src/credential-provenance.js";
import {
  recordAzureApp,
  recordCreatedFederatedCredential,
  recordCreatedRoleAssignment,
  recordServicePrincipal,
  requireInput,
  resumeAfterInput,
  hasWarnings,
  setCloudContext,
  setContext
} from "../../../src/operations.js";
import { ensureServicePrincipal } from "../../../src/server.js";
import type { ConfigureEnvironmentDependencies } from "../../../src/server/services/configure-environment.js";
import type { CreateEnvironmentRequestData } from "../../../src/server/routes/create-environment-refusals.js";
import type { CreateEnvironmentOperation } from "../../../src/server/routes/create-environment-types.js";
import type { AzureAutoSetupOperation } from "../../../src/server/routes/azure-auto-setup-types.js";
import {
  createAzureSetupService,
  type AzureSetupRequest
} from "../../../src/server/services/azure-setup.js";
import { createConfigureEnvironmentService } from "../../../src/server/services/configure-environment.js";
import { createAzureAutoSetupTestDependencies } from "./azure-auto-setup.js";

export const parityAzureRequest = {
  subscriptionId: "22222222-2222-2222-2222-222222222222",
  tenantId: "11111111-1111-1111-1111-111111111111",
  resourceGroup: "resources",
  clusterResourceGroup: "cluster-resources",
  cluster: "cluster",
  createNew: true
};
export const parityClientId = "33333333-3333-3333-3333-333333333333";
const callerId = "44444444-4444-4444-4444-444444444444";

export function unexpectedParityCall(...args: unknown[]): never {
  throw new Error(`Unexpected parity fixture call: ${JSON.stringify(args)}`);
}

export function createParityAzureFixture(
  operation: AzureAutoSetupOperation,
  environment: ConfigureEnvironmentDependencies,
  trace: (entry: unknown) => void
) {
  const provenance = new Map<string, unknown>();
  const registered = environment.getOperation(operation.operationId);
  if (!registered || registered !== operation)
    throw new Error(
      "The parity fixture requires the registered live operation."
    );
  function environmentOperation(
    value: AzureAutoSetupOperation | null
  ): CreateEnvironmentOperation | null {
    if (value === null) return null;
    if (value !== registered) return unexpectedParityCall(value.operationId);
    return registered;
  }
  const executor = environment.getSelectedGitHubExecutor(operation.operationId);
  if (!executor) throw new Error("The fixture requires a selected executor.");
  const tags = buildRadiusAppProvenanceTags({
    repo: operation.repo,
    environment: operation.environment,
    operationId: operation.operationId
  });
  let credentialBody: unknown;
  let liveCredential: object | undefined;
  const dependencies = createAzureAutoSetupTestDependencies({
    stageAuthorizeIdentity: environment.stageAuthorizeIdentity,
    ensureServicePrincipal,
    sleep: async (delay) => {
      trace(["sleep", delay]);
    },
    operations: {
      get: (id) => (id === operation.operationId ? operation : undefined),
      create: unexpectedParityCall,
      persist: environment.persistOperations,
      enterStage: (_op, stage) => environment.enterStage(registered, stage),
      setStageState: (_op, stage, state) =>
        environment.setStageState(registered, stage, state),
      addLegacyStep: (_op, text) => environment.addLegacyStep(registered, text),
      setContext: (op, patch) => {
        setContext(op, patch);
        trace(["context", patch]);
      },
      setCloudContext: (op, provider, patch) => {
        setCloudContext(op, provider, patch);
        trace(["cloud-context", provider, patch]);
      },
      recordAzureApp: (op, patch) => {
        recordAzureApp(op, patch);
        trace(["application", patch]);
      },
      recordServicePrincipal: (op, patch) => {
        recordServicePrincipal(op, patch);
        trace(["principal", patch]);
      },
      recordCreatedFederatedCredential: (op, entry) => {
        recordCreatedFederatedCredential(op, entry);
        trace(["credential", entry]);
      },
      recordCreatedRoleAssignment: (op, entry) => {
        recordCreatedRoleAssignment(op, entry);
        trace(["role", entry]);
      },
      recordFederatedCredentialProvenance: async (op, entry) => {
        const recorded = await recordCredentialProvenance({
          ...entry,
          operationId: op.operationId
        });
        if (!recorded)
          throw new Error("Invalid fixture credential provenance.");
      },
      withCredentialProvenanceLock,
      requireInput: (op, input) => {
        requireInput(op, input);
        trace(["input-required", input]);
      },
      resumeAfterInput,
      hasWarnings,
      finish: (op, state, options) => {
        environmentOperation(op);
        environment.finish(registered, state, options);
      },
      report: environment.reportOperationDiagnostic
    },
    external: {
      getSelectedGitHubExecutor: () => executor,
      preflightRepoAdmin: environment.preflightRepoAdmin,
      preflightGhcrPackageWriteAccess:
        environment.preflightGhcrPackageWriteAccess,
      runGitHubJson: async (path): Promise<GitHubJsonResponse> => {
        trace(["github-identity-read", path]);
        if (path === "/repos/octo/app") {
          return {
            ok: true,
            json: { full_name: "octo/app", id: 2, owner: { id: 1 } }
          };
        }
        if (path === "/repos/octo/app/actions/oidc/customization/sub") {
          return {
            ok: true,
            json: {
              use_default: false,
              include_claim_keys: ["repository_id", "context"]
            }
          };
        }
        // An absent environment client id is an application-selection input,
        // not an ignorable transport read.
        if (
          path === "/repos/octo/app/environments/dev/variables/AZURE_CLIENT_ID"
        )
          return { ok: false, status: 404 };
        return unexpectedParityCall(path);
      },
      runAz: async (args) => {
        trace(["az", args]);
        const reply = (stdout = "", code = 0, stderr = "") => ({
          stdout,
          code,
          stderr
        });
        const verb = args.slice(0, 3).join(" ");
        if (verb === "account set --subscription") return reply();
        if (verb === "account show --output") {
          return reply(
            JSON.stringify({
              id: parityAzureRequest.subscriptionId,
              tenantId: parityAzureRequest.tenantId,
              user: { type: "user", name: "fixture@example.test" }
            })
          );
        }
        if (verb === "ad app list") return reply("[]");
        if (verb === "ad signed-in-user show") return reply(callerId);
        if (verb === "ad app create") return reply(parityClientId);
        if (verb === "ad app owner")
          return args[3] === "list" ?
              reply(callerId)
            : reply("", 1, "added object references already exist");
        if (verb === "ad app show")
          return reply(
            args.includes("tags") ? JSON.stringify(tags) : "application-object"
          );
        if (args[0] === "rest" && args.includes("PATCH")) return reply();
        if (verb === "ad sp show")
          return reply("", 1, "Request_ResourceNotFound");
        if (verb === "ad sp create") return reply('{"id":"principal-object"}');
        if (verb === "ad app federated-credential" && args[3] === "list")
          return reply("[]");
        if (verb === "ad app federated-credential" && args[3] === "create") {
          if (!credentialBody || typeof credentialBody !== "object")
            throw new Error(
              "Credential creation requires a written request body."
            );
          liveCredential = { ...credentialBody, id: "credential-object" };
          return reply(JSON.stringify(liveCredential));
        }
        if (
          verb === "ad app federated-credential" &&
          args[3] === "show" &&
          liveCredential
        )
          return reply(JSON.stringify(liveCredential));
        if (verb === "role assignment create") return reply();
        return unexpectedParityCall(args);
      }
    },
    tempFile: {
      createPath: () => "credential.json",
      write: (path, contents) => {
        credentialBody = JSON.parse(contents);
        trace(["credential-file", path, credentialBody]);
      },
      remove: (path) => {
        trace(["credential-file-remove", path]);
        credentialBody = undefined;
      }
    },
    honorStopBoundary: (input) =>
      environment.guardStopBoundary({
        ...input,
        operation: environmentOperation(input.operation),
        // Azure's service owns its stopped outcome; the configuration stop
        // adapter also presents it, which is irrelevant to this binding.
        respond: () => {}
      }),
    persistMutationCheckpoint: (input) =>
      environment.persistMutationCheckpoint({
        ...input,
        operation: environmentOperation(input.operation)
      }),
    finalizeSetupFailure: (op, input) =>
      environment.finalizeSetupFailure(environmentOperation(op), { ...input })
  });

  return {
    dependencies,
    provenance,
    async bindProvenance() {
      await configureCredentialProvenanceStore({
        load: async () => {
          trace(["provenance-load"]);
          return structuredClone([...provenance.values()]);
        },
        read: unexpectedParityCall,
        write: async (key, value) => {
          provenance.set(key, structuredClone(value));
          trace(["provenance-write", key, value]);
        },
        remove: unexpectedParityCall,
        withLock: async (work) => {
          trace(["lock"]);
          try {
            return await work();
          } finally {
            trace(["unlock"]);
          }
        }
      });
    },
    runDirect(request: AzureSetupRequest) {
      return createAzureSetupService(dependencies)({ data: request });
    }
  };
}

export async function runDirectParityConfiguration(
  data: CreateEnvironmentRequestData,
  dependencies: ConfigureEnvironmentDependencies,
  instanceId = "panel-a"
) {
  return createConfigureEnvironmentService(dependencies)({ data }, instanceId);
}
