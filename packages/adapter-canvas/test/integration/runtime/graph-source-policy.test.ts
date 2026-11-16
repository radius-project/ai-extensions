import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  readdir
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createGraphSourceBindings,
  type DeploymentCommandExecutor
} from "@radius-project/adapter-shared";
import type { CanvasGraphResource } from "../../../src/shared.js";
import { PR_GRAPH_DIFF_MARKDOWN_HEADING } from "../../../src/pr-diff-markdown.js";
import { graphDiffResultText } from "../../../src/runtime/pr-graph-diff-result.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";

const REPO = "acme/widgets";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MOVED = "c".repeat(40);
const MODEL_PATH = ".radius/app.bicep";
const model = (name: string) => `resource ${name} 'Fixture/resources@v1' = {}`;
const resource = (name: string): CanvasGraphResource => ({
  id: name,
  name,
  type: "Fixture/resources"
});

async function fixture(
  workspaceBranch = "feature",
  definitionPath = MODEL_PATH,
  localContent = model("dirty")
) {
  const root = await mkdtemp(path.join(process.cwd(), ".runtime-graph-"));
  const workspace = path.join(root, "workspace");
  await mkdir(path.dirname(path.join(workspace, definitionPath)), {
    recursive: true
  });
  await writeFile(path.join(workspace, definitionPath), localContent);
  const configPath = path.posix.join(
    path.posix.dirname(definitionPath),
    "bicepconfig.json"
  );
  await writeFile(
    path.join(workspace, configPath),
    JSON.stringify({ extensions: {} })
  );
  const files = new Map([
    [`${BASE}:${definitionPath}`, model("committedBase")],
    [`${HEAD}:${definitionPath}`, model("committedHead")],
    [`${BASE}:${configPath}`, JSON.stringify({ extensions: {} })],
    [`${HEAD}:${configPath}`, JSON.stringify({ extensions: {} })]
  ]);
  const branches = new Map([
    ["main", BASE],
    ["feature", HEAD]
  ]);
  const failures = new Map<string, string>();
  const effects: string[] = [];
  const execute = vi.fn<DeploymentCommandExecutor>(
    (command, args, _options, callback) => {
      expect(command).toBe("gh");
      const endpoint = args[1];
      effects.push(`read:${endpoint}`);
      const failure = failures.get(endpoint);
      if (failure) {
        callback(new Error(failure), "", failure);
        return {};
      }
      const commit = /^\/repos\/acme\/widgets\/commits\/(.+)$/.exec(endpoint);
      if (commit) {
        const ref = decodeURIComponent(commit[1]);
        const sha = branches.get(ref) ?? (/^[abc]{40}$/.test(ref) ? ref : null);
        if (!sha) throw new Error(`Unscripted commit ${ref}`);
        callback(null, JSON.stringify({ sha }), "");
        return {};
      }
      const content = /^\/repos\/acme\/widgets\/contents\/(.+)\?ref=(.+)$/.exec(
        endpoint
      );
      if (!content) throw new Error(`Unscripted graph request ${endpoint}`);
      const bytes = files.get(
        `${content[2]}:${decodeURIComponent(content[1])}`
      );
      if (bytes === undefined) {
        callback(new Error("Not Found"), "", "Not Found (HTTP 404)");
      } else {
        callback(
          null,
          JSON.stringify({
            content: Buffer.from(bytes).toString("base64"),
            encoding: "base64",
            size: Buffer.byteLength(bytes)
          }),
          ""
        );
      }
      return {};
    }
  );
  const sources = createGraphSourceBindings({
    execute,
    redactDiagnostic: (message) => message,
    stagingRoot: path.join(root, "staged")
  });
  const stage = sources.stage;
  vi.spyOn(sources, "stage").mockImplementation(async (selection) => {
    const staged = await stage(selection);
    effects.push(`stage:${selection.source.ref}`);
    return {
      ...staged,
      dispose: async () => {
        effects.push(`dispose:${selection.source.ref}`);
        await staged.dispose();
      }
    };
  });
  const compiler = vi.fn(
    async (
      content: string,
      definition: string,
      options: { radArtifactsDir?: string; cleanupRadArtifactsDir?: boolean }
    ) => {
      effects.push(`compile:${content}`);
      expect(definition).toBe(definitionPath);
      expect(options.cleanupRadArtifactsDir).toBe(false);
      expect(options.radArtifactsDir).toBeTruthy();
      const config = await readFile(
        path.join(options.radArtifactsDir || "", "bicepconfig.json"),
        "utf8"
      );
      expect(JSON.parse(config)).toEqual({ extensions: {} });
      const known = new Map([
        [model("dirty"), resource("dirty")],
        [model("committedBase"), resource("committedBase")],
        [model("committedHead"), resource("committedHead")]
      ]);
      const result = known.get(content);
      if (!result) throw new Error("Unscripted compilation");
      return [result];
    }
  );
  const harness = await createRuntimeSdkHarness(
    {
      workspaceContext: {
        workspacePath: workspace,
        repo: REPO,
        branch: workspaceBranch
      }
    },
    (deps) => {
      deps.graphSources = sources;
      deps.rad.buildGraphViaRad = compiler;
    }
  );
  const tool = harness.extension.tools.find(
    ({ name }) => name === "radius_generate_pr_diff_markdown"
  );
  if (!tool) throw new Error("Missing registered PR graph tool");
  return {
    root,
    workspace,
    configPath,
    files,
    branches,
    failures,
    effects,
    execute,
    sources,
    compiler,
    harness,
    open: () =>
      harness.host.open("radius-panel", {
        page: "graph-diff",
        repo: REPO,
        baseBranch: "main",
        headBranch: "feature"
      }),
    compare: () =>
      tool.handler({ repo: REPO, baseBranch: "main", headBranch: "feature" }),
    async close() {
      await harness.extension.shutdown("test");
      await rm(root, { recursive: true, force: true });
    }
  };
}

