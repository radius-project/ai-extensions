import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowObservationScope,
  type DeploymentRuntime
} from "@radius-project/adapter-shared";
import { createTestDeploymentRuntime } from "../../../test/support/server/deployment-runtime.js";
import { createDeferred } from "../../../test/support/browser/fakes.js";
import { createDeployRequestService } from "./deploy-request.js";
import { createDeploymentViews } from "./deployment-views.js";
import type { CanvasState } from "../../shared.js";

const runtimes: DeploymentRuntime[] = [];
afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map((runtime) => runtime.owner.shutdown(1000))
  );
});

function harness(state: CanvasState = {}) {
  const finished = createDeferred<void>();
  const checked = vi.fn(async () => null);
  const runtime = createTestDeploymentRuntime({
    resolveDeployment: checked,
    resolveDefaultBranch: async () => "default-feature",
    createExecution: () => ({
      observation: createWorkflowObservationScope(() => {
        throw new Error("Unexpected artifact read");
      }),
      monitor: {
        async run({ entry }) {
          await finished.promise;
          entry.state.deployStatus = "success";
        }
      }
    })
  });
  runtimes.push(runtime);
  const start = vi.fn(runtime.start);
  const views = createDeploymentViews(runtime);
  let entry: { state: CanvasState } | undefined = { state };
  const attach = vi.fn(views.attach);
  const dependencies = {
    resolveAppFile: vi.fn(async () => ".radius/app.bicep"),
    runtime: { ...runtime, start },
    readInstanceEntry: () => entry,
    attach,
    reportError: vi.fn(),
    errorMessage: (error: unknown) =>
      error instanceof Error ? error.message : String(error)
  };
  return {
    runtime,
    views,
    state,
    finished,
    checked,
    start,
    attach,
    dependencies,
    close() {
      entry = undefined;
    },
    service: createDeployRequestService(dependencies)
  };
}

function body(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    targetRepo: "acme/widgets",
    environment: "production",
    branch: "feature",
    ...extra
  });
}

