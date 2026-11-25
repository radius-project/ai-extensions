import { createServer } from "node:http";
import { ChildProcess, execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createGraphSourceBindings,
  createWorkflowArtifactReader
} from "@radius-project/adapter-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashAppBicep } from "../../../src/app-bicep-hash.js";
import type { RadiusExtensionDependencies } from "../../../src/runtime/dependencies.js";
import {
  createWorkflowObservationScope,
  type WorkflowObservationScope
} from "../../../src/server/services/workflow-observation-scope.js";
import {
  APP_ORIGIN_REPO_PATH,
  deployStatusKeys,
  mergeDeployedGraphDisplayMetadata,
  mergeDeployedGraphMetadata,
  projectDeployedGraph,
  serializeAppOrigin
} from "@radius-project/core";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import {
  createGraphsPlanningRoutes,
  type DeployedGraphReaderOptions,
  type DeployedGraphStatusReader
} from "../../../src/server/routes/graphs-planning.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type {
  DeployProgress,
  WorkflowArtifact
} from "../../../src/deploy-artifacts.js";
import {
  applyDeployMessages,
  buildDeployMessageMap,
  buildDeployStatusMap,
  createDeployStatusReader,
  DEPLOY_MONITOR_TIMED_OUT_MESSAGE,
  DEPLOY_STATUS_FILES,
  settleDeployStatuses
} from "../../../src/deploy-artifacts.js";
import type { CanvasGraphResource, CanvasState } from "../../../src/shared.js";
import { GRAPH_APP_BICEP_IDLE_TIMEOUT_MS } from "../../../src/graph-progress-contract.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createDeferred } from "../../support/browser/fakes.js";
import { setAppBicepHandoff } from "../../../src/server.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";

function initCommittedGraphWorkspace(workspace: string) {
  execFileSync("git", ["init", "--initial-branch", "main"], {
    cwd: workspace,
    stdio: "pipe"
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Radius Fixture",
      "-c",
      "user.email=radius-fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--allow-empty",
      "--no-verify",
      "-m",
      "fixture"
    ],
    { cwd: workspace, stdio: "pipe" }
  );
}

async function concurrentGraphRuntime(
  workspace?: string,
  invalidOutputBuilds: ReadonlySet<number> = new Set(),
  afterWorkspaceBranchRead?: () => void
) {
  const builds: Array<ReturnType<typeof createDeferred<void>>> = [];
  const runtime = createTestCanvasServerRuntime({
    executionOwner: createEnvironmentExecutionOwner(),
    cliExec: (command, args, _options, callback) => {
      if (workspace && command === "git" && args.includes("symbolic-ref")) {
        afterWorkspaceBranchRead?.();
        callback(null, "main\n", "");
        return new ChildProcess();
      }
      const endpoint = args.find((arg) => arg.startsWith("/repos/"));
      let value: unknown;
      const commit = endpoint?.match(
        /^\/repos\/octo\/app\/commits\/(main|other|a{40}|b{40})$/
      )?.[1];
      if (commit) {
        value = {
          sha:
            commit === "main" ? "a".repeat(40)
            : commit === "other" ? "b".repeat(40)
            : commit
        };
      } else if (endpoint?.includes("/contents/.radius/app.bicep")) {
        const content = "resource fixture";
        value = {
          encoding: "base64",
          content: Buffer.from(content).toString("base64"),
          size: Buffer.byteLength(content)
        };
      } else if (endpoint?.includes("/contents/.radius/bicepconfig.json")) {
        callback(new Error("not found"), "", "Not Found (HTTP 404)");
        return new ChildProcess();
      } else {
        throw new Error(`Unscripted graph command: ${args.join(" ")}`);
      }
      callback(null, JSON.stringify(value), "");
      return new ChildProcess();
    },
    buildGraphViaRad: async (_content, _definition, options) => {
      const index = builds.length;
      const gate = createDeferred<void>();
      builds.push(gate);
      await gate.promise;
      if (workspace) {
        if (!options?.saveGraphJsonTo)
          throw new Error("Missing staged compiler output path");
        expect(options.saveGraphJsonTo).not.toBe(
          path.join(workspace, ".radius", "app-graph.json")
        );
        writeFileSync(
          options.saveGraphJsonTo,
          invalidOutputBuilds.has(index) ? '{"resources":[' : (
            JSON.stringify({
              application: { name: `application-${index}` },
              resources: [{ id: `build-${index}` }]
            })
          )
        );
      }
      return [
        {
          id: `build-${index}`,
          name: `build-${index}`,
          type: "Radius.Compute/containers"
        }
      ];
    }
  });
  const entry = await runtime.getOrCreateServer("graph-races", "graph");
  if (workspace)
    Object.assign(entry.state, {
      workspacePath: workspace,
      workspaceRepo: "octo/app",
      workspaceBranch: "main",
      contextRepo: "octo/app",
      contextBranch: "main"
    });
  return {
    entry,
    builds,
    load: (extra = {}) =>
      fetch(`${entry.baseUrl}/api/load-graph`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: entry.baseUrl,
          "Sec-Fetch-Site": "same-origin",
          "X-Radius-Mutation-Nonce": String(
            entry.state.browserMutationNonce || ""
          )
        },
        body: JSON.stringify({ repo: "octo/app", branch: "main", ...extra })
      }),
    stream: (branch = "main") =>
      fetch(
        `${entry.baseUrl}/api/load-graph-stream?repo=octo%2Fapp&branch=${branch}`
      ),
    async close() {
      builds.forEach((build) => build.resolve());
      await runtime.stopServer("graph-races", true);
    }
  };
}

