import { describe, expect, it } from "vitest";
import {
  compileGraphDefinition,
  createGraphReader,
  planGraphResources
} from "./pipeline.js";
import type {
  GraphPipelinePorts,
  GraphProgress,
  GraphSource
} from "./pipeline.js";
import { graphSourceBranch } from "./model-status.js";

const workspace: GraphSource = {
  kind: "workspace",
  repo: "owner/app",
  branch: "feature",
  workspacePath: "workspace"
};
const base = { kind: "committed", repo: "owner/app", ref: "base" } as const;
const head = { kind: "committed", repo: "owner/app", ref: "head" } as const;

function harness(
  contents: Record<string, string | null> = {
    base: "old",
    head: "new",
    feature: "uncommitted"
  }
) {
  const calls: string[] = [];
  const progress: GraphProgress[] = [];
  const ports: GraphPipelinePorts<string> = {
    async readDefinition(source) {
      calls.push(`read:${source.kind}:${graphSourceBranch(source)}`);
      const content = contents[graphSourceBranch(source)];
      if (content === undefined) throw new Error("unreadable revision");
      return { content, bicepPath: "" };
    },
    async stageArtifacts(source) {
      calls.push(`stage:${graphSourceBranch(source)}`);
      return {
        dir: graphSourceBranch(source),
        remote: source.kind === "committed"
      };
    },
    async buildGraphViaRad(content, path, options) {
      calls.push(`compile:${options.radArtifactsDir}:${content}`);
      expect(path).toBe(".radius/app.bicep");
      expect(options.cleanupRadArtifactsDir).toBe(false);
      return [content];
    },
    normalizeResources: (values) => values.map(String),
    graphDefinitionHash: (content, fingerprint) => `${content}:${fingerprint}`,
    radArtifactsFingerprint: (dir) => `artifacts:${dir}`,
    removeDirectory: (dir) => {
      calls.push(`remove:${dir}`);
    },
    computeDiff: (before, after) => [
      ...before.map((item) => `-${item}`),
      ...after.map((item) => `+${item}`)
    ]
  };
  return { ports, calls, progress, reader: createGraphReader(ports) };
}

