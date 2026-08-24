import { describe, expect, it } from "vitest";
import {
  createOperation,
  prepareProviderMutation,
  promoteCreatedGitHubEnvironment,
  settleProviderMutation,
  provenOwnedCleanupTargets,
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

function dependencies(
  op: EnvironmentOperationRecord,
  overrides: Partial<EnvironmentOperationWorkflowDependencies> = {}
): {
  dependencies: EnvironmentOperationWorkflowDependencies;
  events: string[];
  failures: Array<{ status: number; error: string; code: string }>;
  posts: Array<{ pathname: string; data: Record<string, unknown> }>;
} {
  const events: string[] = [];
  const failures: Array<{ status: number; error: string; code: string }> = [];
  const posts: Array<{ pathname: string; data: Record<string, unknown> }> = [];
  return {
    events,
    failures,
    posts,
    dependencies: {
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
      promoteCreatedGitHubEnvironment: () => false,
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
      postInternal: async (pathname, data) => {
        events.push(`post:${pathname}`);
        posts.push({ pathname, data: data as Record<string, unknown> });
        return pathname === "/api/azure-auto-setup" ?
            { clientId: "client-1" }
          : { success: true };
      },
      now: () => Date.parse("2026-08-22T00:00:00.000Z"),
      ...overrides
    }
  };
}

describe("runEnvironmentOperationWorkflow", () => {
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
              created_at: "2026-08-22T00:00:00.000Z"
            })
          });
        }
        return canonicalName ?
            command({ stdout: JSON.stringify({ name: canonicalName }) })
          : command({ code: 1, stderr: "HTTP 404" });
      }
    });
    const test = dependencies(op, {
      promoteCreatedGitHubEnvironment: (target, identity) =>
        promoteCreatedGitHubEnvironment(target, identity)
    });

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
        code: "github-environment-lookup-failed"
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
        code: "repo-admin-required"
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
        code: "ghcr-package-write-required"
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
        created_at: "2026-08-22T00:00:00.000Z"
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
    mutation.preparedAt = "2026-08-22T00:00:00.000Z";
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
              created_at: "2026-08-22T00:00:00.000Z"
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
        created_at: "2026-08-22T00:00:00.000Z"
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
