import { describe, expect, it } from "vitest";
import {
  runSetupCoordinator,
  type SetupCoordinatorOperation,
  type SetupCoordinatorPorts,
  type SetupCoordinatorTarget
} from "./setup-coordinator.js";
import { runAzureSetup } from "./setup-azure.js";
import { configureSetupEnvironment } from "./setup-environment.js";
import { ensureGitHubEnvironment } from "./setup-github-environment.js";
import { ProviderMutationRecoveryError } from "./setup-recovery-error.js";
import { setupEnvironmentHarness } from "../test/support/setup-environment.js";
import {
  azurePorts,
  existingIdentityAz,
  request as azureRequest
} from "../test/support/azure-setup.js";

const ROLE_ARN = "arn:aws:iam::111111111111:role/radius-deploy";

function harness(overrides: Partial<SetupCoordinatorPorts> = {}) {
  const target: SetupCoordinatorTarget = {
    operationId: "op_setup",
    repo: "owner/repo",
    environment: "dev",
    provider: "azure"
  };
  const operation: SetupCoordinatorOperation = {
    state: "running",
    context: {},
    request: {
      needsAzureCredentials: true,
      azure: azureRequest,
      environment: {}
    }
  };
  const transcript: unknown[] = [];
  const mutations: Array<{ mutationId: string; kind: string }> = [];
  const ports: SetupCoordinatorPorts = {
    operation: () => operation,
    currentOperation: () => operation,
    unresolved: () => mutations,
    preflightRepository: async () => true,
    preflightPackages: async () => true,
    stopBoundary: async (boundary) => {
      transcript.push(["stop", boundary]);
      return true;
    },
    readEnsuredEnvironment: () => null,
    ensureEnvironment: (beforeCreate) =>
      ensureGitHubEnvironment({
        repo: target.repo,
        requestedName: target.environment,
        beforeCreate,
        now: () => 100,
        sleep: async () => {
          throw new Error("Unexpected retry");
        },
        readGitHubJson: async () => ({
          ok: true,
          json: { name: target.environment, id: 17 }
        }),
        runGh: async () => {
          throw new Error("Existing environment must not be written");
        }
      }),
    setCanonicalEnvironment: (name) => {
      operation.context = { ...operation.context, canonicalEnvironment: name };
    },
    recordEnvironment: (patch) => {
      transcript.push(["record", patch]);
    },
    promoteCreatedEnvironment: () => false,
    report: (event) => {
      transcript.push(["event", event]);
    },
    checkpoint: async () => {
      transcript.push(["checkpoint"]);
      return true;
    },
    finalizeFailure: async (failure) => {
      transcript.push(["failure", failure]);
    },
    reconcileFailure: async (_mutation, error) => {
      throw error;
    },
    authorizeAzure: async (request) => {
      transcript.push(["azure", request]);
      return { kind: "completed", clientId: "selected-client" };
    },
    authorizeAws: async (request) => {
      transcript.push(["aws", request]);
      return { kind: "completed", roleArn: ROLE_ARN };
    },
    configureEnvironment: async (request) => {
      transcript.push(["configure", request]);
      return { kind: "completed" };
    },
    raiseReconciling: (_stage, message) => {
      throw new ProviderMutationRecoveryError(
        String(message),
        "provider-mutation-outcome-unknown"
      );
    },
    ...overrides
  };
  return { target, operation, transcript, mutations, ports };
}

