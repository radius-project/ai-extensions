import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProductionCanvasServerRuntime,
  setOpenSourceHandler,
  type EnvironmentDeletionCoordinatorPorts
} from "./server.js";
import {
  buildStages,
  configureOperationStore,
  createOperation,
  operations
} from "./operations.js";
import { disabledOperationStore } from "./operation-store.js";
import { createEnvironmentExecutionOwner } from "./runtime/environment-execution-owner.js";
import type { CanvasState } from "./shared.js";

const unexpectedDeletion = async (): Promise<never> => {
  throw new Error("Unexpected external deletion");
};

const deletionPorts: EnvironmentDeletionCoordinatorPorts = {
  deleteRadiusEnvironment: unexpectedDeletion,
  runAz: unexpectedDeletion,
  readAzureIdentity: unexpectedDeletion,
  deleteGitHubEnvironment: unexpectedDeletion,
  deleteStatePackage: unexpectedDeletion,
  withCredentialProvenanceLock: (work) => work(),
  readCredentialProvenance: () => {
    throw new Error("Unexpected credential provenance read");
  },
  removeCredentialProvenance: unexpectedDeletion,
  clearEnvironmentCredentialProvenance: unexpectedDeletion,
  persist: () => operations.persist(),
  errorMessage: String,
  log: () => {
    throw new Error("Unexpected deletion diagnostic");
  }
};