describe("graph concurrency through production HTTP routes", () => {
  it.each(["JSON", "SSE"])(
    "keeps %s graph reload responsive and the registered refresh current while promotion prepares Git",
    async (transport) => {
      const workspace = mkdtempSync(path.resolve(".radius-refresh-http-"));
      const discoveryEntered = createDeferred<void>();
      const discovery = createDeferred<void>();
      let h: Awaited<ReturnType<typeof concurrentGraphRuntime>> | undefined;
      let sdk: Awaited<ReturnType<typeof createRuntimeSdkHarness>> | undefined;
      try {
        initCommittedGraphWorkspace(workspace);
        const model = "resource fixture\n";
        const appFile = path.join(workspace, ".radius", "app.bicep");
        const stage = path.join(
          workspace,
          ".radius",
          ".staging-managed-fixture"
        );
        mkdirSync(path.dirname(appFile));
        writeFileSync(appFile, model);
        type Promotion = ReturnType<
          RadiusExtensionDependencies["beginManagedModel"]
        >["promote"];
        const promote = vi.fn<Promotion>(
          async (prepareCommit, beforeCommit, options) => {
            discoveryEntered.resolve();
            await discovery.promise;
            await prepareCommit();
            beforeCommit();
            options?.onFilesystemCommitted?.({
              definitionHash: "fixture-definition",
              originHash: "fixture-origin"
            });
            return { published: ["app.bicep"], gitError: "" };
          }
        );
        sdk = await createRuntimeSdkHarness(
          {
            workspaceContext: {
              workspacePath: workspace,
              repo: "octo/app",
              branch: "main"
            },
            bicepByRepoBranch: { "workspace:octo/app@main": model },
            filesByRepoBranch: {
              [`workspace:octo/app@main:${APP_ORIGIN_REPO_PATH}`]:
                serializeAppOrigin({
                  generatedAt: "2026-08-11T05:32:32.000Z",
                  sourceCommit: "a".repeat(40),
                  skillVersion: "0.1.0-test",
                  radiusVersion: "0.60",
                  appBicepHash: hashAppBicep(model)
                })
            },
            headCommits: { [`workspace:${workspace}`]: "b".repeat(40) },
            sourceChangedSince: true
          },
          (deps) => {
            deps.appModel.workspaceSourceRevision = async () =>
              "workspace:saved";
            deps.radiusAppBicepSkill = () =>
              JSON.stringify({
                nodeCommand: path.resolve("fixture-node"),
                skillBase: path.resolve("fixture-skill")
              });
            const beginManaged = deps.beginManagedModel;
            deps.beginManagedModel = (worktree) => ({
              ...beginManaged(worktree),
              stagingDir: stage,
              validate: (check) => check(path.join(stage, "app.bicep")),
              promote
            });
          }
        );
        h = await concurrentGraphRuntime(workspace);
        h.entry.state.canvasInstanceId = "graph-races";
        sdk.servers.set("graph-races", h.entry);
        const handoff = sdk.capturedHostCallbacks.appBicepHandoff;
        const complete = sdk.extension.tools.find(
          ({ name }) => name === "radius_complete_app_authoring"
        );
        if (!handoff || !complete)
          throw new Error("Missing registered authoring");
        let settled = createDeferred<void>();
        setAppBicepHandoff(async (input) => {
          const current = settled;
          try {
            await handoff(input);
          } finally {
            current.resolve();
          }
        });
        const { builds, entry, load, stream } = h;
        const request = transport === "JSON" ? load : stream;

        const first = request();
        await settled.promise;
        await vi.waitFor(() => expect(builds).toHaveLength(1));
        builds[0].resolve();
        expect(await (await first).text()).toContain(
          transport === "JSON" ? "build-0" : '"reload":true'
        );
        const requestToken =
          entry.state.appModelAttemptTokens?.["octo/app::main"];
        expect(requestToken).toBeTruthy();
        const completionSettled = vi.fn();
        const completion = Promise.resolve(
          complete.handler({ requestToken, outcome: "complete" })
        ).finally(completionSettled);
        await Promise.race([
          discoveryEntered.promise,
          completion.then(() => {
            throw new Error("Completion settled before Git discovery");
          })
        ]);

        settled = createDeferred<void>();
        let reloadFinished = false;
        const reload = request()
          .then((response) => response.text())
          .finally(() => {
            reloadFinished = true;
          });
        await settled.promise;
        await vi.waitFor(() =>
          expect(builds.length > 1 || reloadFinished).toBe(true)
        );
        builds[1]?.resolve();
        expect(await reload).not.toContain('"stale":true');
        expect(completionSettled).not.toHaveBeenCalled();
        expect(sdk.session.send).toHaveBeenCalledOnce();
        discovery.resolve();
        await expect(completion).resolves.toMatchObject({
          kind: "promoted",
          published: ["app.bicep"]
        });
        expect(promote).toHaveBeenCalledOnce();
      } finally {
        discovery.resolve();
        setAppBicepHandoff(null);
        await sdk?.extension.shutdown("test");
        await h?.close();
        rmSync(workspace, { force: true, recursive: true });
      }
    }
  );

  it.each(["JSON", "SSE"] as const)(
    "reports stale instead of blank-model recovery after another request takes ownership (%s)",
    async (transport) => {
      const workspace = mkdtempSync(path.join(tmpdir(), "radius-blank-race-"));
      const supersede = vi.fn(() => {
        h.entry.state.graphBuildGeneration =
          (h.entry.state.graphBuildGeneration ?? 0) + 1;
      });
      const h = await concurrentGraphRuntime(workspace, new Set(), supersede);
      try {
        initCommittedGraphWorkspace(workspace);
        mkdirSync(path.join(workspace, ".radius"));
        writeFileSync(path.join(workspace, ".radius", "app.bicep"), "  \n");
        h.entry.state.appModelAttemptTokens = { "octo/app::main": "attempt" };
        h.entry.state.appModelFailures = {
          "octo/app::main": {
            attemptToken: "attempt",
            error: "Authoring failed."
          }
        };
        const response =
          transport === "JSON" ? await h.load() : await h.stream();
        if (transport === "JSON") {
          expect(response.status).toBe(409);
          expect(await response.json()).toEqual({ stale: true });
        } else {
          expect(response.status).toBe(200);
          const text = await response.text();
          expect(text.match(/event: done\ndata: .+/g)).toEqual([
            'event: done\ndata: {"stale":true}'
          ]);
        }
        expect(supersede).toHaveBeenCalled();
        expect(h.builds).toEqual([]);
      } finally {
        await h.close();
        rmSync(workspace, { force: true, recursive: true });
      }
    }
  );

  it.each(["JSON", "stream"])(
    "keeps the previous file and retains the %s save warning on reload and cache hits",
    async (transport) => {
      const workspace = mkdtempSync(
        path.join(tmpdir(), "radius-graph-save-http-")
      );
      let h: Awaited<ReturnType<typeof concurrentGraphRuntime>> | undefined;
      try {
        initCommittedGraphWorkspace(workspace);
        const directory = path.join(workspace, ".radius");
        mkdirSync(directory);
        writeFileSync(path.join(directory, "app.bicep"), "resource local");
        const destination = path.join(directory, "app-graph.json");
        writeFileSync(destination, '{"resources":[{"id":"previous"}]}');
        h = await concurrentGraphRuntime(workspace, new Set([0]));
        const { builds, entry } = h;
        const response = transport === "JSON" ? h.load() : h.stream();
        await vi.waitFor(() => expect(builds).toHaveLength(1));
        builds[0].resolve();
        const result = await response;
        const body = await result.text();
        expect(result.ok).toBe(true);
        expect(body).toContain('"saveWarning":');
        if (transport === "stream")
          expect(body.match(/event: done/g)).toHaveLength(1);
        expect(readFileSync(destination, "utf8")).toBe(
          '{"resources":[{"id":"previous"}]}'
        );
        expect(entry.state.graphResources?.[0]?.id).toBe("build-0");
        const page = () =>
          fetch(`${entry.baseUrl}/?page=graph`).then((res) => res.text());
        expect(await page()).toContain("saved app-graph.json may be stale");
        expect(await (await h.load({ refresh: true })).json()).toMatchObject({
          cached: true,
          saveWarning: expect.stringContaining("may be stale")
        });
        const replacement = h.load();
        await vi.waitFor(() => expect(builds).toHaveLength(2));
        builds[1].resolve();
        expect(await (await replacement).json()).not.toHaveProperty(
          "saveWarning"
        );
        expect(await page()).not.toContain("saved app-graph.json may be stale");
        expect(JSON.parse(readFileSync(destination, "utf8")).resources).toEqual(
          [{ id: "build-1" }]
        );
      } finally {
        await h?.close();
        rmSync(workspace, { force: true, recursive: true });
      }
    }
  );

  it.each(["success", "failure"])(
    "keeps newer persisted and in-memory graph when an older JSON build finishes with %s",
    async (result) => {
      const workspace = mkdtempSync(path.join(tmpdir(), "radius-graph-http-"));
      let h: Awaited<ReturnType<typeof concurrentGraphRuntime>> | undefined;
      try {
        initCommittedGraphWorkspace(workspace);
        const directory = path.join(workspace, ".radius");
        mkdirSync(directory);
        writeFileSync(path.join(directory, "app.bicep"), "resource local");
        const destination = path.join(directory, "app-graph.json");
        writeFileSync(destination, "previous output");
        h = await concurrentGraphRuntime(workspace);
        const { builds } = h;
        const old = h.load();
        await vi.waitFor(() => expect(builds).toHaveLength(1));
        expect(readFileSync(destination, "utf8")).toBe("previous output");
        const current = await h.stream();
        await vi.waitFor(() => expect(builds).toHaveLength(2));
        builds[1].resolve();
        expect(await current.text()).toContain('"reload":true');
        if (result === "failure")
          builds[0].reject(new Error("old compiler failed"));
        else builds[0].resolve();
        expect((await old).status).toBe(409);
        expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual({
          application: { name: "application-1" },
          resources: [{ id: "build-1" }]
        });
        expect(h.entry.state.graphResources?.map(({ id }) => id)).toEqual([
          "build-1"
        ]);
      } finally {
        await h?.close();
        rmSync(workspace, { force: true, recursive: true });
      }
    }
  );

  it.each([
    ["JSON", "success"],
    ["JSON", "failure"],
    ["stream", "success"],
    ["stream", "failure"]
  ])(
    "preserves checkout output when an old %s build finishes with %s",
    async (transport, outcome) => {
      const workspace = mkdtempSync(path.join(tmpdir(), "radius-graph-http-"));
      let h: Awaited<ReturnType<typeof concurrentGraphRuntime>> | undefined;
      try {
        initCommittedGraphWorkspace(workspace);
        const directory = path.join(workspace, ".radius");
        mkdirSync(directory);
        writeFileSync(path.join(directory, "app.bicep"), "resource local");
        const destination = path.join(directory, "app-graph.json");
        h = await concurrentGraphRuntime(workspace);
        const response = transport === "JSON" ? h.load() : h.stream();
        const { builds } = h;
        await vi.waitFor(() => expect(builds).toHaveLength(1));
        execFileSync("git", ["switch", "-c", "other"], {
          cwd: workspace,
          stdio: "pipe"
        });
        writeFileSync(destination, "other branch graph");
        if (outcome === "success") builds[0].resolve();
        else builds[0].reject(new Error("Old compiler failed"));
        const result = await response;
        if (transport === "JSON") expect(result.status).toBe(409);
        else expect(await result.text()).toContain('"stale":true');
        expect(readFileSync(destination, "utf8")).toBe("other branch graph");
        expect(h.entry.state.graphResources).toBeUndefined();
      } finally {
        await h?.close();
        rmSync(workspace, { force: true, recursive: true });
      }
    }
  );

  it.each([false, true])(
    "uses strict workspace source reads in the runtime handoff (blank model appears: %s)",
    async (blankAppears) => {
      const workspace = mkdtempSync(
        path.join(tmpdir(), "radius-handoff-http-")
      );
      const execute = vi.fn<
        Parameters<typeof createGraphSourceBindings>[0]["execute"]
      >((command, args, options, callback) => {
        if (command !== "git")
          throw new Error(`Unexpected remote handoff read: ${args.join(" ")}`);
        return execFile(command, args, options, callback);
      });
      const sources = createGraphSourceBindings({
        execute,
        redactDiagnostic: (message) => message,
        stagingRoot: workspace
      });
      const sdk = await createRuntimeSdkHarness(
        {
          workspaceTreeByRepoBranch: { "octo/app@main": ["Dockerfile"] },
          workspaceContext: {
            workspacePath: workspace,
            repo: "octo/app",
            branch: "main"
          }
        },
        (deps) => {
          deps.graphSources = sources;
          deps.appModel.workspaceSourceRevision = async () => "fixture-source";
        }
      );
      let h: Awaited<ReturnType<typeof concurrentGraphRuntime>> | undefined;
      try {
        initCommittedGraphWorkspace(workspace);
        writeFileSync(path.join(workspace, "Dockerfile"), "FROM scratch");
        const handoff = sdk.capturedHostCallbacks.appBicepHandoff;
        if (!handoff)
          throw new Error("Runtime registered no authoring callback");
        if (blankAppears) {
          sdk.deps.clock.wait = async () => {
            writeFileSync(path.join(workspace, "app.bicep"), "  \n");
          };
        }
        let completed = createDeferred<void>();
        setAppBicepHandoff(async (input) => {
          try {
            await handoff(input);
          } finally {
            completed.resolve();
          }
        });
        h = await concurrentGraphRuntime(workspace);
        h.entry.state.canvasInstanceId = "graph-races";
        sdk.servers.set("graph-races", h.entry);
        expect(await (await h.load()).json()).toMatchObject({
          needsAppBicep: true
        });
        await completed.promise;
        if (blankAppears) {
          expect(sdk.session.send).not.toHaveBeenCalled();
          expect(await (await h.load()).json()).toMatchObject({
            error: expect.stringContaining("app.bicep is empty")
          });
          const tool = sdk.extension.tools.find(
            ({ name }) => name === "radius_report_modeling_failure"
          );
          if (!tool) throw new Error("Missing registered failure tool");
          const target = "octo/app::main";
          // Simulate the admitted run whose blank output is still on disk.
          h.entry.state.appModelAttemptTokens = { [target]: "blank-attempt" };
          sdk.servers.set("graph-races", h.entry);
          const failure = "The fixture model has no supported resource.";
          expect(
            await tool.handler({
              instanceId: "graph-races",
              repo: "octo/app",
              branch: "main",
              attemptToken: "blank-attempt",
              error: failure
            })
          ).toEqual({ recorded: true });
          expect(await (await h.load()).json()).toMatchObject({
            error: `Model generation failed and left app.bicep empty. Fix or remove the file, then select Refresh. Diagnostic: ${failure}`,
            appModelAuthoringFailed: true,
            modelingFailed: true
          });
          expect(await (await h.stream()).text()).toContain(
            '"appModelAuthoringFailed":true'
          );
          expect(
            await (await h.load({ retryModeling: true })).json()
          ).toMatchObject({ appModelAuthoringFailed: true });
          expect(sdk.session.send).not.toHaveBeenCalled();

          // A blank saved file is not absence: retry only once the user
          // removes it, rather than silently authoring over it.
          rmSync(path.join(workspace, "app.bicep"));
          sdk.deps.clock.wait = async () => {};
          completed = createDeferred<void>();
          expect(
            await (await h.load({ retryModeling: true })).json()
          ).toMatchObject({ needsAppBicep: true });
          await completed.promise;
          expect(sdk.session.send).toHaveBeenCalledOnce();
          sdk.servers.delete("graph-races");
        } else {
          expect(sdk.session.send).toHaveBeenCalledOnce();
        }
        expect(execute).not.toHaveBeenCalledWith(
          "gh",
          expect.anything(),
          expect.anything(),
          expect.anything()
        );
      } finally {
        setAppBicepHandoff(null);
        await h?.close();
        await sdk.extension.shutdown("test");
        rmSync(workspace, { force: true, recursive: true });
      }
    }
  );

  it("reports a rejected modeling handoff to the next poll and respects explicit retry", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "radius-handoff-http-"));
    let h: Awaited<ReturnType<typeof concurrentGraphRuntime>> | undefined;
    const rejection = createDeferred<void>();
    const handoff = vi.fn(() => rejection.promise);
    setAppBicepHandoff(handoff);
    try {
      initCommittedGraphWorkspace(workspace);
      writeFileSync(path.join(workspace, "Dockerfile"), "FROM scratch");
      h = await concurrentGraphRuntime(workspace);
      expect(await (await h.load()).json()).toMatchObject({
        needsAppBicep: true
      });
      expect(await (await h.load()).json()).toMatchObject({
        needsAppBicep: true
      });
      rejection.reject(new Error("Application model origin is unreadable."));
      const { entry, load } = h;
      await vi.waitFor(() =>
        expect(
          entry.state.graphProgressRecords?.graph?.graphProgressHandoffFailure
        ).toBe("Application model origin is unreadable.")
      );
      const dispatched = handoff.mock.calls.length;
      const terminal = await (await load()).json();
      expect(terminal).toMatchObject({
        error: "Application model origin is unreadable."
      });
      expect(terminal.needsAppBicep).toBeUndefined();
      expect(handoff).toHaveBeenCalledTimes(dispatched);
      expect(
        await (await fetch(`${entry.baseUrl}/api/progress?view=graph`)).json()
      ).toMatchObject({ active: false });
      setAppBicepHandoff(async () => {});
      expect(await (await load({ retryModeling: true })).json()).toMatchObject({
        needsAppBicep: true
      });
    } finally {
      setAppBicepHandoff(null);
      await h?.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("keeps the newer same-selection stream when the older compiler finishes last", async () => {
    const h = await concurrentGraphRuntime();
    try {
      const older = await h.stream();
      await vi.waitFor(() => expect(h.builds).toHaveLength(1));
      const newer = await h.stream();
      await vi.waitFor(() => expect(h.builds).toHaveLength(2));
      h.builds[1].resolve();
      expect(await newer.text()).toContain('"reload":true');
      h.builds[0].resolve();
      const stale = await older.text();
      expect(stale).toContain('"stale":true');
      expect(stale.match(/event: done/g)).toHaveLength(1);
      expect(h.entry.state.graphResources?.map(({ id }) => id)).toEqual([
        "build-1"
      ]);
    } finally {
      await h.close();
    }
  });

  it.each([false, true])(
    "settles cancelled JSON progress without ending a replacement owner (%s)",
    async (replaceOwner) => {
      const h = await concurrentGraphRuntime();
      try {
        const older = h.load();
        await vi.waitFor(() => expect(h.builds).toHaveLength(1));
        if (replaceOwner) {
          const replacement = h.load();
          await vi.waitFor(() => expect(h.builds).toHaveLength(2));
          h.builds[0].resolve();
          expect((await older).status).toBe(409);
          const progress = await fetch(
            `${h.entry.baseUrl}/api/progress?view=graph`
          );
          expect(await progress.json()).toMatchObject({ active: true });
          h.builds[1].resolve();
          expect((await replacement).status).toBe(200);
        } else {
          const stream = await h.stream("other");
          await vi.waitFor(() => expect(h.builds).toHaveLength(2));
          h.builds[1].resolve();
          await stream.text();
          h.builds[0].resolve();
          const stale = await older;
          expect(stale.status).toBe(409);
          expect(await stale.json()).toEqual({ stale: true });
          const progress = await fetch(
            `${h.entry.baseUrl}/api/progress?view=graph`
          );
          expect(await progress.json()).toMatchObject({ active: false });
        }
      } finally {
        await h.close();
      }
    }
  );
});

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

