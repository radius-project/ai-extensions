import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import type { CanvasState } from "../shared.js";
import { radArtifactsDirForSelection } from "../remote-rad-artifacts.js";
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
  provider = "aws",
  state: CanvasState = {},
  appFile = "apps/custom.bicep"
) {
  const owner = ports.owner ?? createProductionDeploymentExecutionOwner();
  const executor = successfulSelectedGhExecutor({ login: "fixture-user", run });
  const target = {
    repo: "fixture/app",
    environment: "dev",
    branch: "feature/model",
    provider,
    appFile,
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
      plannedRepo: target.repo,
      plannedBranch: target.branch,
      plannedEnvironment: target.environment,
      plannedProvider: target.provider,
      deployingResources:
        recoverGraph ? [] : [{ id: "app", name: "app", type: "application" }],
      deployParams: { appFile: target.appFile },
      deployStatus: "in_progress",
      ...state
    }
  });
  if (begun.kind !== "resolved") throw new Error(begun.kind);
  const execution = owner.execution(begun.invocation);
  if (!execution) throw new Error("Missing execution");
  if (!recoverGraph)
    execution.state.deployingResources = [
      { id: "app", name: "app", type: "application" }
    ];
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
    target,
    reservation,
    execution,
    runAz,
    invalidateDeployListCache,
    log,
    run: (overrides: Partial<Parameters<typeof monitor.run>[0]> = {}) =>
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
          !execution.observation.stopped,
        ...overrides
      }),
    dispose: () => {
      owner.shutdown();
      owner.release(reservation);
    }
  };
}

