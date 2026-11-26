import { createServer } from "node:http";
import { execFileSync, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applicationGraphToResources,
  computeGraphDiff,
  createGraphOrchestrator,
  deploymentGraphResources,
  projectSafeApplicationGraph
} from "@radius-project/core";
import {
  RadProcessError,
  createGraphSourceBindings
} from "@radius-project/adapter-shared";
import { createCanvasGraphSources } from "../../../src/server/graph-sources.js";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createGraphsPlanningWritesRoutes } from "../../../src/server/routes/graphs-planning-writes.js";
import { createGraphPlanningWorkflows } from "../../../src/server/routes/graph-workflows.js";
import { GRAPH_MODELING_FAILURE_MESSAGE } from "../../../src/graph-progress-contract.js";
import {
  createGraphPipeline,
  type AppBicepSelection,
  type GraphPipeline
} from "../../../src/server/routes/graph-pipeline.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import {
  prepareSourceRefResources,
  setSourceRefResources
} from "../../../src/source-refs.js";
import {
  commitWorkspaceBranchResolution,
  isWorkspaceSelection,
  resolveGraphBranchForRequest,
  workspaceGraphJsonPath
} from "../../../src/workspace.js";
import {
  addGraphProgress,
  beginPlannedGraphRequest,
  canReuseModeledGraph,
  graphDefinitionHash,
  isCurrentPlannedGraphRequest,
  isCurrentSourceRefToken
} from "../../../src/server.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { CanvasGraphResource, CanvasState } from "../../../src/shared.js";

let container: CanvasServerContainer | undefined;
// Everything the workflows sent to the server log instead of the canvas.
let loggedErrors: string[] = [];

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
  loggedErrors = [];
});

interface PipelineScript {
  selections: Record<string, AppBicepSelection>;
  compiled: Record<string, CanvasGraphResource[]>;
  compileThrows?: unknown;
  branchPaths?: string[];
  afterCompile?: () => void;
  liveWorkspaceBranch?: string;
  commits?: Record<string, string>;
  stageArtifacts?: GraphPipeline["stageArtifacts"];
}

interface Harness {
  state: CanvasState;
  script: PipelineScript;
  setEntryMissing(missing: boolean): void;
  advanceClock(ms: number): void;
}

function selectionOf(
  branch: string,
  content: string | null
): AppBicepSelection {
  return { content, fromWorkspace: false, branch, bicepPath: "" };
}

