import { describe, expect, it } from "vitest";
import {
  createOperation,
  operationDomain
} from "../../../test/support/environment-operation-domain.js";
import {
  runEnvironmentOperationWorkflow,
  createEnvironmentSetupContinuations,
  type EnvironmentOperationRecord,
  type EnvironmentOperationWorkflowDependencies
} from "./environment-operation.js";
import type { SelectedGhExecutor } from "./execution-ports.js";
import { environmentSetupResult } from "./setup-result.js";

function unexpected(): never {
  throw new Error("Unexpected environment port call");
}

function harness(provider: "azure" | "aws" = "azure") {
  const journal = createOperation({ operationId: "op-independent" });
  const operation: EnvironmentOperationRecord = {
    ...journal,
    provider,
    request: {
      needsAzureCredentials: true,
      azure: { resourceGroup: "rg" },
      environment: { clientId: "existing-client" }
    },
    setupArtifacts: {
      githubEnvironment: {
        state: "pending",
        repo: null,
        name: null,
        providerId: null
      }
    }
  };
  const events: string[] = [];
  const requests: object[] = [];
  const executor: SelectedGhExecutor = {
    login: "octocat",
    credentialSource: "keyring",
    requiresKeyringSwitch: false,
    scopes: ["repo"],
    run: unexpected,
    runOrThrow: unexpected,
    verifyIdentity: unexpected,
    packageCredentials: unexpected,
    redact: (value) => value,
    errorMessage: String
  };
  const dependencies: EnvironmentOperationWorkflowDependencies = {
    operationDomain,
    preflightRepoAdmin: async () => {
      events.push("admin");
      return "";
    },
    preflightGhcrPackageWriteAccess: async () => {
      events.push("package");
      return { ok: true };
    },
    guardStopBoundary: async (_operation, boundary) => {
      events.push(boundary);
      return true;
    },
    readGitHubJson: async () => ({
      ok: true,
      status: 200,
      json: { id: "env-1", name: "Dev" },
      stderr: ""
    }),
    setCanonicalEnvironment: (_operation, name) => {
      events.push(`canonical:${name}`);
    },
    recordGitHubEnvironment: (_operation, patch) => {
      operation.setupArtifacts.githubEnvironment = {
        ...patch,
        providerId: patch.providerId ?? null
      };
    },
    promoteCreatedGitHubEnvironment: unexpected,
    addLegacyStep: () => {},
    persistEnvironmentResolution: async () => {
      events.push("persist");
      return true;
    },
    persistProviderMutation: unexpected,
    finalizeEnvironmentResolutionFailure: async (_operation, failure) => {
      requests.push(failure);
    },
    getOperation: () => operation,
    provisionAzureCredentials: async (request) => {
      events.push("azure");
      requests.push(request);
      return { clientId: "new-client" };
    },
    configureEnvironment: async (request) => {
      events.push("configure");
      requests.push(request);
      return { success: true };
    },
    now: () => 0
  };
  return { operation, executor, dependencies, events, requests };
}

