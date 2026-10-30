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
  it.each(["azure_application.create", "github_environment_variable.put"])(
    "preserves interruption without counting a failed reread of %s",
    async (kind) => {
      const interruption = new ProviderMutationRecoveryError(
        "Runtime stopped",
        "setup-execution-interrupted"
      );
      const test = harness({
        reconcileFailure: async () => {
          throw new Error("No provider read occurred");
        },
        authorizeAzure: async () => {
          throw interruption;
        },
        configureEnvironment: async () => {
          throw interruption;
        }
      });
      test.mutations.push({ mutationId: "pending", kind });
      await expect(runSetupCoordinator(test.target, test.ports)).rejects.toBe(
        interruption
      );
    }
  );

  it.each(["azure_application.create", "github_environment_variable.put"])(
    "still accounts for genuine read failure while reconciling %s",
    async (kind) => {
      const failure = new Error("Provider read failed");
      const reported = new ProviderMutationRecoveryError(
        "Recovery remains unresolved",
        "provider-mutation-outcome-unknown"
      );
      const calls: unknown[] = [];
      const test = harness({
        reconcileFailure: async (mutationId, error) => {
          calls.push([mutationId, error]);
          throw reported;
        },
        authorizeAzure: async () => {
          throw failure;
        },
        configureEnvironment: async () => {
          throw failure;
        }
      });
      test.mutations.push({ mutationId: "pending", kind });
      await expect(runSetupCoordinator(test.target, test.ports)).rejects.toBe(
        reported
      );
      expect(calls).toEqual([["pending", failure]]);
    }
  );

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
              roleArn: provider === "aws" ? "role" : undefined
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
});
