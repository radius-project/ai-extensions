import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeploymentPipelineRunner } from "../../test/support/runtime/deployment.js";
import { successfulSelectedGhExecutor } from "../../test/support/server/selected-gh.js";
import { createDeferred } from "../../test/support/browser/fakes.js";
import type { SelectedGhExecutor } from "../gh.js";
import { BARE_GH_COMMAND_PRESENTATION } from "../gh-command-display.js";
import { createProductionDeploymentExecutionOwner } from "./production-deployment-execution-owner.js";
import { createDeploymentExecutionOwner } from "./deployment-execution-owner.js";
import { createWorkflowObservationScope } from "../server/services/workflow-observation-scope.js";
import {
  createProductionDeploymentMonitor,
  type ProductionDeploymentMonitorPorts
} from "./production-deployment-monitor.js";

afterEach(() => vi.useRealTimers());

function fixture(
  run: SelectedGhExecutor["run"],
  recoverGraph = false,
  ports: Partial<ProductionDeploymentMonitorPorts> = {},
  provider = "aws"
) {
  const owner = ports.owner ?? createProductionDeploymentExecutionOwner();
  const executor = successfulSelectedGhExecutor({ login: "fixture-user", run });
  const target = {
    repo: "fixture/app",
    environment: "dev",
    branch: "feature/model",
    provider,
    appFile: "apps/custom.bicep",
    githubLogin: executor.login
  };
  const reservation = owner.reserve(target, "deploy");
  if (!reservation) throw new Error("Missing reservation");
  const begun = owner.begin({
    target,
    reservation,
    executor,
    state: {
      envName: "dev",
      appFile: target.appFile,
      deployParams: { appFile: target.appFile },
      deployStatus: "in_progress"
    }
  });
  if (begun.kind !== "resolved") throw new Error(begun.kind);
  const execution = owner.execution(begun.invocation);
  if (!execution) throw new Error("Missing execution");
  const runAz = vi.fn(async (): Promise<never> => {
    throw new Error("Unexpected Azure command");
  });
  const invalidateDeployListCache = vi.fn();
  const log = vi.fn();
  const monitor = createProductionDeploymentMonitor(execution, {
    owner,
    ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION,
    runAz,
    invalidateDeployListCache,
    reportWorkflowProgress: log,
    ...ports
  });
  return {
    owner,
    execution,
    runAz,
    invalidateDeployListCache,
    log,
    run: () =>
      monitor.run({
        entry: execution,
        repo: target.repo,
        branch: target.branch,
        provider: target.provider,
        requestedEnvironment: target.environment,
        resources:
          recoverGraph ? [] : [{ id: "app", name: "app", type: "application" }],
        log,
        isCurrent: () =>
          owner.execution(begun.invocation) === execution &&
          !execution.observation.stopped
      }),
    dispose: () => {
      owner.shutdown();
      owner.release(reservation);
    }
  };
}

