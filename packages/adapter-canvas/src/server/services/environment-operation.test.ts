import { describe, expect, it } from "vitest";
import {
  assertSetupExecutionActive,
  buildGitHubTrustPolicy
} from "@radius-project/core";
import type { GitHubJsonResponse } from "../../azure-oidc.js";
import {
  addLegacyStep,
  applySetupResumePoint,
  beginRetryAttempt,
  canContinueSetup,
  createOperation,
  enterStage,
  prepareProviderMutation,
  projectOperationActions,
  promoteCreatedGitHubEnvironment,
  requestStop,
  settleProviderMutation,
  shouldStop,
  provenOwnedCleanupTargets,
  recordGitHubEnvironment,
  setCanonicalEnvironment,
  setContext,
  setStageState,
  STAGE_AUTHORIZE_IDENTITY,
  unresolvedProviderMutations
} from "../../operations.js";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import { createAwsEnvironmentAccess } from "./aws-environment-access.js";
import { honorStopBoundary } from "./operation-stop-boundary.js";
import {
  createSetupCoordinatorPorts,
  runEnvironmentOperationWorkflow,
  type EnvironmentOperationRecord,
  type EnvironmentOperationWorkflowDependencies
} from "./environment-operation.js";
import type { GitHubEnvironmentCommandResult } from "./github-environment.js";
import type { SetupOutcome, SetupServices } from "./setup-outcome.js";

function stages(
  invoke: (
    pathname: string,
    data: Record<string, unknown>
  ) => Promise<Record<string, unknown> | null>
): SetupServices {
  const call = async (
    path: string,
    data: Record<string, unknown>
  ): Promise<SetupOutcome> => {
    const body = (await invoke(path, data)) ?? {};
    return {
      kind:
        body.reconciling ? "reconciling"
        : body.inputRequired ? "input-required"
        : "completed",
      status:
        body.reconciling ? 202
        : body.inputRequired ? 409
        : 200,
      body
    };
  };
  return {
    authorizeAzure: (data) => call("/api/azure-auto-setup", data),
    configureEnvironment: (data) => call("/api/create-environment", data)
  };
}

function command(
  overrides: Partial<GitHubEnvironmentCommandResult> = {}
): GitHubEnvironmentCommandResult {
  return { code: 0, stdout: "", stderr: "", ...overrides };
}

function operation(): EnvironmentOperationRecord {
  const op = createOperation({
    provider: "azure",
    repo: "octo/app",
    environment: "production"
  });
  op.request = {
    needsAzureCredentials: true,
    azure: { resourceGroup: "rg" },
    environment: { clientId: "", environment: "production" }
  };
  op.resumeRequest = structuredClone(op.request);
  return op;
}

const NOW = Date.parse("2026-08-25T01:06:05.000Z");
const AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/r";
const AWS_SUBJECTS = ["repo:octo/shop:environment:dev"];

function awsIdentityReady(): Partial<EnvironmentOperationWorkflowDependencies> {
  return {
    setupAwsDeployIdentity: async () => ({
      ok: true,
      roleArn: AWS_ROLE_ARN,
      subjects: AWS_SUBJECTS,
      policyName: "radius-deploy-production-111111111111"
    })
  };
}

function dependencies(
  op: EnvironmentOperationRecord,
  overrides: Partial<EnvironmentOperationWorkflowDependencies> = {}
): {
  dependencies: EnvironmentOperationWorkflowDependencies;
  events: string[];
  failures: Array<{
    status: number;
    error: string;
    code: string;
    remediation?: unknown;
  }>;
  posts: Array<{ pathname: string; data: Record<string, unknown> }>;
} {
  const events: string[] = [];
  const failures: Array<{
    status: number;
    error: string;
    code: string;
    remediation?: unknown;
  }> = [];
  const posts: Array<{ pathname: string; data: Record<string, unknown> }> = [];
  return {
    events,
    failures,
    posts,
    dependencies: {
      setupAwsDeployIdentity: async () => {
        throw new Error("unexpected AWS deploy identity setup");
      },
      releaseAwsDeployIdentity: async () => {
        events.push("release-aws");
      },
      isStopped: () => false,
      guardStopBoundary: async (_target, boundary) => {
        events.push(`stop:${boundary}`);
        return true;
      },
      preflightRepoAdmin: async () => {
        events.push("preflight-admin");
        return "";
      },
      preflightGhcrPackageWriteAccess: async () => {
        events.push("preflight-ghcr");
        return { ok: true };
      },
      readGitHubJson: async (apiPath, executor) => {
        if (apiPath === "/repos/octo/app") {
          return {
            ok: true,
            status: 200,
            json: { full_name: "octo/app" },
            stderr: ""
          };
        }
        const result = await executor.run(["api", apiPath]);
        const statusMatch = result.stderr.match(/\bHTTP\s+(\d{3})\b/i);
        let json: unknown = null;
        if (result.stdout.trim()) {
          json = JSON.parse(result.stdout);
        }
        return {
          ok: result.code === 0 || result.code === "0",
          status:
            result.code === 0 || result.code === "0" ? 200
            : statusMatch ? Number(statusMatch[1])
            : null,
          json,
          stderr: result.stderr
        };
      },
      setCanonicalEnvironment: (target, environment) => {
        events.push(`canonical:${environment}`);
        setCanonicalEnvironment(target, environment);
      },
      recordGitHubEnvironment: (target, patch) => {
        events.push(`record:${patch.state}:${patch.name}`);
        recordGitHubEnvironment(target, patch);
      },
      promoteCreatedGitHubEnvironment: (target, identity) => {
        const promoted = promoteCreatedGitHubEnvironment(target, identity);
        events.push(`promote:${String(promoted)}`);
        return promoted;
      },
      addLegacyStep: (_target, text) => {
        events.push(`step:${text}`);
      },
      persistEnvironmentResolution: async () => {
        events.push("persist");
        return true;
      },
      persistProviderMutation: async () => {
        events.push("persist-provider-mutation");
      },
      finalizeEnvironmentResolutionFailure: async (_target, input) => {
        failures.push(input);
      },
      getOperation: () => op,
      instanceId: "coordinator-panel",
      setupServices: stages(async (pathname, data) => {
        events.push(`post:${pathname}`);
        posts.push({ pathname, data: data as Record<string, unknown> });
        return pathname === "/api/azure-auto-setup" ?
            { clientId: "client-1" }
          : { success: true };
      }),
      now: () => NOW,
      ...overrides
    }
  };
}