describe("registered runtime graph source policy", () => {
  it.each(["main", "feature"])(
    "keeps dirty matching %s local in Canvas but compares GitHub commits in the PR tool",
    async (workspaceBranch) => {
      const f = await fixture(workspaceBranch);
      try {
        await f.open();
        const graph =
          f.harness.servers.get("radius-panel")?.state.diffResources;
        expect(graph?.map(({ id }) => id)).toContain("dirty");
        expect(graph?.map(({ id }) => id)).toContain(
          workspaceBranch === "main" ? "committedHead" : "committedBase"
        );
        expect(graph?.map(({ id }) => id)).not.toContain(
          workspaceBranch === "main" ? "committedBase" : "committedHead"
        );
        await f.harness.host.close("radius-panel");
        vi.mocked(f.harness.deps.workspace.detectWorkspaceContext).mockClear();
        f.harness.getOrCreateServer.mockClear();
        f.execute.mockClear();

        const result = await f.compare();

        expect(result).toMatchObject({
          resultType: "success",
          textResultForLlm: expect.stringContaining(
            PR_GRAPH_DIFF_MARKDOWN_HEADING
          ),
          sources: {
            base: { kind: "github", repo: REPO, ref: "main", revision: BASE },
            head: { kind: "github", repo: REPO, ref: "feature", revision: HEAD }
          },
          toolTelemetry: { radiusGraphDiff: { outcome: "diff" } }
        });
        expect(graphDiffResultText(result)).toContain("committedBase");
        expect(graphDiffResultText(result)).toContain("committedHead");
        expect(graphDiffResultText(result)).toContain(
          `Base source: \`${REPO}@${BASE}\``
        );
        expect(graphDiffResultText(result)).toContain(
          `Head source: \`${REPO}@${HEAD}\``
        );
        expect(graphDiffResultText(result)).not.toContain("dirty");
        expect(
          f.harness.deps.workspace.detectWorkspaceContext
        ).not.toHaveBeenCalled();
        expect(f.harness.getOrCreateServer).not.toHaveBeenCalled();
        expect(f.harness.session.rpc.canvas.open).not.toHaveBeenCalled();
        const reads = f.execute.mock.calls.map(([, args]) => args[1]);
        expect(
          reads
            .filter((entry) => entry.includes("/contents/"))
            .every(
              (entry) =>
                entry.endsWith(`ref=${BASE}`) || entry.endsWith(`ref=${HEAD}`)
            )
        ).toBe(true);
        expect(await readdir(path.join(f.root, "staged"))).toEqual([]);
        const lastComparison = f.effects.slice(
          f.effects.lastIndexOf(`read:/repos/${REPO}/commits/main`)
        );
        expect(
          lastComparison.filter(
            (effect) =>
              effect.startsWith("stage:") ||
              effect.startsWith("compile:") ||
              effect.startsWith("dispose:")
          )
        ).toEqual([
          "stage:main",
          "stage:feature",
          `compile:${model("committedBase")}`,
          `compile:${model("committedHead")}`,
          "dispose:main",
          "dispose:feature"
        ]);
      } finally {
        await f.close();
      }
    }
  );

  it("uses root model paths and root configuration on both ordinary and committed comparisons", async () => {
    const f = await fixture("main", "app.bicep");
    try {
      await f.open();
      expect(
        f.harness.servers.get("radius-panel")?.state.diffError
      ).toBeUndefined();
      const result = await f.compare();
      expect(result).toMatchObject({
        resultType: "success",
        sources: {
          base: { definitionPath: "app.bicep" },
          head: { definitionPath: "app.bicep" }
        }
      });
      expect(f.compiler).toHaveBeenCalledTimes(4);
    } finally {
      await f.close();
    }
  });

  it("pins supporting files to the resolved commit even if a branch moves before staging", async () => {
    const f = await fixture("feature");
    const stage = vi.mocked(f.sources.stage).getMockImplementation();
    if (!stage) throw new Error("Missing staging binding");
    vi.spyOn(f.sources, "stage").mockImplementation(async (selection) => {
      f.branches.set("feature", MOVED);
      return stage(selection);
    });
    try {
      const result = await f.compare();
      expect(result).toMatchObject({
        resultType: "success",
        sources: { head: { ref: "feature", revision: HEAD } }
      });
      expect(f.effects.some((entry) => entry.includes(`ref=${MOVED}`))).toBe(
        false
      );
      expect(f.compiler.mock.calls.map(([content]) => content)).toEqual([
        model("committedBase"),
        model("committedHead")
      ]);
    } finally {
      await f.close();
    }
  });

  it.each(["", " \n"])(
    "rejects present-empty local and committed definitions (%j) without compiling",
    async (content) => {
      const f = await fixture("main", MODEL_PATH, content);
      f.files.set(`${BASE}:${MODEL_PATH}`, content);
      f.files.set(`${BASE}:app.bicep`, model("committedBase"));
      await writeFile(path.join(f.workspace, "app.bicep"), model("dirty"));
      try {
        await f.open();
        expect(
          f.harness.servers.get("radius-panel")?.state.diffError
        ).toContain("empty");
        const result = await f.compare();
        expect(result).toMatchObject({
          resultType: "failure",
          error: expect.stringContaining("empty")
        });
        expect(f.compiler).not.toHaveBeenCalled();
        expect(f.harness.session.send).not.toHaveBeenCalled();
        expect(f.harness.session.rpc.canvas.open).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    }
  );

  it("keeps a missing matching model local instead of reading its committed replacement", async () => {
    const f = await fixture("main");
    await rm(path.join(f.workspace, MODEL_PATH));
    try {
      await f.open();
      expect(
        f.harness.servers.get("radius-panel")?.state.diffResources
      ).toMatchObject([{ id: "committedHead", diffStatus: "added" }]);
      expect(
        f.effects.some(
          (effect) => effect === `read:/repos/${REPO}/commits/main`
        )
      ).toBe(false);
      expect(f.compiler).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it("surfaces unreadable local definitions without root or remote fallback or authoring", async () => {
    const f = await fixture("main");
    await rm(path.join(f.workspace, MODEL_PATH));
    await mkdir(path.join(f.workspace, MODEL_PATH));
    await writeFile(path.join(f.workspace, "app.bicep"), model("dirty"));
    try {
      await f.open();
      expect(f.harness.servers.get("radius-panel")?.state.diffError).toContain(
        "EISDIR"
      );
      expect(
        f.effects.some(
          (effect) => effect === `read:/repos/${REPO}/commits/main`
        )
      ).toBe(false);
      expect(f.compiler).not.toHaveBeenCalled();
      expect(f.harness.session.send).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it.each(["base", "head"])(
    "disposes all staged PR inputs after %s compilation fails without opening Canvas",
    async (side) => {
      const f = await fixture("feature");
      const compile = f.compiler.getMockImplementation();
      if (!compile) throw new Error("Missing compiler");
      f.compiler.mockImplementation(async (...args) => {
        if (
          args[0] === model(side === "base" ? "committedBase" : "committedHead")
        ) {
          throw new Error("invalid Bicep diagnostic");
        }
        return compile(...args);
      });
      try {
        const result = await f.compare();
        expect(result).toMatchObject({
          resultType: "failure",
          error: expect.stringContaining("invalid Bicep diagnostic"),
          sources: { base: { revision: BASE }, head: { revision: HEAD } }
        });
        expect(graphDiffResultText(result)).toContain(
          `Base source: \`${REPO}@${BASE}\``
        );
        expect(graphDiffResultText(result)).toContain(
          `Head source: \`${REPO}@${HEAD}\``
        );
        expect(
          f.effects.filter((effect) => effect.startsWith("dispose:"))
        ).toEqual(["dispose:main", "dispose:feature"]);
        expect(await readdir(path.join(f.root, "staged"))).toEqual([]);
        expect(f.harness.getOrCreateServer).not.toHaveBeenCalled();
        expect(f.harness.session.send).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    }
  );

  it("disposes the first staged PR input if the second side cannot stage", async () => {
    const f = await fixture("feature");
    f.files.set(`${HEAD}:${f.configPath}`, "{ invalid json");
    try {
      const result = await f.compare();
      expect(result).toMatchObject({
        resultType: "failure",
        error: expect.stringContaining("not valid JSON")
      });
      expect(f.compiler).not.toHaveBeenCalled();
      expect(
        f.effects.filter((effect) => effect.startsWith("dispose:"))
      ).toEqual(["dispose:main"]);
      expect(await readdir(path.join(f.root, "staged"))).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("reports disposal failures diagnostically without replacing a successful PR result", async () => {
    const f = await fixture("feature");
    const stage = vi.mocked(f.sources.stage).getMockImplementation();
    if (!stage) throw new Error("Missing staging binding");
    vi.mocked(f.sources.stage).mockImplementation(async (selection) => {
      const staged = await stage(selection);
      return {
        ...staged,
        dispose: async () => {
          await staged.dispose();
          throw new Error("cleanup diagnostic");
        }
      };
    });
    try {
      const result = await f.compare();
      expect(result).toMatchObject({ resultType: "success" });
      expect(f.harness.deps.logError).toHaveBeenCalledTimes(2);
      expect(f.harness.deps.logError).toHaveBeenCalledWith(
        expect.stringContaining("cleanup diagnostic")
      );
      expect(
        f.effects.filter((effect) => effect.startsWith("dispose:"))
      ).toEqual(["dispose:main", "dispose:feature"]);
      expect(await readdir(path.join(f.root, "staged"))).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("cancels later work after a stale staging request settles and disposes that acquired handle", async () => {
    const f = await fixture("feature");
    const stage = vi.mocked(f.sources.stage).getMockImplementation();
    if (!stage) throw new Error("Missing staging binding");
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.sources.stage).mockImplementationOnce(async (selection) => {
      const staged = await stage(selection);
      await held;
      return staged;
    });
    try {
      const pending = f.open();
      await vi.waitFor(() => expect(f.effects).toContain("stage:main"));
      await f.harness.host.close("radius-panel");
      release?.();
      await pending;
      expect(f.compiler).not.toHaveBeenCalled();
      expect(f.sources.stage).toHaveBeenCalledTimes(1);
      expect(
        f.effects.filter((effect) => effect.startsWith("dispose:"))
      ).toEqual(["dispose:main"]);
      expect(await readdir(path.join(f.root, "staged"))).toEqual([]);
    } finally {
      release?.();
      await f.close();
    }
  });

  it.each(["graph", "close"])(
    "fences an in-flight runtime comparison after %s and disposes its staged input",
    async (navigation) => {
      const f = await fixture("feature");
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const compile = f.compiler.getMockImplementation();
      if (!compile) throw new Error("Missing compiler");
      f.compiler.mockImplementationOnce(async (...args) => {
        const resources = await compile(...args);
        await held;
        return resources;
      });
      try {
        const pending = f.open();
        await vi.waitFor(() => expect(f.compiler).toHaveBeenCalledTimes(1));
        const entry = f.harness.servers.get("radius-panel");
        if (navigation === "close") await f.harness.host.close("radius-panel");
        else await f.harness.host.open("radius-panel", { page: "graph" });
        release?.();
        await pending;
        expect(f.compiler).toHaveBeenCalledTimes(1);
        expect(entry?.state.diffResources).toBeUndefined();
        expect(entry?.state.diffError).toBeUndefined();
        expect(
          f.effects.filter((effect) => effect.startsWith("dispose:"))
        ).toEqual(["dispose:main"]);
        expect(await readdir(path.join(f.root, "staged"))).toEqual([]);
        expect(f.harness.session.send).not.toHaveBeenCalled();
      } finally {
        release?.();
        await f.close();
      }
    }
  );

  it("reports remote failure without falling back to matching local content or opening a panel", async () => {
    const f = await fixture("main");
    f.failures.set(
      `/repos/${REPO}/commits/main`,
      "permission denied (HTTP 403)"
    );
    try {
      const result = await f.compare();
      expect(result).toMatchObject({
        resultType: "failure",
        error: expect.stringContaining("permission denied")
      });
      expect(f.compiler).not.toHaveBeenCalled();
      expect(
        f.harness.deps.workspace.detectWorkspaceContext
      ).not.toHaveBeenCalled();
      expect(f.harness.getOrCreateServer).not.toHaveBeenCalled();
      expect(f.harness.session.send).not.toHaveBeenCalled();
      expect(f.harness.session.rpc.canvas.open).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("distinguishes confirmed absence from read failures and never authors missing committed models", async () => {
    const f = await fixture("main");
    f.files.delete(`${BASE}:${MODEL_PATH}`);
    f.files.delete(`${HEAD}:${MODEL_PATH}`);
    await rm(path.join(f.workspace, MODEL_PATH));
    try {
      await f.open();
      expect(f.harness.servers.get("radius-panel")?.state.diffError).toContain(
        "No .radius/app.bicep or app.bicep"
      );
      await f.harness.host.close("radius-panel");
      f.harness.getOrCreateServer.mockClear();
      const result = await f.compare();
      expect(result).toMatchObject({
        resultType: "success",
        textResultForLlm: expect.stringContaining(
          "Create the pull request without a graph diff section"
        ),
        toolTelemetry: { radiusGraphDiff: { outcome: "unavailable" } },
        sources: { base: { revision: BASE }, head: { revision: HEAD } }
      });
      expect(graphDiffResultText(result)).toContain(
        `Base source: \`${REPO}@${BASE}\``
      );
      expect(graphDiffResultText(result)).toContain(
        `Head source: \`${REPO}@${HEAD}\``
      );
      expect(f.compiler).not.toHaveBeenCalled();
      expect(f.harness.getOrCreateServer).not.toHaveBeenCalled();
      expect(f.harness.session.send).not.toHaveBeenCalled();
      expect(f.harness.session.rpc.canvas.open).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it.each(["base", "head"])(
    "renders a committed application's first addition or last removal when %s is absent",
    async (absentSide) => {
      const f = await fixture("main");
      f.files.delete(`${absentSide === "base" ? BASE : HEAD}:${MODEL_PATH}`);
      try {
        const result = await f.compare();
        expect(result).toMatchObject({
          resultType: "success",
          toolTelemetry: { radiusGraphDiff: { outcome: "diff" } },
          sources: { base: { revision: BASE }, head: { revision: HEAD } }
        });
        expect(graphDiffResultText(result)).toContain(
          absentSide === "base" ? "Added" : "Removed"
        );
        expect(f.compiler).toHaveBeenCalledTimes(1);
        expect(f.harness.getOrCreateServer).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    }
  );
});