function runtime(
  overrides: Partial<
    NonNullable<
      Parameters<
        typeof createProductionCanvasServerRuntime
      >[0]["serverDependencies"]
    >
  > = {}
) {
  return createProductionCanvasServerRuntime({
    executionOwner: createEnvironmentExecutionOwner(),
    environmentDeletionPorts: deletionPorts,
    serverDependencies: {
      preferredPort: async () => 0,
      prepareIdentity: () => {},
      ...overrides
    }
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function mutationHeaders(
  baseUrl: string,
  nonce: unknown
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: baseUrl,
    "Sec-Fetch-Site": "same-origin",
    "X-Radius-Mutation-Nonce": String(nonce ?? "")
  };
}

beforeEach(async () => {
  await configureOperationStore(disabledOperationStore());
});

afterEach(async () => {
  operations.clear();
  await configureOperationStore(disabledOperationStore());
  setOpenSourceHandler(async () => {});
  vi.restoreAllMocks();
});

describe("production canvas server runtime", () => {
  it("reuses a loopback instance, updates its page, isolates instances, and cleans up idempotently", async () => {
    let now = 100;
    const createdStates: CanvasState[] = [];
    const server = runtime({
      now: () => ++now,
      createState: () => {
        const state = { contextRepo: `fixture/repo-${createdStates.length}` };
        createdStates.push(state);
        return state;
      }
    });

    const first = await server.getOrCreateServer("panel-a", "graph");
    const reused = await server.getOrCreateServer("panel-a", "planned");
    const second = await server.getOrCreateServer("panel-b", "environment");

    try {
      expect(new URL(first.baseUrl).hostname).toBe("127.0.0.1");
      expect(Number(new URL(first.baseUrl).port)).toBeGreaterThan(0);
      expect(reused).toBe(first);
      expect(reused.url).toBe(`${first.baseUrl}/?page=planned`);
      expect(second.baseUrl).not.toBe(first.baseUrl);
      expect(createdStates).toHaveLength(2);
      expect(server.servers.size).toBe(2);

      const ping = await fetch(`${first.baseUrl}/api/ping`);
      expect(ping.status).toBe(200);
      expect(await json(ping)).toEqual({
        ok: true,
        instanceId: "panel-a"
      });
      expect(server.getLastWebviewActivityAt()).toBe(101);
    } finally {
      await Promise.all([
        server.stopServer("panel-a", true),
        server.stopServer("panel-b", true)
      ]);
      await server.stopServer("panel-a", true);
    }

    expect(server.servers.size).toBe(0);
    await expect(fetch(first.baseUrl)).rejects.toThrow();
  });

  it("coalesces concurrent opens and permits a clean reopen after shutdown", async () => {
    const server = runtime();
    const [first, second] = await Promise.all([
      server.getOrCreateServer("single-flight", "graph"),
      server.getOrCreateServer("single-flight", "deploying")
    ]);

    expect(first).toBe(second);
    expect(first.page).toBe("deploying");
    await server.stopServer("single-flight", true);

    const reopened = await server.getOrCreateServer(
      "single-flight",
      "credentials"
    );
    try {
      expect(reopened).not.toBe(first);
      expect(reopened.page).toBe("credentials");
      expect((await fetch(reopened.baseUrl)).status).toBe(200);
    } finally {
      await server.stopServer("single-flight", true);
    }
  });

  it("fails startup dependencies closed without retaining a partial instance", async () => {
    const server = runtime({
      prepareIdentity: () => {
        throw new Error("identity preparation failed");
      }
    });

    await expect(server.getOrCreateServer("broken", "graph")).rejects.toThrow(
      "identity preparation failed"
    );
    expect(server.servers.size).toBe(0);
    await expect(server.stopServer("broken", true)).resolves.toBeUndefined();
  });

  it("falls back from a busy preferred port to an OS-assigned loopback port", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => {
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP address");
    }
    const server = runtime({ preferredPort: async () => address.port });

    try {
      const entry = await server.getOrCreateServer("fallback", "graph");
      expect(Number(new URL(entry.baseUrl).port)).not.toBe(address.port);
      expect((await fetch(`${entry.baseUrl}/api/ping`)).status).toBe(200);
      await server.stopServer("fallback", true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects malformed, unauthorized, cross-site, wrong-method, and unknown requests before side effects", async () => {
    const server = runtime();
    const entry = await server.getOrCreateServer("boundaries", "graph");
    const headers = mutationHeaders(
      entry.baseUrl,
      entry.state.browserMutationNonce
    );

    try {
      const missingNonce = await fetch(`${entry.baseUrl}/api/operations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      expect(missingNonce.status).toBe(403);
      expect(await json(missingNonce)).toMatchObject({
        code: "browser-mutation-validation-failed"
      });

      const crossSite = await fetch(`${entry.baseUrl}/api/operations`, {
        method: "POST",
        headers: {
          ...headers,
          "Sec-Fetch-Site": "cross-site"
        },
        body: "{}"
      });
      expect(crossSite.status).toBe(403);
      expect(await json(crossSite)).toEqual({
        error: "Cross-site request rejected.",
        code: "cross-site-forbidden"
      });

      const malformed = await fetch(`${entry.baseUrl}/api/operations`, {
        method: "POST",
        headers,
        body: "{"
      });
      expect(malformed.status).toBe(400);
      expect(await json(malformed)).toMatchObject({ code: "invalid-json" });

      const wrongMethod = await fetch(`${entry.baseUrl}/api/operations`, {
        method: "PUT"
      });
      const unknown = await fetch(`${entry.baseUrl}/api/not-a-route`);
      expect(wrongMethod.status).toBe(200);
      expect(wrongMethod.headers.get("content-type")).toBe(
        "text/html; charset=utf-8"
      );
      expect(unknown.status).toBe(200);
      expect(unknown.headers.get("content-type")).toBe(
        "text/html; charset=utf-8"
      );
      expect(operations.all()).toEqual([]);
    } finally {
      await server.stopServer("boundaries", true);
    }
  });

  it("exercises safe read contracts and operation lookup failures repeatedly", async () => {
    const server = runtime();
    const entry = await server.getOrCreateServer("reads", "environment");

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const latest = await fetch(`${entry.baseUrl}/api/operations`);
        expect(latest.status).toBe(200);
        expect(await json(latest)).toEqual({ operation: null });

        const byRepo = await fetch(
          `${entry.baseUrl}/api/operations?repo=fixture%2Fapp`
        );
        expect(byRepo.status).toBe(200);
        expect(await json(byRepo)).toEqual({ operation: null });

        const missing = await fetch(
          `${entry.baseUrl}/api/operations/missing-operation`
        );
        expect(missing.status).toBe(404);
        expect(await json(missing)).toEqual({ error: "Unknown operation." });

        const diagnostics = await fetch(
          `${entry.baseUrl}/api/operations/missing-operation/diagnostics`
        );
        expect(diagnostics.status).toBe(404);
        expect(await json(diagnostics)).toMatchObject({
          code: "unknown-operation"
        });

        const progress = await fetch(`${entry.baseUrl}/api/progress`);
        expect(progress.status).toBe(200);
        expect(await json(progress)).toEqual({ messages: [] });

        const notification = await fetch(
          `${entry.baseUrl}/api/deploy-notification`
        );
        expect(notification.status).toBe(200);
        expect(await json(notification)).toMatchObject({
          status: "pending",
          attemptId: "",
          repairing: false
        });
      }
    } finally {
      await server.stopServer("reads", true);
    }
  });

  it("serves explicit pages, redirects an implicit active deployment, and falls back safely", async () => {
    const server = runtime();
    const entry = await server.getOrCreateServer("pages", "environment");

    try {
      entry.state.deployStatus = "in_progress";
      const implicit = await fetch(entry.baseUrl);
      expect(implicit.status).toBe(200);
      expect(await implicit.text()).toContain(
        "<title>Deployments — Radius</title>"
      );

      const explicit = await fetch(`${entry.baseUrl}/?page=credentials`);
      expect(explicit.status).toBe(200);
      expect(await explicit.text()).toContain('id="pane-credentials"');
      expect(entry.state.activeSubtab).toBe("credentials");

      const environment = await fetch(`${entry.baseUrl}/?page=environment`);
      expect(environment.status).toBe(200);
      expect(await environment.text()).toContain('id="pane-environments"');
      expect(entry.state.activeSubtab).toBe("environments");

      const unknown = await fetch(`${entry.baseUrl}/?page=unknown`);
      expect(unknown.status).toBe(200);
      expect(await unknown.text()).toContain('id="pane-environments"');
    } finally {
      await server.stopServer("pages", true);
    }
  });

  it("delegates valid source opens and turns handler failures into explicit HTTP failures", async () => {
    const opened = vi.fn();
    setOpenSourceHandler(opened);
    const server = runtime({
      createState: () => ({ contextRepo: "fixture/app" })
    });
    const entry = await server.getOrCreateServer("source", "graph");
    const headers = mutationHeaders(
      entry.baseUrl,
      entry.state.browserMutationNonce
    );

    try {
      const success = await fetch(`${entry.baseUrl}/api/open-source`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "infra/main.bicep", line: "12" })
      });
      expect(success.status).toBe(200);
      expect(await json(success)).toEqual({ ok: true });
      expect(opened).toHaveBeenCalledExactlyOnceWith({
        path: "infra/main.bicep",
        line: 12,
        instanceId: "source",
        state: entry.state
      });

      setOpenSourceHandler(() => {
        throw new Error("editor unavailable");
      });
      const failed = await fetch(`${entry.baseUrl}/api/open-source`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "infra/main.bicep", line: 0 })
      });
      expect(failed.status).toBe(500);
      expect(await json(failed)).toEqual({
        ok: false,
        error: "editor unavailable"
      });

      const traversal = await fetch(`${entry.baseUrl}/api/open-source`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "../outside.bicep", line: 1 })
      });
      expect(traversal.status).toBe(400);
      expect(await json(traversal)).toEqual({
        ok: false,
        error: "invalid path"
      });
    } finally {
      await server.stopServer("source", true);
    }
  });

  it("fails safe read routes before reaching unavailable external dependencies", async () => {
    const server = runtime();
    const entry = await server.getOrCreateServer("safe-reads", "environment");

    try {
      const paths = [
        "/api/deployed-graph",
        "/api/deploy-status",
        "/api/list-environments",
        "/api/list-applications",
        "/api/list-deployments",
        "/api/delete-conflict",
        "/api/verify-status"
      ];
      for (const path of paths) {
        const response = await fetch(entry.baseUrl + path);
        expect([200, 400, 404], path).toContain(response.status);
        expect(response.headers.get("content-type"), path).toContain(
          "application/json"
        );
        await response.text();
      }
    } finally {
      await server.stopServer("safe-reads", true);
    }
  });

  it("returns validation failures for safe empty requests across route families without invoking external systems", async () => {
    setOpenSourceHandler(() => {
      throw new Error("Open source must not run for invalid input");
    });
    const runner = vi.fn(async () => {
      throw new Error("Environment runner must not start for invalid input");
    });
    const server = createProductionCanvasServerRuntime({
      executionOwner: createEnvironmentExecutionOwner(),
      environmentOperationRunner: runner,
      environmentDeletionPorts: deletionPorts,
      serverDependencies: {
        preferredPort: async () => 0,
        prepareIdentity: () => {}
      }
    });
    const entry = await server.getOrCreateServer("validation", "environment");
    const headers = mutationHeaders(
      entry.baseUrl,
      entry.state.browserMutationNonce
    );
    const post = (path: string, body = "{}") =>
      fetch(entry.baseUrl + path, {
        method: "POST",
        headers,
        body
      });

    try {
      const cases: Array<[string, number[]]> = [
        ["/api/open-source", [400]],
        ["/api/run-remediation", [400]],
        ["/api/github-account", [400]],
        ["/api/delete-environment", [400]],
        ["/api/bypass-verification", [400, 404, 409]],
        ["/api/operations", [400]],
        ["/api/azure-auto-setup", [403]],
        ["/api/app-params", [400]],
        ["/api/create-environment", [403]],
        ["/api/load-graph", [200, 400]],
        ["/api/delete-deployment", [400]],
        ["/api/abandon-deployment", [400]],
        ["/api/repo-branches", [200, 400]],
        ["/api/plan-graph", [200, 400]],
        ["/api/discover-branches", [200, 400]],
        ["/api/diff-branches", [200, 400]],
        ["/api/deploy", [400]],
        ["/api/discover", [200, 400]]
      ];
      for (const [path, statuses] of cases) {
        const response = await post(path);
        expect(statuses, path).toContain(response.status);
        await response.text();
      }

      const reset = await fetch(`${entry.baseUrl}/api/deploy-reset`, {
        method: "POST",
        headers
      });
      expect(reset.status).toBe(200);
      expect(await json(reset)).toEqual({ ok: true });
      expect(runner).not.toHaveBeenCalled();
      expect(operations.all()).toEqual([]);
    } finally {
      await server.stopServer("validation", true);
    }
  });

  it("fails closed for missing operation actions without scheduling or mutation", async () => {
    const runner = vi.fn(async () => {
      throw new Error("Unexpected operation scheduling");
    });
    const server = createProductionCanvasServerRuntime({
      executionOwner: createEnvironmentExecutionOwner(),
      environmentOperationRunner: runner,
      environmentDeletionPorts: deletionPorts,
      serverDependencies: {
        preferredPort: async () => 0,
        prepareIdentity: () => {}
      }
    });
    const entry = await server.getOrCreateServer("actions", "environment");
    const headers = mutationHeaders(
      entry.baseUrl,
      entry.state.browserMutationNonce
    );

    try {
      const paths = [
        "/api/operations/missing/resume/input-required",
        "/api/operations/missing/abandon",
        "/api/operations/missing/dismiss",
        "/api/operations/missing/stop",
        "/api/operations/missing/continue",
        "/api/operations/missing/cancel-workflow",
        "/api/operations/missing/rollback",
        "/api/operations/missing/exit",
        "/api/operations/missing/retry/cleanup"
      ];
      for (const path of paths) {
        const response = await fetch(entry.baseUrl + path, {
          method: "POST",
          headers,
          body:
            path.endsWith("/abandon") || path.endsWith("/dismiss") ? null : "{}"
        });
        expect(response.status, path).toBe(404);
        expect(await json(response), path).toMatchObject({
          error: "Unknown operation."
        });
      }
      expect(runner).not.toHaveBeenCalled();
      expect(operations.all()).toEqual([]);
    } finally {
      await server.stopServer("actions", true);
    }
  });

  it("previews bounded terminal operation diagnostic identifiers", async () => {
    const operation = {
      operationId: "op_diagnostics",
      schemaVersion: 6,
      repo: "fixture/app",
      environment: "dev",
      provider: "azure",
      state: "failed",
      currentStage: "verify",
      startedAt: "2026-10-15T18:00:00.000Z",
      lastActivityAt: "2026-10-15T18:01:00.000Z",
      endedAt: "2026-10-15T18:01:00.000Z",
      stages: [],
      control: {
        attempts: { setup: 1, verification: 0 },
        stop: { requestedAt: null, acknowledgedAt: null },
        commands: []
      },
      failure: null,
      setupArtifacts: {
        cleanup: { state: "not_needed", attempts: 0, results: [] }
      },
      providerRecovery: { state: "complete", mutations: [] },
      context: { githubLogin: "fixture-user" },
      journey: { resumeBranch: "feature/runtime-coverage" },
      dismissedAt: null
    };
    operations.put(operation);
    const server = runtime();
    const entry = await server.getOrCreateServer("diagnostics", "environment");

    try {
      const preview = await fetch(
        `${entry.baseUrl}/api/operations/${operation.operationId}/diagnostics?identifiers=preview`
      );
      expect(preview.status).toBe(200);
      const previewBody = await json(preview);
      expect(previewBody).toMatchObject({
        contextualIdentifiers: {
          repository: "fixture/app",
          environment: "dev"
        },
        contextFingerprint: expect.any(String)
      });
    } finally {
      await server.stopServer("diagnostics", true);
    }
  });

  it("accepts a cooperative stop and keeps the operation pollable without starting external work", async () => {
    const operation = createOperation({
      operationId: "op_stop",
      repo: "fixture/app",
      environment: "dev",
      provider: "azure",
      stages: buildStages()
    });
    operations.put(operation);
    const runner = vi.fn(async () => {
      throw new Error("Stop must not start environment work");
    });
    const server = createProductionCanvasServerRuntime({
      executionOwner: createEnvironmentExecutionOwner(),
      environmentOperationRunner: runner,
      environmentDeletionPorts: deletionPorts,
      serverDependencies: {
        preferredPort: async () => 0,
        prepareIdentity: () => {}
      }
    });
    const entry = await server.getOrCreateServer("stop", "environment");
    const headers = mutationHeaders(
      entry.baseUrl,
      entry.state.browserMutationNonce
    );

    try {
      const stopped = await fetch(
        `${entry.baseUrl}/api/operations/${operation.operationId}/stop`,
        {
          method: "POST",
          headers,
          body: "{}"
        }
      );
      const stoppedBody = await json(stopped);
      expect({ status: stopped.status, body: stoppedBody }).toMatchObject({
        status: 202
      });
      expect(stoppedBody).toMatchObject({
        code: "operation-stop-pending",
        operation: {
          operationId: operation.operationId,
          stop: { requested: true }
        }
      });

      const poll = await fetch(
        `${entry.baseUrl}/api/operations/${operation.operationId}`
      );
      expect(poll.status).toBe(200);
      expect(await json(poll)).toMatchObject({
        operation: {
          operationId: operation.operationId,
          stop: { requested: true }
        }
      });
      expect(runner).not.toHaveBeenCalled();
    } finally {
      await server.stopServer("stop", true);
    }
  });

  it("exercises state-only deployment callbacks while refusing overlapping destructive requests", async () => {
    const server = runtime();
    const entry = await server.getOrCreateServer(
      "deploy-conflict",
      "deploying"
    );
    Object.assign(entry.state, {
      deployStatus: "in_progress",
      deployingRepo: "fixture/app",
      envName: "dev",
      deployAppName: "app",
      deployStartedAt: Date.now(),
      deployLogs: ["starting", "still running"],
      deployLogBase: 4,
      deployAttempt: {
        id: "attempt-1",
        targetRepo: "fixture/app",
        environment: "dev"
      },
      deploymentMutation: {
        repo: "fixture/app",
        environment: "dev",
        kind: "deploy",
        expiresAt: Date.now() + 60_000
      },
      deployingResources: [
        {
          id: "resource-1",
          name: "resource",
          type: "Applications.Core/containers",
          provider: "azure"
        }
      ]
    });
    const headers = mutationHeaders(
      entry.baseUrl,
      entry.state.browserMutationNonce
    );
    const validBody = JSON.stringify({
      targetRepo: "fixture/app",
      repo: "fixture/app",
      environment: "dev",
      application: "app",
      branch: "feature/runtime-coverage",
      provider: "azure"
    });

    try {
      const status = await fetch(`${entry.baseUrl}/api/deploy-status?since=5`);
      expect(status.status).toBe(200);
      expect(await json(status)).toMatchObject({
        status: "in_progress",
        active: true,
        logBase: 4,
        logTotal: 6,
        logsNew: ["still running"],
        repairing: false
      });

      const deploy = await fetch(`${entry.baseUrl}/api/deploy`, {
        method: "POST",
        headers,
        body: validBody
      });
      expect(deploy.status).toBe(409);
      expect(await json(deploy)).toMatchObject({
        error: expect.stringContaining("already in progress")
      });

      const deleteDeployment = await fetch(
        `${entry.baseUrl}/api/delete-deployment`,
        {
          method: "POST",
          headers,
          body: validBody
        }
      );
      expect(deleteDeployment.status).toBe(409);
      expect(await json(deleteDeployment)).toMatchObject({
        error: expect.stringContaining("already in progress")
      });

      const abandon = await fetch(`${entry.baseUrl}/api/abandon-deployment`, {
        method: "POST",
        headers,
        body: validBody
      });
      expect(abandon.status).toBe(409);
      expect(await json(abandon)).toMatchObject({
        error: expect.stringContaining("already in progress")
      });
    } finally {
      await server.stopServer("deploy-conflict", true);
    }
  });
});