describe("runEnvironmentOperationWorkflow", () => {
  it.each([
    null,
    "provider connection lost",
    { detail: "unstructured failure" }
  ])(
    "finalizes an unstructured environment read rejection without inventing provider success: %j",
    async (failure) => {
      const op = operation();
      const test = dependencies(op, {
        readGitHubJson: async () => {
          throw failure;
        }
      });
      expect(
        await runEnvironmentOperationWorkflow(
          op,
          successfulSelectedGhExecutor(),
          test.dependencies
        )
      ).toEqual({ shouldMonitor: false });
      expect(test.failures).toEqual([
        {
          status: 400,
          error: String(failure),
          code: "github-environment-resolution-failed",
          remediation: null
        }
      ]);
      expect(test.posts).toEqual([]);
      expect(unresolvedProviderMutations(op)).toEqual([]);
    }
  );

  it.each([
    [
      "azure",
      "azure_application.create",
      "One recovery attempt.",
      "One recovery attempt."
    ],
    [
      "environment",
      "github_workflow.put",
      "One recovery attempt.",
      "One recovery attempt."
    ],
    [
      "azure",
      "azure_application.create",
      "",
      "Azure setup is reconciling an uncertain provider mutation."
    ],
    [
      "environment",
      "github_workflow.put",
      undefined,
      "Environment setup is reconciling an uncertain provider mutation."
    ]
  ] as const)(
    "does not reconcile a returned %s reconciliation outcome a second time",
    async (stage, mutationKind, message, expectedMessage) => {
      const op = operation();
      setCanonicalEnvironment(op, "Production");
      recordGitHubEnvironment(op, {
        state: "reused",
        origin: "pre_existing",
        repo: op.repo,
        name: "Production",
        providerId: "environment-1"
      });
      prepareProviderMutation(op, {
        kind: mutationKind,
        target: "pending-write"
      });
      const saved = structuredClone(op);
      const test = dependencies(op, {
        setupServices: {
          authorizeAzure: async () => {
            expect(stage).toBe("azure");
            return {
              kind: "reconciling",
              status: 202,
              body: { message }
            };
          },
          configureEnvironment: async () => {
            expect(stage).toBe("environment");
            return {
              kind: "reconciling",
              status: 202,
              body: { message }
            };
          }
        }
      });
      await expect(
        runEnvironmentOperationWorkflow(
          op,
          successfulSelectedGhExecutor(),
          test.dependencies
        )
      ).rejects.toMatchObject({
        code: "provider-mutation-outcome-unknown",
        message: expectedMessage
      });
      expect(op).toEqual(saved);
      expect(test.events).toEqual([
        "canonical:Production",
        "record:reused:Production",
        'step:✅ GitHub resolved requested environment "production" as "Production".',
        "persist",
        "stop:after-github-environment"
      ]);
      expect(test.failures).toEqual([]);
    }
  );

  it("passes its own projection instance and an isolated JSON snapshot to configuration", async () => {
    const op = operation();
    op.provider = "aws";
    const nested = { value: "saved", omitted: undefined };
    op.request = {
      environment: { nested, optional: undefined, roleName: "fixture" }
    };
    const test = dependencies(op, {
      ...awsIdentityReady(),
      instanceId: "own-panel",
      setupServices: {
        authorizeAzure: async () => {
          throw new Error("Unexpected Azure call");
        },
        configureEnvironment: async (request, instanceId) => {
          expect(instanceId).toBe("own-panel");
          expect(request).not.toHaveProperty("optional");
          expect(request.nested).toEqual({ value: "saved" });
          expect(request.nested).not.toBe(nested);
          Object.assign(request.nested as object, { value: "callback" });
          return { kind: "stopped", status: 200, body: { cancelled: true } };
        }
      }
    });
    const executor = successfulSelectedGhExecutor({
      run: async () =>
        command({ stdout: JSON.stringify({ name: "Production" }) })
    });
    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: true });
    expect(nested).toEqual({ value: "saved", omitted: undefined });
  });

  it("honors a durable stop before any GitHub or GHCR work", async () => {
    const op = operation();
    const test = dependencies(op, {
      guardStopBoundary: async (_target, boundary) => {
        test.events.push(`stop:${boundary}`);
        return false;
      }
    });

    let ghCalls = 0;
    const executor = successfulSelectedGhExecutor({
      run: async () => {
        ghCalls += 1;
        return command();
      }
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: false });
    expect(test.events).toEqual(["stop:before-github-environment"]);
    expect(ghCalls).toBe(0);
  });

  it("keeps repository-read authority independent of cooperative Stop", async () => {
    const op = operation();
    requestStop(op);
    let stopped = false;
    const test = dependencies(op, {
      isStopped: () => stopped,
      preflightRepoAdmin: async (_repo, _executor, assertActive) => {
        expect(assertActive).toBeTypeOf("function");
        assertActive?.();
        stopped = true;
        assertActive?.();
        throw new Error("Missing runtime interruption");
      }
    });
    const ports = createSetupCoordinatorPorts(
      op,
      successfulSelectedGhExecutor(),
      test.dependencies
    );
    await expect(ports.preflightRepository()).rejects.toMatchObject({
      code: "setup-execution-interrupted"
    });
    expect(test.failures).toEqual([]);
    expect(op.endedAt).toBeNull();
  });

  it("lets Stop win over cleanup after a failed preflight", async () => {
    const op = operation();
    let boundaries = 0;
    const test = dependencies(op, {
      guardStopBoundary: async (_target, boundary) => {
        test.events.push(`stop:${boundary}`);
        boundaries += 1;
        return boundaries === 1;
      },
      preflightRepoAdmin: async () => "admin required"
    });

    expect(
      await runEnvironmentOperationWorkflow(
        op,
        successfulSelectedGhExecutor(),
        test.dependencies
      )
    ).toEqual({ shouldMonitor: false });
    expect(test.events).toContain("stop:before-setup-failure-cleanup");
    expect(test.failures).toEqual([]);
  });

  it("lets Stop win over cleanup after a refused GHCR package preflight", async () => {
    const op = operation();
    let boundaries = 0;
    const test = dependencies(op, {
      guardStopBoundary: async (_target, boundary) => {
        test.events.push(`stop:${boundary}`);
        boundaries += 1;
        return boundaries === 1;
      },
      preflightGhcrPackageWriteAccess: async () => ({
        ok: false,
        status: 403,
        error: "GHCR package write access is missing.",
        code: "ghcr-package-write-required"
      })
    });

    expect(
      await runEnvironmentOperationWorkflow(
        op,
        successfulSelectedGhExecutor(),
        test.dependencies
      )
    ).toEqual({ shouldMonitor: false });
    expect(test.events).toContain("stop:before-setup-failure-cleanup");
    expect(test.failures).toEqual([]);
  });

  it("reconciles an outstanding environment write before honoring Stop", async () => {
    const op = operation();
    requestStop(op);
    prepareProviderMutation(op, {
      kind: "github_environment.put",
      target: "octo/app:production"
    });
    const test = dependencies(op, {
      preflightRepoAdmin: async () => {
        throw new Error("repository preflight must not run during recovery");
      },
      preflightGhcrPackageWriteAccess: async () => {
        throw new Error("GHCR preflight must not run during recovery");
      },
      guardStopBoundary: async (_target, boundary) => {
        test.events.push(`stop:${boundary}`);
        return false;
      }
    });
    const ghCalls: string[][] = [];
    const executor = successfulSelectedGhExecutor({
      run: async (args) => {
        ghCalls.push(args);
        return command({ code: 1, stderr: "HTTP 404" });
      }
    });

    await expect(
      runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).resolves.toEqual({ shouldMonitor: false });

    expect(unresolvedProviderMutations(op)).toEqual([]);
    expect(test.events).toEqual([
      "persist-provider-mutation",
      "stop:after-github-environment-attempt"
    ]);
    expect(test.failures).toEqual([]);
    expect(ghCalls.some((args) => args.includes("PUT"))).toBe(false);
    expect(test.events).not.toContain("preflight-admin");
    expect(test.events).not.toContain("preflight-ghcr");
  });

  it.each(["environment", "azure", "interruption"])(
    "preserves unresolved evidence when %s rejects after shutdown",
    async (boundary) => {
      const op = operation();
      let stopped = false;
      if (boundary === "azure") {
        setCanonicalEnvironment(op, "Production");
        recordGitHubEnvironment(op, {
          state: "reused",
          origin: "pre_existing",
          repo: op.repo,
          name: "Production",
          providerId: "environment-1"
        });
      }
      prepareProviderMutation(op, {
        kind:
          boundary === "azure" ?
            "azure_application.create"
          : "github_environment.put",
        target: "octo/app:production"
      });
      const original = structuredClone(unresolvedProviderMutations(op));
      const fail = async (): Promise<never> => {
        stopped = true;
        if (boundary === "interruption")
          assertSetupExecutionActive(() => stopped);
        throw new Error("Late provider read failed");
      };
      const test = dependencies(op, {
        isStopped: () => stopped,
        ...(boundary === "azure" ?
          { setupServices: stages(fail) }
        : { readGitHubJson: fail })
      });
      await expect(
        runEnvironmentOperationWorkflow(
          op,
          successfulSelectedGhExecutor(),
          test.dependencies
        )
      ).rejects.toMatchObject({ code: "setup-execution-interrupted" });
      expect(unresolvedProviderMutations(op)).toEqual(original);
      expect(test.failures).toEqual([]);
      expect(test.events).not.toContain("persist-provider-mutation");
    }
  );
  it("bounds failures before an outstanding environment write can reconcile", async () => {
    const op = operation();
    const mutation = prepareProviderMutation(op, {
      kind: "github_environment.put",
      target: "octo/app:production"
    });
    const test = dependencies(op);
    const executor = successfulSelectedGhExecutor({
      run: async () => command({ code: 1, stderr: "HTTP 500: unavailable" })
    });

    await expect(
      runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).rejects.toMatchObject({
      code: "provider-mutation-outcome-unknown"
    });

    expect(
      unresolvedProviderMutations(op).find(
        (entry) => entry.mutationId === mutation.mutationId
      )
    ).toMatchObject({
      status: "outcome_unknown",
      reconcileAttempts: 1,
      evidence:
        'Provider state could not be read: Could not resolve GitHub environment "production". HTTP 500: unavailable'
    });
    expect(test.events).toContain("persist-provider-mutation");
  });

  it("does not double-count a failure recorded by environment reconciliation", async () => {
    const op = operation();
    const mutation = prepareProviderMutation(op, {
      kind: "github_environment.put",
      target: "octo/app:production"
    });
    let environmentReads = 0;
    const test = dependencies(op, {
      readGitHubJson: async (apiPath) => {
        if (apiPath === "/repos/octo/app/environments/production") {
          environmentReads += 1;
          return environmentReads === 1 ?
              {
                ok: true,
                status: 200,
                json: { id: 1234567, name: "production" },
                stderr: ""
              }
            : {
                ok: false,
                status: 500,
                json: null,
                stderr: "HTTP 500: unavailable"
              };
        }
        throw new Error(`Unexpected GitHub read: ${apiPath}`);
      }
    });

    await expect(
      runEnvironmentOperationWorkflow(
        op,
        successfulSelectedGhExecutor(),
        test.dependencies
      )
    ).rejects.toMatchObject({
      code: "provider-mutation-outcome-unknown"
    });

    expect(
      unresolvedProviderMutations(op).find(
        (entry) => entry.mutationId === mutation.mutationId
      )
    ).toMatchObject({
      status: "outcome_unknown",
      reconcileAttempts: 1,
      evidence: "Provider state could not be read: HTTP 500: unavailable"
    });
    expect(
      test.events.filter((entry) => entry === "persist-provider-mutation")
    ).toHaveLength(1);
  });

  it("reuses the durable environment while downstream recovery is pending", async () => {
    const op = operation();
    requestStop(op);
    setCanonicalEnvironment(op, "Production");
    recordGitHubEnvironment(op, {
      state: "reused",
      origin: "pre_existing",
      repo: "octo/app",
      name: "Production",
      providerId: "environment-1"
    });
    prepareProviderMutation(op, {
      kind: "azure_application.create",
      target: "octo/app:production"
    });
    const test = dependencies(op, {
      preflightRepoAdmin: async () => {
        throw new Error("repository preflight must not run during recovery");
      },
      preflightGhcrPackageWriteAccess: async () => {
        throw new Error("GHCR preflight must not run during recovery");
      },
      readGitHubJson: async () => {
        throw new Error("the durable environment must not be reread");
      },
      setupServices: stages(async (pathname, data) => {
        test.posts.push({ pathname, data: data as Record<string, unknown> });
        return {
          reconciling: true,
          message: "The application create is still being reconciled."
        };
      })
    });

    await expect(
      runEnvironmentOperationWorkflow(
        op,
        successfulSelectedGhExecutor(),
        test.dependencies
      )
    ).rejects.toMatchObject({
      code: "provider-mutation-outcome-unknown"
    });

    expect(test.posts.map(({ pathname }) => pathname)).toEqual([
      "/api/azure-auto-setup"
    ]);
    expect(test.events).not.toContain("preflight-admin");
    expect(test.events).not.toContain("preflight-ghcr");
  });

  it("routes downstream recovery directly to the outstanding mutation owner", async () => {
    const op = operation();
    requestStop(op);
    setCanonicalEnvironment(op, "Production");
    op.context = { ...(op.context || {}), clientId: "durable-client-id" };
    recordGitHubEnvironment(op, {
      state: "reused",
      origin: "pre_existing",
      repo: "octo/app",
      name: "Production",
      providerId: "environment-1"
    });
    prepareProviderMutation(op, {
      kind: "github_workflow.put",
      target: "octo/app:main:.github/workflows/radius-deploy.yml"
    });
    const test = dependencies(op, {
      preflightRepoAdmin: async () => {
        throw new Error("repository preflight must not run during recovery");
      },
      preflightGhcrPackageWriteAccess: async () => {
        throw new Error("GHCR preflight must not run during recovery");
      },
      readGitHubJson: async () => {
        throw new Error("the durable environment must not be reread");
      },
      setupServices: stages(async (pathname, data) => {
        test.posts.push({ pathname, data: data as Record<string, unknown> });
        return {
          reconciling: true,
          message: "The workflow write is still being reconciled."
        };
      })
    });

    await expect(
      runEnvironmentOperationWorkflow(
        op,
        successfulSelectedGhExecutor(),
        test.dependencies
      )
    ).rejects.toMatchObject({
      code: "provider-mutation-outcome-unknown"
    });

    expect(test.posts).toEqual([
      {
        pathname: "/api/create-environment",
        data: expect.objectContaining({
          clientId: "durable-client-id",
          environment: "Production",
          operationId: op.operationId
        })
      }
    ]);
  });

  it("bounds failures that occur before the mutation owner can reconcile", async () => {
    const op = operation();
    setCanonicalEnvironment(op, "Production");
    recordGitHubEnvironment(op, {
      state: "reused",
      origin: "pre_existing",
      repo: "octo/app",
      name: "Production",
      providerId: "environment-1"
    });
    const mutation = prepareProviderMutation(op, {
      kind: "azure_application.create",
      target: "octo/app:production"
    });
    const test = dependencies(op, {
      setupServices: stages(async () => {
        throw new Error("Azure account state is unavailable");
      })
    });

    await expect(
      runEnvironmentOperationWorkflow(
        op,
        successfulSelectedGhExecutor(),
        test.dependencies
      )
    ).rejects.toMatchObject({
      code: "provider-mutation-outcome-unknown"
    });

    expect(
      unresolvedProviderMutations(op).find(
        (entry) => entry.mutationId === mutation.mutationId
      )
    ).toMatchObject({
      status: "outcome_unknown",
      reconcileAttempts: 1,
      evidence:
        "Provider state could not be read: Azure account state is unavailable"
    });
  });

  it("persists GitHub's canonical name before Azure and propagates it downstream", async () => {
    const op = operation();
    const test = dependencies(op);
    const executor = successfulSelectedGhExecutor({
      run: async () =>
        command({ stdout: JSON.stringify({ name: "Production" }) })
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: true });

    expect(op.environment).toBe("production");
    expect(op.context).toMatchObject({
      requestedEnvironment: "production",
      canonicalEnvironment: "Production"
    });
    expect(op.request).toMatchObject({
      environment: { environment: "Production" }
    });
    expect(op.resumeRequest).toMatchObject({
      environment: { environment: "Production" }
    });
    expect(test.events.indexOf("persist")).toBeLessThan(
      test.events.indexOf("post:/api/azure-auto-setup")
    );
    expect(test.posts).toEqual([
      {
        pathname: "/api/azure-auto-setup",
        data: {
          resourceGroup: "rg",
          repo: "octo/app",
          environment: "Production",
          operationEnvironment: "production",
          operationId: op.operationId
        }
      },
      {
        pathname: "/api/create-environment",
        data: {
          clientId: "client-1",
          environment: "Production",
          operationEnvironment: "production",
          repo: "octo/app",
          provider: "azure",
          operationId: op.operationId
        }
      }
    ]);
  });

  it("creates a genuinely new environment once across a rerun", async () => {
    const op = operation();
    op.provider = "aws";
    op.request = {
      needsAzureCredentials: false,
      environment: { environment: "production", roleName: "fixture" }
    };
    let canonicalName: string | null = null;
    let putCalls = 0;
    const executor = successfulSelectedGhExecutor({
      run: async (args) => {
        if (args.includes("PUT")) {
          putCalls += 1;
          canonicalName = "Production";
          return command({
            stdout: JSON.stringify({
              name: canonicalName,
              created_at: new Date(NOW).toISOString()
            })
          });
        }
        return canonicalName ?
            command({ stdout: JSON.stringify({ name: canonicalName }) })
          : command({ code: 1, stderr: "HTTP 404" });
      }
    });
    const test = dependencies(op, awsIdentityReady());

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: true });
    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: true });

    expect(putCalls).toBe(1);
    expect(op.setupArtifacts.githubEnvironment).toMatchObject({
      state: "created",
      origin: "this_operation",
      repo: "octo/app",
      name: "Production"
    });
    expect(test.events).toContain("promote:true");
    expect(test.events.indexOf("promote:true")).toBeLessThan(
      test.events.indexOf("persist")
    );
  });

  it("keeps a newly observed environment outside cleanup when GitHub says it predates setup", async () => {
    const op = operation();
    op.provider = "aws";
    op.request = {
      needsAzureCredentials: false,
      environment: { environment: "production", roleName: "fixture" }
    };
    const executor = successfulSelectedGhExecutor({
      run: async (args) =>
        args.includes("PUT") ?
          command({
            stdout: JSON.stringify({
              name: "Production",
              created_at: "2020-01-01T00:00:00.000Z"
            })
          })
        : command({ code: 1, stderr: "HTTP 404" })
    });
    const test = dependencies(op, awsIdentityReady());

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: true });

    expect(op.setupArtifacts.githubEnvironment).toMatchObject({
      state: "created_candidate",
      origin: "unknown",
      repo: "octo/app",
      name: "Production"
    });
    expect(test.events).toContain(
      'step:ℹ️ Radius left GitHub environment "Production" outside its cleanup scope. GitHub reports the environment was created at 2020-01-01T00:00:00.000Z, before this setup wrote to it, so Radius did not create it.'
    );
  });

  it("does not touch Azure when GitHub environment lookup fails", async () => {
    const op = operation();
    const test = dependencies(op);
    const executor = successfulSelectedGhExecutor({
      run: async () => command({ code: 1, stderr: "HTTP 503" })
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: false });

    expect(test.posts).toEqual([]);
    expect(test.failures).toEqual([
      {
        status: 400,
        error: 'Could not resolve GitHub environment "production". HTTP 503',
        code: "github-environment-lookup-failed",
        remediation: null
      }
    ]);
  });

  it("records uncertain create provenance before finalizing a malformed response", async () => {
    const op = operation();
    const test = dependencies(op);
    const executor = successfulSelectedGhExecutor({
      run: async (args) =>
        args.includes("PUT") ?
          command({ stdout: "{}" })
        : command({ code: 1, stderr: "HTTP 404" })
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: false });

    expect(op.setupArtifacts.githubEnvironment).toMatchObject({
      state: "created_candidate",
      repo: "octo/app",
      name: "production"
    });
    expect(test.posts).toEqual([]);
  });

  it("starts no environment create after Stop and journals nothing", async () => {
    const op = operation();
    const ghCalls: string[][] = [];
    const test = dependencies(op, {
      guardStopBoundary: async (_target, boundary) => {
        test.events.push(`stop:${boundary}`);
        return boundary !== "before-github-environment-create";
      }
    });
    const executor = successfulSelectedGhExecutor({
      run: async (args) => {
        ghCalls.push(args);
        return command({ code: 1, stderr: "HTTP 404" });
      }
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: false });

    expect(test.events).toContain("stop:before-github-environment-create");
    expect(ghCalls.some((args) => args.includes("PUT"))).toBe(false);
    expect(test.failures).toEqual([]);
    expect(test.posts).toEqual([]);
    // Nothing was written, so nothing was journaled for a recovery to settle.
    expect(
      (
        op as EnvironmentOperationRecord & {
          providerRecovery: { mutations: unknown[] };
        }
      ).providerRecovery.mutations
    ).toEqual([]);
  });

  it("records an uncertain create before honoring Stop after the PUT", async () => {
    const op = operation();
    let attemptedPut = false;
    const test = dependencies(op, {
      guardStopBoundary: async (_target, boundary) => {
        test.events.push(`stop:${boundary}`);
        return !(
          attemptedPut && boundary === "after-github-environment-attempt"
        );
      }
    });
    const executor = successfulSelectedGhExecutor({
      run: async (args) => {
        if (args.includes("PUT")) {
          attemptedPut = true;
          return command({ stdout: "{}" });
        }
        return command({ code: 1, stderr: "HTTP 404" });
      }
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: false });

    expect(op.setupArtifacts.githubEnvironment).toMatchObject({
      state: "created_candidate",
      origin: "unknown",
      repo: "octo/app",
      name: "production"
    });
    expect(test.events).toContain("stop:after-github-environment-attempt");
    expect(test.failures).toEqual([]);
    expect(test.posts).toEqual([]);
  });

  it("stops after persisting an input-required Azure response", async () => {
    const op = operation();
    const test = dependencies(op, {
      setupServices: stages(async (pathname) => {
        test.events.push(`post:${pathname}`);
        return { inputRequired: true };
      })
    });
    const executor = successfulSelectedGhExecutor({
      run: async () =>
        command({ stdout: JSON.stringify({ name: "Production" }) })
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: false });
    expect(test.events.filter((event) => event.startsWith("post:"))).toEqual([
      "post:/api/azure-auto-setup"
    ]);
  });

  it("continues to Create Environment when Azure returns a null body", async () => {
    const op = operation();
    const test = dependencies(op, {
      setupServices: stages(async (pathname, data) => {
        test.events.push(`post:${pathname}`);
        test.posts.push({
          pathname,
          data: data as Record<string, unknown>
        });
        return pathname === "/api/azure-auto-setup" ? null : { success: true };
      })
    });
    const executor = successfulSelectedGhExecutor({
      run: async () =>
        command({ stdout: JSON.stringify({ name: "Production" }) })
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: true });
    expect(test.posts.map(({ pathname }) => pathname)).toEqual([
      "/api/azure-auto-setup",
      "/api/create-environment"
    ]);
    expect(test.posts[1]?.data).toMatchObject({
      environment: "Production"
    });
  });

  it.each([
    {
      name: "repository-admin refusal",
      overrides: {
        preflightRepoAdmin: async () => "Admin access is required."
      },
      failure: {
        status: 403,
        error: "Admin access is required.",
        code: "repo-admin-required",
        remediation: null
      }
    },
    {
      name: "GHCR refusal",
      overrides: {
        preflightGhcrPackageWriteAccess: async () => ({
          ok: false as const,
          status: 403,
          error: "Package scope is required.",
          code: "ghcr-package-write-required"
        })
      },
      failure: {
        status: 403,
        error: "Package scope is required.",
        code: "ghcr-package-write-required",
        remediation: null
      }
    }
  ])(
    "stops before environment lookup on $name",
    async ({ overrides, failure }) => {
      const op = operation();
      const test = dependencies(op, overrides);
      let ghCalls = 0;
      const executor = successfulSelectedGhExecutor({
        run: async () => {
          ghCalls += 1;
          return command();
        }
      });

      expect(
        await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
      ).toEqual({ shouldMonitor: false });
      expect(ghCalls).toBe(0);
      expect(test.failures).toEqual([failure]);
    }
  );

  // Only the id and params travel. If the whole view were forwarded, a command
  // string would ride along in a persisted record and could be rendered without
  // ever passing back through the registry.
  it("forwards a preflight remediation as an id and params, not a command", async () => {
    const op = operation();
    const test = dependencies(op, {
      preflightGhcrPackageWriteAccess: async () => ({
        ok: false as const,
        status: 403,
        error: "Run the command below.",
        code: "ghcr-scope-required",
        remediation: {
          id: "github-account-scopes",
          params: { login: "pubuser", packages: "true" },
          command: "gh auth switch -h github.com -u pubuser",
          runnable: true
        }
      })
    });

    await runEnvironmentOperationWorkflow(
      op,
      successfulSelectedGhExecutor({ run: async () => command() }),
      test.dependencies
    );

    expect(test.failures).toEqual([
      {
        status: 403,
        error: "Run the command below.",
        code: "ghcr-scope-required",
        remediation: {
          id: "github-account-scopes",
          params: { login: "pubuser", packages: "true" }
        }
      }
    ]);
  });

  it.each([
    ["a remediation without an id", { params: { login: "pubuser" } }, null],
    ["a remediation that is not a record", "gh auth switch", null],
    ["an empty id", { id: "", params: {} }, null],
    [
      "params that are not strings",
      { id: "github-account-scopes", params: 7 },
      { id: "github-account-scopes", params: {} }
    ],
    [
      "a non-string param value",
      { id: "github-account-scopes", params: { login: 7, packages: "true" } },
      { id: "github-account-scopes", params: { packages: "true" } }
    ]
  ])("normalizes %s", async (_name, remediation, expected) => {
    const op = operation();
    const test = dependencies(op, {
      preflightGhcrPackageWriteAccess: async () => ({
        ok: false as const,
        status: 403,
        error: "boom",
        code: "ghcr-scope-required",
        remediation
      })
    });

    await runEnvironmentOperationWorkflow(
      op,
      successfulSelectedGhExecutor({ run: async () => command() }),
      test.dependencies
    );

    expect(test.failures[0]?.remediation).toEqual(expected);
  });

  it("does not continue when the canonical-name checkpoint cannot persist", async () => {
    const op = operation();
    const test = dependencies(op, {
      persistEnvironmentResolution: async () => false
    });
    const executor = successfulSelectedGhExecutor({
      run: async () =>
        command({ stdout: JSON.stringify({ name: "Production" }) })
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: false });
    expect(test.posts).toEqual([]);
  });

  it("does not publish workflows after Azure ends the operation", async () => {
    const op = operation();
    const test = dependencies(op, {
      setupServices: stages(async () => {
        op.endedAt = "now";
        return { clientId: "client-1" };
      })
    });
    const executor = successfulSelectedGhExecutor({
      run: async () =>
        command({ stdout: JSON.stringify({ name: "Production" }) })
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: false });
  });

  it("refuses a malformed persisted AWS request instead of authorizing a default role", async () => {
    const op = operation();
    op.provider = "aws";
    op.request = null;
    op.resumeRequest = null;
    const test = dependencies(op, awsIdentityReady());
    const executor = successfulSelectedGhExecutor({
      run: async () =>
        command({ stdout: JSON.stringify({ name: "Production" }) })
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: false });
    expect(test.posts).toEqual([]);
    expect(test.failures).toEqual([
      expect.objectContaining({ code: "invalid-aws-operation-input" })
    ]);
  });

  it.each([
    { roleName: "radius-deploy-octo-app", existingRoleArn: "" },
    { roleName: "", existingRoleArn: AWS_ROLE_ARN },
    { roleName: "radius-deploy-octo-app", existingRoleArn: AWS_ROLE_ARN }
  ])(
    "authorizes saved AWS selectors and forwards the resolved role and trust: %j",
    async (selectors) => {
      const op = operation();
      op.provider = "aws";
      op.request = {
        needsAzureCredentials: false,
        environment: {
          environment: "production",
          ...selectors,
          accountId: "123456789012",
          region: "us-west-2",
          cluster: "eks-1"
        }
      };
      const identityCalls: Array<Record<string, unknown>> = [];
      const executor = successfulSelectedGhExecutor({
        run: async () =>
          command({ stdout: JSON.stringify({ name: "Production" }) })
      });
      const test = dependencies(op, {
        setupAwsDeployIdentity: async (target, request, received) => {
          expect(target).toBe(op);
          expect(received).toBe(executor);
          test.events.push("aws-identity");
          identityCalls.push(request);
          return {
            ok: true,
            roleArn: AWS_ROLE_ARN,
            subjects: AWS_SUBJECTS,
            policyName: "radius-deploy-production-111111111111"
          };
        }
      });

      expect(
        await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
      ).toEqual({ shouldMonitor: true });

      expect(identityCalls).toEqual([
        {
          environment: "Production",
          ...selectors,
          accountId: "123456789012",
          region: "us-west-2",
          cluster: "eks-1",
          repo: "octo/app"
        }
      ]);
      expect(test.events.indexOf("canonical:Production")).toBeLessThan(
        test.events.indexOf("aws-identity")
      );
      expect(test.events.indexOf("aws-identity")).toBeLessThan(
        test.events.indexOf("post:/api/create-environment")
      );
      expect(test.posts).toEqual([
        {
          pathname: "/api/create-environment",
          data: expect.objectContaining({
            provider: "aws",
            environment: "Production",
            roleArn: AWS_ROLE_ARN,
            trustSubjects: AWS_SUBJECTS
          })
        }
      ]);
      expect(test.failures).toEqual([]);
    }
  );

  it("stops at the AWS boundary when deploy identity setup is paused", async () => {
    const op = operation();
    op.provider = "aws";
    op.request = {
      needsAzureCredentials: false,
      environment: { environment: "production", roleName: "fixture" }
    };
    const executor = successfulSelectedGhExecutor({
      run: async () =>
        command({ stdout: JSON.stringify({ name: "Production" }) })
    });
    const test = dependencies(op, {
      setupAwsDeployIdentity: async () => ({ ok: false, stopped: true })
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: false });

    expect(test.events).toContain("stop:after-aws-deploy-identity");
    expect(test.posts).toEqual([]);
  });

  describe("an AWS failure while a restart settles an earlier write", () => {
    function restartedAwsSetup() {
      const op = operation();
      op.provider = "aws";
      op.request = {
        needsAzureCredentials: false,
        environment: {
          environment: "production",
          roleName: "radius-deploy-octo-app",
          accountId: "123456789012",
          region: "us-west-2",
          cluster: "eks-1"
        }
      };
      setCanonicalEnvironment(op, "Production");
      recordGitHubEnvironment(op, {
        state: "reused",
        origin: "pre_existing",
        repo: "octo/app",
        name: "Production",
        providerId: "environment-1"
      });
      const mutation = prepareProviderMutation(op, {
        kind: "github_workflow.put",
        target: "octo/app:main:.github/workflows/radius-verify-credentials.yml"
      });
      return { op, mutation };
    }
    const failedAws = (code: string) => ({
      setupAwsDeployIdentity: async () => ({
        ok: false as const,
        status: 400,
        code,
        error: "The AWS CLI profile is not set up. Run aws configure."
      })
    });
    const SIGN_IN_STEP =
      "step:⚠️ Radius could not sign in to AWS to check the interrupted setup. The AWS CLI profile is not set up. Run aws configure. Sign in again, and Radius continues on its own.";

    it.each([
      "aws-cli-login-required",
      "aws-verification-failed",
      "aws-identity-invalid",
      "aws-account-mismatch",
      "aws-cli-unsupported"
    ])(
      "keeps reconciling after %s without charging the GitHub write",
      async (code) => {
        const { op, mutation } = restartedAwsSetup();
        const test = dependencies(op, {
          ...failedAws(code),
          addLegacyStep: (target, text) => {
            test.events.push(`step:${text}`);
            addLegacyStep(target, text);
          }
        });

        // A second try reads the same failure and does not repeat the step.
        for (const _attempt of [1, 2]) {
          await expect(
            runEnvironmentOperationWorkflow(
              op,
              successfulSelectedGhExecutor(),
              test.dependencies
            )
          ).rejects.toMatchObject({
            code: "provider-mutation-outcome-unknown",
            message: "The AWS CLI profile is not set up. Run aws configure."
          });
        }

        expect(
          test.events.filter((event) => event === SIGN_IN_STEP)
        ).toHaveLength(1);
        const live = unresolvedProviderMutations(op).find(
          (entry) => entry.mutationId === mutation.mutationId
        );
        expect(live).toMatchObject({ status: "prepared" });
        expect(live?.reconcileAttempts ?? 0).toBe(0);
        expect(test.failures).toEqual([]);
        expect(test.posts).toEqual([]);
        expect(
          test.events.filter((event) => event === "release-aws")
        ).toHaveLength(2);
      }
    );

    it("still charges an AWS failure that signing in would not fix", async () => {
      const { op, mutation } = restartedAwsSetup();
      const test = dependencies(op, failedAws("aws-role-unreadable"));

      await expect(
        runEnvironmentOperationWorkflow(
          op,
          successfulSelectedGhExecutor(),
          test.dependencies
        )
      ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });

      expect(
        unresolvedProviderMutations(op).find(
          (entry) => entry.mutationId === mutation.mutationId
        )
      ).toMatchObject({
        reconcileAttempts: 1,
        evidence:
          "Provider state could not be read: The AWS CLI profile is not set up. Run aws configure."
      });
      expect(test.events).not.toContain(SIGN_IN_STEP);
    });

    it("finalizes a sign-in failure as usual when nothing is unsettled", async () => {
      const op = operation();
      op.provider = "aws";
      op.request = {
        needsAzureCredentials: false,
        environment: { environment: "production", roleName: "fixture" }
      };
      const test = dependencies(op, failedAws("aws-cli-login-required"));

      expect(
        await runEnvironmentOperationWorkflow(
          op,
          successfulSelectedGhExecutor({
            run: async () =>
              command({ stdout: JSON.stringify({ name: "Production" }) })
          }),
          test.dependencies
        )
      ).toEqual({ shouldMonitor: false });
      expect(test.failures).toEqual([
        expect.objectContaining({ code: "aws-cli-login-required" })
      ]);
    });
  });

  it.each(["lock wait", "failed policy read"])(
    "keeps authorization paused during %s, including after Continue",
    async (pauseAt) => {
      const account = "123456789012";
      const op = createOperation({
        provider: "aws",
        repo: "octo/app",
        environment: "production"
      });
      op.request = {
        needsAzureCredentials: false,
        environment: {
          environment: "production",
          roleName: "radius-deploy-octo-app",
          accountId: account,
          region: "us-west-2",
          cluster: "eks-1"
        }
      };
      op.resumeRequest = structuredClone(op.request);
      const executor = successfulSelectedGhExecutor({
        run: async () =>
          command({ stdout: JSON.stringify({ name: "Production" }) })
      });
      const awsAnswers: Record<string, GitHubEnvironmentCommandResult> = {
        "--version": command({
          stdout: "aws-cli/2.17.0 Python/3.11 Darwin/23"
        }),
        "sts get-caller-identity": command({
          stdout: JSON.stringify({ Account: account })
        }),
        "eks describe-cluster": command({
          stdout: JSON.stringify({
            cluster: {
              status: "ACTIVE",
              accessConfig: { authenticationMode: "API" }
            }
          })
        }),
        // Another run holds the lock for the whole test.
        "iam create-policy": command({
          code: 254,
          stderr:
            "An error occurred (EntityAlreadyExists) when calling CreatePolicy"
        }),
        "iam get-policy": command({
          stdout: JSON.stringify({
            Policy: { PolicyId: "LOCK0", CreateDate: "2026-08-25T01:05:00Z" }
          })
        })
      };
      const stageStates = () =>
        Object.fromEntries(
          op.stages.map((stage: { id: string; state: string }) => [
            stage.id,
            stage.state
          ])
        );
      const waits: Array<Record<string, string>> = [];
      const access = createAwsEnvironmentAccess<EnvironmentOperationRecord>({
        async runAws(args) {
          const answer = awsAnswers[args.slice(0, 2).join(" ")];
          if (!answer) throw new Error(`unexpected aws ${args.join(" ")}`);
          return answer;
        },
        async runGitHubJson(path) {
          if (
            pauseAt === "failed policy read" &&
            path.endsWith("/variables?per_page=100")
          ) {
            waits.push(stageStates());
            requestStop(op);
            return { ok: false, status: 403, json: null };
          }
          if (path === "/repos/octo/app") {
            return {
              ok: true,
              status: 200,
              json: { full_name: "octo/app", id: 42, owner: { id: 7 } }
            };
          }
          return { ok: false, status: 404, json: null };
        },
        environments: {
          listEnvironmentNames: async () => {
            throw new Error("unexpected environment listing");
          },
          readEnvironmentVariables: async () => {
            throw new Error("unexpected variable read");
          }
        },
        // Each poll of the held lock is where the customer presses Pause.
        sleep: async () => {
          waits.push(stageStates());
          requestStop(op);
        },
        now: () => NOW,
        isStopRequested: shouldStop,
        isStoppedOperation: () => false,
        operationId: (target) => target.operationId,
        operations: {
          getContext: (target) => target.context ?? {},
          enterStage,
          setStageState,
          addLegacyStep,
          setContext,
          touch: () => {}
        },
        store: { persist: async () => {} },
        stageAuthorizeIdentity: STAGE_AUTHORIZE_IDENTITY,
        errorMessage: (error) =>
          error instanceof Error ? error.message : String(error)
      });
      const test = dependencies(op, {
        setupAwsDeployIdentity: (target, request, received) =>
          access.setup(target, request, received),
        releaseAwsDeployIdentity: (target) => access.release(target),
        guardStopBoundary: (target, boundary) =>
          honorStopBoundary({
            operation: target,
            boundary,
            persist: async () => {}
          })
      });

      await runEnvironmentOperationWorkflow(op, executor, test.dependencies);

      expect(op.state).toBe("cancelled");
      expect(stageStates()).toEqual({
        authorize_identity: "paused",
        configure_environment: "skipped",
        verify: "skipped"
      });
      const eligibility = canContinueSetup(op);
      expect(eligibility).toMatchObject({
        ok: true,
        resumeFrom: "aws_deploy_identity"
      });
      expect(
        projectOperationActions(op).find(
          (action: { kind: string }) => action.kind === "continue_setup"
        )?.description
      ).toContain("Authorize the deploy identity");

      // What the Continue route does before it schedules the run again.
      beginRetryAttempt(op, "setup");
      applySetupResumePoint(op, eligibility.resumeFrom);
      expect(stageStates()).toEqual({
        authorize_identity: "running",
        configure_environment: "pending",
        verify: "pending"
      });
      waits.length = 0;

      await runEnvironmentOperationWorkflow(op, executor, test.dependencies);

      // Continue reruns authorization, not the later setup stages.
      expect(waits).toEqual([
        {
          authorize_identity: "running",
          configure_environment: "pending",
          verify: "pending"
        }
      ]);
      expect(test.posts).toEqual([]);
      expect(op.state).toBe("cancelled");
      expect(stageStates().authorize_identity).toBe("paused");
    }
  );

  it("finalizes an AWS deploy identity failure without creating the environment", async () => {
    const op = operation();
    op.provider = "aws";
    op.request = {
      needsAzureCredentials: false,
      environment: { environment: "production", roleName: "fixture" }
    };
    const executor = successfulSelectedGhExecutor({
      run: async () =>
        command({ stdout: JSON.stringify({ name: "Production" }) })
    });
    const test = dependencies(op, {
      setupAwsDeployIdentity: async () => ({
        ok: false,
        status: 403,
        error: "The signed-in AWS identity cannot create IAM roles.",
        code: "aws-role-create-denied"
      })
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: false });

    expect(test.events).toContain("stop:before-setup-failure-cleanup");
    expect(test.failures).toEqual([
      expect.objectContaining({
        status: 403,
        error: "The signed-in AWS identity cannot create IAM roles.",
        code: "aws-role-create-denied"
      })
    ]);
    expect(test.posts).toEqual([]);
  });

  it("refuses another repository's Radius role through the real ownership check without writing to AWS", async () => {
    const account = "123456789012";
    const picked = `arn:aws:iam::${account}:role/radius-deploy-octo-web`;
    const op = operation();
    op.provider = "aws";
    op.request = {
      needsAzureCredentials: false,
      environment: {
        environment: "production",
        roleName: "",
        existingRoleArn: picked,
        accountId: account,
        region: "us-west-2",
        cluster: "eks-1"
      }
    };
    const executor = successfulSelectedGhExecutor({
      run: async () =>
        command({ stdout: JSON.stringify({ name: "Production" }) })
    });
    const awsAnswers: Record<string, unknown> = {
      "--version": "aws-cli/2.17.0 Python/3.11 Darwin/23",
      "sts get-caller-identity": { Account: account },
      "eks describe-cluster": {
        cluster: {
          status: "ACTIVE",
          accessConfig: { authenticationMode: "API" }
        }
      },
      "iam create-policy": { Policy: { PolicyId: "LOCK1" } },
      "iam get-policy": { Policy: { PolicyId: "LOCK1" } },
      "iam delete-policy": "",
      "iam get-role": {
        Role: {
          Arn: picked,
          AssumeRolePolicyDocument: buildGitHubTrustPolicy(account, [
            "repo:octo/web:environment:dev"
          ]),
          Tags: [
            { Key: "radius-managed", Value: "true" },
            { Key: "radius-repository", Value: "octo/web" }
          ]
        }
      }
    };
    const githubAnswers: Record<string, GitHubJsonResponse> = {
      "/repos/octo/app/environments/Production/variables?per_page=100": {
        ok: true,
        status: 200,
        json: { variables: [] }
      },
      "/repos/octo/app": {
        ok: true,
        status: 200,
        json: { full_name: "octo/app", id: 42, owner: { id: 7 } }
      },
      "/repos/octo/app/actions/oidc/customization/sub": {
        ok: false,
        status: 404,
        json: null
      }
    };
    const awsCalls: string[] = [];
    const access = createAwsEnvironmentAccess<EnvironmentOperationRecord>({
      async runAws(args) {
        const key = args.slice(0, 2).join(" ");
        awsCalls.push(key);
        const answer = awsAnswers[key];
        if (answer === undefined) throw new Error(`unexpected aws ${key}`);
        return {
          code: 0,
          stdout: typeof answer === "string" ? answer : JSON.stringify(answer),
          stderr: ""
        };
      },
      async runGitHubJson(path) {
        const answer = githubAnswers[path];
        if (!answer) throw new Error(`unexpected GitHub read ${path}`);
        return answer;
      },
      environments: {
        listEnvironmentNames: async () => {
          throw new Error("unexpected environment listing");
        },
        readEnvironmentVariables: async () => {
          throw new Error("unexpected variable read");
        }
      },
      sleep: async () => {},
      now: () => NOW,
      isStopRequested: () => false,
      isStoppedOperation: () => false,
      operationId: (target) => target.operationId,
      operations: {
        getContext: (target) => target.context ?? {},
        enterStage,
        setStageState,
        addLegacyStep,
        setContext,
        touch: () => {}
      },
      store: { persist: async () => {} },
      stageAuthorizeIdentity: STAGE_AUTHORIZE_IDENTITY,
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error)
    });
    const test = dependencies(op, {
      setupAwsDeployIdentity: (target, request, received) =>
        access.setup(target, request, received),
      releaseAwsDeployIdentity: (target) => access.release(target)
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: false });

    expect(test.failures).toEqual([
      expect.objectContaining({
        status: 400,
        code: "aws-role-other-repository",
        error:
          "Radius created IAM role radius-deploy-octo-web for octo/web, so it cannot be used for octo/app. Nothing was changed. Pick another role or let Radius create one. Nothing was created in AWS."
      })
    ]);
    // The lock is the only write, and the refused setup releases it.
    expect(awsCalls).toEqual([
      "--version",
      "sts get-caller-identity",
      "eks describe-cluster",
      "iam create-policy",
      "iam get-policy",
      "iam get-role",
      "iam get-policy",
      "iam delete-policy"
    ]);
    expect(test.posts).toEqual([]);
  });

  it.each([
    [
      "already set up for Azure",
      () =>
        command({
          stdout: JSON.stringify({
            variables: [{ name: "AZURE_CLIENT_ID", value: "app-1" }]
          })
        }),
      409,
      "github-environment-provider-conflict",
      'GitHub environment "Production" is already set up for Azure. Radius did not change it or anything in AWS. Choose a different environment name, or delete the Azure environment first.'
    ],
    [
      "unreadable",
      () => command({ code: 1, stderr: "HTTP 500" }),
      502,
      "github-environment-variables-unreadable",
      'Radius could not read the variables of GitHub environment "Production" to confirm it is not set up for Azure. Nothing was changed in AWS. Retry setup.'
    ]
  ])(
    "refuses AWS setup on a reused GitHub environment that is %s",
    async (_label, variablesResult, status, code, error) => {
      const op = operation();
      op.provider = "aws";
      op.request = {
        needsAzureCredentials: false,
        environment: { environment: "production", roleName: "fixture" }
      };
      const executor = successfulSelectedGhExecutor({
        run: async (args) =>
          String(args[1]).includes("/variables") ?
            variablesResult()
          : command({ stdout: JSON.stringify({ name: "Production" }) })
      });
      const test = dependencies(op, {
        setupAwsDeployIdentity: async () => {
          throw new Error("AWS must not be touched");
        }
      });

      expect(
        await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
      ).toEqual({ shouldMonitor: false });

      expect(test.events).toContain("stop:before-setup-failure-cleanup");
      expect(test.failures).toEqual([
        expect.objectContaining({ status, code, error })
      ]);
      expect(test.posts).toEqual([]);
    }
  );

  it("lets an AWS setup reuse a GitHub environment that already holds AWS variables", async () => {
    const op = operation();
    op.provider = "aws";
    op.request = {
      needsAzureCredentials: false,
      environment: { environment: "production", roleName: "fixture" }
    };
    const executor = successfulSelectedGhExecutor({
      run: async (args) =>
        command({
          stdout: JSON.stringify(
            String(args[1]).includes("/variables") ?
              { variables: [{ name: "AWS_ROLE_ARN" }, "junk"] }
            : { name: "Production" }
          )
        })
    });
    const test = dependencies(op, {
      setupAwsDeployIdentity: async () => ({
        ok: true,
        roleArn: AWS_ROLE_ARN,
        subjects: AWS_SUBJECTS,
        policyName: "radius-deploy-production-111111111111"
      })
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: true });
    expect(test.failures).toEqual([]);
  });

  it.each([
    ["an AWS deploy identity failure", { name: "Production" }],
    [
      "an Azure variable conflict",
      { name: "Production", variables: [{ name: "AZURE_CLIENT_ID" }] }
    ]
  ])(
    "stops before cleanup when %s meets a stop request",
    async (_label, body) => {
      const op = operation();
      op.provider = "aws";
      op.request = {
        needsAzureCredentials: false,
        environment: { environment: "production", roleName: "fixture" }
      };
      const executor = successfulSelectedGhExecutor({
        run: async () => command({ stdout: JSON.stringify(body) })
      });
      const base = dependencies(op, {
        setupAwsDeployIdentity: async () => ({
          ok: false,
          status: 400,
          error: "denied",
          code: "aws-denied"
        })
      });
      const test = {
        ...base,
        dependencies: {
          ...base.dependencies,
          guardStopBoundary: async (
            _target: EnvironmentOperationRecord,
            boundary: string
          ) => {
            base.events.push(`stop:${boundary}`);
            return boundary !== "before-setup-failure-cleanup";
          }
        }
      };

      expect(
        await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
      ).toEqual({ shouldMonitor: false });

      expect(base.failures).toEqual([]);
      expect(base.posts).toEqual([]);
    }
  );
});

