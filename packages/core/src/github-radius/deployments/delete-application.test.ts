import { describe, expect, it, vi } from "vitest";
import {
  deleteApplication,
  type DeleteApplicationPorts
} from "./delete-application.js";
import {
  activeDeploymentMutation,
  reserveDeploymentMutation,
  releaseDeploymentMutation,
  localDeploymentBlocksMutation,
  deploymentStatusBlocksMutation
} from "./mutation.js";
import type { DeploymentState } from "./types.js";

const target = {
  repo: "acme/app",
  environment: "dev",
  application: "application"
};

function fixture(overrides: Partial<DeleteApplicationPorts> = {}) {
  const state: DeploymentState = {
    deployEnvName: "dev",
    deployAppName: "application",
    deployedGraph: [{ name: "application" }]
  };
  const events: string[] = [];
  const releases: (() => void)[] = [];
  const dispatch = vi.fn<DeleteApplicationPorts["runGh"]>(async () => {
    events.push("dispatch");
    return { code: 0, stdout: "", stderr: "" };
  });
  const ports: DeleteApplicationPorts = {
    isValidRepoSlug: (value) => value === target.repo,
    activeDeploymentMutation: (record) => activeDeploymentMutation(record, 0),
    localDeploymentBlocksMutation: (record) =>
      localDeploymentBlocksMutation(record, 0),
    reserveDeploymentMutation: (record, request) => {
      events.push("reserve");
      return reserveDeploymentMutation(record, request, 0);
    },
    releaseDeploymentMutation: (record, lease) => {
      events.push("release");
      releaseDeploymentMutation(record, lease);
    },
    deploymentStatusBlocksMutation,
    resolveEnvDeployment: async () => {
      events.push("verify");
      return {
        app: "application",
        environment: "dev",
        provider: "aws",
        status: "delete-failed",
        deploymentId: "7",
        runUrl: ""
      };
    },
    probeDeleteConflict: async () => {
      events.push("prove");
      return { state: "conflict", resourceState: "Updating", forced: false };
    },
    ensureWorkflowsCurrent: async () => {
      events.push("sync");
      return { created: [], failed: [] };
    },
    runGh: dispatch,
    readProcessEnv: () => ({}),
    findWorkflowRun: async () => {
      events.push("discover");
      return "8";
    },
    sleep: async (ms) => {
      events.push("sleep:" + ms);
    },
    retainReservation: (release) => {
      releases.push(release);
      events.push("retain");
    },
    invalidateDeployListCache: () => {
      events.push("invalidate");
    },
    now: () => 100,
    workflowFiles: ["delete.yml", "delete-azure.yml"],
    workflowScopeHelp: {
      refreshCommand: "gh auth refresh -s workflow",
      installationNote: ""
    },
    ...overrides
  };
  return { state, events, releases, dispatch, ports };
}