describe("host-independent environment continuation", () => {
  it.each(["azure", "aws"] as const)(
    "resolves the canonical name and sequences %s setup through typed ports",
    async (provider) => {
      const test = harness(provider);
      expect(
        await runEnvironmentOperationWorkflow(
          test.operation,
          test.executor,
          test.dependencies
        )
      ).toEqual({ shouldMonitor: true });
      expect(test.events.slice(0, 3)).toEqual([
        "before-github-environment",
        "admin",
        "package"
      ]);
      expect(test.events.indexOf("persist")).toBeLessThan(
        test.events.indexOf("configure")
      );
      expect(test.events.includes("azure")).toBe(provider === "azure");
      expect(test.requests.at(-1)).toMatchObject({
        operationId: "op-independent",
        repo: "octo/app",
        environment: "Dev",
        clientId: provider === "azure" ? "new-client" : "existing-client"
      });
    }
  );

  describe("setup continuation result boundary", () => {
    it.each(["provisionAzureCredentials", "configureEnvironment"] as const)(
      "preserves %s success and input-required bodies, but throws rejected outcomes",
      async (continuation) => {
        const calls: object[] = [];
        let result = environmentSetupResult(200, {
          success: true,
          clientId: "client-1"
        });
        const run = async (data: object) => {
          calls.push(data);
          return result;
        };
        const ports = createEnvironmentSetupContinuations({
          provisionAzureCredentials: run,
          configureEnvironment: run
        });
        const request = { repo: "octo/app", environment: "dev" };
        await expect(ports[continuation](request)).resolves.toBe(result.body);
        expect(calls).toEqual([request]);

        result = environmentSetupResult(409, {
          inputRequired: true,
          error: "Choose an application",
          code: "app-selection-required"
        });
        await expect(ports[continuation](request)).resolves.toBe(result.body);

        result = environmentSetupResult(403, {
          error: "Repository administration is required",
          code: "repo-admin-required"
        });
        await expect(ports[continuation](request)).rejects.toThrow(
          "Repository administration is required"
        );

        result = environmentSetupResult(500, { code: "unavailable" });
        await expect(ports[continuation](request)).rejects.toThrow(
          "Request failed with HTTP 500."
        );
        result = environmentSetupResult(500, { error: "" });
        await expect(ports[continuation](request)).rejects.toThrow(
          "Request failed with HTTP 500."
        );
        result = environmentSetupResult(500, {
          error: { message: "untrusted" }
        });
        await expect(ports[continuation](request)).rejects.toThrow(
          "Request failed with HTTP 500."
        );
      }
    );

    it.each([199, 200, 299, 300])(
      "retains the successful status interval at %s",
      async (status) => {
        const result = environmentSetupResult(status, { success: true });
        const ports = createEnvironmentSetupContinuations({
          provisionAzureCredentials: async () => result,
          configureEnvironment: async () => result
        });
        if (status >= 200 && status < 300) {
          await expect(ports.configureEnvironment({})).resolves.toBe(
            result.body
          );
        } else {
          await expect(ports.configureEnvironment({})).rejects.toThrow(
            `Request failed with HTTP ${status}.`
          );
        }
      }
    );

    it.each(["provisionAzureCredentials", "configureEnvironment"] as const)(
      "does not request verification monitoring when %s rejects",
      async (continuation) => {
        const test = harness();
        const ports = createEnvironmentSetupContinuations({
          provisionAzureCredentials: async () =>
            environmentSetupResult(200, { success: true }),
          configureEnvironment: async () =>
            environmentSetupResult(200, { success: true }),
          [continuation]: async () =>
            environmentSetupResult(500, { error: "Provider unavailable" })
        });
        Object.assign(test.dependencies, ports);
        await expect(
          runEnvironmentOperationWorkflow(
            test.operation,
            test.executor,
            test.dependencies
          )
        ).rejects.toThrow("Provider unavailable");
      }
    );
  });

  it("waits for Azure input rather than starting environment configuration", async () => {
    const test = harness();
    test.dependencies.provisionAzureCredentials = async () => ({
      inputRequired: true
    });
    expect(
      await runEnvironmentOperationWorkflow(
        test.operation,
        test.executor,
        test.dependencies
      )
    ).toEqual({ shouldMonitor: false });
    expect(test.events).not.toContain("configure");
  });

  it("propagates continuation failure without a successful monitor result", async () => {
    const test = harness();
    test.dependencies.configureEnvironment = async () => {
      throw new Error("publication unavailable");
    };
    await expect(
      runEnvironmentOperationWorkflow(
        test.operation,
        test.executor,
        test.dependencies
      )
    ).rejects.toThrow("publication unavailable");
  });

  it("does not proceed if canonical resolution could not be persisted", async () => {
    const test = harness();
    test.dependencies.persistEnvironmentResolution = async () => false;
    expect(
      await runEnvironmentOperationWorkflow(
        test.operation,
        test.executor,
        test.dependencies
      )
    ).toEqual({ shouldMonitor: false });
    expect(test.events).not.toContain("azure");
    expect(test.events).not.toContain("configure");
  });

  it.each([
    { setup: "provisionAzureCredentials", message: "Azure is reconciling" },
    { setup: "configureEnvironment", message: "Environment is reconciling" },
    { setup: "provisionAzureCredentials", message: "" },
    { setup: "configureEnvironment", message: "" }
  ] as const)(
    "surfaces $setup reconciliation without starting a monitor ($message)",
    async ({ setup, message }) => {
      const test = harness();
      test.dependencies[setup] = async () => ({ reconciling: true, message });
      await expect(
        runEnvironmentOperationWorkflow(
          test.operation,
          test.executor,
          test.dependencies
        )
      ).rejects.toMatchObject({
        code: "provider-mutation-outcome-unknown",
        message:
          message ||
          (setup === "provisionAzureCredentials" ?
            "Azure setup is reconciling an uncertain provider mutation."
          : "Environment setup is reconciling an uncertain provider mutation.")
      });
      if (setup === "provisionAzureCredentials")
        expect(test.events).not.toContain("configure");
    }
  );

  it.each([
    {
      setupClient: "fresh",
      contextClient: "saved",
      requestClient: "request",
      expected: "fresh"
    },
    {
      setupClient: "",
      contextClient: "saved",
      requestClient: "request",
      expected: "saved"
    },
    {
      setupClient: 12,
      contextClient: "",
      requestClient: "request",
      expected: "request"
    },
    { setupClient: null, contextClient: false, requestClient: 12, expected: "" }
  ])(
    "selects the first usable client identity ($expected)",
    async ({ setupClient, contextClient, requestClient, expected }) => {
      const test = harness();
      test.operation.context = { clientId: contextClient };
      test.operation.request = {
        needsAzureCredentials: true,
        environment: { clientId: requestClient }
      };
      test.dependencies.provisionAzureCredentials = async () => ({
        clientId: setupClient
      });
      await runEnvironmentOperationWorkflow(
        test.operation,
        test.executor,
        test.dependencies
      );
      expect(test.requests.at(-1)).toMatchObject({ clientId: expected });
    }
  );

  it.each([null, [], "malformed"])(
    "does not forward malformed nested request fields (%j)",
    async (value) => {
      const test = harness();
      test.operation.request = {
        needsAzureCredentials: true,
        azure: value,
        environment: value
      };
      await runEnvironmentOperationWorkflow(
        test.operation,
        test.executor,
        test.dependencies
      );
      expect(test.requests).toEqual([
        {
          repo: "octo/app",
          environment: "Dev",
          operationEnvironment: "dev",
          operationId: "op-independent"
        },
        {
          repo: "octo/app",
          environment: "Dev",
          operationEnvironment: "dev",
          provider: "azure",
          operationId: "op-independent",
          clientId: "new-client"
        }
      ]);
    }
  );

  it("uses the saved resume request when the original request is absent", async () => {
    const test = harness();
    test.operation.request = undefined;
    test.operation.resumeRequest = {
      environment: { clientId: "resumed", namespace: "isolated" }
    };
    await runEnvironmentOperationWorkflow(
      test.operation,
      test.executor,
      test.dependencies
    );
    expect(test.events).not.toContain("azure");
    expect(test.requests).toEqual([
      expect.objectContaining({ clientId: "resumed", namespace: "isolated" })
    ]);
  });

  it.each(["missing", "input_required", "ended"] as const)(
    "does not configure after the live operation becomes %s",
    async (state) => {
      const test = harness();
      test.dependencies.getOperation = () =>
        state === "missing" ? undefined : (
          {
            ...test.operation,
            state: state === "input_required" ? state : "failed",
            endedAt: state === "ended" ? "2026-08-22T00:00:00.000Z" : undefined
          }
        );
      expect(
        await runEnvironmentOperationWorkflow(
          test.operation,
          test.executor,
          test.dependencies
        )
      ).toEqual({ shouldMonitor: false });
      expect(test.events).not.toContain("configure");
    }
  );

  it("honors input state written by Azure even when its response body is empty", async () => {
    const test = harness();
    test.dependencies.provisionAzureCredentials = async () => {
      test.operation.state = "input_required";
      return null;
    };
    expect(
      await runEnvironmentOperationWorkflow(
        test.operation,
        test.executor,
        test.dependencies
      )
    ).toEqual({ shouldMonitor: false });
    expect(test.events).not.toContain("configure");
  });

  it("honors Stop after saving canonical resolution and before provisioning credentials", async () => {
    const test = harness();
    test.dependencies.guardStopBoundary = async (_operation, boundary) =>
      boundary !== "after-github-environment";
    expect(
      await runEnvironmentOperationWorkflow(
        test.operation,
        test.executor,
        test.dependencies
      )
    ).toEqual({ shouldMonitor: false });
    expect(test.events).toContain("persist");
    expect(test.events).not.toContain("azure");
    expect(test.events).not.toContain("configure");
  });

  it("propagates a later setup error when the outstanding mutation was already reconciled", async () => {
    const test = harness();
    const pending = operationDomain.prepareProviderMutation(test.operation, {
      kind: "azure_app.create",
      target: "client"
    });
    test.dependencies.provisionAzureCredentials = async () => {
      operationDomain.settleProviderMutation(
        test.operation,
        pending.mutationId,
        "confirmed",
        "Azure returned the exact application identity."
      );
      throw new Error("Later credential configuration failed");
    };
    await expect(
      runEnvironmentOperationWorkflow(
        test.operation,
        test.executor,
        test.dependencies
      )
    ).rejects.toThrow("Later credential configuration failed");
    expect(operationDomain.unresolvedProviderMutations(test.operation)).toEqual(
      []
    );
    expect(test.events).not.toContain("configure");
  });

  it.each([
    {
      error: "offline",
      message: "offline",
      code: "github-environment-resolution-failed",
      status: 400
    },
    {
      error: { message: "offline", code: "lookup-unavailable", status: 502 },
      message: "offline",
      code: "lookup-unavailable",
      status: 502
    },
    {
      error: { message: "", code: "", status: "invalid" },
      message: "[object Object]",
      code: "github-environment-resolution-failed",
      status: 400
    }
  ])(
    "normalizes provider lookup failures without inventing success ($message)",
    async ({ error, message, code, status }) => {
      const test = harness();
      test.dependencies.readGitHubJson = async () => {
        throw error;
      };
      expect(
        await runEnvironmentOperationWorkflow(
          test.operation,
          test.executor,
          test.dependencies
        )
      ).toEqual({ shouldMonitor: false });
      expect(test.requests).toEqual([
        { status, error: message, code, remediation: null }
      ]);
      expect(test.events).not.toContain("configure");
    }
  );
});