// A GitHub environment is addressed by a name the customer can delete and
// recreate. The id GitHub reports for it is the only thing that tells the one
// this workflow wrote from a replacement, and the rollback's identity gate
// refuses to delete without it — so the workflow has to put it in the ledger,
// not just the canonical name.
describe("the id a later rollback has to match", () => {
  function creates(body: Record<string, unknown>) {
    return successfulSelectedGhExecutor({
      run: async (args) => {
        // The preflight read finds nothing, so the workflow creates it.
        if (!args.includes("--method")) {
          return command({ code: 1, stderr: "HTTP 404: Not Found" });
        }
        return command({ stdout: JSON.stringify(body) });
      }
    });
  }

  it("records the id GitHub reported for the environment it created", async () => {
    const op = operation();
    const test = dependencies(op);

    expect(
      await runEnvironmentOperationWorkflow(
        op,
        creates({ id: 1234567, name: "production" }),
        test.dependencies
      )
    ).toEqual({ shouldMonitor: true });

    expect(op.setupArtifacts.githubEnvironment).toMatchObject({
      state: "created_candidate",
      repo: "octo/app",
      name: "production",
      providerId: "1234567"
    });
  });

  it("hands that id to the identity the rollback deletes on", async () => {
    const op = operation();
    const test = dependencies(op, {
      promoteCreatedGitHubEnvironment: (target, identity) =>
        promoteCreatedGitHubEnvironment(target, identity)
    });

    await runEnvironmentOperationWorkflow(
      op,
      creates({
        id: 1234567,
        node_id: "MDExOkVudmlyb25tZW50MTIzNDU2Nw==",
        name: "production",
        created_at: new Date(NOW).toISOString()
      }),
      test.dependencies
    );

    // The id leads the cleanup identity, so a rollback that later reads the
    // name back can require the same id before deleting anything.
    expect(
      provenOwnedCleanupTargets(op)
        .filter((entry) => entry.artifactType === "github_environment")
        .map((entry) => entry.identity)
    ).toEqual(["1234567|octo/app:production"]);
  });

  it("falls back to the node id when GitHub reports no numeric id", async () => {
    const op = operation();
    const test = dependencies(op);

    await runEnvironmentOperationWorkflow(
      op,
      creates({ node_id: "MDExOkVudmlyb25tZW50OTk5", name: "production" }),
      test.dependencies
    );

    expect(op.setupArtifacts.githubEnvironment.providerId).toBe(
      "MDExOkVudmlyb25tZW50OTk5"
    );
  });

  it("tells the customer when a restart cannot prove it owns the name", async () => {
    const op = operation();
    const test = dependencies(op);
    const mutation = prepareProviderMutation(op, {
      kind: "github_environment.put",
      target: "octo/app:production"
    });
    mutation.preparedAt = new Date(NOW).toISOString();
    settleProviderMutation(
      op,
      mutation.mutationId,
      "confirmed",
      null,
      "1234567"
    );

    await runEnvironmentOperationWorkflow(
      op,
      successfulSelectedGhExecutor({
        run: async () =>
          command({
            stdout: JSON.stringify({
              id: 7654321,
              name: "production",
              created_at: new Date(NOW).toISOString()
            })
          })
      }),
      test.dependencies
    );

    // Leaving it silently would hand back an environment nobody knows about.
    expect(
      test.events.filter((entry) => entry.includes("outside its cleanup scope"))
    ).toHaveLength(1);
    expect(op.setupArtifacts.githubEnvironment.state).toBe("created_candidate");
  });

  it("records no id when GitHub reports none, so the rollback refuses to guess", async () => {
    const op = operation();
    const test = dependencies(op, {
      promoteCreatedGitHubEnvironment: (target, identity) =>
        promoteCreatedGitHubEnvironment(target, identity)
    });

    await runEnvironmentOperationWorkflow(
      op,
      creates({
        name: "production",
        created_at: new Date(NOW).toISOString()
      }),
      test.dependencies
    );

    // Null, never the name standing in for an id: the cleanup gate reads this
    // as "no way to tell a replacement apart" and leaves the resource alone.
    expect(op.setupArtifacts.githubEnvironment.providerId).toBeNull();
    expect(
      provenOwnedCleanupTargets(op)
        .filter((entry) => entry.artifactType === "github_environment")
        .map((entry) => entry.identity)
    ).toEqual(["octo/app:production"]);
  });
});

