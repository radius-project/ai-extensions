import { describe, expect, it } from "vitest";
import {
  createGraphOrchestrator,
  prepareGraph,
  compilePreparedGraph,
  enrichPlannedGraph,
  type GraphOrchestrationPorts
} from "./graph-orchestration.js";
import type { GraphSourceRead } from "./graph-source.js";

const selection = (
  ref: string,
  content: string | null = "model"
): GraphSourceRead => ({
  source: {
    repo: "owner/repository",
    ref,
    definitionPath: "custom/app.bicep",
    kind: "github",
    revision: ref.repeat(40).slice(0, 40)
  },
  ...(content === null ?
    { status: "absent" as const }
  : { status: "present" as const, content })
});

function harness(
  failure?: string,
  options: { borrowed?: boolean; cleanupFails?: boolean } = {}
) {
  const effects: string[] = [];
  const ports: GraphOrchestrationPorts<string, string> = {
    async stage(read) {
      effects.push(`stage:${read.source.ref}`);
      if (failure === `stage:${read.source.ref}`) throw new Error(failure);
      return {
        dir: read.source.ref,
        owned: !options.borrowed,
        fingerprint: "fingerprint",
        async dispose() {
          effects.push(`dispose:${read.source.ref}`);
          if (options.cleanupFails) throw new Error("cleanup denied");
        }
      };
    },
    async compile(content, definitionPath, options) {
      const ref = options.radArtifactsDir;
      effects.push(`compile:${ref}`);
      expect(content).toBe("model");
      expect(definitionPath).toBe("custom/app.bicep");
      expect(options.cleanupRadArtifactsDir).toBe(false);
      if (failure === `compile:${ref}`) throw new Error(failure);
      return [ref];
    },
    diff(base, head) {
      effects.push("diff");
      return `${base.join(",")}=>${head.join(",")}`;
    },
    diagnostic(message) {
      effects.push(message);
    }
  };
  return { graph: createGraphOrchestrator(ports), effects, ports };
}