describe("deployment HTTP request adapter", () => {
  it.each([
    "readInstanceEntry",
    "attach",
    "errorMessage",
    "reportError",
    "resolveAppFile"
  ] as const)("requires the %s binding", (key) => {
    const h = harness();
    Object.defineProperty(h.dependencies, key, { value: undefined });
    expect(() => createDeployRequestService(h.dependencies)).toThrow(key);
  });

  it("requires a runtime", () => {
    const h = harness();
    Object.defineProperty(h.dependencies, "runtime", { value: undefined });
    expect(() => createDeployRequestService(h.dependencies)).toThrow("runtime");
  });

  it.each(["{", "null", "[]", "42", '"text"'])(
    "rejects malformed/objectless input %s",
    async (body) => {
      const h = harness();
      expect(
        await h.service.deploy({ instanceId: "panel", body })
      ).toMatchObject({ status: 400 });
      expect(h.start).not.toHaveBeenCalled();
    }
  );

  it.each([
    "targetRepo",
    "environment",
    "branch",
    "provider",
    "appFile",
    "attemptId"
  ])(
    "rejects a non-string %s rather than falling back to a different target",
    async (key) => {
      const h = harness();
      expect(
        await h.service.deploy({
          instanceId: "panel",
          body: body({ [key]: 7 })
        })
      ).toEqual({ status: 400, body: { error: `${key} must be a string.` } });
      expect(h.start).not.toHaveBeenCalled();
    }
  );

  it("fails before admission when the panel no longer exists", async () => {
    const h = harness();
    h.close();
    expect(
      await h.service.deploy({ instanceId: "panel", body: body() })
    ).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining("unavailable") }
    });
    expect(h.start).not.toHaveBeenCalled();
  });

  it("returns acceptance before completion and projects rather than owns state", async () => {
    const h = harness({ plannedResources: [{ name: "web" }] });
    expect(
      await h.service.deploy({ instanceId: "panel", body: body() })
    ).toEqual({ status: 200, body: { ok: true } });
    const current = h.runtime.owner.lookup();
    expect(current.kind).toBe("found");
    if (current.kind !== "found") throw new Error("Missing deployment");
    expect(current.invocation.state).not.toBe(h.state);
    expect(h.state.deployingResources).toEqual([
      { name: "web", deployStatus: "pending" }
    ]);
    expect(h.state.deployingResources).not.toBe(
      current.invocation.state.deployingResources
    );
    h.state.deployStatus = "failed";
    expect(current.invocation.state.deployStatus).toBe("in_progress");
    h.finished.resolve();
    await vi.waitFor(() => expect(h.state.deployStatus).toBe("success"));
  });

  it("uses trusted workspace context but ignores workspace fields supplied in JSON", async () => {
    const h = harness({
      workspaceRepo: "acme/widgets",
      workspaceBranch: "worktree",
      workspacePath: "workspace",
      contextRepo: "acme/widgets",
      envName: "test",
      deployProvider: "azure",
      appFile: ".radius/custom.bicep"
    });
    await h.service.deploy({
      instanceId: "panel",
      body: JSON.stringify({
        workspacePath: "untrusted",
        workspaceBranch: "wrong"
      })
    });
    expect(h.start).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "acme/widgets",
        environment: "test",
        appFile: undefined
      }),
      expect.objectContaining({
        workspace: {
          repo: "acme/widgets",
          branch: "worktree",
          workspacePath: "workspace"
        }
      })
    );
    expect(h.state.deployingBranch).toBe("worktree");
    expect(h.state.appFile).toBe(".radius/app.bicep");
    h.finished.resolve();
  });

  it("does not fall back to Canvas target fields for explicit repair identity", async () => {
    const h = harness({
      contextRepo: "other/repo",
      envName: "other",
      deployProvider: "aws",
      appFile: "other.bicep"
    });
    const result = await h.service.deploy({
      instanceId: "panel",
      body: JSON.stringify({ attemptId: "attempt:missing" })
    });
    expect(result.status).toBe(409);
    expect(h.start).toHaveBeenCalledWith(
      {
        attemptId: "attempt:missing",
        repo: undefined,
        environment: undefined,
        branch: undefined,
        provider: undefined,
        appFile: undefined
      },
      expect.any(Object)
    );
  });

  it("serializes the repair budget returned by the owner without creating a new loop", async () => {
    const h = harness();
    const target = {
      repo: "acme/widgets",
      environment: "production",
      branch: "feature",
      provider: "azure",
      appFile: ".radius/app.bicep"
    };
    const reservation = h.runtime.owner.reserve(target, "deploy");
    if (!reservation) throw new Error("Target is busy");
    const previous = h.runtime.owner.begin(
      target,
      {
        deployStatus: "failed",
        deployRepairAttempts: 1
      },
      reservation
    );
    previous.state.deployAttempt = { id: previous.attemptId };
    h.runtime.owner.release(reservation);
    const response = await h.service.deploy({
      instanceId: "panel",
      body: JSON.stringify({ attemptId: previous.attemptId })
    });
    expect(response).toEqual({
      status: 200,
      body: { ok: true, repairAttempt: 2, repairAttemptCap: 5 }
    });
    expect(h.state.deployAttempt?.id).toBe(previous.attemptId);
    expect(h.state.deployGeneration).toBe(2);
    h.finished.resolve();
  });

  it("prefers the planned repository over ambient context", async () => {
    const h = harness({
      plannedRepo: "acme/widgets",
      contextRepo: "other/repo",
      envName: "test"
    });
    await h.service.deploy({ instanceId: "panel", body: "{}" });
    expect(h.state.deployingRepo).toBe("acme/widgets");
    h.finished.resolve();
  });

  it("keeps admitted work when the view closes during an external target check", async () => {
    const h = harness();
    const check = createDeferred<null>();
    h.checked.mockImplementation(() => check.promise);
    const result = h.service.deploy({
      instanceId: "panel",
      body: body({ appFile: ".radius/app.bicep" })
    });
    h.close();
    check.resolve(null);
    expect(await result).toEqual({ status: 200, body: { ok: true } });
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.runtime.owner.hasActiveWork()).toBe(true);
    h.finished.resolve();
  });

  it("uses the resolved root model instead of a previous deployment's file", async () => {
    const h = harness({ appFile: "old.bicep" });
    h.dependencies.resolveAppFile.mockResolvedValue("app.bicep");
    expect(
      await h.service.deploy({ instanceId: "panel", body: body() })
    ).toMatchObject({ status: 200 });
    expect(h.dependencies.resolveAppFile).toHaveBeenCalledWith(
      expect.objectContaining({ appFile: "old.bicep" }),
      "acme/widgets",
      "feature"
    );
    expect(h.state.appFile).toBe("app.bicep");
    h.finished.resolve();
  });

  it("refuses changed Canvas context while resolving the model", async () => {
    const h = harness({ contextBranch: "feature" });
    const selection = createDeferred<string>();
    h.dependencies.resolveAppFile.mockImplementation(() => selection.promise);
    const result = h.service.deploy({ instanceId: "panel", body: body() });
    await vi.waitFor(() =>
      expect(h.dependencies.resolveAppFile).toHaveBeenCalled()
    );
    h.state.contextBranch = "other";
    selection.resolve("app.bicep");
    expect(await result).toMatchObject({ status: 409 });
    expect(h.runtime.owner.hasActiveWork()).toBe(false);
    expect(h.attach).not.toHaveBeenCalled();
  });

  it("preserves fail-closed service errors and rejection status", async () => {
    const h = harness();
    h.checked.mockRejectedValue(new Error("GitHub unavailable"));
    const result = await h.service.deploy({
      instanceId: "panel",
      body: body()
    });
    expect(result).toMatchObject({
      status: 503,
      body: { error: expect.stringContaining("GitHub unavailable") }
    });
    expect(h.attach).not.toHaveBeenCalled();
  });

  it("serializes unexpected failures without accepting work", async () => {
    const h = harness();
    h.start.mockRejectedValue(new Error("invalid model path"));
    expect(
      await h.service.deploy({ instanceId: "panel", body: body() })
    ).toEqual({ status: 400, body: { error: "invalid model path" } });
  });

  it("preserves accepted work when attaching its optional view fails", async () => {
    const h = harness();
    const failure = new Error("View detached");
    h.attach.mockImplementation(() => {
      throw failure;
    });
    expect(
      await h.service.deploy({ instanceId: "panel", body: body() })
    ).toEqual({ status: 200, body: { ok: true } });
    expect(h.dependencies.reportError).toHaveBeenCalledWith(failure);
    expect(h.runtime.owner.hasActiveWork()).toBe(true);
    h.finished.resolve();
  });
});