// The route that finalizes a failure builds the environment reader the cleanup
// identity gate needs out of the executor it is handed. Handing it anything
// else — or nothing — reads the environment as some other account.
describe("the executor a failing workflow hands to cleanup", () => {
  it("is the same pinned executor the workflow ran its GitHub work with", async () => {
    const op = operation();
    const handed: unknown[] = [];
    const test = dependencies(op, {
      preflightRepoAdmin: async () => "You need admin on octo/app.",
      finalizeEnvironmentResolutionFailure: async (
        _target,
        _input,
        executor
      ) => {
        handed.push(executor);
      }
    });
    const executor = successfulSelectedGhExecutor();

    await runEnvironmentOperationWorkflow(op, executor, test.dependencies);

    expect(handed).toEqual([executor]);
  });

  it("is handed along after the environment exists, when there is something to clean", async () => {
    const op = operation();
    const handed: unknown[] = [];
    const test = dependencies(op, {
      preflightGhcrPackageWriteAccess: async () => ({
        ok: false,
        status: 403,
        error: "Your token cannot write packages.",
        code: "ghcr-package-write-required"
      }),
      finalizeEnvironmentResolutionFailure: async (
        _target,
        _input,
        executor
      ) => {
        handed.push(executor);
      }
    });
    const executor = successfulSelectedGhExecutor();

    await runEnvironmentOperationWorkflow(op, executor, test.dependencies);

    expect(handed).toEqual([executor]);
  });
});
