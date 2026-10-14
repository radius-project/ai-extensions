import { afterEach, describe, expect, it, vi } from "vitest";
import {
  providerMutationRecord,
  recordAzureApp,
  recordCreatedFederatedCredential,
  recordCreatedRoleAssignment,
  recordServicePrincipal
} from "../../operations.js";
import {
  buildRadiusAppProvenanceTags,
  type ResolveOidcSubjectResult
} from "../../azure-oidc.js";
import { ensureServicePrincipal } from "../../server.js";
import { resolveAzureAutoSetupApplication } from "./azure-auto-setup-application.js";
import { configureAzureAutoSetupCredentials } from "./azure-auto-setup-credentials.js";
import type {
  AzureAutoSetupCommandResult,
  AzureAutoSetupOperation,
  AzureAutoSetupWorkflow
} from "./azure-auto-setup-types.js";
import { createAzureAutoSetupTestDependencies } from "../../../test/support/server/azure-auto-setup.js";

const appId = "33333333-3333-3333-3333-333333333333";
const callerId = "44444444-4444-4444-4444-444444444444";
const oidc: ResolveOidcSubjectResult = {
  fullName: "owner/repo",
  repoId: 2,
  ownerId: 1,
  subjectConfig: { useDefault: false },
  federatedCredentials: [
    { name: "dev", subject: "repo:owner/repo:environment:dev" }
  ]
};
const credential = {
  id: "credential-object",
  name: "dev",
  subject: oidc.federatedCredentials[0].subject,
  issuer: "https://token.actions.githubusercontent.com",
  audiences: ["api://AzureADTokenExchange"]
};
afterEach(() => vi.useRealTimers());

describe("Azure setup ordered provider transcript", () => {
  it("preserves commands, journal saves, legacy narration, and durable evidence for every Azure mutation kind", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-14T10:00:00.000Z");
    const trace: unknown[] = [];
    const operation: AzureAutoSetupOperation = {
      operationId: "setup-golden",
      repo: "owner/repo",
      environment: "dev",
      provider: "azure",
      currentStage: "authorize_identity"
    };
    const tags = buildRadiusAppProvenanceTags({
      repo: "owner/repo",
      environment: "dev",
      operationId: operation.operationId
    });
    const steps: string[] = [];
    const rawPush = steps.push.bind(steps);
    steps.push = (...items) => {
      trace.push(...items.map((text) => ["step", text]));
      return rawPush(...items);
    };
    const reply = (
      stdout = "",
      code: number | string = 0,
      stderr = ""
    ): AzureAutoSetupCommandResult => ({ stdout, code, stderr });
    const runAz = async (args: string[]) => {
      trace.push(["az", args]);
      const verb = args.slice(0, 3).join(" ");
      if (verb === "ad app list") return reply("[]");
      if (verb === "ad signed-in-user show") return reply(callerId);
      if (verb === "ad app create") return reply(appId);
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
      if (verb === "ad app federated-credential")
        return reply(args[3] === "list" ? "[]" : JSON.stringify(credential));
      if (verb === "role assignment create") return reply();
      throw new Error(`Unexpected Azure command ${args.join(" ")}`);
    };
    const persisted: unknown[] = [];
    const persist = async () => {
      const state = operation.providerRecovery as
        { mutations?: Array<{ kind: string; target: string }> } | undefined;
      const latest = state?.mutations?.at(-1);
      if (latest) {
        const record = providerMutationRecord(
          operation,
          latest.kind,
          latest.target
        );
        trace.push(["save", latest.kind, record?.status, record?.evidence]);
        persisted.push(JSON.parse(JSON.stringify(record)));
      } else trace.push(["save"]);
    };
    const dependencies = createAzureAutoSetupTestDependencies({
      ensureServicePrincipal,
      sleep: async (delay) => {
        trace.push(["sleep", delay]);
      },
      tempFile: {
        createPath: () => "credential.json",
        write: (path, contents) => {
          trace.push(["file", path, JSON.parse(contents)]);
        },
        remove: (path) => {
          trace.push(["remove", path]);
        }
      },
      operations: {
        persist,
        recordAzureApp: (op, patch) => {
          recordAzureApp(op, patch);
          trace.push(["application", patch]);
        },
        recordServicePrincipal: (op, patch) => {
          recordServicePrincipal(op, patch);
          trace.push(["principal", patch]);
        },
        recordCreatedFederatedCredential: (op, entry) => {
          recordCreatedFederatedCredential(op, entry);
          trace.push(["credential", entry]);
        },
        recordFederatedCredentialProvenance: async (_op, entry) => {
          trace.push(["provenance", entry]);
        },
        recordCreatedRoleAssignment: (op, entry) => {
          recordCreatedRoleAssignment(op, entry);
          trace.push(["role", entry]);
        },
        withCredentialProvenanceLock: async (work) => {
          trace.push(["lock"]);
          try {
            return await work();
          } finally {
            trace.push(["unlock"]);
          }
        }
      }
    });
    const workflow: AzureAutoSetupWorkflow = {
      operation,
      steps,
      runAz,
      runGitHubJson: async (path) => {
        trace.push(["github", path]);
        return { ok: false, status: 404 };
      },
      respond: () => {
        throw new Error("Unexpected response");
      },
      fail: async (_status, error) => {
        throw new Error(error);
      },
      stopBoundary: async (boundary) => {
        trace.push(["stop", boundary]);
        return true;
      },
      checkpoint: async (boundary) => {
        trace.push(["checkpoint", boundary]);
        await persist();
        return true;
      }
    };
    const application = await resolveAzureAutoSetupApplication({
      workflow,
      dependencies,
      oidc,
      environment: "dev",
      explicitAppId: "",
      createNewApp: true,
      appNameProvided: false,
      requestedAppName: "",
      requestedClientId: "",
      serviceManagementReference: "",
      callerIdentity: { kind: "user" }
    });
    expect(application).toEqual({
      clientId: appId,
      appName: "radius-deploy-owner-repo",
      state: "created"
    });
    expect(
      await configureAzureAutoSetupCredentials({
        workflow,
        dependencies,
        oidc,
        oidcSuffix: "environment:dev",
        clientId: appId,
        tenantId: "11111111-1111-1111-1111-111111111111",
        appName: "radius-deploy-owner-repo",
        subscriptionId: "22222222-2222-2222-2222-222222222222",
        resourceGroup: "resources",
        clusterResourceGroup: "cluster-resources",
        clusterName: "cluster"
      })
    ).toBe(true);
    expect(trace).toMatchSnapshot("ordered external and durable effects");
    expect(persisted).toMatchSnapshot("journal records at each save");
  });
});
