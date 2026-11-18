import { describe, expect, it } from "vitest";
import {
  BlankModelAuthoringFailed,
  createGraphPipeline,
  graphArtifactHandle,
  DEFAULT_APP_BICEP_PATH,
  type AppBicepSelection,
  type GraphCompileOptions,
  type GraphPipelineDependencies,
  type RadArtifactsRequest,
  type StagedRadArtifacts
} from "./graph-pipeline.js";
import type { CanvasGraphResource, CanvasState } from "../../shared.js";

interface CompileCall {
  content: string;
  definitionFile: string;
  options: GraphCompileOptions;
}

interface Recorder {
  selections: Array<{ state: CanvasState; repo: string; branch: string }>;
  artifactRequests: RadArtifactsRequest[];
  compiles: CompileCall[];
  normalized: unknown[][];
  removed: string[];
  jsonPaths: Array<{ state: CanvasState; bicepRepoPath: unknown }>;
  hashes: Array<{ content: string; fingerprint: string }>;
  fingerprinted: Array<string | undefined>;
}

interface Script {
  selection?: AppBicepSelection;
  staged?: StagedRadArtifacts;
  built?: unknown[];
  fingerprint?: string;
  jsonPath?: string;
  removeThrows?: Error;
}

function selectionOf(
  overrides: Partial<AppBicepSelection> = {}
): AppBicepSelection {
  return {
    content: "resource app 'Radius.Compute/containers'",
    fromWorkspace: false,
    branch: "main",
    bicepPath: "",
    ...overrides
  };
}

// Every seam throws on an unscripted call so a stage that quietly reaches for a
// dependency the scenario did not model fails loudly instead of succeeding on a
// default. The two pure helpers the pipeline composes (`bicepPathOf`'s fallback
// and the `fromWorkspace` gate) are exercised through real behavior rather than
// asserted on the fakes.
function build(script: Script = {}): {
  pipeline: ReturnType<typeof createGraphPipeline>;
  calls: Recorder;
} {
  const calls: Recorder = {
    selections: [],
    artifactRequests: [],
    compiles: [],
    normalized: [],
    removed: [],
    jsonPaths: [],
    hashes: [],
    fingerprinted: []
  };
  const dependencies: GraphPipelineDependencies = {
    fetchBicepSelection: (entry, repo, branch) => {
      calls.selections.push({ state: entry.state, repo, branch });
      if (!script.selection) throw new Error("unscripted fetchBicepSelection");
      return Promise.resolve(script.selection);
    },
    resolveRadArtifactsDir: (request) => {
      calls.artifactRequests.push(request);
      if (!script.staged) throw new Error("unscripted resolveRadArtifactsDir");
      return Promise.resolve(script.staged);
    },
    buildGraphViaRad: (content, definitionFile, options) => {
      calls.compiles.push({ content, definitionFile, options });
      if (!script.built) throw new Error("unscripted buildGraphViaRad");
      return Promise.resolve(script.built);
    },
    canvasGraphResources: (values) => {
      calls.normalized.push(values);
      return values.map((value) => ({
        ...(value as Record<string, unknown>),
        normalized: true
      })) as unknown as CanvasGraphResource[];
    },
    workspaceGraphJsonPath: (state, bicepRepoPath) => {
      calls.jsonPaths.push({ state, bicepRepoPath });
      return script.jsonPath ?? "/ws/.radius/app-graph.json";
    },
    graphDefinitionHash: (content, fingerprint) => {
      calls.hashes.push({ content, fingerprint });
      return `hash(${content}|${fingerprint})`;
    },
    removeDirectory: (dir) => {
      calls.removed.push(dir);
      if (script.removeThrows) throw script.removeThrows;
    }
  };
  return { pipeline: createGraphPipeline(dependencies), calls };
}

