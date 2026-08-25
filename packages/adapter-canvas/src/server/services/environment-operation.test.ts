import { describe, expect, it } from "vitest";
import {
  createOperation,
  promoteCreatedGitHubEnvironment,
  recordGitHubEnvironment,
  setCanonicalEnvironment
} from "../../operations.js";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import {
  runEnvironmentOperationWorkflow,
  type EnvironmentOperationRecord,
  type EnvironmentOperationWorkflowDependencies
} from "./environment-operation.js";
import type { GitHubEnvironmentCommandResult } from "./github-environment.js";

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
      finalizeEnvironmentResolutionFailure: async (_target, input) => {
        failures.push(input);
      },
      getOperation: () => op,
      postInternal: async (pathname, data) => {
        events.push(`post:${pathname}`);
        posts.push({ pathname, data: data as Record<string, unknown> });
        return pathname === "/api/azure-auto-setup" ?
            { clientId: "client-1" }
          : { success: true };
      },
      now: () => NOW,
      ...overrides
    }
  };
}

describe("runEnvironmentOperationWorkflow", () => {
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
      environment: { environment: "production" }
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
    const test = dependencies(op);

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
      environment: { environment: "production" }
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
    const test = dependencies(op);

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

  it("stops after persisting an input-required Azure response", async () => {
    const op = operation();
    const test = dependencies(op, {
      postInternal: async (pathname) => {
        test.events.push(`post:${pathname}`);
        return { inputRequired: true };
      }
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
      postInternal: async (pathname, data) => {
        test.events.push(`post:${pathname}`);
        test.posts.push({
          pathname,
          data: data as Record<string, unknown>
        });
        return pathname === "/api/azure-auto-setup" ? null : { success: true };
      }
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
      postInternal: async () => {
        op.endedAt = "now";
        return { clientId: "client-1" };
      }
    });
    const executor = successfulSelectedGhExecutor({
      run: async () =>
        command({ stdout: JSON.stringify({ name: "Production" }) })
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: false });
  });

  it("treats a malformed persisted request as empty instead of forwarding it", async () => {
    const op = operation();
    op.provider = "aws";
    op.request = null;
    op.resumeRequest = null;
    const test = dependencies(op);
    const executor = successfulSelectedGhExecutor({
      run: async () =>
        command({ stdout: JSON.stringify({ name: "Production" }) })
    });

    expect(
      await runEnvironmentOperationWorkflow(op, executor, test.dependencies)
    ).toEqual({ shouldMonitor: true });
    expect(test.posts).toEqual([
      {
        pathname: "/api/create-environment",
        data: {
          repo: "octo/app",
          environment: "Production",
          operationEnvironment: "production",
          provider: "aws",
          operationId: op.operationId,
          clientId: ""
        }
      }
    ]);
  });
});
