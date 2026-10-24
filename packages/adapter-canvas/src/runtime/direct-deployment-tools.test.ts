import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeploymentToolHarness } from "../../test/support/runtime/deployment.js";
import { createDeferred } from "../../test/support/browser/fakes.js";
import { createDirectDeploymentTools } from "./direct-deployment-tools.js";

const fixtures: ReturnType<typeof createDeploymentToolHarness>[] = [];
function fixture() {
  const f = createDeploymentToolHarness();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.tools.shutdown();
});

describe("direct deployment tools", () => {
  it("starts without a panel, resolves the real default branch, and shares its completed snapshot", async () => {
    const f = fixture();
    expect(
      await f.tools.start({ repo: "fixture/app", environment: "dev" })
    ).toContain("branch trunk");
    await vi.waitFor(() =>
      expect(f.owner.activeReservation(f.target)).toBeUndefined()
    );
    expect(f.monitor).toHaveBeenCalledOnce();
    expect(f.account.mock.calls[0][0].savedLogin).toBeUndefined();
    expect(JSON.parse(await f.tools.status({}))).toMatchObject({
      status: "success",
      attemptId: "attempt-1"
    });
    expect(f.notify).toHaveBeenCalled();
  });

  it("repeats one retained context and permits explicit overrides only for new manual work", async () => {
    const f = fixture();
    f.seed();
    expect(
      await f.tools.start({
        repo: "fixture/app",
        environment: "other",
        branch: "release",
        provider: "aws",
        appFile: "models/app.bicep"
      })
    ).toContain('environment "other"');
    expect(f.monitor.mock.calls[0][0]).toMatchObject({
      repo: "fixture/app",
      branch: "release",
      provider: "aws",
      entry: { state: { appFile: "models/app.bicep" } }
    });

    expect(f.account.mock.calls[0][0].savedLogin).toBeUndefined();
  });

  it.each(["fixture/app", "fixture/other"])(
    "does not inherit an unrelated target's branch, provider, model or graph when explicitly selecting %s/prod",
    async (repo) => {
      const f = fixture();
      f.seed(
        { plannedResources: [{ id: "old", name: "old", type: "application" }] },
        {
          branch: "old-feature",
          provider: "aws",
          appFile: "infra/custom.bicep"
        }
      );
      expect(await f.tools.start({ repo, environment: "prod" })).toContain(
        "branch trunk"
      );
      expect(f.monitor.mock.calls[0][0]).toMatchObject({
        repo,
        branch: "trunk",
        provider: "azure",
        resources: [],
        entry: { state: { appFile: ".radius/app.bicep" } }
      });
    }
  );

  it("permits a branch-only manual override of one unambiguous context", async () => {
    const f = fixture();
    f.seed();
    expect(await f.tools.start({ branch: "release" })).toContain(
      "branch release"
    );
    expect(f.monitor.mock.calls[0][0]).toMatchObject({
      repo: "fixture/app",
      requestedEnvironment: "dev",
      branch: "release"
    });
  });

  it("requires a complete new target rather than borrowing from an unrelated deployment", async () => {
    const f = fixture();
    f.seed();
    expect(await f.tools.start({ environment: "other" })).toContain(
      "Pass repo and environment"
    );
    expect(await f.tools.start({ repo: "fixture/other" })).toContain(
      "Pass repo and environment"
    );
    expect(f.monitor).not.toHaveBeenCalled();
    expect(f.account).not.toHaveBeenCalled();
  });

  it("repeats the resolved branch rather than resolving an originally omitted branch again", async () => {
    const f = fixture();
    await f.tools.start({ repo: "fixture/app", environment: "dev" });
    await vi.waitFor(() =>
      expect(f.owner.activeReservation(f.target)).toBeUndefined()
    );
    expect(await f.tools.start({})).toContain("branch trunk");
    expect(
      f.run.mock.calls.filter(([args]) => args[0] === "repo")
    ).toHaveLength(1);
    expect(f.monitor.mock.calls.map(([request]) => request.branch)).toEqual([
      "trunk",
      "trunk"
    ]);
  });

  it("refuses ambiguous contexts rather than choosing the latest attempt", async () => {
    const f = fixture();
    f.seed();
    f.seed({}, { repo: "fixture/other" });
    expect(await f.tools.start({})).toContain("Multiple deployment contexts");
    expect(await f.tools.status({})).toContain("Multiple deployment contexts");
    expect(f.account).not.toHaveBeenCalled();
    expect(f.monitor).not.toHaveBeenCalled();
    expect(
      await f.tools.start({
        repo: "fixture/third",
        environment: "new",
        branch: "release"
      })
    ).toContain("started");
  });

  it("pins repairs to the retained account and preserves the independent attempt budget", async () => {
    const f = fixture();
    const prior = f.seed({
      deployStatus: "failed",
      deployError: "model failure",
      deployRepairAttempts: 2
    });
    expect(
      await f.tools.start({ attemptId: prior.invocation.attemptId })
    ).toContain("automatic repair attempt 3 of 5");
    expect(f.account.mock.calls[0][0].savedLogin).toBe("fixture-user");
    expect(
      f.owner.resolve({ attemptId: prior.invocation.attemptId })
    ).toMatchObject({
      kind: "resolved",
      invocation: { generation: 2 }
    });
  });

  it.each(["stale", "retargeted", "nonrepairable", "capped"] as const)(
    "refuses %s repair before account selection or I/O",
    async (reason) => {
      const f = fixture();
      const prior = f.seed({
        deployStatus: "failed",
        ...(reason === "nonrepairable" ?
          { deployErrorKind: "run-unconfirmed" }
        : {}),
        ...(reason === "capped" ? { deployRepairAttempts: 5 } : {})
      });
      const result = await f.tools.start({
        attemptId:
          reason === "stale" ? "not-current" : prior.invocation.attemptId,
        ...(reason === "retargeted" ? { repo: "fixture/other" } : {})
      });
      expect(result).toMatch(
        /no longer active|cannot change|never confirmed|already used its 5/i
      );
      expect(f.account).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    }
  );

  it.each([{}, { repo: "fixture/app" }, { environment: "dev" }])(
    "reports missing target guidance for %j",
    async (input) => {
      const f = fixture();
      expect(await f.tools.start(input)).toContain("Pass repo and environment");
      expect(await f.tools.status({})).toContain("No deployment context");
      expect(f.run).not.toHaveBeenCalled();
    }
  );

  it.each([
    null,
    undefined,
    [],
    "not-an-object",
    { repo: 42 },
    { environment: " " },
    { repo: "invalid" },
    { provider: "other" }
  ])("rejects malformed explicit input %j", async (input) => {
    const f = fixture();
    expect(await f.tools.start(input)).toContain("Could not start");
    expect(await f.tools.status(input)).toContain("Could not read");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("reports account refusal and releases admission without switching identity", async () => {
    const f = fixture();
    f.account.mockResolvedValue({
      state: "unavailable",
      message: "Retained account unavailable"
    });
    expect(
      await f.tools.start({ repo: "fixture/app", environment: "dev" })
    ).toContain("Retained account unavailable");
    expect(f.owner.activeReservation(f.target)).toBeUndefined();
    expect(f.monitor).not.toHaveBeenCalled();
  });

  it("rejects a second start while one monitor owns the target reservation", async () => {
    const f = fixture();
    const gate = createDeferred<void>();
    f.monitor.mockImplementation(() => gate.promise);
    try {
      const input = {
        repo: "fixture/app",
        environment: "dev",
        branch: "feature/model"
      };
      expect(await f.tools.start(input)).toContain("started");
      expect(f.tools.hasPendingWork()).toBe(true);
      expect(await f.tools.start(input)).toContain("already in progress");
      expect(f.monitor).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
    }
    await vi.waitFor(() => expect(f.tools.hasPendingWork()).toBe(false));
    f.tools.shutdown();
    expect(f.tools.hasPendingWork()).toBe(false);
  });

  it.each([undefined, 1, 999])(
    "bounds status diagnostics for logLines=%s without exposing raw errors",
    async (logLines) => {
      const f = fixture();
      const runUrl = "https://github.com/fixture/app/actions/runs/42";
      const execution = f.seed({
        deployStatus: "failed",
        deployError: "model failure",
        deployRunUrl: runUrl,
        deployLogs: Array.from({ length: 300 }, (_, index) => `line ${index}`)
      });
      const result = JSON.parse(
        await f.tools.status({
          attemptId: execution.invocation.attemptId,
          logLines
        })
      );
      expect(result).toMatchObject({
        status: "failed",
        deployRunUrl: runUrl,
        attemptId: execution.invocation.attemptId
      });
      expect(result).not.toHaveProperty("error");
      expect(result.diagnostic).toContain("line 299");
      expect(result.diagnostic).not.toContain(
        `line ${
          logLines === 999 ? 99
          : logLines === 1 ? 298
          : 259
        }\n`
      );
    }
  );

  it("reports snapshot failures explicitly instead of manufacturing pending success", async () => {
    const f = fixture();
    f.seed();
    vi.spyOn(f.owner, "snapshot").mockImplementation(() => {
      throw new Error("snapshot unavailable");
    });
    expect(await f.tools.status({})).toContain("snapshot unavailable");
  });

  it.each([undefined, "", "unsupported"])(
    "reports an unavailable stored status %s rather than a fabricated pending outcome",
    async (deployStatus) => {
      const f = fixture();
      const execution = f.seed();
      execution.state.deployStatus = deployStatus;
      expect(await f.tools.status({})).toContain(
        "Deployment status is unavailable"
      );
    }
  );

  it("does not publish a stale snapshot when notification retires the runtime", async () => {
    const f = fixture();
    f.seed({ deployStatus: "failed" });
    f.notify.mockImplementation(() => f.owner.shutdown());
    expect(await f.tools.status({})).toContain("no longer active");
    expect(
      await f.tools.start({ repo: "fixture/app", environment: "dev" })
    ).toContain("runtime has stopped");
    expect(await f.tools.status({})).toContain("runtime has stopped");
  });

  it("does not invoke another notifier after an asynchronous callback retires the runtime", async () => {
    const f = fixture();
    f.seed({ deployStatus: "failed" });
    const later = vi.fn();
    const tools = createDirectDeploymentTools({
      owner: f.owner,
      controller: f.controller,
      notifications: [
        async () => {
          f.owner.shutdown();
        },
        later
      ],
      reportError: f.reportError,
      redactDiagnostic: (value) => value
    });
    expect(await tools.status({})).toContain("no longer active");
    expect(later).not.toHaveBeenCalled();
  });

  it("reports notification failures while preserving authoritative workflow status", async () => {
    const f = fixture();
    f.seed({ deployStatus: "complete" });
    f.notify.mockImplementation(() => {
      throw new Error("host unavailable");
    });
    expect(JSON.parse(await f.tools.status({})).status).toBe("success");
    expect(f.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "host unavailable" })
    );
  });

  it("observes rejected asynchronous notification callbacks without losing workflow status", async () => {
    const f = fixture();
    f.seed({ deployStatus: "complete" });
    f.notify.mockRejectedValue(new Error("asynchronous host unavailable"));
    expect(JSON.parse(await f.tools.status({})).status).toBe("success");
    expect(f.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "asynchronous host unavailable" })
    );
  });
});