interface ReaderScript {
  graph?: {
    graph: unknown | null;
    status: string;
    artifact?: WorkflowArtifact | null;
  };
  progress?: DeployProgress | null;
  graphThrows?: Error;
}

interface Harness {
  state: CanvasState;
  reader: ReaderScript;
  readerOptions: DeployedGraphReaderOptions[];
  modeledLoads: Array<{ repo: string; branch: string }>;
  modeledOutcome: { status: number; error?: string; retry?: boolean };
  modeledResources: CanvasGraphResource[];
  setEntryMissing(missing: boolean): void;
  setModelingActivity(atMs: number | null): void;
  advanceClock(ms: number): void;
}

// Real helpers wherever the projection is pure, so the wire payload is the one
// production produces rather than a fixture the fakes invented. Only the
// artifact reader is scripted: it is the sole seam that would otherwise reach
// the network.
function start(
  actualReader?: DeployedGraphStatusReader,
  observation?: WorkflowObservationScope
): Harness {
  const state: CanvasState = {};
  const reader: ReaderScript = {};
  const readerOptions: DeployedGraphReaderOptions[] = [];
  const modeledLoads: Array<{ repo: string; branch: string }> = [];
  const modeledOutcome: { status: number; error?: string; retry?: boolean } = {
    status: 200
  };
  const modeledResources: CanvasGraphResource[] = [];
  let entryMissing = false;
  let modelingActivityAtMs: number | null = null;
  let nowMs = 0;

  const routes = createTestRouteTable(
    createGraphsPlanningRoutes({
      readInstanceEntry: () =>
        entryMissing ? undefined : { state, observation },
      createDeployStatusReader: (options) => {
        readerOptions.push(options);
        if (actualReader) return actualReader;
        return {
          read: () =>
            Promise.resolve({
              status: reader.graph?.status ?? "missing",
              progress: reader.progress ?? null
            }),
          graph: () => {
            if (reader.graphThrows) return Promise.reject(reader.graphThrows);
            return Promise.resolve({
              graph: null,
              status: "missing",
              artifact: null,
              ...reader.graph
            });
          },
          progress: () => Promise.resolve(reader.progress ?? null)
        };
      },
      loadModeledGraph: (_instanceId, repo, branch) => {
        modeledLoads.push({ repo, branch });
        state.graphTargetRepo = repo;
        state.graphBranch = branch;
        state.graphResources = structuredClone(modeledResources);
        return Promise.resolve({ ...modeledOutcome });
      },
      buildDeployStatusMap,
      buildDeployMessageMap,
      deployStatusKeys,
      mergeDeployedGraphDisplayMetadata,
      mergeDeployedGraphMetadata,
      projectDeployedGraph,
      canvasGraphResources: (values) => values as CanvasGraphResource[],
      applyDeployMessages,
      settleDeployStatuses,
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error),
      repoMatchesWorkspace: (current, repo) =>
        !!current.workspaceRepo && current.workspaceRepo === repo,
      observeModelingRun: () => Promise.resolve(modelingActivityAtMs),
      now: () => nowMs
    })
  );

  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        handleUnmatchedRequest: (_request, response) => {
          response.writeHead(404);
          response.end("unmatched");
        }
      }),
    createState: () => ({}),
    defaultPage: "graph",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });

  return {
    state,
    reader,
    readerOptions,
    modeledLoads,
    modeledOutcome,
    modeledResources,
    setEntryMissing(missing) {
      entryMissing = missing;
    },
    setModelingActivity(atMs) {
      modelingActivityAtMs = atMs;
    },
    advanceClock(ms) {
      nowMs += ms;
    }
  };
}