describe("graph orchestration", () => {
  it("supports cache preparation and compilation with only their required ports", async () => {
    const effects: string[] = [];
    const selected = selection("a");
    const prepared = await prepareGraph(selected, async (input) => {
      expect(input).toBe(selected);
      effects.push("stage");
      return {
        dir: "artifacts",
        owned: true,
        fingerprint: "supporting-inputs",
        async dispose() {
          effects.push("dispose");
        }
      };
    });
    expect(prepared.staged?.fingerprint).toBe("supporting-inputs");
    expect(effects).toEqual(["stage"]);
    try {
      expect(
        await compilePreparedGraph(prepared, async (content, file, options) => {
          effects.push("compile");
          expect([content, file, options]).toEqual([
            "model",
            "custom/app.bicep",
            { radArtifactsDir: "artifacts", cleanupRadArtifactsDir: false }
          ]);
          return [{ name: "application" }];
        })
      ).toEqual([{ name: "application" }]);
      expect(effects).toEqual(["stage", "compile"]);
    } finally {
      await prepared.staged?.dispose();
    }
    expect(effects).toEqual(["stage", "compile", "dispose"]);
  });

  it("enriches already-authored resources without constructing compiler or diff ports", async () => {
    const effects: string[] = [];
    const result = await enrichPlannedGraph([{ name: "authored" }], "azure", {
      async fetchRecipePack(provider) {
        effects.push(`recipes:${provider}`);
        return [{ name: "default" }];
      },
      async resolveRecipeOutputs(resources, recipes, provider) {
        effects.push("outputs");
        expect([resources, recipes, provider]).toEqual([
          [{ name: "authored" }],
          [{ name: "default" }],
          "azure"
        ]);
        return [{ name: "planned" }];
      }
    });
    expect(result).toEqual({
      resources: [{ name: "planned" }],
      recipes: [{ name: "default" }]
    });
    expect(effects).toEqual(["recipes:azure", "outputs"]);
  });

  it("stages both sources before compiling, retains identities and disposes once", async () => {
    const { graph, effects } = harness();
    const result = await graph.compare(selection("a"), selection("b"));
    expect(result).toMatchObject({
      status: "compared",
      base: { ref: "a" },
      head: { ref: "b" },
      baseResources: ["a"],
      headResources: ["b"],
      diff: "a=>b"
    });
    expect(effects).toEqual([
      "stage:a",
      "stage:b",
      "compile:a",
      "compile:b",
      "diff",
      "dispose:a",
      "dispose:b"
    ]);
  });

  it.each([
    ["stage:b", ["stage:a", "stage:b", "dispose:a"]],
    [
      "compile:a",
      ["stage:a", "stage:b", "compile:a", "dispose:a", "dispose:b"]
    ],
    [
      "compile:b",
      ["stage:a", "stage:b", "compile:a", "compile:b", "dispose:a", "dispose:b"]
    ]
  ])(
    "preserves %s failure and cleans acquired handles",
    async (failure, expected) => {
      const { graph, effects } = harness(failure);
      await expect(
        graph.compare(selection("a"), selection("b"))
      ).rejects.toThrow(failure);
      expect(effects).toEqual(expected);
    }
  );

  it("treats confirmed absence as an empty side without staging or compiling", async () => {
    const { graph, effects } = harness();
    expect(
      await graph.compare(selection("a", null), selection("b"))
    ).toMatchObject({
      status: "compared",
      baseResources: [],
      diff: "=>b"
    });
    expect(effects).toEqual(["stage:b", "compile:b", "diff", "dispose:b"]);
    effects.length = 0;
    expect(
      await graph.compare(selection("a", null), selection("b", null))
    ).toMatchObject({ status: "definitions-absent" });
    expect(effects).toEqual([]);
    expect(await graph.authored(selection("a", null))).toMatchObject({
      status: "definition-absent",
      resources: []
    });
  });

  it.each(["", " \n "])(
    "rejects empty input %j before staging",
    async (content) => {
      const { graph, effects } = harness();
      await expect(
        graph.compare(selection("a"), selection("b", content))
      ).rejects.toMatchObject({ code: "empty" });
      expect(effects).toEqual([]);
    }
  );

  it("preserves unavailable diagnostics, never compiling them as absence", async () => {
    const { graph, effects } = harness();
    await expect(
      graph.authored({
        status: "unavailable",
        source: selection("a").source,
        diagnostic: "access denied"
      })
    ).rejects.toMatchObject({ code: "unavailable", message: "access denied" });
    expect(effects).toEqual([]);
  });

  it("waits for compilation to settle before honoring cancellation and disposal", async () => {
    const { graph, effects, ports } = harness();
    let cancelled = false;
    ports.compile = async () => {
      effects.push("compile-settled");
      cancelled = true;
      return ["late"];
    };
    await expect(
      graph.compare(selection("a"), selection("b"), {
        checkCancelled() {
          if (cancelled) throw new Error("cancelled");
        }
      })
    ).rejects.toThrow("cancelled");
    expect(effects).toEqual([
      "stage:a",
      "stage:b",
      "compile-settled",
      "dispose:a",
      "dispose:b"
    ]);
  });

  it("owns a just-staged handle when cancellation arrives during staging", async () => {
    const { graph, effects, ports } = harness();
    const stage = ports.stage;
    let cancelled = false;
    ports.stage = async (input) => {
      const staged = await stage(input);
      cancelled = true;
      return staged;
    };
    await expect(
      graph.authored(selection("a"), {
        checkCancelled() {
          if (cancelled) throw new Error("cancelled");
        }
      })
    ).rejects.toThrow("cancelled");
    expect(effects).toEqual(["stage:a", "dispose:a"]);
  });

  it("keeps cleanup failures diagnostic-only and attempts all disposals", async () => {
    const { graph, effects } = harness("compile:a", { cleanupFails: true });
    await expect(graph.compare(selection("a"), selection("b"))).rejects.toThrow(
      "compile:a"
    );
    expect(effects.filter((effect) => effect.startsWith("dispose:"))).toEqual([
      "dispose:a",
      "dispose:b"
    ]);
    expect(
      effects.filter((effect) => effect.includes("cleanup failed"))
    ).toHaveLength(2);
    const success = harness(undefined, { cleanupFails: true });
    success.ports.diagnostic = () => {
      throw new Error("broken logger");
    };
    expect(await success.graph.authored(selection("a"))).toMatchObject({
      status: "authored",
      resources: ["a"]
    });
  });

  it("supports pre-staged cache decisions without transferring disposal ownership", async () => {
    const { graph, effects } = harness();
    const base = await graph.prepare(selection("a"));
    const head = await graph.prepare(selection("b"));
    try {
      expect(await graph.comparePrepared(base, head)).toMatchObject({
        status: "compared",
        diff: "a=>b"
      });
      expect(effects).toEqual([
        "stage:a",
        "stage:b",
        "compile:a",
        "compile:b",
        "diff"
      ]);
      effects.length = 0;
      await expect(
        graph.comparePrepared(base, { selection: selection("c") })
      ).rejects.toThrow("has not been staged");
      expect(effects).toEqual([]);
    } finally {
      await graph.disposePrepared(base);
      await graph.disposePrepared(head);
    }
    expect(effects).toEqual(["dispose:a", "dispose:b"]);
  });

  it("borrows workspace directories and makes explicit disposal idempotent", async () => {
    const borrowed = harness(undefined, { borrowed: true });
    await borrowed.graph.authored(selection("a"));
    expect(borrowed.effects).toEqual(["stage:a", "compile:a"]);
    const { graph, effects } = harness();
    const prepared = await graph.prepare(selection("a"));
    expect(prepared.staged?.fingerprint).toBe("fingerprint");
    await graph.compilePrepared(prepared);
    await graph.disposePrepared(prepared);
    await graph.disposePrepared(prepared);
    expect(effects).toEqual(["stage:a", "compile:a", "dispose:a"]);
    await expect(
      graph.compilePrepared({ selection: selection("b") })
    ).rejects.toThrow("has not been staged");
  });

  it("emits host-neutral phase events and returns recipes with enrichment", async () => {
    const { graph } = harness();
    const phases: string[] = [];
    await graph.compare(selection("a"), selection("b"), {
      onPhase: (phase, side) => phases.push(`${phase}:${side ?? ""}`)
    });
    expect(phases).toEqual([
      "staging:base",
      "staging:head",
      "compiling:base",
      "compiling:head",
      "comparing:"
    ]);
    const enriched = await graph.enrich(
      ["authored"],
      "azure",
      {
        async fetchRecipePack(provider) {
          expect(provider).toBe("azure");
          return ["recipe"];
        },
        async resolveRecipeOutputs(resources, recipes, provider) {
          expect([resources, recipes, provider]).toEqual([
            ["authored"],
            ["recipe"],
            "azure"
          ]);
          return ["planned"];
        }
      },
      { onPhase: (phase) => phases.push(phase) }
    );
    expect(enriched).toEqual({ resources: ["planned"], recipes: ["recipe"] });
    expect(phases.at(-1)).toBe("enriching");
  });

  it("propagates recipe failures and fences late enrichment", async () => {
    const { graph } = harness();
    await expect(
      graph.enrich([], "azure", {
        async fetchRecipePack() {
          throw new Error("pack unavailable");
        },
        async resolveRecipeOutputs() {
          throw new Error("unexpected");
        }
      })
    ).rejects.toThrow("pack unavailable");
    let cancelled = false;
    await expect(
      graph.enrich(
        [],
        "azure",
        {
          async fetchRecipePack() {
            return [];
          },
          async resolveRecipeOutputs() {
            cancelled = true;
            return [];
          }
        },
        {
          checkCancelled() {
            if (cancelled) throw new Error("cancelled");
          }
        }
      )
    ).rejects.toThrow("cancelled");
  });

  it("accepts non-Error cleanup diagnostics without requiring a diagnostic sink", async () => {
    const { graph, ports, effects } = harness();
    const stage = ports.stage;
    ports.stage = async (input) => ({
      ...(await stage(input)),
      async dispose() {
        throw "cleanup unavailable";
      }
    });
    expect(await graph.authored(selection("a"))).toMatchObject({
      status: "authored"
    });
    expect(effects.at(-1)).toContain("cleanup unavailable");
    ports.diagnostic = undefined;
    expect(await graph.authored(selection("b"))).toMatchObject({
      status: "authored"
    });
  });
});