describe("graph pipeline", () => {
  it("disposes an owned temporary artifact directory through its owning handle", async () => {
    const removed: string[] = [];
    await graphArtifactHandle({ dir: "/temporary", remote: true }, (dir) => {
      removed.push(dir);
    }).dispose();
    expect(removed).toEqual(["/temporary"]);
  });

  it("preserves the typed revision, root path, and shared ownership handle through compilation", async () => {
    let disposed = 0;
    const sourceRead = {
      status: "present" as const,
      source: {
        kind: "github" as const,
        repo: "octo/app",
        ref: "topic",
        revision: "a".repeat(40),
        definitionPath: "app.bicep"
      },
      content: "root model"
    };
    const handle = {
      dir: "/staging",
      owned: true,
      fingerprint: "captured-config",
      dispose: async () => {
        disposed += 1;
      }
    };
    const selection = selectionOf({
      content: sourceRead.content,
      bicepPath: "app.bicep",
      sourceRead
    });
    const { pipeline, calls } = build({
      staged: { dir: handle.dir, remote: true, handle },
      built: []
    });
    const staged = await pipeline.stageArtifacts({
      entry: { state: {} },
      selection,
      repo: "octo/app",
      branch: "topic"
    });
    await pipeline.compileResources({ selection, staged });
    await pipeline.discardStagedArtifacts(staged);
    expect(calls.artifactRequests[0]?.selection).toBe(sourceRead);
    expect(calls.compiles[0]).toMatchObject({
      content: "root model",
      definitionFile: "app.bicep",
      options: { radArtifactsDir: "/staging", cleanupRadArtifactsDir: false }
    });
    expect(disposed).toBe(1);
  });

  it.each([
    { dir: "/workspace", remote: false },
    { dir: "", remote: true }
  ])(
    "never deletes borrowed or empty artifact directories ($dir)",
    async (staged) => {
      const removed: string[] = [];
      await graphArtifactHandle(staged, (dir) => {
        removed.push(dir);
      }).dispose();
      expect(removed).toEqual([]);
    }
  );

  it.each([true, false])(
    "retains a single cleanup owner for prepared artifacts (remote=%s)",
    async (remote) => {
      const { pipeline, calls } = build({
        staged: { dir: "/artifacts", remote }
      });
      const staged = await pipeline.stageArtifacts({
        entry: { state: {} },
        selection: selectionOf(),
        repo: "octo/app",
        branch: "main"
      });
      await pipeline.discardStagedArtifacts(staged);
      expect(calls.removed).toEqual(remote ? ["/artifacts"] : []);
    }
  );

  it("does not stage a confirmed absent source", async () => {
    const { pipeline, calls } = build();
    expect(
      await pipeline.stageArtifacts({
        entry: { state: {} },
        selection: selectionOf({ content: null }),
        repo: "octo/app",
        branch: "main"
      })
    ).toMatchObject({ dir: "", remote: false });
    expect(calls.artifactRequests).toEqual([]);
  });

  describe("bicepPathOf", () => {
    it("falls back to the default path for an empty bicepPath", () => {
      const { pipeline } = build();
      expect(pipeline.bicepPathOf(selectionOf({ bicepPath: "" }))).toBe(
        DEFAULT_APP_BICEP_PATH
      );
      expect(DEFAULT_APP_BICEP_PATH).toBe(".radius/app.bicep");
    });

    it("keeps a resolved workspace path", () => {
      const { pipeline } = build();
      expect(
        pipeline.bicepPathOf(selectionOf({ bicepPath: "infra/app.bicep" }))
      ).toBe("infra/app.bicep");
    });
  });

  describe("selectAppBicep", () => {
    it.each([
      {
        selection: "workspace",
        fromWorkspace: true,
        attempt: "current",
        terminal: true
      },
      {
        selection: "workspace",
        fromWorkspace: true,
        attempt: "stale",
        terminal: false
      },
      {
        selection: "GitHub",
        fromWorkspace: false,
        attempt: "current",
        terminal: false
      }
    ])(
      "classifies a blank $selection definition with a $attempt failure",
      async ({ fromWorkspace, attempt, terminal }) => {
        const target = "octo/app::main";
        const state: CanvasState = {
          appModelAttemptTokens: { [target]: "current" },
          appModelFailures: {
            [target]: { attemptToken: attempt, error: "No supported resource." }
          }
        };
        const { pipeline } = build({
          selection: selectionOf({ content: " \n", fromWorkspace })
        });

        const selected = pipeline.selectAppBicep({ state }, "octo/app", "main");
        if (terminal) {
          await expect(selected).rejects.toBeInstanceOf(
            BlankModelAuthoringFailed
          );
          await expect(selected).rejects.toThrow(
            "No supported resource. Fix or remove the empty .radius/app.bicep in the workspace, then select Refresh."
          );
        } else {
          await expect(selected).rejects.not.toBeInstanceOf(
            BlankModelAuthoringFailed
          );
          await expect(selected).rejects.toThrow(
            "octo/app@main:.radius/app.bicep is empty; the graph is unavailable."
          );
        }
      }
    );

    it.each(["", " \n\t"])(
      "rejects a present empty definition without compiling",
      async (content) => {
        const { pipeline, calls } = build({
          selection: selectionOf({ content, bicepPath: "app.bicep" })
        });
        await expect(
          pipeline.selectAppBicep({ state: {} }, "octo/app", "feature/x")
        ).rejects.toThrow("app.bicep is empty");
        expect(calls.compiles).toEqual([]);
        expect(calls.artifactRequests).toEqual([]);
      }
    );

    it("passes the entry state and selection through to the reader", async () => {
      const selection = selectionOf({ branch: "feature/x" });
      const { pipeline, calls } = build({ selection });
      const state: CanvasState = { workspaceRepo: "octo/app" };

      await expect(
        pipeline.selectAppBicep({ state }, "octo/app", "feature/x")
      ).resolves.toBe(selection);
      expect(calls.selections).toEqual([
        { state, repo: "octo/app", branch: "feature/x" }
      ]);
    });
  });

  describe("stageArtifacts", () => {
    it("stages a remote branch with the default bicep path and the log", async () => {
      const staged = { dir: "/tmp/staged", remote: true };
      const { pipeline, calls } = build({ staged });
      const state: CanvasState = {};
      const log = (): void => {};

      await expect(
        pipeline.stageArtifacts({
          entry: { state },
          selection: selectionOf({ fromWorkspace: false, bicepPath: "" }),
          repo: "octo/app",
          branch: "main",
          log
        })
      ).resolves.toMatchObject(staged);
      expect(calls.artifactRequests).toEqual([
        {
          selection: expect.objectContaining({ status: "present" }),
          isLocal: false,
          state,
          repo: "octo/app",
          branch: "main",
          bicepRepoPath: DEFAULT_APP_BICEP_PATH,
          log
        }
      ]);
    });

    it("marks a workspace selection local and omits the log when none is given", async () => {
      const { pipeline, calls } = build({
        staged: { dir: "/ws/.radius", remote: false }
      });

      await pipeline.stageArtifacts({
        entry: { state: {} },
        selection: selectionOf({
          fromWorkspace: true,
          bicepPath: "infra/app.bicep"
        }),
        repo: "octo/app",
        branch: "feature/x"
      });

      expect(calls.artifactRequests[0]).toMatchObject({
        isLocal: true,
        bicepRepoPath: "infra/app.bicep",
        log: undefined
      });
    });
  });

  describe("compileResources", () => {
    it("compiles through rad and normalizes the result", async () => {
      const { pipeline, calls } = build({
        built: [{ id: "res-a" }]
      });
      const log = (): void => {};

      const resources = await pipeline.compileResources({
        selection: selectionOf({ content: "app bicep", bicepPath: "" }),
        staged: { dir: "/tmp/staged", remote: true },
        log,
        saveGraphJsonTo: "/ws/.radius/app-graph.json"
      });

      expect(calls.compiles).toEqual([
        {
          content: "app bicep",
          definitionFile: DEFAULT_APP_BICEP_PATH,
          options: {
            log,
            saveGraphJsonTo: "/ws/.radius/app-graph.json",
            radArtifactsDir: "/tmp/staged",
            cleanupRadArtifactsDir: false
          }
        }
      ]);
      expect(resources).toEqual([{ id: "res-a", normalized: true }]);
    });

    it("contributes no resources for confirmed absence without invoking rad", async () => {
      const { pipeline, calls } = build({ built: [] });

      const resources = await pipeline.compileResources({
        selection: selectionOf({ content: null }),
        staged: { dir: "", remote: false }
      });

      expect(resources).toEqual([]);
      expect(calls.compiles).toEqual([]);
    });

    it("refuses present-empty content even when a caller bypasses selection", async () => {
      const { pipeline, calls } = build();
      await expect(
        pipeline.compileResources({
          selection: selectionOf({ content: "" }),
          staged: { dir: "", remote: false }
        })
      ).rejects.toThrow("is empty");
      expect(calls.compiles).toEqual([]);
    });
  });

  describe("toCanvasResources", () => {
    it("normalizes values that never went through rad", () => {
      const { pipeline, calls } = build();
      expect(pipeline.toCanvasResources([{ id: "planned" }])).toEqual([
        { id: "planned", normalized: true }
      ]);
      expect(calls.normalized).toEqual([[{ id: "planned" }]]);
    });
  });

  describe("graphJsonPathFor", () => {
    it("resolves a workspace path only for a workspace selection", () => {
      const { pipeline, calls } = build({ jsonPath: "/ws/app-graph.json" });
      const state: CanvasState = { workspacePath: "/ws" };

      expect(
        pipeline.graphJsonPathFor(
          { state },
          selectionOf({ fromWorkspace: true, bicepPath: "infra/app.bicep" })
        )
      ).toBe("/ws/app-graph.json");
      expect(calls.jsonPaths).toEqual([
        { state, bicepRepoPath: "infra/app.bicep" }
      ]);
    });

    it("returns an empty path for a remote selection without consulting the workspace", () => {
      const { pipeline, calls } = build();

      expect(
        pipeline.graphJsonPathFor(
          { state: { workspacePath: "/ws" } },
          selectionOf({ fromWorkspace: false })
        )
      ).toBe("");
      expect(calls.jsonPaths).toEqual([]);
    });
  });

  describe("definitionHashFor", () => {
    it("hashes the bicep together with the staged artifacts fingerprint", () => {
      const { pipeline, calls } = build();

      expect(
        pipeline.definitionHashFor(selectionOf({ content: "app bicep" }), {
          dir: "/tmp/staged",
          remote: true,
          handle: {
            dir: "/tmp/staged",
            owned: true,
            fingerprint: "artifacts-v2",
            dispose: async () => {}
          }
        })
      ).toBe("hash(app bicep|artifacts-v2)");
      expect(calls.hashes).toEqual([
        { content: "app bicep", fingerprint: "artifacts-v2" }
      ]);
    });

    it("hashes empty content when the selection carries none", () => {
      const { pipeline, calls } = build();

      pipeline.definitionHashFor(selectionOf({ content: null }), {
        dir: "",
        remote: false
      });

      expect(calls.hashes[0]?.content).toBe("");
    });
  });

  describe("modelRevisionFor", () => {
    it("hashes only the selected model content", () => {
      const { pipeline, calls } = build();

      expect(
        pipeline.modelRevisionFor(selectionOf({ content: "app bicep" }))
      ).toBe("hash(app bicep|)");
      expect(calls.hashes).toEqual([{ content: "app bicep", fingerprint: "" }]);
      expect(calls.fingerprinted).toEqual([]);
    });

    it("hashes empty content when the selection carries none", () => {
      const { pipeline, calls } = build();

      pipeline.modelRevisionFor(selectionOf({ content: null }));

      expect(calls.hashes[0]?.content).toBe("");
    });
  });

  describe("discardStagedArtifacts", () => {
    it("removes a staged remote directory", () => {
      const { pipeline, calls } = build();
      pipeline.discardStagedArtifacts({ dir: "/tmp/staged", remote: true });
      expect(calls.removed).toEqual(["/tmp/staged"]);
    });

    it.each([
      ["a workspace directory", { dir: "/ws/.radius", remote: false }],
      ["a remote selection that staged nothing", { dir: "", remote: true }],
      ["neither", { dir: "", remote: false }]
    ])("never removes %s", (_label, staged) => {
      const { pipeline, calls } = build();
      pipeline.discardStagedArtifacts(staged);
      expect(calls.removed).toEqual([]);
    });

    it("propagates a removal failure so the caller decides whether it matters", () => {
      const { pipeline } = build({ removeThrows: new Error("EBUSY") });
      expect(() =>
        pipeline.discardStagedArtifacts({ dir: "/tmp/staged", remote: true })
      ).toThrow("EBUSY");
    });
  });
});
