import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeploymentRuntime,
  type DeploymentRuntime,
  type DeploymentRuntimePorts
} from "./runtime-deployment.js";
import { createWorkflowObservationScope } from "./workflow-observation-scope.js";
import type { DeployMonitorRequest } from "./deployment-monitor.js";
import { createDeploymentDeferred } from "../test/support/deployment.js";

const target = {
  repo: "fixture/app",
  branch: "topic",
  environment: "dev",
  provider: "azure",
  appFile: ".radius/app.bicep"
};
const runtimes: DeploymentRuntime[] = [];
const releaseHeld: (() => void)[] = [];

function held() {
  const deferred = createDeploymentDeferred<void>();
  releaseHeld.push(() => deferred.resolve());
  return deferred;
}

function fixture(
  overrides: Partial<DeploymentRuntimePorts> = {},
  monitor?: (request: DeployMonitorRequest) => Promise<void>
) {
  let id = 0;
  const run = vi.fn(
    monitor ??
      (async (request: DeployMonitorRequest) => {
        request.entry.state.deployStatus = "complete";
      })
  );
  const resolveDeployment = vi.fn(async () => null);
  const sendRepair = vi.fn(async () => {});
  const sendNotice = vi.fn(async () => {});
  const reportError = vi.fn();
  const createExecution = vi.fn(() => ({
    monitor: { run },
    observation: createWorkflowObservationScope(() => {
      throw new Error("No artifact reads expected");
    })
  }));
  const runtime = createDeploymentRuntime({
    now: () => 0,
    id: () => String(++id),
    reportError,
    awsEnabled: false,
    resolveDefaultBranch: async () => "release",
    normalizeAppFile: (path) => path,
    resolveDeployment,
    statusBlocksMutation: (status) => status === "deploying",
    createExecution,
    delivery: {
      sendRepair,
      sendNotice,
      redactDiagnostic: (value) => value,
      reportDiagnostic: vi.fn()
    },
    ...overrides
  });
  runtimes.push(runtime);
  return {
    runtime,
    run,
    resolveDeployment,
    sendRepair,
    sendNotice,
    reportError,
    createExecution
  };
}

afterEach(async () => {
  for (const release of releaseHeld.splice(0)) release();
  vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) await runtime.owner.shutdown(100);
});