describe("server-independent production deployment monitor", () => {
  it.each([null, false, [], {}])(
    "does not mistake malformed Azure metadata %j for verified credentials",
    async (metadata) => {
      const run = vi.fn<SelectedGhExecutor["run"]>(async (args) => {
        if (args[1].includes("/git/ref/heads/"))
          return {
            code: 0,
            stdout: JSON.stringify({ object: { sha: "a".repeat(40) } }),
            stderr: ""
          };
        if (args[1].endsWith("/variables/AZURE_CLIENT_ID"))
          return { code: 0, stdout: JSON.stringify(metadata), stderr: "" };
        if (args[1].includes("/contents/"))
          return {
            code: 1,
            stdout: "",
            stderr: "HTTP 403: committed source unavailable"
          };
        throw new Error(`Unexpected command ${JSON.stringify(args)}`);
      });
      const f = fixture(run, false, {}, "azure");
      try {
        await f.run();
        expect(f.log).toHaveBeenCalledWith(
          expect.stringContaining(
            "Could not verify Azure federated credential coverage"
          )
        );
        expect(f.execution.state.deployError).toContain(
          "committed source unavailable"
        );
        expect(f.runAz).not.toHaveBeenCalled();
      } finally {
        f.dispose();
      }
    }
  );

  it("uses the bounded Azure advisory command and refuses a confirmed missing subject before publication", async () => {
    const ok = (value: unknown) => ({
      code: 0,
      stdout: JSON.stringify(value),
      stderr: ""
    });
    const run = vi.fn<SelectedGhExecutor["run"]>(async (args) => {
      const path = args[1];
      if (path.includes("/git/ref/heads/"))
        return ok({ object: { sha: "a".repeat(40) } });
      if (path.endsWith("/variables/AZURE_CLIENT_ID"))
        return ok({ value: "fixture-client" });
      if (path === "/repos/fixture/app/environments/dev")
        return ok({ name: "dev" });
      if (path === "/repos/fixture/app")
        return ok({ full_name: "fixture/app", id: 2, owner: { id: 1 } });
      if (path.endsWith("/actions/oidc/customization/sub"))
        return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      throw new Error(`Unexpected command ${JSON.stringify(args)}`);
    });
    const runAz = vi.fn(async () => ok([]));
    const f = fixture(run, false, { runAz }, "azure");
    try {
      await f.run();
      expect(runAz).toHaveBeenCalledExactlyOnceWith(
        expect.arrayContaining([
          "ad",
          "app",
          "federated-credential",
          "list",
          "--id",
          "fixture-client"
        ]),
        15000
      );
      expect(f.execution.state.deployErrorKind).toBe("oidc-subject-missing");
      expect(
        run.mock.calls.every(
          ([args]) => args[0] === "api" && !args[1].includes("/contents/")
        )
      ).toBe(true);
    } finally {
      f.dispose();
    }
  });

  it("recovers a planned graph using selected repository reads and explicit rad I/O before refusing dispatch", async () => {
    const source =
      "resource app 'Radius.Core/applications@2025-08-01' = { name: 'app' }";
    const run = vi.fn<SelectedGhExecutor["run"]>(async (args) => {
      if (args[1].includes("/contents/.radius/app.bicep?"))
        return {
          code: 0,
          stdout: JSON.stringify({
            type: "file",
            encoding: "base64",
            content: Buffer.from(source).toString("base64")
          }),
          stderr: ""
        };
      if (args[1].includes("/contents/") && args[1].includes("recipe"))
        return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      if (args[1].includes("/git/ref/heads/"))
        return { code: 1, stdout: "", stderr: "HTTP 403: branch unavailable" };
      throw new Error(`Unexpected command ${JSON.stringify(args)}`);
    });
    const buildGraph = vi.fn(async () => [
      { id: "app", name: "app", type: "Radius.Core/applications" }
    ]);
    const readRadArtifacts = vi.fn(async () => ({
      dir: "fixture-artifacts",
      remote: true
    }));
    const f = fixture(run, true, { buildGraph, readRadArtifacts });
    try {
      await f.run();
      expect(
        buildGraph,
        JSON.stringify(f.log.mock.calls)
      ).toHaveBeenCalledExactlyOnceWith(source, ".radius/app.bicep", {
        log: expect.any(Function),
        radArtifactsDir: "fixture-artifacts",
        cleanupRadArtifactsDir: true
      });
      expect(readRadArtifacts).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: "fixture/app",
          branch: "feature/model",
          github: expect.objectContaining({ getContent: expect.any(Function) })
        })
      );
      expect(f.execution.state.plannedResources).toEqual([
        expect.objectContaining({
          name: "app",
          type: "Radius.Core/applications"
        })
      ]);
      expect(f.execution.state.deployErrorKind).toBe("dispatch-refused");
    } finally {
      f.dispose();
    }
  });

  it.each(["success", "failure", "uncertain"] as const)(
    "uses the production selected-account pipeline for %s without a server",
    async (conclusion) => {
      vi.useFakeTimers();
      const { run, unexpected } = createDeploymentPipelineRunner(conclusion);
      const owner =
        conclusion === "success" ?
          createDeploymentExecutionOwner({
            now: () => Date.now(),
            newAttemptId: () => "projected-attempt",
            reportError: (error) => {
              throw error;
            },
            createObservation: () =>
              createWorkflowObservationScope(() => ({
                sequence: 0,
                read: async () => {
                  throw new Error("Unscripted raw artifact read");
                },
                status: async () => {
                  throw new Error("Unscripted artifact status read");
                },
                progress: async () => null,
                graph: async () => ({
                  status: "ok",
                  artifact: null,
                  graph: [
                    { id: "app", name: "app", type: "Radius.Core/applications" }
                  ]
                }),
                controlPlaneLog: async () => null
              }))
          })
        : undefined;
      const f = fixture(run, false, owner ? { owner } : {});
      try {
        let settled = false;
        const completed = expect(
          f.run().finally(() => {
            settled = true;
          })
        ).resolves.toBeUndefined();
        for (let tick = 0; tick < 100 && !settled; tick++)
          await vi.advanceTimersByTimeAsync(1000);
        expect(settled, JSON.stringify(f.log.mock.calls)).toBe(true);
        await completed;
        expect(unexpected).toEqual([]);
        expect(
          run.mock.calls.filter(([args]) => args[0] === "workflow"),
          JSON.stringify(f.log.mock.calls)
        ).toHaveLength(1);
        expect(f.execution.state).toMatchObject({
          deployStatus: conclusion === "success" ? "complete" : "failed",
          ...(conclusion === "uncertain" ?
            {
              deployErrorKind: "run-unconfirmed",
              deployDispatchEvidence: "uncertain"
            }
          : {
              deployRunId: 42,
              deployRunUrl: "https://github.com/fixture/app/actions/runs/42"
            })
        });
        if (conclusion === "success") {
          expect(f.execution.state.deployedGraph).toEqual([
            expect.objectContaining({ id: "app" })
          ]);
          const secret = run.mock.calls.find(([args]) => args[0] === "secret");
          expect(secret?.[0]).not.toContain("--body");
          expect(secret?.[1]?.stdin).toBeTruthy();
        }
        if (conclusion !== "uncertain")
          expect(f.invalidateDeployListCache).toHaveBeenCalledWith(
            "fixture/app"
          );
        else expect(f.invalidateDeployListCache).not.toHaveBeenCalled();
      } finally {
        f.dispose();
      }
    }
  );

  it("constructs without I/O and refuses an unpushed branch through the retained account", async () => {
    const run = vi.fn<SelectedGhExecutor["run"]>(async (args) => {
      if (args[1] === "/repos/fixture/app/git/ref/heads/feature%2Fmodel")
        return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      if (args[1] === "/repos/fixture/app")
        return { code: 0, stdout: '{"default_branch":"trunk"}', stderr: "" };
      throw new Error(`Unexpected command ${JSON.stringify(args)}`);
    });
    const f = fixture(run);
    try {
      expect(run).not.toHaveBeenCalled();
      await f.run();
      expect(f.execution.state).toMatchObject({
        deployStatus: "failed",
        deployErrorKind: "branch-not-pushed"
      });
      expect(run).toHaveBeenCalledTimes(2);
      expect(f.runAz).not.toHaveBeenCalled();
      expect(f.invalidateDeployListCache).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("retains the planned-graph recovery port without a Canvas entry or server", async () => {
    const run = vi.fn<SelectedGhExecutor["run"]>(async (args) => {
      if (args[1].includes("/contents/"))
        return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      return { code: 1, stdout: "", stderr: "HTTP 403: branch unavailable" };
    });
    const f = fixture(run, true);
    try {
      await f.run();
      expect(run.mock.calls.map(([args]) => args[1])).toEqual([
        "/repos/fixture/app/contents/.radius/app.bicep?ref=feature%2Fmodel",
        "/repos/fixture/app/contents/app.bicep?ref=feature%2Fmodel",
        "/repos/fixture/app/git/ref/heads/feature%2Fmodel"
      ]);
      expect(f.log).toHaveBeenCalledWith(
        expect.stringContaining("Resolving planned application graph")
      );
      expect(f.execution.state.deployError).toContain("branch unavailable");
      expect(f.execution.state.deployErrorKind).toBe("dispatch-refused");
    } finally {
      f.dispose();
    }
  });

  it("never substitutes workspace content for the committed dispatch source", async () => {
    const run = vi.fn<SelectedGhExecutor["run"]>(async (args) => {
      if (args[1].includes("/git/ref/heads/"))
        return {
          code: 0,
          stdout: JSON.stringify({ object: { sha: "a".repeat(40) } }),
          stderr: ""
        };
      if (
        args[1] ===
        "/repos/fixture/app/contents/apps/custom.bicep?ref=feature%2Fmodel"
      )
        return {
          code: 1,
          stdout: "",
          stderr: "HTTP 403: committed source unavailable"
        };
      throw new Error(`Unexpected command ${JSON.stringify(args)}`);
    });
    const f = fixture(run);
    f.execution.state.workspacePath = "/synthetic/workspace";
    f.execution.state.workspaceRepo = "fixture/app";
    f.execution.state.workspaceBranch = "feature/model";
    try {
      await f.run();
      expect(run).toHaveBeenCalledTimes(2);
      expect(f.execution.state.deployError).toContain(
        "committed source unavailable"
      );
      expect(f.execution.state.deployDispatchEvidence).toBe("refused");
    } finally {
      f.dispose();
    }
  });

  it("fences in-flight reads and makes no follow-up calls after shutdown", async () => {
    const pending = createDeferred<{
      code: number;
      stdout: string;
      stderr: string;
    }>();
    const run = vi.fn<SelectedGhExecutor["run"]>(() => pending.promise);
    const f = fixture(run);
    const result = f.run();
    const rejected = expect(result).rejects.toMatchObject({
      reason: "cancelled"
    });
    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      f.owner.shutdown();
      pending.resolve({
        code: 0,
        stdout: JSON.stringify({ object: { sha: "a".repeat(40) } }),
        stderr: ""
      });
      await rejected;
      expect(run).toHaveBeenCalledOnce();
      expect(f.execution.state.deployStatus).toBe("in_progress");
      expect(f.invalidateDeployListCache).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });
});