// Most scenarios script the pipeline; those testing cache inputs use the real
// pipeline with controlled I/O. Unscripted branches fail instead of returning
// an empty graph.
function start(
  script: Partial<PipelineScript> = {},
  productionPipeline?: GraphPipeline
): Harness {
  const state: CanvasState = {};
  let entryMissing = false;
  let nowMs = 1_000;
  const active: PipelineScript = {
    selections: {},
    compiled: {},
    ...script
  };

  function scripted<T>(
    table: Record<string, T>,
    branch: string,
    stage: string
  ) {
    const value = table[branch];
    if (!value) throw new Error(`unscripted ${stage} for branch: ${branch}`);
    return value;
  }

  const pipeline: GraphPipeline = productionPipeline ?? {
    selectAppBicep: (_entry, _repo, branch) =>
      Promise.resolve(scripted(active.selections, branch, "selectAppBicep")),
    bicepPathOf: (selection) => selection.bicepPath || ".radius/app.bicep",
    stageArtifacts: (input) =>
      active.stageArtifacts?.(input) ??
      Promise.resolve({ dir: "", remote: false }),
    compileResources: ({ selection }) => {
      if (active.compileThrows) return Promise.reject(active.compileThrows);
      const compiled = scripted(
        active.compiled,
        selection.branch,
        "compileResources"
      );
      active.afterCompile?.();
      return Promise.resolve(compiled);
    },
    toCanvasResources: (values) => values as CanvasGraphResource[],
    graphJsonPathFor: () => "",
    definitionHashFor: () => "hash-a",
    modelRevisionFor: () => "model-a",
    discardStagedArtifacts: () => {}
  };

  const entry = { state };
  const routes = createTestRouteTable(
    createGraphsPlanningWritesRoutes({
      // The real workflow service, so this suite still exercises the whole
      // stack from the socket down to the state machine.
      workflows: createGraphPlanningWorkflows({
        readInstanceEntry: () => (entryMissing ? undefined : entry),
        resolveBranchForRequest: (
          entry,
          repo,
          requestedBranch,
          followWorkspaceBranch
        ) =>
          resolveGraphBranchForRequest(
            entry.state,
            repo,
            requestedBranch,
            followWorkspaceBranch,
            async () => active.liveWorkspaceBranch || ""
          ),
        commitBranchResolution: (entry, repo, resolution) =>
          commitWorkspaceBranchResolution(entry.state, repo, resolution),
        pipeline,
        triggerAppBicepHandoff: () => {},
        observeModelingRun: () => Promise.resolve(null),
        readBranchSourceRevision: (_entry, _repo, branch) =>
          Promise.resolve(active.commits?.[branch] ?? ""),
        triggerGraphRepairHandoff: () => ({
          attempt: 1,
          maxAttempts: 3,
          repairing: true,
          repairExhausted: false
        }),
        clearGraphRepairAttempt: () => {},
        listBranchPaths: () => Promise.resolve(active.branchPaths ?? []),
        prepareSourceRefResources,
        setSourceRefResources,
        isCurrentSourceRefToken,
        canReuseModeledGraph,
        addGraphProgress,
        beginPlannedGraphRequest,
        isCurrentPlannedGraphRequest,
        fetchRecipePack: () => Promise.resolve([]),
        resolveRecipeOutputs: (resources) => Promise.resolve(resources),
        computeGraphDiff: (baseResources, headResources) =>
          computeGraphDiff(
            baseResources,
            headResources
          ) as CanvasGraphResource[],
        record: (value) => {
          if (
            value === null ||
            typeof value !== "object" ||
            Array.isArray(value)
          ) {
            return {};
          }
          return Object.fromEntries(Object.entries(value));
        },
        optionalString: (value) => (typeof value === "string" ? value : ""),
        errorMessage: (error) =>
          error instanceof Error ? error.message : String(error),
        logError: (message) => {
          loggedErrors.push(message);
        },
        now: () => nowMs
      })
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
    script: active,
    setEntryMissing(missing) {
      entryMissing = missing;
    },
    advanceClock(ms) {
      nowMs += ms;
    }
  };
}

function post(baseUrl: string, path: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", body });
}

describe("graphs-planning writes real-loopback HIT", () => {
  it.each(["base", "head"])(
    "shares production source/graph coordination with a direct caller when %s is dirty",
    async (workspaceBranch) => {
      const root = await mkdtemp(path.join(tmpdir(), "radius-http-graph-"));
      try {
        execFileSync(
          "git",
          ["init", "--initial-branch", workspaceBranch, root],
          { stdio: "pipe" }
        );
        await mkdir(path.join(root, ".radius"));
        await writeFile(path.join(root, ".radius", "app.bicep"), "dirty-model");
        const effects: string[] = [];
        const sha = "a".repeat(40);
        const sources = createGraphSourceBindings({
          stagingRoot: root,
          redactDiagnostic: (message) => message,
          execute: (command, args, _options, callback) => {
            if (command === "git") {
              execFile(
                command,
                args,
                { timeout: 5000 },
                (error, stdout, stderr) => callback(error, stdout, stderr)
              );
              return {};
            }
            const apiPath = args[1] || "";
            effects.push(apiPath);
            if (apiPath.startsWith("/repos/octo/app/commits/")) {
              callback(null, JSON.stringify({ sha }), "");
            } else if (
              apiPath ===
              `/repos/octo/app/contents/.radius/app.bicep?ref=${sha}`
            ) {
              const bytes = Buffer.from("committed-model");
              callback(
                null,
                JSON.stringify({
                  encoding: "base64",
                  size: bytes.length,
                  content: bytes.toString("base64")
                }),
                ""
              );
            } else if (
              apiPath ===
              `/repos/octo/app/contents/.radius/bicepconfig.json?ref=${sha}`
            ) {
              callback(new Error("not found"), "", "gh: Not Found (HTTP 404)");
            } else {
              throw new Error(`Unscripted GitHub read: ${apiPath}`);
            }
            return {};
          }
        });
        const state: CanvasState = {
          workspaceRepo: "octo/app",
          workspaceBranch,
          workspacePath: root
        };
        const compile = async (
          content: string
        ): Promise<CanvasGraphResource[]> => {
          if (content !== "dirty-model" && content !== "committed-model")
            throw new Error("Unscripted model");
          effects.push(`compile:${content}`);
          return [
            { id: content, name: content, type: "Radius.Compute/containers" }
          ];
        };
        const direct = createGraphOrchestrator({
          stage: sources.stage,
          compile,
          diff: computeGraphDiff
        });
        const workspace = {
          repo: "octo/app",
          ref: workspaceBranch,
          path: root,
          authorized: true
        };
        const compared = await direct.compare(
          await sources.read({ repo: "octo/app", ref: "base", workspace }),
          await sources.read({ repo: "octo/app", ref: "head", workspace })
        );
        expect(compared.status).toBe("compared");
        if (compared.status !== "compared")
          throw new Error("Expected a comparison.");
        const directEffects = [...effects];
        effects.length = 0;
        const binding = createCanvasGraphSources(
          sources,
          isWorkspaceSelection,
          async () => workspaceBranch
        );
        const pipeline = createGraphPipeline({
          fetchBicepSelection: binding.select,
          resolveRadArtifactsDir: binding.stage,
          buildGraphViaRad: compile,
          canvasGraphResources: deploymentGraphResources,
          workspaceGraphJsonPath: () => "",
          graphDefinitionHash: (content, fingerprint) => content + fingerprint,
          removeDirectory: () => {
            throw new Error("The shared handle must own cleanup.");
          }
        });
        const harness = start({}, pipeline);
        Object.assign(harness.state, state);
        const entry = await container!.getOrCreate("panel-a");
        const response = await post(
          entry.baseUrl,
          "/api/diff-branches",
          JSON.stringify({ repo: "octo/app", base: "base", head: "head" })
        );
        expect(response.status).toBe(200);
        expect(harness.state.diffResources).toEqual(compared.diff);
        expect(
          compared.diff.some((resource) => resource.name === "dirty-model")
        ).toBe(true);
        expect(effects).toEqual(directEffects);
        expect(effects).not.toContain(
          `/repos/octo/app/commits/${workspaceBranch}`
        );
        effects.length = 0;
        execFileSync(
          "git",
          ["-C", root, "symbolic-ref", "HEAD", "refs/heads/other"],
          { stdio: "pipe" }
        );
        const stale = await post(
          entry.baseUrl,
          "/api/diff-branches",
          JSON.stringify({ repo: "octo/app", base: "base", head: "head" })
        );
        expect(stale.ok).toBe(false);
        expect(await stale.text()).toContain("Workspace branch changed");
        expect(effects.some((effect) => effect.startsWith("compile:"))).toBe(
          false
        );
        expect(effects).not.toContain(
          `/repos/octo/app/commits/${workspaceBranch}`
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("serves the modeled graph and its state transition over a real socket", async () => {
    const harness = start({
      selections: { main: selectionOf("main", "resource app = {}") },
      compiled: { main: [{ id: "res-a", name: "api" } as CanvasGraphResource] }
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app"}'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(
      '{"reload":true,"resources":[{"id":"res-a","name":"api"}],"fromWorkspace":false}'
    );
    expect(harness.state.graphLoaded).toBe(true);
    expect(harness.state.graphTargetRepo).toBe("octo/app");
  });

  it("reuses a workspace graph until a referenced JSONC artifact changes", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "radius-refresh-"));
    try {
      execFileSync("git", ["init", "--initial-branch", "main", workspacePath], {
        stdio: "pipe"
      });
      const artifactsDir = path.join(workspacePath, ".radius");
      const artifact = path.join(artifactsDir, "types.tgz");
      await mkdir(artifactsDir);
      await writeFile(
        path.join(artifactsDir, "app.bicep"),
        "resource app = {}"
      );
      const config = path.join(artifactsDir, "bicepconfig.json");
      await writeFile(
        config,
        `{
          // Bicep permits comments and trailing commas.
          "extensions": {"types": "./types.tgz",},
        }`
      );
      await writeFile(artifact, "original");
      const compiledArtifacts: string[] = [];
      const sources = createGraphSourceBindings({
        stagingRoot: workspacePath,
        redactDiagnostic: (message) => message,
        execute: (command, args, _options, callback) => {
          if (command !== "git") throw new Error("expected a workspace read");
          return execFile(
            command,
            args,
            { timeout: 5000 },
            (error, stdout, stderr) => callback(error, stdout, stderr)
          );
        }
      });
      const binding = createCanvasGraphSources(
        sources,
        isWorkspaceSelection,
        async () => "main"
      );
      const pipeline = createGraphPipeline({
        fetchBicepSelection: binding.select,
        resolveRadArtifactsDir: binding.stage,
        buildGraphViaRad: async (_content, _definition, options) => {
          if (
            !options.radArtifactsDir ||
            options.radArtifactsDir === artifactsDir
          )
            throw new Error(
              "expected a staged snapshot of workspace artifacts"
            );
          compiledArtifacts.push(
            await readFile(
              path.join(options.radArtifactsDir, "types.tgz"),
              "utf8"
            )
          );
          return [
            { id: "res-a", name: "api", type: "Radius.Compute/containers" }
          ];
        },
        canvasGraphResources: deploymentGraphResources,
        workspaceGraphJsonPath,
        graphDefinitionHash,
        removeDirectory: () => {
          throw new Error("workspace artifacts must not be deleted");
        }
      });
      const { state } = start({ liveWorkspaceBranch: "main" }, pipeline);
      Object.assign(state, {
        workspacePath,
        workspaceRepo: "octo/app",
        workspaceBranch: "main"
      });
      const { baseUrl } = await container!.getOrCreate("panel-a");
      const refresh = async () => {
        const response = await post(
          baseUrl,
          "/api/load-graph",
          '{"repo":"octo/app","refresh":true}'
        );
        const body: unknown = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(200);
        return body;
      };

      expect(await refresh()).toMatchObject({
        reload: false,
        fromWorkspace: true
      });
      expect(compiledArtifacts).toEqual(["original"]);
      const { graphDefinitionHash: initialHash, graphModelRevision } = state;
      expect(initialHash).toBeTruthy();
      expect(graphModelRevision).toBeTruthy();
      expect(await refresh()).toMatchObject({ reload: false, cached: true });
      expect(compiledArtifacts).toEqual(["original"]);

      await writeFile(artifact, "updated");
      expect(await refresh()).toMatchObject({
        reload: false,
        fromWorkspace: true
      });
      expect(compiledArtifacts).toEqual(["original", "updated"]);
      expect(state.graphDefinitionHash).not.toBe(initialHash);
      expect(state.graphModelRevision).toBe(graphModelRevision);

      await writeFile(
        config,
        '{"extensions":{"radius":{"toString":null},"types":"./types.tgz"}}'
      );
      const rejected = await post(
        baseUrl,
        "/api/load-graph",
        '{"repo":"octo/app","refresh":true}'
      );
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({
        error: expect.stringContaining("radius")
      });
      expect(compiledArtifacts).toEqual(["original", "updated"]);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("does not expose rejected icon entries in the modeled graph response", async () => {
    const sentinel = "fixture-private-field";
    const iconHash =
      "1e8500bafa3c1523488304fe478d570e4f518b8347f42a0796abd560fa08c7e5";
    const icon =
      '<svg viewBox="0 0 8 8" fill="none" xmlns="http://www.w3.org/2000/svg"><mask id="resource-icon" maskUnits="userSpaceOnUse" x="0" y="0" width="8" height="8"><path d="M1 1h6v6H1z" fill="white"/></mask><rect x="0" y="0" width="8" height="8" fill="currentColor" mask="url(#resource-icon)"/></svg>';
    const projected = projectSafeApplicationGraph({
      resources: [
        {
          id: "res-a",
          name: "api",
          type: "Radius.Compute/containers",
          diffHash: `sha256:${"b".repeat(64)}`,
          iconHash
        }
      ],
      icons: {
        [iconHash]: icon,
        "not-a-hash": sentinel,
        [`sha256:${"c".repeat(64)}`]: sentinel
      }
    });
    start({
      selections: { main: selectionOf("main", "resource app = {}") },
      compiled: {
        main: applicationGraphToResources(projected) as CanvasGraphResource[]
      }
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app"}'
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('fill=\\"currentColor\\"');
    expect(body).toContain('mask=\\"url(#resource-icon)\\"');
    expect(body).not.toContain(sentinel);
    expect(body).not.toContain("not-a-hash");
  });

  it("answers the app-bicep handoff payload when the branch has no model", async () => {
    start({ selections: { main: selectionOf("main", null) } });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app"}'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      error:
        "Copilot is generating .radius/app.bicep with the radius-app-model skill.",
      needsAppBicep: true,
      repo: "octo/app",
      branch: "main"
    });
  });

  it("returns a terminal authoring failure instead of another app-bicep handoff", async () => {
    const harness = start({
      selections: { main: selectionOf("main", null) }
    });
    harness.state.appModelFailures = {
      "octo/app::main": {
        attemptToken: "attempt-1",
        error: "The configured Recipe rejects the required credential shape."
      }
    };
    harness.state.appModelAttemptTokens = {
      "octo/app::main": "attempt-1"
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app"}'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      modelingFailed: true,
      appModelAuthoringFailed: true,
      repo: "octo/app",
      branch: "main"
    });
  });

  it("keeps a terminal authoring failure when the page is reloaded", async () => {
    const harness = start({
      selections: { main: selectionOf("main", null) },
      commits: { main: "sha-1" }
    });
    harness.state.appModelFailures = {
      "octo/app::main": {
        attemptToken: "attempt-1",
        error: "The configured Recipe rejects the required credential shape.",
        sourceRevision: "sha-1"
      }
    };
    harness.state.appModelAttemptTokens = {
      "octo/app::main": "attempt-1"
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app","restartWait":true}'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      modelingFailed: true,
      error: expect.stringContaining("click Refresh")
    });
    expect(harness.state.appModelFailures).not.toEqual({});
  });

  it("restarts modeling once the branch commit changes after a terminal failure", async () => {
    const harness = start({
      selections: { main: selectionOf("main", null) },
      commits: { main: "sha-2" }
    });
    harness.state.appModelFailures = {
      "octo/app::main": {
        attemptToken: "attempt-1",
        error: "The configured Recipe rejects the required credential shape.",
        sourceRevision: "sha-1"
      }
    };
    harness.state.appModelAttemptTokens = {
      "octo/app::main": "attempt-1"
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app"}'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ needsAppBicep: true });
    expect(harness.state.appModelFailures).toEqual({});
  });

  it.each([
    ["/api/load-graph", { repo: "octo/app" }],
    [
      "/api/plan-graph",
      { repo: "octo/app", provider: "azure", environment: "dev" }
    ],
    [
      "/api/diff-branches",
      { repo: "octo/app", base: "main", head: "feature/x" }
    ]
  ])(
    "accepts only a boolean explicit retry over HTTP on %s",
    async (route, request) => {
      const harness = start({
        selections: {
          main: selectionOf("main", null),
          "feature/x": selectionOf("feature/x", null)
        },
        commits: { main: "sha-1" }
      });
      harness.state.appModelFailures = {
        "octo/app::main": {
          attemptToken: "attempt-1",
          error: "Recipe unavailable",
          sourceRevision: "sha-1",
          environmentKey: '["azure","dev"]'
        }
      };
      harness.state.appModelAttemptTokens = { "octo/app::main": "attempt-1" };
      const entry = await container!.getOrCreate("panel-a");
      expect(
        await (
          await post(
            entry.baseUrl,
            route,
            JSON.stringify({
              ...request,
              restartWait: true,
              refresh: true,
              retryModeling: "true"
            })
          )
        ).json()
      ).toMatchObject({ appModelAuthoringFailed: true });
      expect(
        await (
          await post(
            entry.baseUrl,
            route,
            JSON.stringify({
              ...request,
              restartWait: true,
              retryModeling: true
            })
          )
        ).json()
      ).toMatchObject({ needsAppBicep: true });
      expect(harness.state.appModelFailures).toEqual({});
    }
  );

  it("allows an environment change but keeps the failed environment fenced over HTTP", async () => {
    const harness = start({
      selections: { main: selectionOf("main", null) },
      commits: { main: "sha-1" }
    });
    harness.state.appModelFailures = {
      "octo/app::main": {
        attemptToken: "attempt-1",
        error: "Recipe unavailable",
        sourceRevision: "sha-1",
        environmentKey: '["azure","dev"]'
      }
    };
    harness.state.appModelAttemptTokens = { "octo/app::main": "attempt-1" };
    const entry = await container!.getOrCreate("panel-a");
    const plan = (environment: string) =>
      post(
        entry.baseUrl,
        "/api/plan-graph",
        JSON.stringify({
          repo: "octo/app",
          provider: "azure",
          environment,
          restartWait: true
        })
      );
    expect(await (await plan("dev")).json()).toMatchObject({
      appModelAuthoringFailed: true
    });
    expect(await (await plan("production")).json()).toMatchObject({
      needsAppBicep: true
    });
  });

  it("keeps a graph failure fenced when the planned view opens over HTTP", async () => {
    const harness = start({
      selections: { main: selectionOf("main", null) },
      commits: { main: "sha-1" }
    });
    harness.state.appModelFailures = {
      "octo/app::main": {
        attemptToken: "attempt-1",
        error: "Recipe unavailable",
        sourceRevision: "sha-1",
        environmentKey: ""
      }
    };
    harness.state.appModelAttemptTokens = { "octo/app::main": "attempt-1" };
    const entry = await container!.getOrCreate("panel-a");
    for (const environment of ["", "dev"]) {
      expect(
        await (
          await post(
            entry.baseUrl,
            "/api/plan-graph",
            JSON.stringify({
              repo: "octo/app",
              provider: "azure",
              environment,
              restartWait: true
            })
          )
        ).json()
      ).toMatchObject({ appModelAuthoringFailed: true });
    }
    expect(harness.state.appModelAttemptTokens).toEqual({
      "octo/app::main": "attempt-1"
    });
  });

  it("recovers an unknown source baseline before permitting a later edit", async () => {
    const harness = start({
      selections: { main: selectionOf("main", null) },
      commits: { main: "" }
    });
    harness.state.appModelFailures = {
      "octo/app::main": {
        attemptToken: "attempt-1",
        error: "No source profile"
      }
    };
    harness.state.appModelAttemptTokens = { "octo/app::main": "attempt-1" };
    const entry = await container!.getOrCreate("panel-a");
    const load = () =>
      post(
        entry.baseUrl,
        "/api/load-graph",
        '{"repo":"octo/app","restartWait":true}'
      );
    expect(await (await load()).json()).toMatchObject({
      modelingFailed: true,
      error: expect.stringContaining("source revision could not be read")
    });
    harness.script.commits = { main: "source-1" };
    expect(await (await load()).json()).toMatchObject({
      modelingFailed: true,
      error: expect.stringContaining("change saved source files")
    });
    expect(
      harness.state.appModelFailures?.["octo/app::main"]?.sourceRevision
    ).toBe("source-1");
    expect(await (await load()).json()).toMatchObject({ modelingFailed: true });
    harness.script.commits = { main: "source-2" };
    expect(await (await load()).json()).toMatchObject({ needsAppBicep: true });
    expect(harness.state.appModelFailures).toEqual({});
  });

  it.each([
    ["workspace:source-1", "remote:sha-1"],
    ["remote:sha-1", "workspace:source-1"]
  ])(
    "retains a failure when source evidence changes kind from %s to %s over HTTP",
    async (recorded, current) => {
      const harness = start({
        selections: { main: selectionOf("main", null) },
        commits: { main: current }
      });
      harness.state.appModelFailures = {
        "octo/app::main": {
          attemptToken: "attempt-1",
          error: "Recipe unavailable",
          sourceRevision: recorded
        }
      };
      harness.state.appModelAttemptTokens = { "octo/app::main": "attempt-1" };
      const entry = await container!.getOrCreate("panel-a");
      const load = () =>
        post(
          entry.baseUrl,
          "/api/load-graph",
          '{"repo":"octo/app","restartWait":true}'
        );
      expect(await (await load()).json()).toMatchObject({
        appModelAuthoringFailed: true
      });
      expect(
        harness.state.appModelFailures?.["octo/app::main"]?.sourceRevision
      ).toBe(current);
      expect(await (await load()).json()).toMatchObject({
        appModelAuthoringFailed: true
      });
      harness.script.commits = { main: `${current}-changed` };
      expect(await (await load()).json()).toMatchObject({
        needsAppBicep: true
      });
    }
  );

  it("stops asking the diff to generate once modeling failed permanently on one side", async () => {
    const harness = start({
      selections: {
        main: selectionOf("main", null),
        "feature/x": selectionOf("feature/x", null)
      }
    });
    harness.state.appModelFailures = {
      "octo/app::main": {
        attemptToken: "attempt-1",
        error: "The configured Recipe rejects the required credential shape."
      }
    };
    harness.state.appModelAttemptTokens = { "octo/app::main": "attempt-1" };
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/diff-branches",
      '{"repo":"octo/app","base":"main","head":"feature/x"}'
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      modelingFailed: true,
      appModelAuthoringFailed: true,
      repo: "octo/app"
    });
    expect(payload.needsAppBicep).toBeUndefined();
  });

  it("restarts diff modeling once both branch commits have changed", async () => {
    const harness = start({
      selections: {
        main: selectionOf("main", null),
        "feature/x": selectionOf("feature/x", null)
      },
      commits: { main: "sha-9", "feature/x": "sha-9" }
    });
    harness.state.appModelFailures = {
      "octo/app::main": {
        attemptToken: "attempt-1",
        error: "base failed",
        sourceRevision: "sha-1"
      },
      "octo/app::feature/x": {
        attemptToken: "attempt-1",
        error: "head failed",
        sourceRevision: "sha-2"
      }
    };
    harness.state.appModelAttemptTokens = {
      "octo/app::main": "attempt-1",
      "octo/app::feature/x": "attempt-1"
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/diff-branches",
      '{"repo":"octo/app","base":"main","head":"feature/x","restartWait":true}'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ needsAppBicep: true });
    expect(harness.state.appModelFailures).toEqual({});
  });

  it("loads the worktree model after an implicit workspace branch is renamed", async () => {
    const harness = start({
      liveWorkspaceBranch: "new-name",
      selections: {
        "new-name": {
          content: "resource app = {}",
          fromWorkspace: true,
          branch: "new-name",
          bicepPath: ".radius/app.bicep"
        }
      },
      compiled: {
        "new-name": [{ id: "res-a", name: "api" } as CanvasGraphResource]
      }
    });
    Object.assign(harness.state, {
      workspacePath: "C:\\worktrees\\app",
      workspaceRepo: "octo/app",
      workspaceBranch: "old-name",
      contextRepo: "octo/app",
      contextBranch: "old-name",
      contextBranchSource: "workspace",
      graphTargetRepo: "octo/app",
      graphBranch: "old-name",
      graphFollowsWorkspaceBranch: true,
      plannedRepo: "octo/app",
      plannedBranch: "old-name",
      plannedFollowsWorkspaceBranch: true
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app","branch":"old-name","followWorkspaceBranch":true}'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resources: [{ id: "res-a", name: "api" }],
      fromWorkspace: true,
      resolvedBranch: "new-name"
    });
    expect(harness.state.workspaceBranch).toBe("new-name");
    expect(harness.state.contextBranch).toBe("new-name");
    expect(harness.state.graphBranch).toBe("new-name");
    expect(harness.state.plannedBranch).toBe("new-name");
  });

  it("keeps renamed workspace provenance after a missing-model response", async () => {
    const harness = start({
      liveWorkspaceBranch: "new-name",
      selections: {
        "new-name": {
          content: null,
          fromWorkspace: true,
          branch: "new-name",
          bicepPath: ".radius/app.bicep"
        }
      }
    });
    Object.assign(harness.state, {
      workspacePath: "C:\\worktrees\\app",
      workspaceRepo: "octo/app",
      workspaceBranch: "old-name",
      contextRepo: "octo/app",
      contextBranch: "old-name",
      contextBranchSource: "workspace",
      graphTargetRepo: "octo/app",
      graphBranch: "old-name",
      graphFollowsWorkspaceBranch: true,
      plannedRepo: "octo/app",
      plannedBranch: "old-name",
      plannedFollowsWorkspaceBranch: true
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app","branch":"old-name","followWorkspaceBranch":true}'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      needsAppBicep: true,
      branch: "new-name",
      resolvedBranch: "new-name"
    });
    expect(harness.state.contextBranch).toBe("new-name");
    expect(harness.state.graphBranch).toBe("new-name");
    expect(harness.state.plannedBranch).toBe("new-name");
    expect(harness.state.graphFollowsWorkspaceBranch).toBe(true);
    expect(harness.state.plannedFollowsWorkspaceBranch).toBe(true);

    const startedAt =
      harness.state.graphProgressRecords?.graph?.graphProgressStartedAtMs;
    harness.advanceClock(5_000);
    const retry = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app","branch":"new-name","followWorkspaceBranch":true,"restartWait":true}'
    );

    expect(retry.status).toBe(200);
    expect(
      harness.state.graphProgressRecords?.graph?.graphProgressStartedAtMs
    ).toBe(startedAt);
  });

  it("does not hand off generation when the live workspace branch is unavailable", async () => {
    const harness = start();
    Object.assign(harness.state, {
      workspacePath: "C:\\worktrees\\app",
      workspaceRepo: "octo/app",
      workspaceBranch: "old-name",
      contextRepo: "octo/app",
      contextBranch: "old-name",
      contextBranchSource: "workspace"
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app","branch":"old-name","followWorkspaceBranch":true}'
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "The workspace branch is unavailable. Reopen the Radius canvas after restoring the worktree branch.",
      workspaceBranchUnavailable: true,
      repo: "octo/app"
    });
  });

  it("keeps an explicit branch of the workspace repository remote", async () => {
    const harness = start({
      selections: {
        release: selectionOf("release", "resource app = {}")
      },
      compiled: {
        release: [{ id: "res-a", name: "api" } as CanvasGraphResource]
      }
    });
    Object.assign(harness.state, {
      workspacePath: "C:\\worktrees\\app",
      workspaceRepo: "octo/app",
      workspaceBranch: "new-name",
      contextRepo: "octo/app",
      contextBranch: "release",
      contextBranchSource: "explicit"
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app","branch":"release","followWorkspaceBranch":false}'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resources: [{ id: "res-a", name: "api" }],
      fromWorkspace: false
    });
    expect(harness.state.contextBranch).toBe("release");
    expect(harness.state.graphBranch).toBe("release");
  });

  it("answers 503 with no Content-Type when the instance entry is gone", async () => {
    const harness = start();
    harness.setEntryMissing(true);
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/plan-graph",
      '{"repo":"octo/app"}'
    );

    expect(response.status).toBe(503);
    // The header's absence is observable on the wire, not merely in a recorder.
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe(
      '{"error":"Canvas server state is unavailable."}'
    );
  });

  it("answers 400 for a malformed body on every write route", async () => {
    start();
    const entry = await container!.getOrCreate("panel-a");

    for (const path of [
      "/api/load-graph",
      "/api/plan-graph",
      "/api/diff-branches"
    ]) {
      const response = await post(entry.baseUrl, path, "{not json");
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(((await response.json()) as { error: string }).error).toContain(
        "JSON"
      );
    }
    expect(loggedErrors).toEqual([]);
  });

  it("keeps app.bicep validation diagnostics out of the graph response", async () => {
    const harness = start({
      selections: { main: selectionOf("main", "resource app = {}") },
      compileThrows: new Error("rad app graph failed", {
        cause: new RadProcessError(
          "rad exited with code 1",
          "Error BCP035: missing required property",
          ""
        )
      })
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/load-graph",
      '{"repo":"octo/app"}'
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: GRAPH_MODELING_FAILURE_MESSAGE,
      modelingFailed: true,
      attempt: 1,
      maxAttempts: 3,
      repairing: true,
      repairExhausted: false
    });
    expect(harness.state.graphLoaded).toBeUndefined();
    expect(loggedErrors).toEqual([
      "[radius graph] modeling failed for octo/app@main: Error BCP035: missing required property"
    ]);
  });

  it("plans the graph through the recipe pack over a real socket", async () => {
    const harness = start({
      selections: { main: selectionOf("main", "resource app = {}") },
      compiled: { main: [{ id: "res-a", name: "api" } as CanvasGraphResource] }
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/plan-graph",
      '{"repo":"octo/app","environment":"prod"}'
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"reload":true}');
    expect(harness.state.plannedProvider).toBe("azure");
    expect(harness.state.plannedEnvironment).toBe("prod");
    expect(harness.state.activeGraphView).toBe("planned");
  });

  it.each(["compile", "cached refresh"])(
    "rejects a workspace plan after a checkout during %s",
    async (phase) => {
      let liveBranch = "main";
      const harness = start({
        selections: {
          main: {
            ...selectionOf("main", "resource app = {}"),
            fromWorkspace: true,
            verifyWorkspaceBranch: async () => liveBranch === "main"
          }
        },
        compiled: {
          main: [{ id: "res-a", name: "api", type: "Fixture/containers" }]
        }
      });
      const entry = await container!.getOrCreate("panel-a");
      const plan = (refresh: boolean) =>
        post(
          entry.baseUrl,
          "/api/plan-graph",
          JSON.stringify({ repo: "octo/app", branch: "main", refresh })
        );
      if (phase === "cached refresh") {
        expect((await plan(false)).status).toBe(200);
        harness.script.stageArtifacts = async () => {
          liveBranch = "topic";
          return { dir: "", remote: false };
        };
      } else {
        harness.script.afterCompile = () => {
          liveBranch = "topic";
        };
      }

      const response = await plan(phase === "cached refresh");

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ stale: true });
      if (phase === "compile")
        expect(harness.state.plannedRepo).toBeUndefined();
    }
  );

  it.each(["planned", "diff"] as const)(
    "fences a %s compile failure after the admitted workspace branch changes",
    async (view) => {
      let branch = "main";
      const harness = start({
        selections: {
          main: {
            ...selectionOf("main", "resource app = {}"),
            fromWorkspace: true,
            verifyWorkspaceBranch: async () => branch === "main"
          },
          topic: selectionOf("topic", "resource other = {}")
        },
        compiled: { main: [], topic: [] },
        afterCompile: () => {
          branch = "topic";
          throw new Error("compiler failed after checkout");
        }
      });
      const entry = await container!.getOrCreate("panel-a");
      const response = await post(
        entry.baseUrl,
        view === "planned" ? "/api/plan-graph" : "/api/diff-branches",
        view === "planned" ?
          '{"repo":"octo/app","branch":"main"}'
        : '{"repo":"octo/app","base":"topic","head":"main"}'
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ stale: true });
      expect(harness.state.diffError).toBeUndefined();
      expect(
        harness.state.graphProgressRecords?.[view]?.graphBuildEvents ?? []
      ).not.toContainEqual(expect.objectContaining({ state: "failed" }));
    }
  );

  it("compares two branches over a real socket", async () => {
    const harness = start({
      selections: {
        main: selectionOf("main", "resource app = {}"),
        "feature/x": selectionOf("feature/x", "resource app = {}")
      },
      compiled: {
        main: [{ id: "res-a", name: "api" } as CanvasGraphResource],
        "feature/x": [
          { id: "res-a", name: "api" } as CanvasGraphResource,
          { id: "res-b", name: "cache" } as CanvasGraphResource
        ]
      }
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/diff-branches",
      '{"repo":"octo/app","base":"main","head":"feature/x"}'
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      '{"message":"Comparing main → feature/x","reload":true}'
    );
    expect(harness.state.page).toBe("graphDiff");
    expect(harness.state.diffResources).toHaveLength(2);
  });

  it.each(["main", "topic"])(
    "rejects the diff when the workspace side %s changes branch during disposal",
    async (workspaceBranch) => {
      let liveBranch = workspaceBranch;
      const workspaceSelection = {
        ...selectionOf(workspaceBranch, "workspace model"),
        fromWorkspace: true,
        verifyWorkspaceBranch: async () => liveBranch === workspaceBranch
      };
      const harness = start({
        selections: {
          main: selectionOf("main", "base model"),
          topic: selectionOf("topic", "head model"),
          [workspaceBranch]: workspaceSelection
        },
        compiled: { main: [], topic: [] },
        stageArtifacts: async () => ({
          dir: "fixture-stage",
          remote: true,
          handle: {
            dir: "fixture-stage",
            owned: true,
            fingerprint: "fixture",
            async dispose() {
              liveBranch = "other";
            }
          }
        })
      });
      const entry = await container!.getOrCreate("panel-a");

      const stale = await post(
        entry.baseUrl,
        "/api/diff-branches",
        '{"repo":"octo/app","base":"main","head":"topic"}'
      );

      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ stale: true });
      expect(harness.state.diffResources).toBeUndefined();
      expect(harness.state.activeGraphView).toBeUndefined();
    }
  );

  it("keeps the newer same-selection diff when the older disposal finishes last", async () => {
    let cleanupStarted = () => {};
    let releaseCleanup = () => {};
    const disposing = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const heldCleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const resource = (id: string): CanvasGraphResource => ({
      id,
      name: id,
      type: "Fixture/containers"
    });
    let holdFirst = true;
    const harness = start({
      selections: {
        main: selectionOf("main", "resource base = {}"),
        topic: selectionOf("topic", "resource head = {}")
      },
      compiled: { main: [], topic: [resource("older")] },
      stageArtifacts: async () => {
        const hold = holdFirst;
        holdFirst = false;
        return {
          dir: "fixture-stage",
          remote: true,
          handle: {
            dir: "fixture-stage",
            owned: true,
            fingerprint: "fixture",
            async dispose() {
              if (!hold) return;
              cleanupStarted();
              await heldCleanup;
            }
          }
        };
      }
    });
    const entry = await container!.getOrCreate("panel-a");
    const compare = () =>
      post(
        entry.baseUrl,
        "/api/diff-branches",
        '{"repo":"octo/app","base":"main","head":"topic"}'
      );
    const older = compare();
    try {
      await disposing;
      harness.script.compiled.topic = [resource("newer")];
      expect(await (await compare()).json()).toMatchObject({ reload: true });
    } finally {
      releaseCleanup();
    }
    const stale = await older;
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ stale: true });
    expect(harness.state.diffResources?.map(({ id }) => id)).toEqual(["newer"]);
  });

  it("refuses a comparison whose selection moved on, with 409", async () => {
    const harness = start({
      selections: {
        main: selectionOf("main", "resource app = {}"),
        "feature/x": selectionOf("feature/x", "resource app = {}")
      },
      compiled: { main: [], "feature/x": [] }
    });
    harness.script.afterCompile = () => {
      prepareSourceRefResources({ state: harness.state }, "diff", {
        repo: "octo/app",
        baseBranch: "main",
        headBranch: "other"
      });
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await post(
      entry.baseUrl,
      "/api/diff-branches",
      '{"repo":"octo/app","base":"main","head":"feature/x"}'
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toBe('{"stale":true}');
    expect(harness.state.page).toBeUndefined();
  });

  it.each([["/api/load-graph"], ["/api/plan-graph"], ["/api/diff-branches"]])(
    "delegates unmatched GET %s",
    async (path) => {
      start();
      const entry = await container!.getOrCreate("panel-a");
      // Only POST is declared, so the method flip must not reach the new handler.
      const response = await fetch(`${entry.baseUrl}${path}`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("unmatched");
    }
  );
});