describe("runSetupCoordinator", () => {
  it("stops after the canonical environment checkpoint without invoking a provider", async () => {
    const test = harness({
      stopBoundary: async (boundary) => boundary !== "after-github-environment"
    });
    expect(await runSetupCoordinator(test.target, test.ports)).toEqual({
      shouldMonitor: false
    });
    expect(test.transcript.at(-1)).toEqual(["checkpoint"]);
  });

  it("uses the saved resume request only when the original request is undefined", async () => {
    const test = harness();
    test.operation.resumeRequest = {
      needsAzureCredentials: false,
      environment: { clientId: "resume-client" }
    };
    test.operation.request = undefined;
    expect(await runSetupCoordinator(test.target, test.ports)).toEqual({
      shouldMonitor: true
    });
    expect(test.transcript).toContainEqual([
      "configure",
      { ...test.target, operationEnvironment: "dev", clientId: "resume-client" }
    ]);
  });

  it.each(["azure", "aws"])(
    "composes the shared %s setup entry points against one live record without HTTP",
    async (provider) => {
      const test = harness();
      test.target.provider = provider;
      const environment = setupEnvironmentHarness();
      const azure = azurePorts(existingIdentityAz);
      azure.application.operationId = test.target.operationId;
      azure.credentials.operationId = test.target.operationId;
      azure.application.recovery = environment.ports.recovery;
      azure.credentials.recovery = environment.ports.recovery;
      environment.ports.azureCredential = () => test.operation.context ?? {};
      test.ports.unresolved = () => environment.ports.recovery.unresolved();
      test.ports.authorizeAzure = async (forwarded) => {
        const result = await runAzureSetup(
          {
            request: {
              ...azureRequest,
              repo: forwarded.repo,
              environment: forwarded.environment,
              operationEnvironment: forwarded.operationEnvironment
            },
            serviceManagementReference: "",
            continuation: null
          },
          {
            ...azure,
            identityProgress: (event) =>
              test.transcript.push(["identity", event]),
            finalizeIdentityFailure: async (failure) => {
              throw new Error(`Unexpected identity failure: ${failure.kind}`);
            },
            prepareContinuation: (resolved) => {
              test.operation.context = {
                ...test.operation.context,
                tenantId: resolved.tenantId,
                subscriptionId: resolved.subscriptionId
              };
            }
          }
        );
        if (result.kind !== "completed") {
          throw new Error(`Unexpected Azure result: ${result.kind}`);
        }
        test.operation.context = {
          ...test.operation.context,
          clientId: result.application.clientId
        };
        return { kind: "completed", clientId: result.application.clientId };
      };
      test.ports.configureEnvironment = async (forwarded) => {
        const result = await configureSetupEnvironment(
          {
            ...environment.input,
            operationId: forwarded.operationId,
            targetRepo: forwarded.repo,
            envName: forwarded.environment,
            provider,
            data: {
              clientId: forwarded.clientId,
              roleArn: forwarded.roleArn === undefined ? undefined : "role"
            }
          },
          environment.ports
        );
        expect(result.kind).toBe("configured");
        return { kind: "completed" };
      };
      expect(await runSetupCoordinator(test.target, test.ports)).toEqual({
        shouldMonitor: true
      });
      expect(
        environment.mutations.every((entry) => entry.status === "confirmed")
      ).toBe(true);
      expect(environment.transcript).toContainEqual([
        "variable",
        provider === "azure" ? "AZURE_CLIENT_ID" : "AWS_ROLE_ARN",
        provider === "azure" ? azureRequest.requestedClientId : "role"
      ]);
      expect(test.operation.context?.canonicalEnvironment).toBe("dev");
      expect(azure.events.length > 0).toBe(provider === "azure");
      expect(environment.transcript).not.toContain("deploy");
    }
  );

  it.each(["input_required", "failed"])(
    "re-reads the registry after Azure changes the live operation to %s",
    async (state) => {
      const test = harness();
      test.ports.authorizeAzure = async () => {
        test.operation.state = state;
        test.operation.endedAt = state === "failed" ? "finished" : undefined;
        return { kind: "completed" };
      };
      expect(await runSetupCoordinator(test.target, test.ports)).toEqual({
        shouldMonitor: false
      });
      expect(
        test.transcript.some(
          (entry) => Array.isArray(entry) && entry[0] === "configure"
        )
      ).toBe(false);
    }
  );

  it("uses a client id written to live context by Azure when its result has no id", async () => {
    const test = harness();
    test.ports.authorizeAzure = async () => {
      test.operation.context = { clientId: "live-client" };
      return { kind: "completed" };
    };
    await runSetupCoordinator(test.target, test.ports);
    expect(test.transcript).toContainEqual([
      "configure",
      {
        ...test.target,
        operationEnvironment: "dev",
        clientId: "live-client"
      }
    ]);
  });

  it("does not reconcile an already settled mutation when a later transport fails", async () => {
    const test = harness();
    test.mutations.push({ mutationId: "pending", kind: "azure_app.create" });
    const failure = new Error("connection failed");
    test.ports.authorizeAzure = async () => {
      test.mutations.length = 0;
      throw failure;
    };
    test.ports.reconcileFailure = async () => {
      throw new Error("Already-settled journal must not be counted again");
    };
    await expect(runSetupCoordinator(test.target, test.ports)).rejects.toBe(
      failure
    );
  });

  it("does not count a reconciling result as another failed provider read", async () => {
    const test = harness();
    test.mutations.push({ mutationId: "pending", kind: "azure_app.create" });
    test.ports.authorizeAzure = async () => ({
      kind: "reconciling",
      message: "read already recorded"
    });
    test.ports.reconcileFailure = async () => {
      throw new Error("The reconciling result must not be recounted");
    };
    await expect(
      runSetupCoordinator(test.target, test.ports)
    ).rejects.toMatchObject({
      code: "provider-mutation-outcome-unknown",
      message: "read already recorded"
    });
  });

  describe("AWS", () => {
    function awsHarness(overrides: Partial<SetupCoordinatorPorts> = {}) {
      const test = harness(overrides);
      test.target.provider = "aws";
      test.operation.request = {
        environment: { accountId: "111111111111", cluster: "dev-cluster" }
      };
      return test;
    }

    it("authorizes the deploy identity before configuring the environment with its role", async () => {
      const test = awsHarness();
      expect(await runSetupCoordinator(test.target, test.ports)).toEqual({
        shouldMonitor: true
      });
      const stages = test.transcript.filter(
        (entry) =>
          Array.isArray(entry) &&
          (entry[0] === "aws" || entry[0] === "configure")
      );
      expect(stages).toEqual([
        [
          "aws",
          {
            accountId: "111111111111",
            cluster: "dev-cluster",
            repo: "owner/repo",
            environment: "dev",
            reused: true
          }
        ],
        [
          "configure",
          {
            accountId: "111111111111",
            cluster: "dev-cluster",
            ...test.target,
            operationEnvironment: "dev",
            roleArn: ROLE_ARN,
            clientId: ""
          }
        ]
      ]);
    });

    it("marks a newly created GitHub environment as not reused", async () => {
      const test = awsHarness({
        ensureEnvironment: async () => ({
          name: "dev",
          state: "created",
          providerId: "17"
        })
      });
      await runSetupCoordinator(test.target, test.ports);
      expect(test.transcript).toContainEqual([
        "aws",
        expect.objectContaining({ reused: false })
      ]);
    });

    it("finalizes an AWS authorization failure without configuring the environment", async () => {
      const error = { status: 409, message: "conflict", code: "conflict" };
      const test = awsHarness({
        authorizeAws: async () => ({ kind: "failed", error })
      });
      expect(await runSetupCoordinator(test.target, test.ports)).toEqual({
        shouldMonitor: false
      });
      expect(test.transcript.slice(-2)).toEqual([
        ["stop", "before-setup-failure-cleanup"],
        ["failure", { kind: "aws-authorization", error }]
      ]);
      expect(
        test.transcript.some(
          (entry) => Array.isArray(entry) && entry[0] === "configure"
        )
      ).toBe(false);
    });

    it("stops without finalizing when the stop boundary declines after an AWS failure", async () => {
      const test = awsHarness({
        authorizeAws: async () => ({ kind: "failed", error: "denied" }),
        stopBoundary: async (boundary) =>
          boundary !== "before-setup-failure-cleanup"
      });
      expect(await runSetupCoordinator(test.target, test.ports)).toEqual({
        shouldMonitor: false
      });
      expect(
        test.transcript.some(
          (entry) => Array.isArray(entry) && entry[0] === "failure"
        )
      ).toBe(false);
    });

    it("reuses the recorded role instead of authorizing again while reconciling", async () => {
      const test = awsHarness({
        authorizeAws: async () => {
          throw new Error("A reconciling setup must not authorize again");
        },
        readEnsuredEnvironment: (name) => ({
          name,
          state: "reused",
          providerId: "17"
        })
      });
      test.mutations.push({ mutationId: "pending", kind: "github_variable" });
      test.operation.context = { awsRoleArn: ROLE_ARN };
      expect(await runSetupCoordinator(test.target, test.ports)).toEqual({
        shouldMonitor: true
      });
      expect(test.transcript).toContainEqual([
        "configure",
        expect.objectContaining({ roleArn: ROLE_ARN })
      ]);
    });

    it("leaves the role out when no authorization or recorded role exists", async () => {
      const test = awsHarness({
        readEnsuredEnvironment: (name) => ({
          name,
          state: "reused",
          providerId: "17"
        })
      });
      test.mutations.push({ mutationId: "pending", kind: "github_variable" });
      await runSetupCoordinator(test.target, test.ports);
      const configure = test.transcript.find(
        (entry) => Array.isArray(entry) && entry[0] === "configure"
      );
      expect(configure).toBeDefined();
      expect(Array.isArray(configure) && configure[1]).not.toHaveProperty(
        "roleArn"
      );
    });
  });
});