describe("standalone application deletion", () => {
  it("returns uncertain execution evidence independently from the legacy HTTP error envelope", async () => {
    const f = fixture({
      runGh: async () => ({
        code: 1,
        stdout: "",
        stderr: "timeout",
        timedOut: true
      })
    });
    expect(
      await deleteApplication(f.state, target, false, f.ports)
    ).toMatchObject({
      status: 400,
      execution: {
        state: "uncertain",
        workflow: "delete.yml",
        dispatchedAt: 100
      }
    });
  });

  it("retains accepted execution evidence when updating local listing state fails", async () => {
    const f = fixture({
      invalidateDeployListCache: () => {
        throw new Error("state save failed");
      }
    });
    expect(
      await deleteApplication(f.state, target, false, f.ports)
    ).toMatchObject({
      status: 400,
      body: { error: "state save failed" },
      execution: {
        state: "accepted",
        workflow: "delete.yml",
        dispatchedAt: 100
      }
    });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.state.deploymentMutation).toBeDefined();
  });
  it("preserves uncertainty when the scoped-credential retry times out", async () => {
    const runGh = vi
      .fn<DeleteApplicationPorts["runGh"]>()
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "missing workflow scope"
      })
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "timeout",
        timedOut: true
      });
    const f = fixture({
      runGh,
      readProcessEnv: () => ({ GH_TOKEN: "injected-placeholder" })
    });
    expect(
      (await deleteApplication(f.state, target, false, f.ports)).status
    ).toBe(400);
    expect(runGh).toHaveBeenCalledTimes(2);
    expect(f.releases).toHaveLength(1);
    expect(f.state.deploymentMutation).toBeDefined();
  });

  it("retains admission when the mutation port throws without proving rejection", async () => {
    const f = fixture({
      runGh: async () => {
        throw new Error("connection closed");
      }
    });
    expect(
      (await deleteApplication(f.state, target, false, f.ports)).status
    ).toBe(400);
    expect(f.releases).toHaveLength(1);
    expect(f.state.deploymentMutation).toBeDefined();
  });
  it("reserves, re-verifies force evidence, publishes, dispatches, retains the lease and retires matching graph state", async () => {
    const f = fixture();
    expect(await deleteApplication(f.state, target, true, f.ports)).toEqual({
      status: 200,
      body: {
        success: true,
        forced: true,
        runUrl: "https://github.com/acme/app/actions/runs/8"
      }
    });
    expect(f.events).toEqual([
      "reserve",
      "verify",
      "prove",
      "sync",
      "dispatch",
      "retain",
      "discover",
      "invalidate"
    ]);
    expect(f.dispatch.mock.calls[0]?.[0]).toEqual([
      "workflow",
      "run",
      "delete.yml",
      "-f",
      "environment=dev",
      "-f",
      "application=application",
      "-f",
      "force=true",
      "--repo",
      "acme/app"
    ]);
    expect(f.state.deployedGraph).toBeNull();
    expect(f.state.deploymentMutation).toBeDefined();
    expect(
      (await deleteApplication(f.state, target, false, f.ports)).status
    ).toBe(409);
    f.releases[0]?.();
    expect(f.state.deploymentMutation).toBeUndefined();
  });

  it.each([
    { state: "unknown" as const, detail: "artifact missing" },
    { state: "clear" as const }
  ])("fails closed when force evidence is %j", async (proof) => {
    const f = fixture({ probeDeleteConflict: async () => proof });
    expect(
      (await deleteApplication(f.state, target, true, f.ports)).status
    ).toBe(409);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.state.deployedGraph).not.toBeNull();
    expect(f.state.deploymentMutation).toBeUndefined();
  });

  it.each(["pending", "deleting", "success"])(
    "does not force a deployment with status %s",
    async (status) => {
      const f = fixture({
        resolveEnvDeployment: async () => ({
          app: "application",
          environment: "dev",
          provider: "aws",
          status,
          deploymentId: "7",
          runUrl: ""
        })
      });
      expect(
        (await deleteApplication(f.state, target, true, f.ports)).status
      ).toBe(409);
      expect(f.dispatch).not.toHaveBeenCalled();
    }
  );

  it.each(["resolveEnvDeployment", "probeDeleteConflict"] as const)(
    "fails closed on unreadable %s and releases admission",
    async (port) => {
      const f = fixture({
        [port]: async () => {
          throw new Error("permission denied");
        }
      });
      expect(
        (await deleteApplication(f.state, target, true, f.ports)).status
      ).toBe(503);
      expect(f.state.deploymentMutation).toBeUndefined();
      expect(f.dispatch).not.toHaveBeenCalled();
    }
  );

  it("does not replay or immediately unlock a timed-out mutation", async () => {
    const runGh = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "workflow scope timeout",
      timedOut: true
    }));
    const f = fixture({
      runGh,
      readProcessEnv: () => ({ GH_TOKEN: "injected-placeholder" })
    });
    expect(
      (await deleteApplication(f.state, target, true, f.ports)).status
    ).toBe(400);
    expect(runGh).toHaveBeenCalledTimes(1);
    expect(f.releases).toHaveLength(1);
    expect(
      (await deleteApplication(f.state, target, true, f.ports)).status
    ).toBe(409);
  });

  it("never reports an accepted delete as rejected just because its run cannot yet be observed", async () => {
    const f = fixture({
      findWorkflowRun: async () => {
        throw new Error("temporarily unavailable");
      }
    });
    expect(await deleteApplication(f.state, target, false, f.ports)).toEqual({
      status: 200,
      body: { success: true, forced: false, runUrl: "" }
    });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.state.deploymentMutation).toBeDefined();
  });

  it("rejects invalid identity before reservation or external reads", async () => {
    const f = fixture();
    expect(
      (
        await deleteApplication(
          f.state,
          { ...target, repo: "../other" },
          false,
          f.ports
        )
      ).status
    ).toBe(400);
    expect(f.events).toEqual([]);
  });

  it("does not dispatch when workflow publication fails", async () => {
    const f = fixture({
      ensureWorkflowsCurrent: async () => ({
        created: [],
        failed: [{ path: ".github/workflows/delete.yml", branch: "protected" }]
      })
    });
    const result = await deleteApplication(f.state, target, false, f.ports);
    expect(result).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining("protected") }
    });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.state.deploymentMutation).toBeUndefined();
  });
});