describe("panel-independent deployment runtime", () => {
  it.each([undefined, "models/custom.bicep"])(
    "keeps repeat intent separate from pinned repair identity (%s)",
    async (appFile) => {
      const h = fixture({}, async ({ entry }) => {
        entry.state.deployStatus = "failed";
        entry.state.deployError = "Model failed";
      });
      const resolve = vi.fn(async () => "app.bicep");
      const context = {
        modelSelection: { resolve, isCurrent: () => true }
      };
      const first = await h.runtime.start({ ...target, appFile }, context);
      if (!first.ok) throw new Error(first.error);
      await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
      const selected = appFile || "app.bicep";
      expect(first.invocation.state.deployAttempt?.appFile).toBe(selected);
      expect(first.invocation.state.deployParams?.appFile).toBe(appFile);
      const repair = await h.runtime.start(
        { attemptId: first.invocation.attemptId },
        context
      );
      if (!repair.ok) throw new Error(repair.error);
      expect(repair.invocation.target.appFile).toBe(selected);
      expect(repair.invocation.state.deployAttempt?.appFile).toBe(selected);
      expect(repair.invocation.state.deployParams?.appFile).toBe(appFile);
      expect(repair.invocation.attemptId).toBe(first.invocation.attemptId);
      expect(resolve).toHaveBeenCalledTimes(appFile ? 0 : 1);
    }
  );

  it("reselects an omitted model on repeat instead of pinning the first selection", async () => {
    const h = fixture();
    const resolve = vi
      .fn(async () => "app.bicep")
      .mockResolvedValueOnce("app.bicep")
      .mockResolvedValueOnce(".radius/app.bicep");
    const context = { modelSelection: { resolve, isCurrent: () => true } };
    const first = await h.runtime.start(
      { ...target, appFile: undefined },
      context
    );
    if (!first.ok) throw new Error(first.error);
    await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
    const repeated = await h.runtime.start(
      { ...target, ...first.invocation.state.deployParams, appFile: undefined },
      context
    );
    if (!repeated.ok) throw new Error(repeated.error);
    expect(repeated.invocation.target.appFile).toBe(".radius/app.bicep");
    expect(repeated.invocation.state.deployParams).not.toHaveProperty(
      "appFile"
    );
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it.each([new Error("invalid path"), "invalid path"])(
    "translates explicit model normalization refusal into admission failure: %s",
    async (error) => {
      const h = fixture({
        normalizeAppFile: () => {
          throw error;
        }
      });
      expect(await h.runtime.start(target)).toMatchObject({
        ok: false,
        status: 400,
        error: expect.stringContaining("invalid path")
      });
      expect(h.resolveDeployment).not.toHaveBeenCalled();
      expect(h.createExecution).not.toHaveBeenCalled();
    }
  );

  it("resolves a host-selected model after the final branch and pins it to execution", async () => {
    const h = fixture();
    const resolve = vi.fn(async () => "app.bicep");
    const result = await h.runtime.start(
      { ...target, branch: "", appFile: undefined },
      { modelSelection: { resolve, isCurrent: () => true } }
    );
    if (!result.ok) throw new Error(result.error);
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ repo: target.repo, branch: "release" })
    );
    expect(result.invocation.target.appFile).toBe("app.bicep");
    await expect.poll(() => h.run.mock.calls.length).toBe(1);
    expect(h.run.mock.calls[0][0].appFile).toBe("app.bicep");
  });

  it.each([
    "missing",
    "unreadable",
    "invalid",
    "stale-before",
    "stale-after",
    "shutdown"
  ] as const)(
    "refuses %s host model selection and releases unadmitted ownership",
    async (failure) => {
      const h = fixture({
        normalizeAppFile: (value) => {
          if (value === "invalid") throw new Error("invalid model path");
          return value;
        }
      });
      let current = failure !== "stale-before";
      const resolve = vi.fn(async () => {
        if (failure === "unreadable") throw new Error("unavailable source");
        if (failure === "stale-after") current = false;
        if (failure === "shutdown") void h.runtime.owner.shutdown(0);
        return (
          failure === "missing" ? null
          : failure === "invalid" ? "invalid"
          : "app.bicep"
        );
      });
      const result = await h.runtime.start(
        { ...target, appFile: undefined },
        { modelSelection: { resolve, isCurrent: () => current } }
      );
      expect(result).toMatchObject({
        ok: false,
        status:
          failure === "unreadable" ? 503
          : failure === "missing" || failure === "invalid" ? 400
          : 409
      });
      expect(h.createExecution).not.toHaveBeenCalled();
      expect(h.runtime.owner.hasActiveWork()).toBe(false);
    }
  );

  it("never replaces an explicit file using host model selection", async () => {
    const h = fixture();
    const resolve = vi.fn(async () => "other.bicep");
    const result = await h.runtime.start(target, {
      modelSelection: { resolve, isCurrent: () => false }
    });
    expect(result.ok).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["retained", "retired"] as const)(
    "resolves a new selection without reusing a %s prior model",
    async (state) => {
      const h = fixture();
      const first = await h.runtime.start(
        { ...target, appFile: undefined },
        {
          modelSelection: {
            isCurrent: () => true,
            resolve: async () => "models/auto.bicep"
          }
        }
      );
      if (!first.ok) throw new Error(first.error);
      await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
      const second = await h.runtime.start(
        { ...target, appFile: undefined },
        {
          modelSelection: {
            isCurrent: () => true,
            resolve: async () => {
              if (state === "retired") h.runtime.owner.retire(first.invocation);
              return "app.bicep";
            }
          }
        }
      );
      if (!second.ok) throw new Error(second.error);
      expect(second.invocation.target.appFile).toBe("app.bicep");
      expect(second.invocation.state.deployParams?.appFile).toBeUndefined();
      expect(second.invocation.state.deployAttempt?.appFile).toBe("app.bicep");
    }
  );

  it.each(["read", "normalization"] as const)(
    "redacts non-Error model %s failures",
    async (boundary) => {
      const h = fixture({
        normalizeAppFile: (value) => {
          if (value === "invalid") throw "fixture-private";
          return value;
        },
        delivery: {
          redactDiagnostic: (text) =>
            text.replaceAll("fixture-private", "[redacted]"),
          reportDiagnostic: vi.fn()
        }
      });
      const result = await h.runtime.start(
        { ...target, appFile: undefined },
        {
          modelSelection: {
            isCurrent: () => true,
            resolve: async () => {
              if (boundary === "read") throw "fixture-private";
              return "invalid";
            }
          }
        }
      );
      expect(result).toMatchObject({
        ok: false,
        status: boundary === "read" ? 503 : 400,
        error: expect.stringContaining("[redacted]")
      });
      expect(h.createExecution).not.toHaveBeenCalled();
      expect(h.runtime.owner.hasActiveWork()).toBe(false);
    }
  );

  it("refuses incomplete production bindings during construction", () => {
    expect(() => fixture({ awsEnabled: undefined })).toThrow(
      "requires awsEnabled"
    );
    expect(() => fixture({ createExecution: undefined })).toThrow(
      "createExecution"
    );
  });

  it("refuses missing targets, unavailable repairs and ambiguous repeats before external reads", async () => {
    const { runtime, resolveDeployment } = fixture();
    expect(await runtime.start({})).toMatchObject({ ok: false, status: 400 });
    expect(await runtime.start({ attemptId: "foreign" })).toMatchObject({
      ok: false,
      status: 409
    });
    expect(resolveDeployment).not.toHaveBeenCalled();
    await runtime.start(target);
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    await runtime.start({ ...target, environment: "other" });
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(await runtime.start({})).toMatchObject({ ok: false, status: 400 });
    expect(await runtime.start({ repo: target.repo })).toMatchObject({
      ok: false,
      status: 400
    });
    expect(resolveDeployment).toHaveBeenCalledTimes(2);
    expect((await runtime.start(target)).ok).toBe(true);
  });

  it.each(["target", "branch", "model"] as const)(
    "does not fence an unrelated settled attempt during fresh %s resolution",
    async (boundary) => {
      const entered = held();
      const gate = held();
      const h = fixture({
        resolveDeployment: async (repo) => {
          if (repo === "other/app" && boundary === "target") {
            entered.resolve();
            await gate.promise;
          }
          return null;
        },
        resolveDefaultBranch: async () => {
          entered.resolve();
          await gate.promise;
          return "remote-default";
        }
      });
      const first = await h.runtime.start(target);
      if (!first.ok) throw new Error(first.error);
      await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
      const second = h.runtime.start(
        {
          ...target,
          repo: "other/app",
          ...(boundary === "branch" ? { branch: undefined } : {}),
          ...(boundary === "model" ? { appFile: undefined } : {})
        },
        boundary === "model" ?
          {
            modelSelection: {
              isCurrent: () => true,
              resolve: async () => {
                entered.resolve();
                await gate.promise;
                return "models/other.bicep";
              }
            }
          }
        : {}
      );
      await entered.promise;
      expect(h.runtime.owner.retire(first.invocation)).toBe(true);
      gate.resolve();
      const result = await second;
      if (!result.ok) throw new Error(result.error);
      expect(result.invocation.target).toMatchObject({
        repo: "other/app",
        branch: boundary === "branch" ? "remote-default" : "topic",
        appFile: boundary === "model" ? "models/other.bicep" : target.appFile
      });
    }
  );

  it("rejects retirement of genuinely inherited repeat context during admission", async () => {
    let retirePrior = () => {};
    const h = fixture({
      resolveDeployment: async () => {
        retirePrior();
        return null;
      }
    });
    const first = await h.runtime.start(target);
    if (!first.ok) throw new Error(first.error);
    await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
    retirePrior = () => {
      expect(h.runtime.owner.retire(first.invocation)).toBe(true);
    };
    expect(await h.runtime.start({})).toMatchObject({
      ok: false,
      status: 409
    });
    expect(h.createExecution).toHaveBeenCalledOnce();
  });

  it.each(["workspace", "remote", "prior"] as const)(
    "uses %s branch resolution for an explicit target despite unrelated history",
    async (source) => {
      const h = fixture();
      for (const repo of ["one/app", "two/app"]) {
        expect((await h.runtime.start({ ...target, repo })).ok).toBe(true);
        await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
      }
      const result = await h.runtime.start(
        {
          repo: source === "prior" ? "one/app" : "three/app",
          environment: "dev"
        },
        source === "workspace" ?
          { workspace: { repo: "three/app", branch: "workspace-branch" } }
        : {}
      );
      if (!result.ok) throw new Error(result.error);
      expect(result.invocation.target.branch).toBe(
        source === "prior" ? "topic"
        : source === "workspace" ? "workspace-branch"
        : "release"
      );
    }
  );

  it("retains explicit repeat intent without invoking automatic model selection", async () => {
    const h = fixture();
    const first = await h.runtime.start({
      ...target,
      appFile: "models/explicit.bicep"
    });
    if (!first.ok) throw new Error(first.error);
    await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
    const resolve = vi.fn(async () => "models/auto.bicep");
    const second = await h.runtime.start(
      { repo: target.repo, environment: target.environment },
      { modelSelection: { resolve, isCurrent: () => true } }
    );
    if (!second.ok) throw new Error(second.error);
    expect(resolve).not.toHaveBeenCalled();
    expect(second.invocation.state.deployParams?.appFile).toBe(
      "models/explicit.bicep"
    );
    expect(second.invocation.target.appFile).toBe("models/explicit.bicep");
  });

  it("inherits explicit repeat intent across environment casing without rewriting the requested target", async () => {
    const h = fixture({ awsEnabled: true });
    const first = await h.runtime.start({
      ...target,
      environment: "prod",
      provider: "aws",
      branch: "release/Production",
      appFile: "models/explicit.bicep"
    });
    if (!first.ok) throw new Error(first.error);
    await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
    const resolve = vi.fn(async () => "models/auto.bicep");
    const second = await h.runtime.start(
      { repo: target.repo, environment: "Prod" },
      { modelSelection: { resolve, isCurrent: () => true } }
    );
    if (!second.ok) throw new Error(second.error);
    expect(second.invocation.target).toEqual({
      repo: target.repo,
      environment: "Prod",
      provider: "aws",
      branch: "release/Production",
      appFile: "models/explicit.bicep"
    });
    expect(second.invocation.state.deployParams).toMatchObject({
      environment: "Prod",
      provider: "aws",
      branch: "release/Production",
      appFile: "models/explicit.bicep"
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(second.invocation.state.deployAttempt?.environment).toBe("Prod");
    await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
    const independent = await h.runtime.start({
      repo: target.repo,
      environment: "staging"
    });
    if (!independent.ok) throw new Error(independent.error);
    expect(independent.invocation.target).toEqual({
      repo: target.repo,
      environment: "staging",
      provider: "azure",
      branch: "release",
      appFile: ".radius/app.bicep"
    });
  });

  it("does not retarget a pinned repair to another environment spelling", async () => {
    const h = fixture({ awsEnabled: true }, async ({ entry }) => {
      entry.state.deployStatus = "failed";
      entry.state.deployError = "Model validation failed";
    });
    const first = await h.runtime.start({
      ...target,
      environment: "prod",
      provider: "aws"
    });
    if (!first.ok) throw new Error(first.error);
    await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
    expect(
      await h.runtime.start({
        attemptId: first.invocation.attemptId,
        environment: "Prod"
      })
    ).toMatchObject({ ok: false, status: 409 });
    const repaired = await h.runtime.start({
      attemptId: first.invocation.attemptId
    });
    if (!repaired.ok) throw new Error(repaired.error);
    expect(repaired.invocation.target).toEqual(first.invocation.target);
    expect(repaired.invocation.target.environment).toBe("prod");
  });

  it("fences inherited mixed-case environment intent if its prior attempt retires during admission", async () => {
    let retire = () => {};
    const h = fixture({
      resolveDeployment: async () => {
        retire();
        return null;
      }
    });
    const first = await h.runtime.start({
      ...target,
      environment: "prod",
      appFile: "models/explicit.bicep"
    });
    if (!first.ok) throw new Error(first.error);
    await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
    retire = () => {
      h.runtime.owner.retire(first.invocation);
    };
    expect(
      await h.runtime.start({
        ...target,
        environment: "Prod",
        appFile: undefined
      })
    ).toMatchObject({ ok: false, status: 409 });
    expect(h.createExecution).toHaveBeenCalledOnce();
  });

  it.each(["branch", "environment"] as const)(
    "does not inherit explicit model intent across a different %s",
    async (field) => {
      const h = fixture();
      await h.runtime.start({ ...target, appFile: "models/explicit.bicep" });
      await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
      const result = await h.runtime.start({
        ...target,
        [field]: "other",
        appFile: undefined
      });
      if (!result.ok) throw new Error(result.error);
      expect(result.invocation.target.appFile).toBe(".radius/app.bicep");
      expect(result.invocation.state.deployParams?.appFile).toBeUndefined();
    }
  );

  it("resolves a missing branch from GitHub when no workspace or prior target supplies it", async () => {
    const { runtime } = fixture();
    const result = await runtime.start({ ...target, branch: "" });
    if (!result.ok) throw new Error(result.error);
    expect(result.invocation.target.branch).toBe("release");
  });

  it("does not continue branch discovery after shutdown during a remote lookup", async () => {
    const gate = held();
    const entered = held();
    const resolveDefaultBranch = vi.fn(async () => "main");
    const { runtime } = fixture({
      resolveDefaultBranch,
      resolveDeployment: async () => {
        entered.resolve();
        await gate.promise;
        return null;
      }
    });
    const start = runtime.start({ ...target, branch: "" });
    await entered.promise;
    const stopping = runtime.owner.shutdown(100);
    gate.resolve();
    expect(await start).toMatchObject({ ok: false, status: 409 });
    await stopping;
    expect(resolveDefaultBranch).not.toHaveBeenCalled();
  });

  it("rejects a late branch lookup after shutdown", async () => {
    const gate = held();
    const entered = held();
    const { runtime, run } = fixture({
      resolveDefaultBranch: async () => {
        entered.resolve();
        await gate.promise;
        return "late";
      }
    });
    const start = runtime.start({ ...target, branch: "" });
    await entered.promise;
    const stopping = runtime.owner.shutdown(100);
    gate.resolve();
    expect(await start).toMatchObject({ ok: false, status: 409 });
    await stopping;
    expect(run).not.toHaveBeenCalled();
  });

  it("accounts for bounded repair delivery retries and stops them at shutdown", async () => {
    vi.useFakeTimers();
    const sendRepair = vi.fn(async () => {
      throw new Error("delivery unavailable");
    });
    const { runtime } = fixture(
      {
        delivery: {
          sendRepair,
          redactDiagnostic: (value) => value,
          reportDiagnostic: vi.fn()
        }
      },
      async ({ entry }) => {
        entry.state.deployStatus = "failed";
      }
    );
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendRepair).toHaveBeenCalledTimes(1);
    expect(runtime.owner.hasActiveWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sendRepair).toHaveBeenCalledTimes(2);
    const stopped = await runtime.owner.shutdown(100);
    expect(stopped.complete).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(sendRepair).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks a monitor that returns without an outcome as unconfirmed", async () => {
    const { runtime, sendNotice } = fixture({}, async () => {});
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(result.invocation.state.deployError).toContain("without confirming");
    expect(sendNotice).toHaveBeenCalledOnce();
  });

  it("does not schedule repair delivery after a diagnostic callback invalidates the invocation", async () => {
    const sendRepair = vi.fn(async () => {
      throw new Error("delivery unavailable");
    });
    const reportDiagnostic = vi.fn(() => {
      const current = h.runtime.owner.lookup();
      if (current.kind === "found")
        h.runtime.owner.invalidate(current.invocation);
    });
    const h = fixture(
      {
        delivery: {
          sendRepair,
          redactDiagnostic: (value) => value,
          reportDiagnostic
        }
      },
      async ({ entry }) => {
        entry.state.deployStatus = "failed";
      }
    );
    const started = await h.runtime.start(target);
    if (!started.ok) throw new Error(started.error);
    await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
    expect(reportDiagnostic).toHaveBeenCalledOnce();
    expect(sendRepair).toHaveBeenCalledOnce();
    expect(h.runtime.owner.lookup()).toEqual({ kind: "missing" });
    expect(h.runtime.owner.reserve(target, "delete")).not.toBeNull();
  });

  it.each(["waiting", "delivering"] as const)(
    "fences invalidated repair retries while %s without dropping issued work",
    async (phase) => {
      vi.useFakeTimers();
      const finish = held();
      let attempts = 0;
      const sendRepair = vi.fn(async () => {
        if (++attempts > 1) await finish.promise;
        throw new Error("delivery unavailable");
      });
      const { runtime } = fixture(
        {
          delivery: {
            sendRepair,
            redactDiagnostic: (value) => value,
            reportDiagnostic: vi.fn()
          }
        },
        async ({ entry }) => {
          entry.state.deployStatus = "failed";
        }
      );
      const started = await runtime.start(target);
      if (!started.ok) throw new Error(started.error);
      await vi.advanceTimersByTimeAsync(0);
      if (phase === "delivering") await vi.advanceTimersByTimeAsync(2000);
      const published = vi.fn();
      runtime.owner.subscribe(started.invocation, published);
      expect(runtime.owner.invalidate(started.invocation)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.owner.lookup()).toEqual({ kind: "missing" });
      expect(runtime.owner.hasActiveWork()).toBe(phase === "delivering");
      if (phase === "delivering")
        expect(runtime.owner.reserve(target, "delete")).toBeNull();
      finish.resolve();
      await vi.advanceTimersByTimeAsync(10000);
      expect(runtime.owner.hasActiveWork()).toBe(false);
      expect(sendRepair).toHaveBeenCalledTimes(phase === "delivering" ? 2 : 1);
      expect(published).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("publishes pending, retryable and delivered repair state to attached views", async () => {
    vi.useFakeTimers();
    const finishMonitor = held();
    const finishDelivery = held();
    let attempts = 0;
    const sendRepair = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("delivery unavailable");
      await finishDelivery.promise;
    });
    const { runtime } = fixture(
      {
        delivery: {
          sendRepair,
          redactDiagnostic: (value) => value,
          reportDiagnostic: vi.fn()
        }
      },
      async ({ entry }) => {
        await finishMonitor.promise;
        entry.state.deployStatus = "failed";
        entry.state.deployError = "model validation failed";
      }
    );
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    const changes: {
      handoff: string | undefined;
      repairing: boolean | undefined;
    }[] = [];
    const detach = runtime.owner.subscribe(result.invocation, ({ state }) => {
      changes.push({
        handoff: state.deployHandoffState,
        repairing: state.deployRepairing
      });
    });
    try {
      finishMonitor.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(changes).toContainEqual({ handoff: "pending", repairing: false });
      expect(changes.at(-1)).toEqual({
        handoff: "retryable",
        repairing: false
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(sendRepair).toHaveBeenCalledTimes(2);
      expect(changes.at(-1)).toEqual({ handoff: "pending", repairing: false });
      finishDelivery.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(changes.at(-1)).toEqual({ handoff: "delivered", repairing: true });
      expect(runtime.owner.hasActiveWork()).toBe(false);
    } finally {
      detach();
    }
  });

  it("surfaces execution construction failures without leaving the target active", async () => {
    const { runtime } = fixture({
      createExecution: () => {
        throw new Error("execution unavailable");
      }
    });
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(result.invocation.state.deployError).toContain(
      "execution unavailable"
    );
    expect(runtime.owner.reserve(target, "delete")).not.toBeNull();
  });

  it("admits without any panel and returns observation-only identity", async () => {
    const { runtime, run, resolveDeployment } = fixture();
    const result = await runtime.start(target);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.invocation.target).toEqual(target);
    expect(
      runtime.owner.lookup({ observationId: result.invocation.observationId })
    ).toMatchObject({ kind: "found" });
    expect(
      runtime.owner.lookup({ attemptId: result.invocation.observationId })
    ).toEqual({ kind: "missing" });
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.invocation.state.deployStatus).toBe("complete");
    expect(resolveDeployment).toHaveBeenCalledWith("fixture/app", "dev", "app");
  });

  it("captures trusted workspace context before asynchronous admission", async () => {
    const { runtime, createExecution } = fixture();
    const workspace = {
      repo: "fixture/app",
      branch: "topic",
      workspacePath: "fixture-workspace"
    };
    const pending = runtime.start({ environment: "dev" }, { workspace });
    workspace.branch = "changed";
    const result = await pending;
    if (!result.ok) throw new Error(result.error);
    expect(result.invocation.target.branch).toBe("topic");
    expect(createExecution).toHaveBeenCalledWith(
      result.invocation,
      {
        repo: "fixture/app",
        branch: "topic",
        workspacePath: "fixture-workspace"
      },
      undefined
    );
  });

  it("detaches a view without stopping the monitor or unlocking its target", async () => {
    const gate = held();
    const { runtime } = fixture({}, async ({ entry }) => {
      await gate.promise;
      entry.state.deployStatus = "complete";
    });
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    const detach = runtime.owner.subscribe(result.invocation, vi.fn());
    detach();
    expect(runtime.owner.retire(result.invocation)).toBe(false);
    expect(runtime.owner.reserve(target, "delete")).toBeNull();
    expect(await runtime.start(target)).toMatchObject({
      ok: false,
      status: 409
    });
    const independent = await runtime.start({
      ...target,
      environment: "other"
    });
    expect(independent.ok).toBe(true);
    gate.resolve();
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(result.invocation.state.deployStatus).toBe("complete");
  });

  it.each(["empty", "failed"] as const)(
    "never guesses main when branch lookup is %s",
    async (mode) => {
      const { runtime, run } = fixture({
        resolveDefaultBranch: async () => {
          if (mode === "failed") throw new Error("unavailable");
          return " ";
        }
      });
      const result = await runtime.start({ ...target, branch: "" });
      expect(result).toMatchObject({ ok: false, status: 503 });
      expect(run).not.toHaveBeenCalled();
      expect(runtime.owner.lookup()).toEqual({ kind: "missing" });
      expect(runtime.owner.reserve(target, "delete")).not.toBeNull();
    }
  );

  it("blocks admission on an unavailable or active remote deployment", async () => {
    const lookup = vi
      .fn<DeploymentRuntimePorts["resolveDeployment"]>()
      .mockRejectedValueOnce(new Error("GitHub unavailable"))
      .mockResolvedValueOnce({ status: "deploying" });
    const { runtime, run } = fixture({ resolveDeployment: lookup });
    expect(await runtime.start(target)).toMatchObject({
      ok: false,
      status: 503
    });
    expect(await runtime.start(target)).toMatchObject({
      ok: false,
      status: 409
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps admission alive and refuses late lookup after shutdown", async () => {
    const gate = held();
    const entered = held();
    const { runtime, run } = fixture({
      resolveDeployment: async () => {
        entered.resolve();
        await gate.promise;
        return null;
      }
    });
    const start = runtime.start(target);
    await entered.promise;
    expect(runtime.owner.hasActiveWork()).toBe(true);
    const stop = runtime.owner.shutdown(100);
    gate.resolve();
    expect(await start).toMatchObject({ ok: false, status: 409 });
    expect(await stop).toEqual({ complete: true, pending: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it("publishes message-only monitor progress without adding logs", async () => {
    const entered = held();
    const release = held();
    const h = fixture({}, async ({ entry, onProgress }) => {
      entered.resolve();
      await release.promise;
      const resource = entry.state.deployingResources?.[0];
      if (!resource) throw new Error("Missing test resource");
      resource.deployMessage = "Waiting for provisioning";
      onProgress?.();
      entry.state.deployStatus = "complete";
    });
    const result = await h.runtime.start(target, {
      resources: [{ name: "api", deployStatus: "pending" }]
    });
    if (!result.ok) throw new Error(result.error);
    await entered.promise;
    const snapshots: string[] = [];
    h.runtime.owner.subscribe(result.invocation, ({ state }) => {
      if (state.deployStatus === "in_progress")
        snapshots.push(state.deployingResources?.[0].deployMessage ?? "");
    });
    release.resolve();
    await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
    expect(snapshots).toContain("Waiting for provisioning");
    expect(result.invocation.state.deployLogs).toEqual([]);
  });

  it("does not deliver repair after a terminal publication invalidates its attempt", async () => {
    const entered = held();
    const release = held();
    const h = fixture({}, async ({ entry }) => {
      entered.resolve();
      await release.promise;
      entry.state.deployStatus = "failed";
      entry.state.deployError = "Model failure";
    });
    const result = await h.runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    await entered.promise;
    const listener = vi.fn(() => {
      if (result.invocation.state.deployStatus === "failed")
        h.runtime.owner.invalidate(result.invocation);
    });
    h.runtime.owner.subscribe(result.invocation, listener);
    release.resolve();
    await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    expect(h.sendRepair).not.toHaveBeenCalled();
    expect(h.sendNotice).not.toHaveBeenCalled();
  });

  it("reports monitor crashes as unconfirmed notices, never model repair", async () => {
    const { runtime, sendRepair, sendNotice, reportError } = fixture(
      {},
      async () => {
        throw new Error("monitor unavailable");
      }
    );
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(result.invocation.state).toMatchObject({
      deployStatus: "failed",
      deployErrorKind: "run-unconfirmed"
    });

    expect(reportError).toHaveBeenCalledOnce();
    expect(result.invocation.state.deployLogs).toEqual([
      "\u274c Deploy monitor stopped unexpectedly: monitor unavailable"
    ]);
    expect(sendNotice).toHaveBeenCalledOnce();
    expect(sendRepair).not.toHaveBeenCalled();
    expect(
      await runtime.start({ attemptId: result.invocation.attemptId })
    ).toMatchObject({ ok: false, status: 409 });
  });

  it.each(["invalidate", "shutdown"] as const)(
    "does not synthesize a failure when an intentionally %s monitor settles",
    async (action) => {
      for (const settlement of ["resolve", "reject"] as const) {
        const entered = held();
        const gate = held();
        const h = fixture({}, async () => {
          entered.resolve();
          await gate.promise;
          if (settlement === "reject") throw new Error("Observation stopped");
        });
        const result = await h.runtime.start(target);
        if (!result.ok) throw new Error(result.error);
        await entered.promise;
        const listener = vi.fn();
        h.runtime.owner.subscribe(result.invocation, listener);
        const stopping =
          action === "shutdown" ? h.runtime.owner.shutdown(100) : undefined;
        if (action === "invalidate")
          h.runtime.owner.invalidate(result.invocation);
        expect(h.runtime.owner.reserve(target, "delete")).toBeNull();
        gate.resolve();
        if (stopping) await stopping;
        await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
        expect(result.invocation.state).toMatchObject({
          deployStatus: "in_progress",
          deployError: null,
          deployErrorKind: null
        });
        expect(h.reportError).not.toHaveBeenCalled();
        expect(h.sendRepair).not.toHaveBeenCalled();
        expect(h.sendNotice).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
      }
    }
  );

  it("preserves a live monitor's existing diagnostic and failure classification", async () => {
    const h = fixture({}, async ({ entry }) => {
      entry.state.deployError = "Already recorded actionable diagnostic";
      entry.state.deployErrorKind = "workflow-preflight-failed";
      throw new Error("later observation failure");
    });
    const result = await h.runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    await expect.poll(() => h.runtime.owner.hasActiveWork()).toBe(false);
    expect(result.invocation.state).toMatchObject({
      deployStatus: "failed",
      deployError: "Already recorded actionable diagnostic",
      deployErrorKind: "workflow-preflight-failed"
    });
    expect(h.reportError).toHaveBeenCalledOnce();
    expect(h.sendRepair).not.toHaveBeenCalled();
  });
  it.each(["target lookup", "branch lookup", "monitor"] as const)(
    "redacts non-Error rejections from %s",
    async (boundary) => {
      const rejected = () => Promise.reject("fixture-private");
      const redactDiagnostic = (value: string) =>
        value.replaceAll("fixture-private", "[redacted]");
      const { runtime } = fixture(
        {
          ...(boundary === "target lookup" ?
            { resolveDeployment: rejected }
          : {}),
          ...(boundary === "branch lookup" ?
            { resolveDefaultBranch: rejected }
          : {}),
          delivery: { redactDiagnostic, reportDiagnostic: vi.fn() }
        },
        boundary === "monitor" ? rejected : undefined
      );
      const result = await runtime.start({ ...target, branch: "" });
      if (boundary === "monitor") {
        if (!result.ok) throw new Error(result.error);
        await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
        expect(result.invocation.state.deployError).toContain("[redacted]");
        expect(result.invocation.state.deployError).not.toContain(
          "fixture-private"
        );
        expect(result.invocation.state.deployErrorKind).toBe("run-unconfirmed");
      } else {
        expect(result).toMatchObject({
          ok: false,
          status: 503,
          error: expect.stringContaining("[redacted]")
        });
        expect(JSON.stringify(result)).not.toContain("fixture-private");
      }
    }
  );

  it("stops publishing late monitor progress and repair after shutdown", async () => {
    const entered = held();
    const gate = held();
    const { runtime, sendRepair, sendNotice } = fixture(
      {},
      async ({ entry, log }) => {
        log("before shutdown");
        entered.resolve();
        await gate.promise;
        log("late progress");
        entry.state.deployStatus = "failed";
        entry.state.deployError = "model failure after shutdown";
      }
    );
    const result = await runtime.start(target);
    if (!result.ok) throw new Error(result.error);
    await entered.promise;
    const stopping = runtime.owner.shutdown(100);
    gate.resolve();
    expect(await stopping).toEqual({ complete: true, pending: [] });
    expect(result.invocation.state.deployLogs).toEqual(["before shutdown"]);
    expect(sendRepair).not.toHaveBeenCalled();
    expect(sendNotice).not.toHaveBeenCalled();
  });

  it("treats repeated empty attempt IDs as fresh deployment starts", async () => {
    const { runtime } = fixture();
    const first = await runtime.start({ ...target, attemptId: "" });
    if (!first.ok) throw new Error(first.error);
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    const second = await runtime.start({ ...target, attemptId: "" });
    if (!second.ok) throw new Error(second.error);
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(first.invocation.attemptId).toMatch(/^attempt:.+/);
    expect(second.invocation.attemptId).toMatch(/^attempt:.+/);
    expect(second.invocation.attemptId).not.toBe(first.invocation.attemptId);
    expect(second.invocation.observationId).not.toBe(
      first.invocation.observationId
    );
    expect(second.invocation.state.deployStatus).toBe("complete");
    expect(second.repairAttempt).toBeUndefined();
  });

  it.each([undefined, ""])(
    "repairs a failure started with attemptId %j using its generated identity and budget",
    async (attemptId) => {
      const { runtime, sendRepair } = fixture({}, async ({ entry }) => {
        entry.state.deployStatus = "failed";
        entry.state.deployError = "model validation failed";
      });
      const first = await runtime.start({ ...target, attemptId });
      if (!first.ok) throw new Error(first.error);
      await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
      expect(sendRepair).toHaveBeenCalledOnce();
      expect(first.invocation.attemptId).toMatch(/^attempt:.+/);
      expect(sendRepair).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: first.invocation.attemptId })
      );
      const second = await runtime.start({
        attemptId: first.invocation.attemptId
      });
      if (!second.ok) throw new Error(second.error);
      expect(second.repairAttempt).toBe(1);
      expect(second.repairAttemptCap).toBe(5);
      expect(second.invocation.attemptId).toBe(first.invocation.attemptId);
      expect(second.invocation.generation).toBe(2);
      expect(second.invocation.observationId).not.toBe(
        first.invocation.observationId
      );
      expect(
        runtime.owner.lookup({ observationId: first.invocation.observationId })
      ).toEqual({ kind: "missing" });
      await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
      expect(sendRepair).toHaveBeenCalledOnce();
    }
  );

  it("preserves optional display resources and bounded logs without sharing the view's arrays", async () => {
    const { runtime } = fixture({}, async ({ entry, log }) => {
      for (let index = 0; index < 4002; index++) log(`line ${index}`);
      entry.state.deployStatus = "complete";
    });
    const resources = [{ name: "db", outputResources: [{ name: "storage" }] }];
    const result = await runtime.start(target, { resources });
    if (!result.ok) throw new Error(result.error);
    await expect.poll(() => runtime.owner.hasActiveWork()).toBe(false);
    expect(resources).toEqual([
      { name: "db", outputResources: [{ name: "storage" }] }
    ]);
    expect(result.invocation.state.deployingResources).toEqual([
      {
        name: "db",
        deployStatus: "pending",
        outputResources: [{ name: "storage", deployStatus: "pending" }]
      }
    ]);
    expect(result.invocation.state.deployLogBase).toBe(2);
    expect(result.invocation.state.deployLogs).toHaveLength(4000);
  });
});