describe("graphs-planning reads real-loopback HIT (RF-05)", () => {
  it("fences a reader that fulfills after its owning scope stops", async () => {
    const scope = createWorkflowObservationScope(() => {
      throw new Error("Unexpected reader factory");
    });
    const h = start(
      {
        graph: async () => {
          scope.stop();
          return { graph: [{ name: "late" }], status: "ok", artifact: null };
        },
        progress: async () => {
          throw new Error("Stopped graph must not read progress");
        },
        read: async () => {
          throw new Error("Stopped graph must not read inventory");
        }
      },
      scope
    );
    if (!container) throw new Error("Server not initialized");
    const entry = await container.getOrCreate("late-graph");
    const response = await fetch(
      entry.baseUrl + "/api/deployed-graph?repo=octo/app"
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Workflow observation stopped."
    });
    expect(h.state.deployedGraph).toBeUndefined();
  });
  it.each(["fulfills", "rejects"] as const)(
    "completes physical stop before the shared graph runner later %s",
    async (settlement) => {
      type Result = { code: number; stdout: string; stderr: string };
      let complete: (result: Result) => void = () => {
        throw new Error("Not initialized");
      };
      let reject: (error: Error) => void = () => {
        throw new Error("Not initialized");
      };
      const pending = new Promise<Result>((resolve, fail) => {
        complete = resolve;
        reject = fail;
      });
      const run = vi.fn(async () => pending);
      const scope = createWorkflowObservationScope((options) =>
        createWorkflowArtifactReader(options, run)
      );
      const reader = scope.reader({ repo: "octo/app", runId: 41 });
      const h = start(reader, scope);
      if (!container) throw new Error("Server not initialized");
      try {
        const entry = await container.getOrCreate("stopped-graph");
        const response = fetch(
          entry.baseUrl + "/api/deployed-graph?repo=octo/app"
        );
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
        scope.stop();
        const closing = container.stop("stopped-graph");
        const result = await response;
        expect(result.status).toBe(503);
        expect(await result.json()).toEqual({
          error: "Workflow observation stopped."
        });
        await closing;
        if (settlement === "fulfills")
          complete({
            code: 0,
            stdout: 'HTTP/2 200\n\n{"artifacts":[]}',
            stderr: ""
          });
        else reject(new Error("Late rejected read"));
        await pending.catch(() => {});
        expect(h.state.deployedGraph).toBeUndefined();
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        scope.stop();
        complete({ code: 0, stdout: "", stderr: "" });
      }
    }
  );

  it.each([
    "valid",
    "wrong-app",
    "wrong-run",
    "wrong-environment",
    "malformed",
    "graph-budget-exhausted",
    "auth"
  ] as const)(
    "projects only validated %s evidence through the real shared binding",
    async (mode) => {
      const directories: string[] = [];
      const reader = createWorkflowArtifactReader(
        {
          repo: "octo/app",
          runId: 42,
          environment: "prod",
          application: "billing"
        },
        async (args) => {
          if (args[0] === "api")
            return {
              code: 0,
              stderr: "",
              stdout:
                "HTTP/2 200\n\n" +
                JSON.stringify({
                  artifacts: [
                    {
                      id: 1,
                      name: "radius-deploy-status-prod-billing",
                      workflow_run: { id: 42 }
                    }
                  ]
                })
            };
          expect(args[1]).toBe("download");
          directories.push(args[6]);
          if (mode === "auth")
            return { code: 1, stdout: "", stderr: "HTTP 403" };
          writeFileSync(
            path.join(args[6], DEPLOY_STATUS_FILES.progress),
            JSON.stringify({
              schemaVersion: mode === "malformed" ? 2 : 1,
              application: mode === "wrong-app" ? "foreign" : "billing",
              environment: mode === "wrong-environment" ? "dev" : "prod",
              runId: mode === "wrong-run" ? 99 : 42,
              sequence: 1,
              resources: [
                {
                  name: "api",
                  type: "Radius.Compute/containers",
                  status: "failed"
                }
              ]
            })
          );
          if (mode === "graph-budget-exhausted")
            writeFileSync(
              path.join(args[6], DEPLOY_STATUS_FILES.graph),
              "[10:32:01]".repeat(64) +
                JSON.stringify({ resources: [{ name: "foreign" }] })
            );
          return { code: 0, stdout: "", stderr: "" };
        }
      );
      const harness = start(reader);
      harness.state.contextRepo = "octo/app";
      harness.state.deployRunId = 42;
      harness.state.deployStatus = "in_progress";
      harness.modeledResources.push({
        name: "api",
        type: "Radius.Compute/containers"
      });
      const entry = await container!.getOrCreate("artifact-panel");
      const response = await fetch(
        `${entry.baseUrl}/api/deployed-graph?application=billing&environment=prod`
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        resources: expect.arrayContaining([
          expect.objectContaining({
            name: "api",
            deployStatus:
              mode === "valid" || mode === "graph-budget-exhausted" ?
                "failed"
              : "pending"
          })
        ])
      });
      if (mode === "graph-budget-exhausted") {
        expect(body).toHaveProperty("resources.length", 1);
        expect(await reader.graph()).toMatchObject({ graph: null });
        expect((await reader.progress())?.resources).toHaveLength(1);
      }
      expect(directories).toHaveLength(1);
      expect(directories.every((directory) => !existsSync(directory))).toBe(
        true
      );
      expect(harness.state.deployStatus).toBe("in_progress");
    }
  );
  it.each([
    ["cancelled", "", undefined, "Deployment cancelled"],
    ["timed_out", "", undefined, "Deployment timed out"],
    [
      "failure",
      "Error: recipe quota exceeded",
      undefined,
      "Error: recipe quota exceeded"
    ],
    [
      "monitor_timed_out",
      "",
      "run-unconfirmed",
      DEPLOY_MONITOR_TIMED_OUT_MESSAGE
    ],
    [
      "failure",
      "Quota exceeded.\n".repeat(300),
      undefined,
      "Quota exceeded.\n".repeat(300).slice(0, 497) + "..."
    ]
  ] as const)(
    "retains the settled %s message through HTTP with error kind %s",
    async (conclusion, detail, errorKind, expected) => {
      const harness = start();
      harness.state.contextRepo = "octo/app";
      harness.state.deployRunId = 7;
      harness.state.deployStatus = "failed";
      harness.state.deployErrorKind = errorKind;
      harness.state.deployingResources = [
        {
          id: "db",
          name: "db",
          deployStatus: "in_progress",
          deployMessage: "creating"
        },
        {
          id: "api",
          name: "api",
          deployStatus: "success",
          deployMessage: "creating"
        },
        {
          id: "cache",
          name: "cache",
          deployStatus: "failed",
          deployMessage: "cache quota exceeded"
        }
      ];
      settleDeployStatuses(
        harness.state.deployingResources,
        conclusion,
        detail
      );
      harness.modeledResources.push(
        ...["db", "api", "cache"].map((id) => ({ id, name: id }))
      );
      const entry = await container!.getOrCreate("panel-a");

      const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);
      const payload = (await response.json()) as {
        mode: string;
        resources: CanvasGraphResource[];
      };

      expect(response.status).toBe(200);
      expect(payload.mode).toBe("terminal");
      expect(
        payload.resources.map((resource) => [
          resource.deployStatus,
          resource.deployMessage
        ])
      ).toEqual([
        ["failed", expected],
        ["success", undefined],
        ["failed", "cache quota exceeded"]
      ]);
      expect(harness.state.deployErrorKind).toBe(errorKind);
    }
  );

  it("does not revive timed-out nodes from the last in-progress artifact", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.state.deployRunId = 7;
    harness.state.deployStatus = "failed";
    harness.state.deployErrorKind = "run-unconfirmed";
    harness.state.deployingResources = [
      { id: "db", name: "db", deployStatus: "in_progress" },
      { id: "api", name: "api", deployStatus: "success" }
    ];
    settleDeployStatuses(harness.state.deployingResources, "monitor_timed_out");
    harness.modeledResources.push(
      { id: "db", name: "db" },
      { id: "api", name: "api" }
    );
    harness.reader.progress = {
      schemaVersion: 1,
      application: "test-app",
      environment: "default",
      sequence: 1,
      runId: 7,
      state: "in_progress",
      resources: ["db", "api"].map((id) => ({
        id,
        name: id,
        type: "Radius.Compute/containers",
        status: "in_progress",
        message: "creating"
      }))
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);
    const payload = (await response.json()) as {
      mode: string;
      resources: CanvasGraphResource[];
    };

    expect(payload.mode).toBe("terminal");
    expect(
      payload.resources.map((resource) => [
        resource.deployStatus,
        resource.deployMessage
      ])
    ).toEqual([
      ["failed", DEPLOY_MONITOR_TIMED_OUT_MESSAGE],
      ["success", undefined]
    ]);
    expect(harness.state.deployErrorKind).toBe("run-unconfirmed");
  });

  it.each([
    [undefined, "Monitoring stopped"],
    [6, "Monitoring stopped"],
    [7, "Final Radius error"]
  ] as const)(
    "uses artifact workflow identity %s when a terminal payload omits runId",
    async (artifactRunId, expectedMessage) => {
      const harness = start();
      Object.assign(harness.state, {
        contextRepo: "octo/app",
        deployRunId: 7,
        deployStatus: "failed",
        deployErrorKind: "run-unconfirmed",
        deployingResources: [
          {
            id: "db",
            name: "db",
            deployStatus: "failed",
            deployMessage: "Monitoring stopped"
          }
        ]
      });
      harness.modeledResources.push({ id: "db", name: "db" });
      harness.reader.graph = {
        graph: null,
        status: "ok",
        artifact: {
          id: 1,
          name: "radius-deploy-status",
          workflow_run:
            artifactRunId == null ? undefined : { id: artifactRunId }
        }
      };
      harness.reader.progress = {
        schemaVersion: 1,
        application: "test-app",
        environment: "default",
        sequence: 2,
        state: "failed",
        resources: [
          {
            id: "db",
            name: "db",
            type: "Radius.Data/sqlDatabases",
            status: "failed",
            message: "Final Radius error"
          }
        ]
      };
      const entry = await container!.getOrCreate("panel-a");

      const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        mode: "terminal",
        resources: [{ deployStatus: "failed", deployMessage: expectedMessage }]
      });
      expect(harness.state.deployErrorKind).toBe("run-unconfirmed");
    }
  );

  it.each(["failed", "succeeded"] as const)(
    "replaces the timeout presentation when the same run publishes a %s artifact",
    async (artifactState) => {
      const harness = start();
      harness.state.contextRepo = "octo/app";
      harness.state.deployRunId = 7;
      harness.state.deployStatus = "failed";
      harness.state.deployErrorKind = "run-unconfirmed";
      harness.state.deployingResources = [
        { id: "db", name: "db", deployStatus: "in_progress" },
        { id: "api", name: "api", deployStatus: "success" }
      ];
      settleDeployStatuses(
        harness.state.deployingResources,
        "monitor_timed_out"
      );
      harness.modeledResources.push(
        { id: "db", name: "db" },
        { id: "api", name: "api" }
      );
      const entry = await container!.getOrCreate("panel-a");
      const before = await fetch(`${entry.baseUrl}/api/deployed-graph`);
      expect(before.status).toBe(200);
      expect(await before.json()).toMatchObject({
        resources: [
          {
            deployStatus: "failed",
            deployMessage: DEPLOY_MONITOR_TIMED_OUT_MESSAGE
          },
          { deployStatus: "success" }
        ]
      });

      harness.reader.progress = {
        schemaVersion: 1,
        application: "test-app",
        environment: "default",
        sequence: 2,
        runId: 7,
        state: artifactState,
        resources: [
          {
            id: "db",
            name: "db",
            type: "Radius.Data/sqlDatabases",
            status: artifactState === "failed" ? "failed" : "success",
            message:
              artifactState === "failed" ? "Radius quota exceeded" : undefined
          },
          {
            id: "api",
            name: "api",
            type: "Radius.Compute/containers",
            status: "success"
          }
        ]
      };
      const after = await fetch(`${entry.baseUrl}/api/deployed-graph`);
      const payload = (await after.json()) as {
        mode: string;
        resources: CanvasGraphResource[];
      };

      expect(after.status).toBe(200);
      expect(payload.mode).toBe("terminal");
      expect(
        payload.resources.map((resource) => [
          resource.deployStatus,
          resource.deployMessage
        ])
      ).toEqual([
        artifactState === "failed" ?
          ["failed", "Radius quota exceeded"]
        : ["success", undefined],
        ["success", undefined]
      ]);
      expect(harness.state.deployErrorKind).toBe("run-unconfirmed");
    }
  );
  it("keeps revalidated inventory across reader TTLs but rejects regressions and failed refreshes", async () => {
    let clock = 0;
    let sequence = 2;
    let failure = false;
    const actualReader = createDeployStatusReader({
      repo: "octo/app",
      application: "billing",
      environment: "prod",
      now: () => clock,
      listArtifacts: async () => {
        if (failure) throw new Error("artifact service unavailable");
        return [
          {
            id: 1,
            name: "radius-deploy-status-prod-billing",
            workflow_run: { id: 42 }
          }
        ];
      },
      downloadArtifact: async () => ({
        [DEPLOY_STATUS_FILES.graph]: JSON.stringify({
          resources: [{ name: "modeled-only" }]
        }),
        [DEPLOY_STATUS_FILES.progress]: JSON.stringify({
          schemaVersion: 1,
          application: "billing",
          environment: "prod",
          runId: 42,
          sequence,
          state: "succeeded",
          resources: [{ name: "deployed-only", type: "Radius.Resources/redis" }]
        })
      })
    });
    const harness = start(actualReader);
    harness.state.contextRepo = "octo/app";
    harness.modeledResources.push({ name: "modeled-only" });
    const entry = await container!.getOrCreate("panel-a");
    const read = async (): Promise<unknown> => {
      const response = await fetch(
        `${entry.baseUrl}/api/deployed-graph?application=billing&environment=prod`
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    for (const time of [0, 10001, 20002]) {
      clock = time;
      expect(await read()).toMatchObject({
        deletionInventory: {
          application: "billing",
          environment: "prod",
          resources: [{ name: "deployed-only", type: "Radius.Resources/redis" }]
        }
      });
    }
    clock = 30003;
    sequence = 1;
    expect(await read()).toMatchObject({ deletionInventory: null });
    clock = 40004;
    failure = true;
    expect(await read()).toMatchObject({ deletionInventory: null });
  });

  it("withholds inventory when the artifact carried an unreadable resource entry", async () => {
    // The malformed entry is dropped during parsing, so the surviving list
    // looks complete by the time the route validates it. Only the parser's
    // discard marker can prevent undercounting a destructive action, which
    // makes this the boundary worth exercising through the real reader.
    const actualReader = createDeployStatusReader({
      repo: "octo/app",
      application: "billing",
      environment: "prod",
      now: () => 0,
      listArtifacts: async () => [
        {
          id: 1,
          name: "radius-deploy-status-prod-billing",
          workflow_run: { id: 42 }
        }
      ],
      downloadArtifact: async () => ({
        [DEPLOY_STATUS_FILES.graph]: JSON.stringify({
          resources: [{ name: "modeled-only" }]
        }),
        [DEPLOY_STATUS_FILES.progress]: JSON.stringify({
          schemaVersion: 1,
          application: "billing",
          environment: "prod",
          runId: 42,
          sequence: 1,
          state: "succeeded",
          resources: [
            { name: "deployed-only", type: "Radius.Resources/redis" },
            { type: "Radius.Resources/containers" }
          ]
        })
      })
    });
    const harness = start(actualReader);
    harness.state.contextRepo = "octo/app";
    harness.modeledResources.push({ name: "modeled-only" });
    const entry = await container!.getOrCreate("panel-a");
    const response = await fetch(
      `${entry.baseUrl}/api/deployed-graph?application=billing&environment=prod`
    );
    expect(response.status).toBe(200);
    // The graph itself still projects: only the inventory claim is withheld.
    expect(await response.json()).toMatchObject({
      deletionInventory: null,
      resources: [{ name: "modeled-only" }]
    });
  });

  it("adds a scoped resource-list inventory without changing modeled graph projection", async () => {
    const harness = start();
    Object.assign(harness.state, {
      contextRepo: "octo/app",
      contextBranch: "feature/current",
      deployAppName: "Billing",
      deployEnvName: "Prod",
      graphTargetRepo: "octo/app",
      graphBranch: "feature/current",
      graphResources: [
        { name: "never-created", type: "Radius.Resources/containers" }
      ]
    });
    harness.reader.graph = {
      status: "ok",
      graph: [
        { name: "published-model-only", type: "Radius.Resources/containers" }
      ]
    };
    harness.reader.progress = {
      schemaVersion: 1,
      application: "Billing",
      environment: "Prod",
      runId: 42,
      sequence: 1,
      state: "failed",
      updatedAt: "2026-09-09T00:00:00Z",
      resources: [
        {
          name: "removed-from-model",
          type: "Radius.Resources/redis",
          id: "actual-resource-id",
          message: "Internal-only detail"
        }
      ]
    };
    const entry = await container!.getOrCreate("panel-a");
    const response = await fetch(
      `${entry.baseUrl}/api/deployed-graph?application=billing&environment=PROD`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      repo: "octo/app",
      branch: "feature/current",
      mode: "terminal",
      application: "Billing",
      updatedAt: "2026-09-09T00:00:00Z",
      resources: [
        {
          name: "never-created",
          type: "Radius.Resources/containers",
          deployStatus: "failed",
          deployMessage: "Deployment failed",
          connections: [],
          outputResources: []
        }
      ],
      deletionInventory: {
        application: "Billing",
        environment: "Prod",
        resources: [
          { name: "removed-from-model", type: "Radius.Resources/redis" }
        ]
      }
    });

    const implicitSelection = await fetch(
      `${entry.baseUrl}/api/deployed-graph`
    );
    expect(await implicitSelection.json()).toMatchObject({
      mode: "terminal",
      application: "Billing",
      deletionInventory: null
    });

    // Retained progress may still paint a useful graph after authentication
    // fails, but cannot authorize the resource names shown before deletion.
    harness.reader.graph.status = "auth";
    const failedRead = await fetch(
      `${entry.baseUrl}/api/deployed-graph?application=billing&environment=PROD`
    );
    expect(failedRead.status).toBe(200);
    expect(await failedRead.json()).toMatchObject({
      mode: "terminal",
      deletionInventory: null,
      resources: [{ name: "never-created", deployStatus: "failed" }]
    });
  });

  it.each([
    "superseded",
    "repair",
    "discarded",
    "selection drift",
    "other environment",
    "switch away",
    "late failure"
  ] as const)(
    "keeps deployed graph evidence scoped to its selection during a held progress read: %s",
    async (scenario) => {
      let markReached = () => {};
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      let release = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const unrelated = scenario === "other environment";
      const switchAway = scenario === "switch away";
      const repair = scenario === "repair";
      const progress: DeployProgress = {
        schemaVersion: 1,
        application: "artifact-app",
        environment: "prod",
        runId: 42,
        sequence: 1,
        updatedAt: "2026-08-13T00:00:00.000Z",
        resources: [
          {
            id: "db",
            name: "db",
            type: "example/db",
            status: "failed",
            message: "old failure"
          }
        ]
      };
      const harness = start({
        graph: async () => ({
          status: "ok",
          graph: {
            resources: [
              {
                id: "db",
                outputResources: [{ id: "old-db", type: "example/db" }]
              }
            ]
          }
        }),
        progress: async () => {
          markReached();
          await hold;
          if (scenario === "late failure") throw new Error("old read error");
          return progress;
        },
        read: async () => ({ status: "ok", progress })
      });
      harness.modeledResources.push({
        id: "db",
        name: "db",
        type: "example/db"
      });
      Object.assign(harness.state, {
        deployStatus:
          repair ? "failed"
          : switchAway ? "complete"
          : "in_progress",
        deployRunId: repair ? null : 42,
        deployGeneration: 1,
        deployAppName: scenario === "selection drift" ? "" : "store",
        deployEnvName: unrelated ? "dev" : "prod",
        deployingResources: [{ id: "db", deployStatus: "failed" }]
      });
      const entry = await container!.getOrCreate("panel-a");
      const request = fetch(
        `${entry.baseUrl}/api/deployed-graph?repo=octo/app&application=store&environment=prod`
      );
      try {
        await Promise.race([
          reached,
          request.then(() => {
            throw new Error("The graph returned without reading progress");
          })
        ]);
        if (scenario === "selection drift")
          harness.state.deployAppName = "other";
        else if (scenario === "discarded") {
          harness.state.deployStatus = "";
          harness.state.deployRunId = null;
          harness.state.deployingResources = null;
        } else {
          harness.state.deployGeneration = 2;
          harness.state.deployRunId = 43;
          harness.state.deployStatus = "in_progress";
          if (switchAway) harness.state.deployEnvName = "dev";
          harness.state.deployingResources = [
            { id: "db", name: "db", deployStatus: "in_progress" }
          ];
          harness.state.progressMessages = ["current progress"];
        }
      } finally {
        release();
      }
      const response = await request;
      const payload = await response.json();
      expect(response.status).toBe(200);
      if (unrelated || switchAway) {
        expect(payload).toMatchObject({
          application: "artifact-app",
          updatedAt: progress.updatedAt,
          resources: [{ deployStatus: "failed", deployMessage: "old failure" }]
        });
        if (switchAway)
          expect(payload).toMatchObject({
            mode: "terminal",
            deletionInventory: null
          });
      } else {
        const active =
          scenario !== "discarded" && scenario !== "selection drift";
        expect(payload).toMatchObject({
          application: "store",
          mode: active ? "live" : "greyed",
          updatedAt: null,
          deletionInventory: null,
          resources: [
            { name: "db", deployStatus: active ? "in_progress" : "pending" }
          ]
        });
        expect(JSON.stringify(payload)).not.toMatch(/old-db|old failure/);
      }
      if (scenario === "late failure")
        expect(harness.state.progressMessages).toEqual(["current progress"]);
    }
  );

  it("does not publish display evidence or inventory if a different attempt owns the session when the inventory read completes", async () => {
    let markReached = () => {};
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const progress: DeployProgress = {
      schemaVersion: 1,
      application: "store",
      environment: "prod",
      runId: 42,
      sequence: 1,
      state: "succeeded",
      resources: [{ name: "db", type: "example/db" }]
    };
    const harness = start({
      graph: async () => ({ status: "ok", graph: null }),
      progress: async () => progress,
      read: async () => {
        markReached();
        await hold;
        return { status: "ok", progress };
      }
    });
    Object.assign(harness.state, {
      deployStatus: "complete",
      deployRunId: 42,
      deployAppName: "store",
      deployEnvName: "prod"
    });
    const entry = await container!.getOrCreate("panel-a");
    const request = fetch(
      `${entry.baseUrl}/api/deployed-graph?repo=octo/app&application=store&environment=prod`
    );
    try {
      await Promise.race([
        reached,
        request.then(() => {
          throw new Error("The graph returned without reading inventory");
        })
      ]);
      harness.state.deployRunId = 43;
    } finally {
      release();
    }

    const response = await request;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      application: "store",
      updatedAt: null,
      deletionInventory: null
    });
  });

  it("serves typed graph progress events over a real socket", async () => {
    const harness = start();
    harness.state.progressMessages = ["deployed diagnostic"];
    harness.state.graphProgressRecords = {
      graph: {
        graphProgressGeneration: 7,
        graphProgressActive: true,
        graphProgressView: "graph",
        graphProgressStartedAtMs: 1_000,
        graphProgressKey: "octo/app",
        graphProgressOwner: 1,
        graphProgressAwaitingModel: false,
        graphBuildEvents: [
          {
            sequence: 1,
            stage: "building_graph",
            state: "running",
            detail: "Building graph."
          }
        ]
      }
    };
    const entry = await container!.getOrCreate("panel-a");
    harness.advanceClock(5_000);
    const graphEvents =
      harness.state.graphProgressRecords.graph?.graphBuildEvents;
    expect(graphEvents).toBeDefined();

    const response = await fetch(`${entry.baseUrl}/api/progress`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      messages: ["deployed diagnostic"],
      generation: 7,
      events: graphEvents,
      active: true,
      view: "graph",
      // The server measures the build's age, so a client whose clock disagrees
      // still reports the time the build has actually been running.
      elapsedMs: 4_000
    });
  });

  it("observes a scoped modeling run before expiring progress", async () => {
    const harness = start();
    const staleActivityAtMs = 1_000;
    harness.advanceClock(staleActivityAtMs + GRAPH_APP_BICEP_IDLE_TIMEOUT_MS);
    harness.setModelingActivity(
      staleActivityAtMs + GRAPH_APP_BICEP_IDLE_TIMEOUT_MS - 1
    );
    harness.state.graphProgressRecords = {
      graph: {
        graphBuildEvents: [],
        graphProgressGeneration: 1,
        graphProgressStartedAtMs: 0,
        graphProgressActive: true,
        graphProgressView: "graph",
        graphProgressKey: "octo/app",
        graphProgressRepo: "octo/app",
        graphProgressBranches: ["main"],
        graphProgressOwner: 1,
        graphProgressAwaitingModel: true,
        graphProgressWaitStartedAtMs: 1
      }
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/progress?view=graph`);
    const payload = (await response.json()) as { active: boolean };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ active: true });
    expect(
      harness.state.graphProgressRecords.graph?.graphProgressAwaitingModel
    ).toBe(true);
    expect(
      harness.state.graphProgressRecords.graph?.graphProgressLastActivityAtMs
    ).toBe(staleActivityAtMs + GRAPH_APP_BICEP_IDLE_TIMEOUT_MS - 1);
  });

  it("greys out an unresolvable repo without constructing a reader", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(
      '{"resources":[],"repo":"","mode":"greyed","deletionInventory":null}'
    );
    expect(harness.readerOptions).toEqual([]);

    // Only GET is declared, so other methods still fall through.
    const posted = await fetch(`${entry.baseUrl}/api/deployed-graph`, {
      method: "POST"
    });
    expect(posted.status).toBe(404);
  });

  it("returns a modeled workflow failure without reading deployment artifacts", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.modeledOutcome.status = 400;
    harness.modeledOutcome.error = "Application model compilation failed.";
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error: "Application model compilation failed.",
      retry: false
    });
    expect(harness.readerOptions).toEqual([]);
  });

  it("paints modeled topology with artifact status over a real socket", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.state.workspaceRepo = "octo/app";
    harness.state.workspaceBranch = "feature/x";
    harness.state.deployEnvName = "prod";
    harness.state.deployAppName = "billing";
    harness.modeledResources.push({
      id: "res-a",
      name: "api",
      type: "Radius.Compute/containers"
    });
    harness.reader.graph = {
      graph: {
        resources: [
          {
            id: "res-a",
            name: "api",
            type: "Radius.Compute/containers",
            outputResources: [
              { id: "service", name: "api", type: "core/Service" },
              {
                id: "deployment",
                name: "api",
                type: "apps/Deployment"
              }
            ]
          }
        ]
      },
      status: "ok"
    };
    harness.reader.progress = {
      schemaVersion: 1,
      application: "billing-resolved",
      environment: "prod",
      sequence: 3,
      updatedAt: "2026-08-13T00:00:00.000Z",
      resources: [
        {
          id: "res-a",
          name: "api",
          type: "Radius.Compute/containers",
          status: "failed",
          message: "recipe failed"
        }
      ]
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resources: [
        {
          id: "res-a",
          name: "api",
          type: "Radius.Compute/containers",
          deployStatus: "failed",
          deployMessage: "recipe failed",
          connections: [],
          outputResources: [
            { id: "service", name: "api", type: "core/Service" },
            { id: "deployment", name: "api", type: "apps/Deployment" }
          ]
        }
      ],
      repo: "octo/app",
      branch: "feature/x",
      mode: "terminal",
      updatedAt: "2026-08-13T00:00:00.000Z",
      application: "billing-resolved",
      deletionInventory: null
    });
    // The selectors reach the reader as the page sent them.
    expect(harness.readerOptions).toEqual([
      {
        repo: "octo/app",
        environment: "prod",
        application: "billing",
        runId: null
      }
    ]);
    expect(harness.modeledLoads).toEqual([
      { repo: "octo/app", branch: "feature/x" }
    ]);
  });

  it("omits unknown deployed artifact fields from the real graph response", async () => {
    const harness = start();
    const sentinel = "fixture-private-field";
    harness.state.contextRepo = "octo/app";
    harness.modeledResources.push({
      id: "res-a",
      name: "api",
      type: "Radius.Compute/containers"
    });
    harness.reader.graph = {
      graph: {
        resources: [
          {
            id: "res-a",
            name: "api",
            type: "Radius.Compute/containers",
            properties: { privateField: sentinel },
            outputResources: [
              {
                id: "provider-output",
                type: "apps/Deployment",
                privateField: sentinel
              }
            ]
          }
        ]
      },
      status: "ok"
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(sentinel);
    expect(JSON.parse(body).resources[0].outputResources).toEqual([
      { id: "provider-output", type: "apps/Deployment" }
    ]);
  });

  it("preserves full modeled topology and settles a partial failed deploy", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/voting";
    harness.state.contextBranch = "feature/topology";
    harness.state.deployEnvName = "prod";
    harness.modeledResources.push(
      {
        id: "frontend",
        name: "frontend",
        type: "Radius.Compute/containers",
        connections: [{ id: "redis" }, { id: "frontend-image" }]
      },
      {
        id: "backend",
        name: "backend",
        type: "Radius.Compute/containers",
        connections: [{ id: "postgres" }, { id: "backend-image" }]
      },
      {
        id: "votes",
        name: "votes",
        type: "Radius.Compute/containers",
        connections: [{ id: "redis" }, { id: "votes-image" }]
      },
      {
        id: "redis",
        name: "redis",
        type: "Radius.Data/redisCaches"
      },
      {
        id: "postgres",
        name: "postgres",
        type: "Radius.Data/postgreSqlDatabases"
      },
      {
        id: "frontend-image",
        name: "frontend-image",
        type: "Radius.Compute/containerImages",
        connections: [{ id: "registry-secret" }]
      },
      {
        id: "backend-image",
        name: "backend-image",
        type: "Radius.Compute/containerImages",
        connections: [{ id: "registry-secret" }]
      },
      {
        id: "votes-image",
        name: "votes-image",
        type: "Radius.Compute/containerImages",
        connections: [{ id: "registry-secret" }]
      },
      {
        id: "registry-secret",
        name: "radius-ghcr-registry-creds",
        type: "Radius.Security/secrets",
        connections: [{ id: "frontend-image" }]
      }
    );
    harness.reader.graph = {
      graph: {
        resources: [
          {
            id: "frontend-image",
            name: "frontend-image",
            type: "Radius.Compute/containerImages",
            connections: []
          },
          {
            id: "backend-image",
            name: "backend-image",
            type: "Radius.Compute/containerImages",
            connections: []
          },
          {
            id: "votes-image",
            name: "votes-image",
            type: "Radius.Compute/containerImages",
            connections: []
          },
          {
            id: "redis",
            name: "redis",
            type: "Radius.Data/redisCaches",
            connections: []
          },
          {
            id: "registry-secret",
            name: "radius-ghcr-registry-creds",
            type: "Radius.Security/secrets",
            connections: []
          },
          {
            id: "postgres",
            name: "postgres",
            type: "Radius.Data/postgreSqlDatabases",
            connections: []
          }
        ]
      },
      status: "ok"
    };
    harness.reader.progress = {
      schemaVersion: 1,
      application: "voting",
      environment: "prod",
      sequence: 4,
      state: "failed",
      resources: [
        {
          id: "frontend",
          name: "frontend",
          type: "Radius.Compute/containers",
          status: "failed",
          message: "container deployment failed"
        },
        {
          id: "redis",
          name: "redis",
          type: "Radius.Data/redisCaches",
          status: "success"
        }
      ]
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);
    const payload = (await response.json()) as {
      resources: CanvasGraphResource[];
      mode: string;
      branch: string;
    };

    expect(payload.mode).toBe("terminal");
    expect(payload.branch).toBe("feature/topology");
    expect(
      payload.resources.map(({ name, deployStatus }) => ({
        name,
        deployStatus
      }))
    ).toEqual([
      { name: "frontend", deployStatus: "failed" },
      { name: "backend", deployStatus: "failed" },
      { name: "votes", deployStatus: "failed" },
      { name: "redis", deployStatus: "success" },
      { name: "postgres", deployStatus: "failed" }
    ]);
    expect(
      payload.resources.map(({ name, connections }) => ({
        name,
        connections
      }))
    ).toEqual([
      { name: "frontend", connections: [{ id: "redis" }] },
      { name: "backend", connections: [{ id: "postgres" }] },
      { name: "votes", connections: [{ id: "redis" }] },
      { name: "redis", connections: [] },
      { name: "postgres", connections: [] }
    ]);
    expect(payload.resources[0].deployMessage).toBe(
      "container deployment failed"
    );
  });

  it("keeps each failed node's own error when the terminal artifact has none", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/todo";
    harness.state.deployEnvName = "aws-demo";
    harness.state.deployStatus = "failed";
    harness.state.deployRunId = 7;
    harness.state.deployingResources = [
      {
        id: "brokendb",
        name: "brokendb",
        type: "Radius.Data/mySqlDatabases",
        deployStatus: "failed",
        deployMessage: "InvalidRequest: DBName must begin with a letter"
      },
      {
        id: "todo",
        name: "todo",
        type: "Radius.Compute/containers",
        deployStatus: "success"
      }
    ];
    harness.modeledResources.push(
      { id: "brokendb", name: "brokendb", type: "Radius.Data/mySqlDatabases" },
      { id: "todo", name: "todo", type: "Radius.Compute/containers" }
    );
    harness.reader.progress = {
      schemaVersion: 1,
      application: "todo",
      environment: "aws-demo",
      runId: 7,
      sequence: 9,
      state: "failed",
      resources: [
        {
          id: "brokendb",
          name: "brokendb",
          type: "Radius.Data/mySqlDatabases",
          status: "failed",
          message: ""
        },
        {
          id: "todo",
          name: "todo",
          type: "Radius.Compute/containers",
          status: "success"
        }
      ]
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);
    const payload = (await response.json()) as {
      resources: CanvasGraphResource[];
    };

    expect(response.status).toBe(200);
    expect(
      payload.resources.map(({ name, deployStatus, deployMessage }) => ({
        name,
        deployStatus,
        deployMessage
      }))
    ).toEqual([
      {
        name: "brokendb",
        deployStatus: "failed",
        deployMessage: "InvalidRequest: DBName must begin with a letter"
      },
      { name: "todo", deployStatus: "success", deployMessage: undefined }
    ]);
  });

  it("does not apply live session state to another repository", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.state.deployStatus = "in_progress";
    harness.state.deployEnvName = "prod";
    harness.state.deployRunId = 0;
    harness.state.deployingResources = [
      { id: "res-a", name: "api", deployStatus: "in_progress" }
    ];
    harness.modeledResources.push({
      id: "res-a",
      name: "api",
      deployStatus: "pending"
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/deployed-graph?repo=octo%2Fother&environment=PROD&application=billing`
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      mode: string;
      repo: string;
      branch: string;
      resources: CanvasGraphResource[];
    };
    expect(payload.mode).toBe("greyed");
    expect(payload.repo).toBe("octo/other");
    expect(payload.branch).toBe("main");
    expect(payload.resources).toEqual([
      {
        id: "res-a",
        name: "api",
        deployStatus: "pending",
        connections: [],
        outputResources: []
      }
    ]);
    expect(harness.readerOptions).toEqual([
      {
        repo: "octo/other",
        environment: "PROD",
        application: "billing",
        runId: null
      }
    ]);
  });

  it("applies a newer same-run artifact before the final graph is published", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.state.deployStatus = "in_progress";
    harness.state.deployRunId = 32529608815;
    harness.state.deployingResources = [
      {
        id: "container",
        name: "todo-list-app-1",
        type: "Radius.Compute/containers",
        deployStatus: "in_progress"
      }
    ];
    harness.modeledResources.push({
      id: "container",
      name: "todo-list-app-1",
      type: "Radius.Compute/containers"
    });
    harness.reader.progress = {
      schemaVersion: 1,
      application: "todo-list-app-1",
      environment: "default",
      runId: 32529608815,
      sequence: 5,
      state: "in_progress",
      resources: [
        {
          id: "container",
          name: "todo-list-app-1",
          type: "Radius.Compute/containers",
          outputResourceIds: ["deployment", "service"],
          provisioningState: "Succeeded",
          status: "success"
        }
      ]
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);
    const payload = (await response.json()) as {
      mode: string;
      resources: CanvasGraphResource[];
    };

    expect(payload.mode).toBe("live");
    expect(payload.resources[0].deployStatus).toBe("success");
  });

  it("serves matching planned provider types when deployed metadata is sparse", async () => {
    const harness = start();
    const plannedOutputs = [
      {
        id: "planned-server",
        name: "server",
        type: "Microsoft.DBforMySQL/flexibleServers",
        portalUrl:
          "https://portal.azure.com/#@tenant/resource/subscriptions/s/resourceGroups/rg/providers/Microsoft.DBforMySQL/flexibleServers/server"
      }
    ];
    harness.state.contextRepo = "octo/app";
    harness.state.plannedRepo = "octo/app";
    harness.state.plannedBranch = "main";
    harness.state.plannedEnvironment = "prod";
    harness.state.plannedProvider = "azure";
    harness.state.deployProvider = "azure";
    harness.state.plannedResources = [
      {
        id: "mysql",
        name: "mysql",
        type: "Radius.Data/mySqlDatabases",
        connections: [{ id: "api" }],
        outputResources: plannedOutputs
      }
    ];
    harness.modeledResources.push(
      {
        id: "mysql",
        name: "mysql",
        type: "Radius.Data/mySqlDatabases",
        connections: [{ id: "api" }]
      },
      { id: "api", name: "api", type: "Radius.Compute/containers" }
    );
    harness.reader.graph = {
      graph: {
        resources: [{ id: "mysql", name: "mysql", outputResources: [] }]
      },
      status: "ok"
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/deployed-graph?environment=prod`
    );
    const payload = (await response.json()) as {
      resources: CanvasGraphResource[];
    };

    expect(payload.resources.map((resource) => resource.name)).toEqual([
      "mysql",
      "api"
    ]);
    expect(payload.resources[0].connections).toEqual([{ id: "api" }]);
    expect(payload.resources[0].outputResources).toEqual(plannedOutputs);
    expect(payload.resources.map((resource) => resource.deployStatus)).toEqual([
      "pending",
      "pending"
    ]);
  });

  it("serves planned friendly types with final deployment metadata", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.state.plannedRepo = "octo/app";
    harness.state.plannedBranch = "main";
    harness.state.plannedEnvironment = "prod";
    harness.state.plannedProvider = "azure";
    harness.state.deployProvider = "azure";
    harness.state.plannedResources = [
      {
        id: "postgres",
        name: "postgres",
        type: "Radius.Data/postgreSqlDatabases",
        outputResources: [
          {
            id: "planned-server",
            type: "Microsoft.DBforPostgreSQL/flexibleServers@2024-01-01",
            displayType: "Azure Database for PostgreSQL"
          }
        ]
      }
    ];
    harness.modeledResources.push({
      id: "postgres",
      name: "postgres",
      type: "Radius.Data/postgreSqlDatabases"
    });
    harness.reader.graph = {
      graph: {
        resources: [
          {
            id: "postgres",
            name: "postgres",
            outputResources: [
              {
                id: "deployed-server",
                type: "Microsoft.DBforPostgreSQL/flexibleServers@2025-01-01",
                portalUrl: "https://portal.azure.com/postgres"
              }
            ]
          }
        ]
      },
      status: "ok"
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/deployed-graph?environment=prod`
    );
    const payload = (await response.json()) as {
      resources: CanvasGraphResource[];
    };

    expect(response.status).toBe(200);
    expect(payload.resources[0].outputResources).toEqual([
      {
        id: "deployed-server",
        type: "Microsoft.DBforPostgreSQL/flexibleServers@2025-01-01",
        displayType: "Azure Database for PostgreSQL",
        portalUrl: "https://portal.azure.com/postgres"
      }
    ]);
  });

  it("does not serve planned-only provider links after deployment failure", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.state.plannedRepo = "octo/app";
    harness.state.plannedBranch = "main";
    harness.state.plannedEnvironment = "prod";
    harness.state.plannedProvider = "azure";
    harness.state.deployProvider = "azure";
    harness.state.deployEnvName = "prod";
    harness.state.deployStatus = "failed";
    harness.state.deployRunId = 7;
    harness.state.plannedResources = [
      {
        id: "mysql",
        name: "mysql",
        type: "Radius.Data/mySqlDatabases",
        outputResources: [
          {
            id: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.DBforMySQL/flexibleServers/missing",
            type: "Microsoft.DBforMySQL/flexibleServers",
            portalUrl: "https://portal.azure.com/#@tenant/resource/missing"
          }
        ]
      }
    ];
    harness.state.deployingResources = [
      {
        id: "mysql",
        name: "mysql",
        type: "Radius.Data/mySqlDatabases",
        outputResources: [
          {
            id: "attempt-server",
            type: "Microsoft.DBforMySQL/flexibleServers@2024-01-01",
            displayType: "Azure Database for MySQL",
            portalUrl: "https://portal.azure.com/#attempt-only"
          }
        ]
      }
    ];
    harness.modeledResources.push({
      id: "mysql",
      name: "mysql",
      type: "Radius.Data/mySqlDatabases"
    });
    harness.reader.graph = {
      graph: {
        resources: [
          {
            id: "mysql",
            name: "mysql",
            outputResources: [
              { id: "secret", type: "core/Secret", displayType: "Secret" }
            ]
          }
        ]
      },
      status: "ok"
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/deployed-graph?environment=prod`
    );
    const payload = (await response.json()) as {
      resources: CanvasGraphResource[];
    };

    expect(payload.resources[0].outputResources).toEqual([
      { id: "secret", type: "core/Secret", displayType: "Secret" },
      {
        type: "Microsoft.DBforMySQL/flexibleServers@2024-01-01",
        displayType: "Azure Database for MySQL"
      }
    ]);
    expect(JSON.stringify(payload.resources)).not.toContain("attempt-only");
    expect(JSON.stringify(payload.resources)).not.toContain("missing");
    expect(payload.resources[0].deployStatus).toBe("failed");
  });

  it("keeps current terminal state when a mismatched artifact predates the attempt", async () => {
    const harness = start();
    const currentOutputs = [
      {
        id: "current-server",
        type: "Microsoft.DBforMySQL/flexibleServers",
        portalUrl:
          "https://portal.azure.com/#@tenant/resource/subscriptions/s/resourceGroups/rg/providers/Microsoft.DBforMySQL/flexibleServers/current-server"
      }
    ];
    harness.state.contextRepo = "octo/app";
    harness.state.deployStatus = "complete";
    harness.state.deployStartedAt = Date.parse("2026-08-12T00:00:00.000Z");
    harness.state.deployFinishedAt = Date.parse("2026-08-13T00:00:00.000Z");
    harness.state.deployRunId = 7;
    harness.state.deployingResources = [
      { id: "mysql", name: "mysql", deployStatus: "success" }
    ];
    harness.state.deployedGraph = [
      {
        id: "mysql",
        name: "mysql",
        outputResources: currentOutputs
      }
    ];
    harness.modeledResources.push({ id: "mysql", name: "mysql" });
    harness.reader.graph = {
      graph: {
        resources: [
          {
            id: "mysql",
            name: "mysql",
            outputResources: [
              {
                id: "stale-server",
                type: "Microsoft.DBforMySQL/flexibleServers"
              }
            ]
          }
        ]
      },
      status: "ok",
      artifact: {
        id: 6,
        name: "radius-deploy-status-prod-old",
        created_at: "2026-08-11T00:00:00.000Z"
      }
    };
    harness.reader.progress = {
      schemaVersion: 1,
      application: "todo-list-app-1",
      environment: "default",
      runId: 6,
      sequence: 1,
      state: "failed",
      resources: [
        {
          id: "mysql",
          name: "mysql",
          type: "Radius.Data/mySqlDatabases",
          status: "failed"
        }
      ]
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);
    const payload = (await response.json()) as {
      mode: string;
      resources: CanvasGraphResource[];
      updatedAt: string | null;
    };

    expect(payload.mode).toBe("terminal");
    expect(payload.updatedAt).toBeNull();
    expect(payload.resources[0].deployStatus).toBe("success");
    expect(payload.resources[0].outputResources).toEqual(currentOutputs);
  });

  it("publishes a read failure to the sibling progress route", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.state.plannedResources = [{ id: "res-a", name: "api" }];
    harness.modeledResources.push({ id: "res-a", name: "api" });
    harness.reader.graphThrows = new Error("artifact listing exploded");
    const entry = await container!.getOrCreate("panel-a");

    const empty = await fetch(`${entry.baseUrl}/api/progress`);
    expect(empty.status).toBe(200);
    expect(empty.headers.get("content-type")).toBe("application/json");
    expect(await empty.text()).toBe('{"messages":[]}');

    const graph = await fetch(`${entry.baseUrl}/api/deployed-graph`);
    expect(graph.status).toBe(200);
    // The tab is not blanked: the modeled topology still renders.
    expect(
      ((await graph.json()) as { resources: CanvasGraphResource[] }).resources
    ).toEqual([
      {
        id: "res-a",
        name: "api",
        deployStatus: "pending",
        connections: [],
        outputResources: []
      }
    ]);

    const logged = await fetch(`${entry.baseUrl}/api/progress`);
    expect(await logged.text()).toBe(
      '{"messages":["Deployed graph status read failed: artifact listing exploded"]}'
    );
  });

  it("answers both routes when the instance entry is gone", async () => {
    const harness = start();
    harness.setEntryMissing(true);
    harness.reader.graphThrows = new Error("boom");
    const entry = await container!.getOrCreate("panel-a");

    const progress = await fetch(`${entry.baseUrl}/api/progress`);
    expect(progress.status).toBe(200);
    expect(await progress.text()).toBe('{"messages":[]}');

    const graph = await fetch(
      `${entry.baseUrl}/api/deployed-graph?repo=octo%2Fapp`
    );
    expect(graph.status).toBe(200);
    expect(await graph.json()).toEqual({
      resources: [],
      repo: "octo/app",
      branch: "main",
      mode: "greyed",
      updatedAt: null,
      application: null,
      deletionInventory: null
    });
  });
});