describe("server-independent production deployment monitor", () => {
  it("rejects a retired execution before any source read", async () => {
    const run = vi.fn<SelectedGhExecutor["run"]>(async () => {
      throw new Error("Unexpected read");
    });
    const f = fixture(run, true);
    try {
      f.owner.shutdown();
      await expect(f.run()).rejects.toMatchObject({ reason: "cancelled" });
      expect(run).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("rejects an invalid admitted file even when a graph was already supplied", async () => {
    const run = vi.fn<SelectedGhExecutor["run"]>(async () => {
      throw new Error("Unexpected read");
    });
    const f = fixture(run, false, {}, "aws", {}, "../outside.bicep");
    try {
      await expect(f.run()).rejects.toThrow("repository-relative");
      expect(run).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it.each([
    "custom-and-default",
    "custom-only",
    "root-only",
    "default-first"
  ] as const)(
    "graphs and dispatches the same admitted committed source in a %s repository",
    async (layout) => {
      vi.useFakeTimers();
      const pipeline = createDeploymentPipelineRunner("success");
      const custom =
        "@secure()\nparam password string\nparam environment string\nresource app 'Radius.Core/applications@2025-08-01' = { name: 'custom' }";
      const modelPath =
        layout === "root-only" ? "app.bicep"
        : layout === "default-first" ? ".radius/app.bicep"
        : "apps/custom.bicep";
      const run = vi.fn<SelectedGhExecutor["run"]>(async (args, options) => {
        if (
          args[0] === "api" &&
          args[1].includes("/contents/") &&
          args[1].includes(".bicep?")
        )
          return (
            args[1].includes(`/contents/${modelPath}?`) ?
              {
                code: 0,
                stdout: JSON.stringify({
                  type: "file",
                  encoding: "base64",
                  content: Buffer.from(custom).toString("base64")
                }),
                stderr: ""
              }
            : layout === "custom-and-default" ?
              {
                code: 0,
                stdout: JSON.stringify({
                  type: "file",
                  encoding: "base64",
                  content: Buffer.from("wrong default model").toString("base64")
                }),
                stderr: ""
              }
            : { code: 1, stdout: "", stderr: "HTTP 404: Not Found" }
          );
        if (args[0] === "api" && args[1].includes("bicepconfig.json"))
          return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
        return pipeline.run(args, options);
      });
      const buildGraph = vi.fn(async () => [
        { id: "custom", name: "custom", type: "Radius.Core/applications" }
      ]);
      const state: CanvasState = {
        envName: "staging",
        appFile: "wrong.bicep",
        deployParams: { environment: "staging", appFile: "wrong.bicep" },
        workspaceRepo: "fixture/app",
        workspaceBranch: "feature/model",
        workspacePath: "/synthetic/matching-workspace",
        plannedResources: [{ id: "wrong" }],
        deployingResources: [{ id: "wrong" }]
      };
      const f = fixture(
        run,
        true,
        { buildGraph },
        "aws",
        state,
        layout === "root-only" ? ".radius/app.bicep" : modelPath
      );
      try {
        state.envName = "retargeted";
        const result = f.run();
        await vi.runAllTimersAsync();
        await result;
        expect(buildGraph).toHaveBeenCalledExactlyOnceWith(
          custom,
          modelPath,
          expect.objectContaining({
            radArtifactsDir: "",
            cleanupRadArtifactsDir: false
          })
        );
        expect(f.execution.state.deployStatus).toBe("complete");
        expect(f.execution.state.deployEnvName).toBe("dev");
        expect(f.execution.state.deployParams?.appFile).toBe(modelPath);
        expect(f.execution.state.deployingResources?.[0].id).toBe("custom");
        const commands = run.mock.calls.map(([args]) => args);
        const dispatch = commands.find((args) => args[0] === "workflow");
        expect(dispatch).toEqual(
          expect.arrayContaining([
            "--repo",
            "fixture/app",
            "--ref",
            "feature/model"
          ])
        );
        expect(dispatch?.join(" ")).toContain(modelPath);
        expect(dispatch?.join(" ")).toContain("dev");
        expect(
          commands.find((args) => args[0] === "secret")?.join(" ")
        ).toContain("dev");
        expect(
          commands.some((args) => args.join(" ").includes("staging"))
        ).toBe(false);
        expect(state.deployParams?.appFile).toBe("wrong.bicep");
        expect(
          commands.filter((args) =>
            args[1]?.includes(`/contents/${modelPath}?`)
          )
        ).toHaveLength(1);
        expect(pipeline.unexpected).toEqual([]);
      } finally {
        f.dispose();
      }
    }
  );

  it("refuses a missing custom application without falling back to an existing default", async () => {
    const pipeline = createDeploymentPipelineRunner("success");
    const run = vi.fn<SelectedGhExecutor["run"]>(async (args, options) =>
      args[1]?.includes("/contents/apps/custom.bicep?") ?
        { code: 1, stdout: "", stderr: "HTTP 404: Not Found" }
      : pipeline.run(args, options)
    );
    const buildGraph = vi.fn(async () => []);
    const f = fixture(run, true, { buildGraph });
    try {
      await f.run();
      expect(f.execution.state.deployErrorKind).toBe("dispatch-refused");
      expect(f.execution.state.deployError).toContain("apps/custom.bicep");
      expect(buildGraph).not.toHaveBeenCalled();
      expect(
        run.mock.calls
          .filter(([args]) => args[1]?.includes(".bicep?"))
          .map(([args]) => args[1])
      ).toEqual([
        "/repos/fixture/app/contents/apps/custom.bicep?ref=feature%2Fmodel"
      ]);
      expect(
        run.mock.calls.some(
          ([args]) => args[0] === "workflow" || args[0] === "secret"
        )
      ).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("uses the resolved root default even when graph recovery was already completed", async () => {
    vi.useFakeTimers();
    const pipeline = createDeploymentPipelineRunner("success");
    const run = vi.fn<SelectedGhExecutor["run"]>(async (args, options) =>
      args[1]?.includes("/contents/.radius/app.bicep?") ?
        { code: 1, stdout: "", stderr: "HTTP 404: Not Found" }
      : pipeline.run(args, options)
    );
    const f = fixture(run, false, {}, "aws", {}, ".radius/app.bicep");
    try {
      const work = f.run();
      await vi.runAllTimersAsync();
      await work;
      expect(f.execution.state.deployStatus).toBe("complete");
      expect(
        run.mock.calls
          .filter(([args]) => args[1]?.includes(".bicep?"))
          .map(([args]) => args[1])
      ).toEqual([
        "/repos/fixture/app/contents/.radius/app.bicep?ref=feature%2Fmodel",
        "/repos/fixture/app/contents/app.bicep?ref=feature%2Fmodel"
      ]);
      expect(
        run.mock.calls.find(([args]) => args[0] === "workflow")?.[0].join(" ")
      ).toContain("app.bicep");
    } finally {
      f.dispose();
    }
  });

  it.each(["shutdown", "replacement"] as const)(
    "does not compile or publish after %s during remote config staging",
    async (retirement) => {
      const held = createDeferred<{
        code: number;
        stdout: string;
        stderr: string;
      }>();
      const started = createDeferred<void>();
      const buildGraph = vi.fn(async () => []);
      const run = vi.fn<SelectedGhExecutor["run"]>(async (args) => {
        if (args[1].includes("apps/custom.bicep?"))
          return {
            code: 0,
            stdout: JSON.stringify({
              type: "file",
              encoding: "base64",
              content: Buffer.from("model").toString("base64")
            }),
            stderr: ""
          };
        if (args[1].includes("apps/bicepconfig.json?")) {
          started.resolve();
          return held.promise;
        }
        throw new Error("Unexpected follow-up " + args.join(" "));
      });
      const f = fixture(run, true, { buildGraph });
      const work = f.run();
      const rejected = expect(work).rejects.toMatchObject({
        reason: "cancelled"
      });
      try {
        await started.promise;
        if (retirement === "shutdown") f.owner.shutdown();
        else {
          f.owner.release(f.reservation);
          const reservation = f.owner.reserve(f.target, "deploy");
          if (!reservation) throw new Error("Missing replacement");
          f.owner.begin({
            reservation,
            target: f.target,
            executor: f.execution.executor,
            state: { deployLogs: ["replacement"] }
          });
        }
        held.resolve({ code: 1, stdout: "", stderr: "HTTP 404: Not Found" });
        await rejected;
        expect(run).toHaveBeenCalledTimes(2);
        expect(buildGraph).not.toHaveBeenCalled();
        expect(f.execution.state.deployingResources).toEqual([]);
        expect(f.invalidateDeployListCache).not.toHaveBeenCalled();
      } finally {
        f.dispose();
      }
    }
  );

  it.each(["shutdown", "replacement"] as const)(
    "cleans staged artifacts without compiling when %s wins the stage-return race",
    async (retirement) => {
      const staged = createDeferred<string>();
      const resume = createDeferred<void>();
      const buildGraph = vi.fn(async () => []);
      const run = vi.fn<SelectedGhExecutor["run"]>(async (args) => {
        const content =
          args[1].includes("custom.bicep?") ? "model"
          : args[1].includes("bicepconfig.json?") ?
            JSON.stringify({ extensions: {} })
          : null;
        if (content === null)
          throw new Error("Unexpected follow-up " + args.join(" "));
        return {
          code: 0,
          stdout: JSON.stringify({
            type: "file",
            encoding: "base64",
            content: Buffer.from(content).toString("base64")
          }),
          stderr: ""
        };
      });
      const f = fixture(run, true, {
        buildGraph,
        readRadArtifacts: async (input) => {
          const result = await ("github" in input ?
            radArtifactsDirForSelection(input)
          : radArtifactsDirForSelection(input));
          staged.resolve(result.dir);
          await resume.promise;
          return result;
        }
      });
      const work = f.run();
      const rejected = expect(work).rejects.toMatchObject({
        reason: "cancelled"
      });
      try {
        const directory = await staged.promise;
        expect(existsSync(directory)).toBe(true);
        if (retirement === "shutdown") f.owner.shutdown();
        else {
          f.owner.release(f.reservation);
          const reservation = f.owner.reserve(f.target, "deploy");
          if (!reservation) throw new Error("Missing replacement");
          const replacement = f.owner.begin({
            reservation,
            target: f.target,
            executor: f.execution.executor,
            state: { deployLogs: ["replacement"] }
          });
          if (replacement.kind !== "resolved")
            throw new Error(replacement.kind);
          expect(
            f.owner.execution(replacement.invocation)?.state.deployLogs
          ).toEqual(["replacement"]);
        }
        resume.resolve();
        await rejected;
        expect(existsSync(directory)).toBe(false);
        expect(buildGraph).not.toHaveBeenCalled();
        expect(run).toHaveBeenCalledTimes(2);
        expect(f.invalidateDeployListCache).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        f.dispose();
      }
    }
  );

  it.each([
    "repo",
    "branch",
    "provider",
    "requestedEnvironment",
    "entry"
  ] as const)(
    "rejects a conflicting independent %s before I/O",
    async (field) => {
      const run = vi.fn<SelectedGhExecutor["run"]>(async () => {
        throw new Error("Must not run");
      });
      const f = fixture(run);
      try {
        await expect(
          f.run(
            field === "entry" ? { entry: { state: {} } } : { [field]: "other" }
          )
        ).rejects.toThrow("admitted deployment");
        expect(run).not.toHaveBeenCalled();
      } finally {
        f.dispose();
      }
    }
  );

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
      if (args[1].includes("/contents/apps/custom.bicep?"))
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
      ).toHaveBeenCalledExactlyOnceWith(source, "apps/custom.bicep", {
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
                    {
                      id: "app",
                      name: "app",
                      type: "Radius.Core/applications"
                    }
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
      delete f.execution.state.deployingResources;
      await f.run();
      expect(run.mock.calls.map(([args]) => args[1])).toEqual([
        "/repos/fixture/app/contents/apps/custom.bicep?ref=feature%2Fmodel",
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