describe("graph reader without a Canvas host", () => {
  it("supports individual stages for a missing definition without conflating its hash", async () => {
    const h = harness({ base: null });
    const prepared = await h.reader.prepare(await h.reader.select(base));
    await expect(h.reader.compile(prepared)).resolves.toEqual([]);
    expect(h.reader.definitionHash(prepared)).toBe(":artifacts:base");
    expect(h.reader.modelRevision(prepared.definition)).toBe(":");
    h.reader.discard({ remote: true, dir: "" });
    h.ports.buildGraphViaRad = async (content, path) => {
      expect(content).toBe("");
      expect(path).toBe("custom/app.bicep");
      return [];
    };
    await expect(
      compileGraphDefinition(
        { content: null, bicepPath: "custom/app.bicep" },
        {},
        h.ports
      )
    ).resolves.toEqual([]);
  });

  it("reads the authorized worktree, including uncommitted content, without removing it", async () => {
    const h = harness();
    await expect(
      h.reader.read(
        workspace,
        { progress: (event) => h.progress.push(event) },
        "workspace/graph.json"
      )
    ).resolves.toEqual({ kind: "completed", resources: ["uncommitted"] });
    expect(h.calls).toEqual([
      "read:workspace:feature",
      "stage:feature",
      "compile:feature:uncommitted"
    ]);
    expect(h.progress.map((event) => event.stage)).toEqual([
      "staging",
      "building",
      "building"
    ]);
    const prepared = await h.reader.prepare(await h.reader.select(workspace));
    expect(h.reader.definitionHash(prepared)).toBe(
      "uncommitted:artifacts:feature"
    );
    expect(h.reader.modelRevision(prepared.definition)).toBe("uncommitted:");
  });

  it("stages both committed sources before compiling either and releases both", async () => {
    const h = harness();
    await expect(
      h.reader.compare(base, head, {
        progress: (event) => h.progress.push(event)
      })
    ).resolves.toEqual({ kind: "completed", resources: ["-old", "+new"] });
    expect(h.calls).toEqual([
      "read:committed:base",
      "read:committed:head",
      "stage:base",
      "stage:head",
      "compile:base:old",
      "compile:head:new",
      "remove:base",
      "remove:head"
    ]);
    expect(h.progress.at(-1)).toEqual({
      stage: "comparing",
      status: "succeeded",
      resourceCount: 2
    });
  });

  it.each([
    { before: null, after: "new", resources: ["+new"] },
    { before: "old", after: null, resources: ["-old"] },
    { before: "", after: "new", resources: ["-", "+new"] }
  ])(
    "distinguishes absence from an empty file: $before -> $after",
    async ({ before, after, resources }) => {
      const h = harness({ base: before, head: after });
      await expect(h.reader.compare(base, head)).resolves.toEqual({
        kind: "completed",
        resources
      });
      expect(
        h.calls.filter((call) => call.startsWith("compile:"))
      ).toHaveLength(before === null || after === null ? 1 : 2);
    }
  );

  it("returns missing without staging or asking an agent when neither definition exists", async () => {
    const h = harness({ base: null, head: null });
    await expect(h.reader.compare(base, head)).resolves.toEqual({
      kind: "missing-definition"
    });
    await expect(h.reader.read(base)).resolves.toEqual({
      kind: "missing-definition"
    });
    expect(h.calls.every((call) => call.startsWith("read:"))).toBe(true);
  });

  it("propagates unreadable revisions instead of returning an empty comparison", async () => {
    const h = harness({ base: "old" });
    await expect(h.reader.compare(base, head)).rejects.toThrow(
      "unreadable revision"
    );
    expect(h.calls.some((call) => call.startsWith("stage:"))).toBe(false);
  });

  it("cleans the first side when staging the second fails", async () => {
    const h = harness();
    const stage = h.ports.stageArtifacts;
    h.ports.stageArtifacts = async (source, definition, log) => {
      if (graphSourceBranch(source) === "head") throw new Error("stage failed");
      return stage(source, definition, log);
    };
    await expect(h.reader.compare(base, head)).rejects.toThrow("stage failed");
    expect(h.calls.at(-1)).toBe("remove:base");
    expect(h.calls.some((call) => call.startsWith("compile:"))).toBe(false);
  });

  it("preserves a compile failure when cleanup fails and still cleans the other side", async () => {
    const h = harness();
    const primary = new Error("invalid bicep");
    const cleanup = new Error("cleanup failed");
    h.ports.buildGraphViaRad = async () => {
      throw primary;
    };
    h.ports.removeDirectory = (dir) => {
      h.calls.push(`remove:${dir}`);
      if (dir === "base") throw cleanup;
    };
    await expect(h.reader.compare(base, head)).rejects.toMatchObject({
      name: "AggregateError",
      message: "invalid bicep Graph artifact cleanup also failed.",
      cause: primary,
      errors: [primary, cleanup]
    });
    expect(h.calls.slice(-2)).toEqual(["remove:base", "remove:head"]);
  });

  it.each([0, 1, 2, 3])(
    "rejects a stale comparison at guard %i without committing results",
    async (guard) => {
      const h = harness();
      let checks = 0;
      await expect(
        h.reader.compare(base, head, { isCurrent: () => checks++ < guard })
      ).resolves.toEqual({ kind: "stale" });
      expect(
        h.calls.filter((call) => call.startsWith("compile:"))
      ).toHaveLength(Math.max(0, guard - 1));
      expect(h.calls.filter((call) => call.startsWith("remove:"))).toHaveLength(
        guard === 0 ? 0 : 2
      );
    }
  );

  it.each([0, 1, 2])(
    "rejects a stale standalone read at guard %i",
    async (guard) => {
      const h = harness();
      let checks = 0;
      await expect(
        h.reader.read(base, { isCurrent: () => checks++ < guard })
      ).resolves.toEqual({ kind: "stale" });
      expect(h.calls.filter((call) => call.startsWith("remove:"))).toHaveLength(
        guard === 0 ? 0 : 1
      );
    }
  );

  it.each([new Error("compile failed"), "compile failed", undefined])(
    "preserves a read failure and reports cleanup failure when the rejection is %s",
    async (primary) => {
      const h = harness();
      const cleanup = new Error("cleanup failed");
      h.ports.buildGraphViaRad = async () => {
        throw primary;
      };
      h.ports.removeDirectory = () => {
        throw cleanup;
      };
      await expect(h.reader.read(base)).rejects.toMatchObject({
        name: "AggregateError",
        cause: primary,
        errors: [primary, cleanup]
      });
    }
  );

  it.each(["read", "compare"] as const)(
    "rejects successful %s execution if cleanup fails, even without a diagnostics logger",
    async (operation) => {
      const h = harness();
      const cleanup = new Error("staged directory is busy");
      h.ports.removeDirectory = (directory) => {
        h.calls.push(`remove:${directory}`);
        throw cleanup;
      };
      await expect(
        operation === "read" ?
          h.reader.read(base)
        : h.reader.compare(base, head)
      ).rejects.toMatchObject({
        name: "AggregateError",
        message: "Graph artifact cleanup failed.",
        errors: operation === "read" ? [cleanup] : [cleanup, cleanup]
      });
      expect(h.calls.filter((call) => call.startsWith("remove:"))).toEqual(
        operation === "read" ? ["remove:base"] : ["remove:base", "remove:head"]
      );
    }
  );

  it("retains the original primary failure identity when cleanup succeeds", async () => {
    const h = harness();
    const primary = new Error("invalid bicep");
    h.ports.buildGraphViaRad = async () => {
      throw primary;
    };
    await expect(h.reader.read(base)).rejects.toBe(primary);
  });

  it("reports cleanup failures after cancellation instead of returning a silent stale result", async () => {
    const h = harness();
    const cleanup = new Error("cannot release staged directory");
    let checks = 0;
    h.ports.removeDirectory = () => {
      throw cleanup;
    };
    await expect(
      h.reader.compare(base, head, { isCurrent: () => checks++ === 0 })
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: [cleanup, cleanup]
    });
    expect(h.calls.some((call) => call.startsWith("compile:"))).toBe(false);
  });

  it("isolates simultaneous readers by their source-specific staging directories", async () => {
    const h = harness();
    await Promise.all([h.reader.read(base), h.reader.read(head)]);
    expect(h.calls.filter((call) => call.startsWith("remove:")).sort()).toEqual(
      ["remove:base", "remove:head"]
    );
  });

  it("resolves planned resources with the explicit provider and propagates recipe failure", async () => {
    const calls: string[] = [];
    const ports = {
      async fetchRecipePack(provider: string) {
        calls.push(provider);
        return ["recipe"];
      },
      async resolveRecipeOutputs(
        resources: string[],
        recipes: unknown[],
        provider: string
      ) {
        expect(recipes).toEqual(["recipe"]);
        return resources.map((resource) => `${provider}:${resource}`);
      },
      normalizeResources: (values: unknown[]) => values.map(String)
    };
    const recipeEvents: unknown[][] = [];
    await expect(
      planGraphResources(["app"], "azure", ports, (recipes) =>
        recipeEvents.push(recipes)
      )
    ).resolves.toEqual(["azure:app"]);
    expect(recipeEvents).toEqual([["recipe"]]);
    await expect(planGraphResources(["app"], "aws", ports)).resolves.toEqual([
      "aws:app"
    ]);
    expect(calls).toEqual(["azure", "aws"]);
    ports.fetchRecipePack = async () => {
      throw new Error("unreadable recipes");
    };
    await expect(planGraphResources(["app"], "aws", ports)).rejects.toThrow(
      "unreadable recipes"
    );
  });
});
