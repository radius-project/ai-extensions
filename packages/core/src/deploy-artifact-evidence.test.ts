import { describe, it, expect, vi } from "vitest";
import { Worker } from "node:worker_threads";
import {
  confirmArtifactIdentity,
  createDeployStatusReader,
  DEPLOY_STATUS_ARTIFACT_PREFIX,
  DEPLOY_STATUS_FILES,
  deployStatusArtifactPrefix,
  isLiveSlotArtifactName,
  MAX_ARTIFACT_CANDIDATES,
  parseDeployGraphArtifact,
  parseDeployProgressArtifact,
  sanitizeArtifactSegment,
  selectDeployStatusArtifacts
} from "./deploy-artifact-evidence.js";
import type {
  ArtifactFiles,
  DeployProgress,
  WorkflowArtifact
} from "./deploy-artifact-evidence.js";

function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!complete) throw new Error("Deferred promise not initialized");
      complete(value);
    }
  };
}

async function parseGraphInWorker(text: string): Promise<unknown | null> {
  const moduleUrl = new URL("./deploy-artifact-evidence.ts", import.meta.url)
    .href;
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     import(workerData.moduleUrl).then(({ parseDeployGraphArtifact }) => {
       parentPort.postMessage(parseDeployGraphArtifact(workerData.text));
     }, (error) => parentPort.postMessage({ error: String(error) }));`,
    { eval: true, workerData: { moduleUrl, text } }
  );
  try {
    return await new Promise<unknown | null>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Graph parse exceeded bounded deadline")),
        4000
      );
      worker.once("message", (result: unknown) => {
        clearTimeout(timeout);
        if (result && typeof result === "object" && "error" in result) {
          reject(new Error(String(result.error)));
          return;
        }
        resolve(result);
      });
      worker.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      worker.once("exit", (code) => {
        if (code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Graph parser worker exited with code ${code}`));
        }
      });
    });
  } finally {
    await worker.terminate();
  }
}

describe("artifact evidence validation boundaries", () => {
  it.each([
    null,
    [],
    3,
    true,
    { schemaVersion: 1 },
    ...[-1, 1.5, "41", Number.MAX_SAFE_INTEGER + 1, null].map((runId) => ({
      schemaVersion: 1,
      application: "app",
      environment: "dev",
      resources: [],
      sequence: 1,
      runId
    }))
  ])("rejects invalid identity or document %j", (value) => {
    expect(parseDeployProgressArtifact(JSON.stringify(value))).toBeNull();
  });

  it("records incomplete inventories without discarding the valid resource", () => {
    const parsed = parseDeployProgressArtifact(
      progressPayload({
        resources: [null, false, 4, { name: "api" }],
        updatedAt: 4,
        state: false
      })
    );
    expect(parsed).toMatchObject({
      resourcesDiscarded: true,
      resources: [{ name: "api", type: "" }]
    });
    expect(parsed?.updatedAt).toBeUndefined();
    expect(parsed?.state).toBeUndefined();
  });

  it("parses escaped graph text and all supported resource identity fields", () => {
    const graph = {
      resources: [
        { id: 'a"b\\c' },
        { name: "n" },
        { type: "t" },
        { connections: [] },
        { outputResources: [] }
      ]
    };
    expect(
      parseDeployGraphArtifact("{broken}\n[}\n" + JSON.stringify(graph))
    ).toEqual(graph);
    expect(parseDeployGraphArtifact("[{}]")).toBeNull();
    expect(parseDeployGraphArtifact("[false]")).toBeNull();
    expect(parseDeployGraphArtifact('[{"id":"one"}]\n[{"id":"two"}]')).toEqual([
      { id: "one" }
    ]);
  });

  it("orders undated candidates by id and limits downloads at the exact budget", async () => {
    const candidates = Array.from(
      { length: MAX_ARTIFACT_CANDIDATES + 1 },
      (_, i) =>
        artifact("radius-deploy-status-dev-app", {
          id: i + 1,
          created_at: i % 2 ? undefined : "invalid"
        })
    );
    expect(selectDeployStatusArtifacts(candidates)).toHaveLength(
      MAX_ARTIFACT_CANDIDATES
    );
    expect(
      selectDeployStatusArtifacts(candidates).map((entry) => entry.id)
    ).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const downloadArtifact = vi.fn(async () => null);
    const reader = createDeployStatusReader({
      repo: "org/app",
      listArtifacts: async () => candidates,
      downloadArtifact
    });
    expect(await reader.status()).toBe("error");
    expect(downloadArtifact).toHaveBeenCalledTimes(MAX_ARTIFACT_CANDIDATES);
  });

  it.each(["auth", "malformed", "error"] as const)(
    "preserves classified %s download failures",
    async (status) => {
      const error = Object.assign(new Error("unavailable"), {
        code:
          status === "auth" ? "GH_ARTIFACT_AUTH"
          : status === "malformed" ? "GH_ARTIFACT_MALFORMED"
          : "network"
      });
      const reader = createDeployStatusReader({
        repo: "org/app",
        listArtifacts: async () => [artifact("radius-deploy-status-dev-app")],
        downloadArtifact: async () => {
          throw error;
        }
      });
      expect(await reader.read()).toMatchObject({ status, error });
    }
  );

  it("surfaces non-Error rejections and malformed listings explicitly", async () => {
    for (const error of ["unavailable", { code: "GH_ARTIFACT_MALFORMED" }]) {
      const reader = createDeployStatusReader({
        repo: "org/app",
        listArtifacts: async () => {
          throw error;
        },
        downloadArtifact: async () => null
      });
      expect(await reader.read()).toMatchObject({
        status: typeof error === "string" ? "error" : "malformed",
        error
      });
    }
  });

  it("rejects foreign listed runs before downloading and unproven runs after parsing", async () => {
    for (const candidate of [
      artifact("radius-deploy-status-dev-app", { workflow_run: { id: 999 } }),
      artifact("radius-deploy-status-dev-app", { workflow_run: null })
    ]) {
      const downloadArtifact = vi.fn(async () => ({
        [DEPLOY_STATUS_FILES.progress]: progressPayload({ runId: undefined })
      }));
      const reader = createDeployStatusReader({
        repo: "org/app",
        runId: 100,
        listArtifacts: async () => [candidate],
        downloadArtifact
      });
      expect(await reader.progress()).toBeNull();
      expect(await reader.status()).toBe("missing");
      expect(downloadArtifact).toHaveBeenCalledTimes(
        candidate.workflow_run ? 0 : 1
      );
    }
  });

  it("uses artifact execution identity for monotonicity when legacy progress omits runId", async () => {
    let id = 1;
    const reader = createDeployStatusReader({
      repo: "org/app",
      runId: 100,
      ttlMs: 0,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-app", { id: id++ })
      ],
      downloadArtifact: async () => ({
        [DEPLOY_STATUS_FILES.progress]: progressPayload({ runId: undefined })
      })
    });
    expect(await reader.status()).toBe("ok");
    expect(await reader.status()).toBe("stale");
    expect(reader.sequence).toBe(1);
  });

  it("rejects a payload claiming a different run when listing identity is absent", async () => {
    const reader = createDeployStatusReader({
      repo: "org/app",
      runId: 100,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-app", { workflow_run: null })
      ],
      downloadArtifact: async () => ({
        [DEPLOY_STATUS_FILES.progress]: progressPayload({ runId: 99 })
      })
    });
    expect(await reader.progress()).toBeNull();
  });

  it("never exposes another explicit application to a direct caller", async () => {
    const reader = createDeployStatusReader({
      repo: "org/app",
      application: "other",
      listArtifacts: async () => [artifact("radius-deploy-status-dev-app")],
      downloadArtifact: async () => ({
        [DEPLOY_STATUS_FILES.progress]: progressPayload(),
        [DEPLOY_STATUS_FILES.graph]: '{"resources":[{"name":"foreign"}]}'
      })
    });
    expect(await reader.graph()).toEqual({
      status: "missing",
      graph: null,
      artifact: null
    });
    expect(await reader.progress()).toBeNull();
  });

  it("keeps valid progress when a graph is malformed and does not expose graph bytes", async () => {
    const reader = createDeployStatusReader({
      repo: "org/app",
      listArtifacts: async () => [artifact("radius-deploy-status-dev-app")],
      downloadArtifact: async () => ({
        [DEPLOY_STATUS_FILES.progress]: progressPayload(),
        [DEPLOY_STATUS_FILES.graph]: "{broken"
      })
    });
    expect(await reader.graph()).toMatchObject({ status: "ok", graph: null });
    expect(await reader.progress()).toMatchObject({ sequence: 1 });
  });

  it("isolates equal artifact ids across targets and lets an independent read complete first", async () => {
    const delayed = deferred<ArtifactFiles>();
    const ready = deferred<void>();
    const first = createDeployStatusReader({
      repo: "org/first",
      runId: 100,
      listArtifacts: async () => [artifact("radius-deploy-status-dev-app")],
      downloadArtifact: async () => {
        ready.resolve();
        return delayed.promise;
      }
    });
    const second = createDeployStatusReader({
      repo: "org/second",
      runId: 200,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-app", { workflow_run: { id: 200 } })
      ],
      downloadArtifact: async () => ({
        [DEPLOY_STATUS_FILES.progress]: progressPayload({
          runId: 200,
          sequence: 7
        })
      })
    });
    const pending = first.progress();
    await ready.promise;
    expect((await second.progress())?.runId).toBe(200);
    delayed.resolve({ [DEPLOY_STATUS_FILES.progress]: progressPayload() });
    expect((await pending)?.runId).toBe(100);
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(7);
  });
});
function progressPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    application: "todolist",
    environment: "dev",
    runId: 100,
    sequence: 1,
    updatedAt: "2026-08-06T18:00:00Z",
    state: "succeeded",
    resources: [
      {
        id: "/planes/radius/local/resourcegroups/default/providers/Radius.Compute/containers/frontend",
        name: "frontend",
        type: "Radius.Compute/containers",
        provisioningState: "Succeeded",
        status: "success"
      }
    ],
    ...overrides
  });
}

function artifact(
  name: string,
  extra: Partial<WorkflowArtifact> = {}
): WorkflowArtifact {
  return {
    id: 1,
    name,
    expired: false,
    created_at: "2026-08-06T18:00:00Z",
    workflow_run: { id: 100 },
    ...extra
  };
}

describe("sanitizeArtifactSegment", () => {
  it("lowercases and collapses disallowed runs to a single dash", () => {
    expect(sanitizeArtifactSegment("Prod/EU  West")).toBe("prod-eu-west");
  });

  it("strips leading and trailing dashes", () => {
    expect(sanitizeArtifactSegment("--dev--")).toBe("dev");
  });

  it("collapses multi-byte characters rather than leaving them in the name", () => {
    // The producer sanitizes byte-wise under LC_ALL=C, so non-ASCII collapses
    // to a dash — which is then stripped here because it lands at the end.
    expect(sanitizeArtifactSegment("café™")).toBe("caf");
    expect(sanitizeArtifactSegment("café-app")).toBe("caf--app");
  });

  it("caps the result at 80 characters", () => {
    expect(sanitizeArtifactSegment("a".repeat(120))).toHaveLength(80);
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeArtifactSegment("")).toBe("");
    expect(sanitizeArtifactSegment(null)).toBe("");
  });
});

describe("deployStatusArtifactPrefix", () => {
  it("appends the sanitized environment and a separator", () => {
    expect(deployStatusArtifactPrefix("Dev")).toBe("radius-deploy-status-dev-");
  });

  it("falls back to the bare prefix when the environment sanitizes away", () => {
    expect(deployStatusArtifactPrefix("///")).toBe(
      DEPLOY_STATUS_ARTIFACT_PREFIX
    );
  });
});

describe("isLiveSlotArtifactName", () => {
  it("matches the eight run-scoped live-slot names", () => {
    for (let slot = 0; slot < 8; slot++) {
      expect(
        isLiveSlotArtifactName(
          `radius-deploy-status-dev-todolist-live-100-slot-${slot}`
        )
      ).toBe(true);
    }
  });

  it("does not match the fixed-name terminal artifact", () => {
    expect(isLiveSlotArtifactName("radius-deploy-status-dev-todolist")).toBe(
      false
    );
  });

  it("does not match an unrelated artifact name", () => {
    expect(isLiveSlotArtifactName("build-logs")).toBe(false);
    expect(isLiveSlotArtifactName(null)).toBe(false);
    expect(isLiveSlotArtifactName(undefined)).toBe(false);
  });
});

describe("selectDeployStatusArtifacts", () => {
  it("prefers artifacts scoped to the environment", () => {
    const selected = selectDeployStatusArtifacts(
      [
        artifact("radius-deploy-status-prod-todolist", { id: 1 }),
        artifact("radius-deploy-status-dev-todolist", { id: 2 })
      ],
      "dev"
    );
    expect(selected.map((a) => a.id)).toEqual([2]);
  });

  it("falls back to the bare prefix when no name carries the environment", () => {
    // The producer caps "<env>-<app>" at 80 chars, so a long environment name
    // truncates the app segment away and can even truncate the env itself.
    const truncated = artifact("radius-deploy-status-" + "e".repeat(80), {
      id: 7
    });
    const selected = selectDeployStatusArtifacts([truncated], "e".repeat(90));
    expect(selected.map((a) => a.id)).toEqual([7]);
  });

  it("ignores artifacts that are not deploy status at all", () => {
    expect(
      selectDeployStatusArtifacts([artifact("build-logs")], "dev")
    ).toEqual([]);
  });

  it("skips expired artifacts, whose bytes are gone", () => {
    expect(
      selectDeployStatusArtifacts(
        [artifact("radius-deploy-status-dev-app", { expired: true })],
        "dev"
      )
    ).toEqual([]);
  });

  it("orders candidates newest first", () => {
    const selected = selectDeployStatusArtifacts(
      [
        artifact("radius-deploy-status-dev-app", {
          id: 1,
          created_at: "2026-08-01T00:00:00Z"
        }),
        artifact("radius-deploy-status-dev-app", {
          id: 2,
          created_at: "2026-08-06T00:00:00Z"
        })
      ],
      "dev"
    );
    expect(selected.map((a) => a.id)).toEqual([2, 1]);
  });

  it("caps how many artifacts one read will download", () => {
    // Every candidate the caller tries costs a `gh run download` subprocess, so
    // an uncapped tier-2 match in a busy repo would turn one HTTP request into a
    // long serial fan-out.
    const many = Array.from({ length: 30 }, (_, i) =>
      artifact("radius-deploy-status-dev-app", { id: i + 1 })
    );
    expect(selectDeployStatusArtifacts(many, "dev")).toHaveLength(
      MAX_ARTIFACT_CANDIDATES
    );
    expect(selectDeployStatusArtifacts(many, "no-such-env")).toHaveLength(
      MAX_ARTIFACT_CANDIDATES
    );
  });

  it("returns an empty array for non-array input", () => {
    expect(selectDeployStatusArtifacts(null, "dev")).toEqual([]);
  });
});

describe("parseDeployProgressArtifact", () => {
  it("parses a well-formed payload", () => {
    const parsed = parseDeployProgressArtifact(progressPayload());
    expect(parsed?.application).toBe("todolist");
    expect(parsed?.environment).toBe("dev");
    expect(parsed?.sequence).toBe(1);
    expect(parsed?.resources).toHaveLength(1);
    expect(parsed?.resourcesDiscarded).toBeUndefined();
    expect(
      parseDeployProgressArtifact(
        progressPayload({
          resources: [
            {
              name: "frontend",
              type: "Radius.Compute/containers",
              message: "Deployed"
            }
          ]
        })
      )?.resources[0]?.message
    ).toBe("Deployed");
  });

  it.each([
    ["a non-object entry", 42],
    ["a nameless entry", { type: "Radius.Resources/redis" }],
    ["a non-string name", { name: 7, type: "Radius.Resources/redis" }]
  ])("reports that %s was dropped from the resource list", (_label, bad) => {
    // Built inline rather than through progressPayload: that helper is typed
    // to DeployProgress, which by design cannot express a malformed entry.
    const parsed = parseDeployProgressArtifact(
      JSON.stringify({
        schemaVersion: 1,
        application: "todolist",
        environment: "dev",
        runId: 100,
        sequence: 1,
        state: "succeeded",
        resources: [{ name: "api", type: "Radius.Resources/containers" }, bad]
      })
    );
    // Readable entries still parse, so the count alone cannot tell a consumer
    // that the list is short. The marker is the only signal.
    expect(parsed?.resources).toHaveLength(1);
    expect(parsed?.resourcesDiscarded).toBe(true);
  });

  describe("parseDeployGraphArtifact", () => {
    const graph = {
      resources: [
        {
          id: "mysql",
          outputResources: [
            {
              id: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DBforMySQL/flexibleServers/mysql",
              portalUrl:
                "https://portal.azure.com/#@tenant/resource/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DBforMySQL/flexibleServers/mysql"
            }
          ]
        }
      ]
    };

    it("preserves a producer graph beneath Rad build progress output", () => {
      expect(
        parseDeployGraphArtifact(
          `Compiling .radius/app.bicep\nBuilding {model}...\n${JSON.stringify(graph)}\nDone in 4.2s\n`
        )
      ).toEqual(graph);
    });

    it("ignores structured log records before and after the graph document", () => {
      const graphWithBraces = {
        ...graph,
        resources: [
          { ...graph.resources[0], message: "created {successfully}" }
        ]
      };
      expect(
        parseDeployGraphArtifact(
          `${JSON.stringify({ level: "info" })}\n${JSON.stringify(graphWithBraces)}\n${JSON.stringify({ level: "done" })}\n`
        )
      ).toEqual(graphWithBraces);
    });

    it("ignores non-resource array log records before the graph document", () => {
      expect(
        parseDeployGraphArtifact(
          `${JSON.stringify(["starting build"])}\n${JSON.stringify(graph)}\n`
        )
      ).toEqual(graph);
    });

    it("accepts exact object and array documents", () => {
      expect(parseDeployGraphArtifact(JSON.stringify(graph))).toEqual(graph);
      expect(parseDeployGraphArtifact('[{"id":"one"}]')).toEqual([
        { id: "one" }
      ]);
    });

    it("rejects empty, scalar, and malformed content", () => {
      expect(parseDeployGraphArtifact()).toBeNull();
      expect(parseDeployGraphArtifact("")).toBeNull();
      expect(parseDeployGraphArtifact("progress\n42")).toBeNull();
      expect(parseDeployGraphArtifact("progress\n{broken")).toBeNull();
      expect(
        parseDeployGraphArtifact('{"level":"info"}\n{"message":"done"}')
      ).toBeNull();
      expect(parseDeployGraphArtifact('["starting build"]')).toBeNull();
    });

    it.each([
      '{"unfinished\n',
      '{"unfinished ',
      'note: "unterminated ',
      'error: "{\\"k\\":\\"v\\"} ',
      '"{a\\"} ',
      'x "[ ',
      '"{\n"',
      '"[]\\"',
      '"[]',
      '"{}',
      '"{x\n"',
      "{\\\n",
      "{",
      "]"
    ])("recovers after %j while the scan budget allows it", (preamble) => {
      const decoratedGraph = {
        resources: [{ id: "web", name: 'web[0] {x} "\\' }]
      };
      expect(
        parseDeployGraphArtifact(preamble + JSON.stringify(decoratedGraph))
      ).toEqual(decoratedGraph);
    });

    it("walks decoded wrappers once and prefers graph objects over arrays", () => {
      const first = { resources: [{ name: "first" }] };
      const second = { resources: [{ name: "second" }] };
      for (const value of [
        [first, second],
        { event: { first, second } },
        [[], null, 42, "info", first],
        { events: [first, second] }
      ]) {
        expect(parseDeployGraphArtifact(JSON.stringify(value))).toEqual(first);
      }
      expect(parseDeployGraphArtifact(`[]\n${JSON.stringify(first)}`)).toEqual(
        first
      );
      expect(
        parseDeployGraphArtifact('[{"id":"prior"}]\n' + JSON.stringify(first))
      ).toEqual(first);
      expect(parseDeployGraphArtifact('[[{"id":"first"}],[]]')).toEqual([
        { id: "first" }
      ]);
    });

    it.each([
      ["[null,]", 63],
      ["[null,]", 64],
      ["[null,]", 65],
      ["[10:32:01]", 63],
      ["[10:32:01]", 64],
      ["[10:32:01]", 65]
    ] as const)(
      "caps failed decoding of %s repeated %i times before a graph",
      (fragment, count) => {
        expect(
          parseDeployGraphArtifact(
            fragment.repeat(count) + JSON.stringify(graph)
          )
        ).toEqual(count < 64 ? graph : null);
      }
    );

    it.each([-1, 0, 1])(
      "honors the total scan budget with %i characters of headroom",
      (headroom) => {
        const document = JSON.stringify(graph);
        // Two unclosed starts scan the suffix before the graph's own scan.
        // Padding is charged once, so length - 1 yields exactly 2 * text.length.
        const padding = " ".repeat(document.length - 1 + headroom);
        expect(parseDeployGraphArtifact(`${padding}{{${document}`)).toEqual(
          headroom < 0 ? null : graph
        );
      }
    );

    it("does not spend failed-decode attempts on tags with non-JSON characters", () => {
      const preamble = "[INFO] Building\n[1/120] Working\n[=====>   ]\n".repeat(
        100
      );
      expect(
        parseDeployGraphArtifact(preamble + JSON.stringify(graph))
      ).toEqual(graph);
    });

    it("retains only a validated array when later output exhausts a budget", () => {
      expect(parseDeployGraphArtifact(" {{[]x")).toEqual([]);
      expect(
        parseDeployGraphArtifact('[{"id":"prior"}]' + "{".repeat(1000))
      ).toEqual([{ id: "prior" }]);
      expect(
        parseDeployGraphArtifact('[{"id":"prior"}]' + "[null,]".repeat(64))
      ).toEqual([{ id: "prior" }]);
    });

    it.each([
      ["unmatched openers", () => "{".repeat(8 * 1024 * 1024), null],
      [
        "unmatched openers exhaust the budget before a later graph",
        () => `${"{".repeat(8 * 1024 * 1024)}\n${JSON.stringify(graph)}`,
        null
      ],
      [
        "deep valid nesting without a graph",
        () => `${"[".repeat(4 * 1024 * 1024)}0${"]".repeat(4 * 1024 * 1024)}`,
        null
      ],
      [
        "many valid small fragments before a later graph",
        () => `{broken${"[]".repeat(100_000)}${JSON.stringify(graph)}`,
        graph
      ],
      [
        "invalid-character fragments",
        () => `[${"[x],".repeat(2 * 1024 * 1024)}`,
        null
      ],
      [
        "invalid-grammar fragments",
        () => `[${"[null,],".repeat(1024 * 1024)}`,
        null
      ],
      [
        "invalid fragments exhaust the budget before a later graph",
        () => `[${"[x],".repeat(100_000)}${JSON.stringify(graph)}`,
        null
      ],
      [
        "a full-size valid producer graph after CLI progress",
        () =>
          "[INFO] Building\n" +
          JSON.stringify({
            resources: [{ id: "web", name: "x".repeat(8 * 1024 * 1024) }]
          }),
        { resources: [{ id: "web", name: "x".repeat(8 * 1024 * 1024) }] }
      ]
    ] as const)(
      "bounds %s within a worker deadline",
      async (_label, input, expected) => {
        expect(await parseGraphInWorker(input())).toEqual(expected);
      },
      5000
    );
  });

  it("rejects an unknown schemaVersion rather than guessing", () => {
    expect(
      parseDeployProgressArtifact(progressPayload({ schemaVersion: 2 }))
    ).toBeNull();
  });

  it("rejects a payload missing application or environment", () => {
    expect(
      parseDeployProgressArtifact(progressPayload({ application: "" }))
    ).toBeNull();
    expect(
      parseDeployProgressArtifact(progressPayload({ environment: "" }))
    ).toBeNull();
  });

  it("rejects a payload whose resources is not an array", () => {
    expect(
      parseDeployProgressArtifact(progressPayload({ resources: undefined }))
    ).toBeNull();
  });

  it("rejects malformed JSON and empty input", () => {
    expect(parseDeployProgressArtifact("{not json")).toBeNull();
    expect(parseDeployProgressArtifact("")).toBeNull();
    expect(parseDeployProgressArtifact(null)).toBeNull();
  });

  it("drops resource entries with no name but keeps the rest", () => {
    const parsed = parseDeployProgressArtifact(
      progressPayload({
        resources: [
          { type: "Radius.Compute/containers" },
          { name: "db", type: "Radius.Data/postgreSQLDatabases" }
        ]
      })
    );
    expect(parsed?.resources.map((r) => r.name)).toEqual(["db"]);
  });

  it("discards a status value outside the four known ones", () => {
    const parsed = parseDeployProgressArtifact(
      progressPayload({
        resources: [{ name: "db", type: "Radius.Data/x", status: "weird" }]
      })
    );
    expect(parsed?.resources[0].status).toBeUndefined();
  });

  it("accepts optional exact output resource ids and drops malformed entries", () => {
    const parsed = parseDeployProgressArtifact(
      progressPayload({
        resources: [
          {
            name: "api",
            type: "Radius.Compute/containers",
            outputResourceIds: [" deployment ", "", "  ", 42, "service"]
          }
        ]
      })
    );
    expect(parsed?.resources[0].outputResourceIds).toEqual([
      "deployment",
      "service"
    ]);
  });

  it("rejects a payload without a finite positive-integer sequence", () => {
    // The producer contract starts sequences at 1 and increments by 1.
    // Accepting a bogus value would let malformed uploads win the
    // greatest-sequence selection against a legitimate terminal artifact.
    expect(
      parseDeployProgressArtifact(progressPayload({ sequence: undefined }))
    ).toBeNull();
    expect(
      parseDeployProgressArtifact(progressPayload({ sequence: "1" }))
    ).toBeNull();
    expect(
      parseDeployProgressArtifact(progressPayload({ sequence: 0 }))
    ).toBeNull();
    expect(
      parseDeployProgressArtifact(progressPayload({ sequence: -1 }))
    ).toBeNull();
    expect(
      parseDeployProgressArtifact(progressPayload({ sequence: 1.5 }))
    ).toBeNull();
    expect(
      parseDeployProgressArtifact(progressPayload({ sequence: Number.NaN }))
    ).toBeNull();
    expect(
      parseDeployProgressArtifact(
        progressPayload({ sequence: Number.POSITIVE_INFINITY })
      )
    ).toBeNull();
    expect(
      parseDeployProgressArtifact(progressPayload({ sequence: 1 }))?.sequence
    ).toBe(1);
  });
});

describe("confirmArtifactIdentity", () => {
  const progress = parseDeployProgressArtifact(progressPayload())!;

  it("accepts a matching application and environment", () => {
    expect(
      confirmArtifactIdentity(progress, {
        environment: "dev",
        application: "todolist"
      })
    ).toBe(true);
  });

  it("compares after sanitization, so derivation differences do not matter", () => {
    expect(
      confirmArtifactIdentity(progress, {
        environment: "DEV",
        application: "TodoList"
      })
    ).toBe(true);
  });

  it("rejects another application in the same environment", () => {
    expect(
      confirmArtifactIdentity(progress, {
        environment: "dev",
        application: "other"
      })
    ).toBe(false);
  });

  it("rejects another environment", () => {
    expect(confirmArtifactIdentity(progress, { environment: "prod" })).toBe(
      false
    );
  });

  it("treats an unspecified expectation as matching anything", () => {
    expect(confirmArtifactIdentity(progress, {})).toBe(true);
    expect(confirmArtifactIdentity(progress, { environment: "dev" })).toBe(
      true
    );
  });

  it("rejects a null payload", () => {
    expect(confirmArtifactIdentity(null, {})).toBe(false);
  });
});

describe("createDeployStatusReader", () => {
  const okFiles = (over: Partial<DeployProgress> = {}): ArtifactFiles => ({
    [DEPLOY_STATUS_FILES.progress]: progressPayload(over),
    [DEPLOY_STATUS_FILES.graph]: '{"resources":[{"name":"frontend"}]}'
  });

  const baseOptions = {
    repo: "octo/app",
    environment: "dev",
    application: "todolist"
  };

  it("reads the progress payload and the deployed graph", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist")
      ],
      downloadArtifact: async () => okFiles()
    });
    expect(await reader.status()).toBe("ok");
    const progress = await reader.progress();
    expect(progress?.application).toBe("todolist");
    const { graph } = await reader.graph();
    expect(graph).toEqual({ resources: [{ name: "frontend" }] });
  });

  it("reads portal metadata when Rad prefixes graph JSON with build progress", async () => {
    const portalUrl =
      "https://portal.azure.com/#@tenant/resource/subscriptions/sub/resourceGroups/rg/providers/Microsoft.DBforMySQL/flexibleServers/mysql";
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist")
      ],
      downloadArtifact: async () => ({
        ...okFiles(),
        [DEPLOY_STATUS_FILES.graph]:
          "Compiling .radius/app.bicep\nBuilding .radius/app.bicep...\n" +
          JSON.stringify({
            resources: [
              {
                id: "mysql",
                outputResources: [{ id: "/subscriptions/sub/mysql", portalUrl }]
              }
            ]
          }) +
          '\n{"level":"info","message":"complete"}\n'
      })
    });

    expect((await reader.graph()).graph).toEqual({
      resources: [
        {
          id: "mysql",
          outputResources: [{ id: "/subscriptions/sub/mysql", portalUrl }]
        }
      ]
    });
  });

  it("surfaces the control-plane log when the artifact carries one", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist")
      ],
      downloadArtifact: async () => ({
        ...okFiles(),
        [DEPLOY_STATUS_FILES.controlPlane]: "recipe failed: boom"
      })
    });
    expect(await reader.controlPlaneLog()).toBe("recipe failed: boom");
  });

  it("returns null control-plane log when the artifact omits one", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist")
      ],
      downloadArtifact: async () => okFiles()
    });
    expect(await reader.controlPlaneLog()).toBeNull();
  });

  it("reports missing when no deploy-status artifact exists", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => [artifact("build-logs")],
      downloadArtifact: async () => okFiles()
    });
    expect(await reader.status()).toBe("missing");
  });

  it("reports malformed when the payload cannot be understood", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist")
      ],
      downloadArtifact: async () => ({
        [DEPLOY_STATUS_FILES.progress]: "{not json"
      })
    });
    expect(await reader.status()).toBe("malformed");
  });

  it("classifies a permission failure as auth, not a transient error", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => {
        throw Object.assign(new Error("HTTP 403"), {
          code: "GH_ARTIFACT_AUTH"
        });
      },
      downloadArtifact: async () => null
    });
    expect(await reader.status()).toBe("auth");
  });

  it("classifies any other listing failure as error", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => {
        throw new Error("network down");
      },
      downloadArtifact: async () => null
    });
    expect(await reader.status()).toBe("error");
  });

  it("prefers an exact application match over another app in the same environment", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-other", {
          id: 2,
          created_at: "2026-08-06T00:00:00Z"
        }),
        artifact("radius-deploy-status-dev-todolist", {
          id: 1,
          created_at: "2026-08-01T00:00:00Z"
        })
      ],
      downloadArtifact: async (_repo, a) =>
        a.id === 2 ? okFiles({ application: "other" }) : okFiles()
    });
    const progress = await reader.progress();
    expect(progress?.application).toBe("todolist");
  });

  it("allows an explicit guessed application fallback only for repo-wide discovery", async () => {
    // The caller's application name can be a guess: it falls back to the
    // repository's short name when app.bicep cannot be read. Treating a
    // mismatch as fatal would blank the tab over a name this side never knew.
    const reader = createDeployStatusReader({
      ...baseOptions,
      application: "guessed-from-repo-name",
      allowApplicationFallback: true,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist")
      ],
      downloadArtifact: async () => okFiles()
    });
    const result = await reader.read();
    expect(result.status).toBe("ok");
    expect(result.progress?.application).toBe("todolist");
  });

  it("never returns an artifact from a different environment", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      environment: "prod",
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist")
      ],
      downloadArtifact: async () => okFiles()
    });
    expect(await reader.status()).toBe("missing");
  });

  it("falls through to an older artifact when the newest is unreadable", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist", {
          id: 2,
          created_at: "2026-08-06T00:00:00Z"
        }),
        artifact("radius-deploy-status-dev-todolist", {
          id: 1,
          created_at: "2026-08-01T00:00:00Z"
        })
      ],
      downloadArtifact: async (_repo, a) => (a.id === 2 ? null : okFiles())
    });
    expect(await reader.status()).toBe("ok");
  });

  it("selects the greatest valid sequence independent of artifact order", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      runId: 100,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist-live-100-slot-1", {
          id: 31,
          created_at: "2026-08-06T00:00:03Z"
        }),
        artifact("radius-deploy-status-dev-todolist-live-100-slot-7", {
          id: 32,
          created_at: "2026-08-06T00:00:01Z"
        }),
        artifact("radius-deploy-status-dev-todolist-live-100-slot-4", {
          id: 33,
          created_at: "2026-08-06T00:00:02Z"
        })
      ],
      downloadArtifact: async (_repo, candidate) =>
        okFiles({ sequence: candidate.id === 32 ? 8 : candidate.id - 29 })
    });

    expect((await reader.progress())?.sequence).toBe(8);
  });

  it("hands off from live slots to the higher-sequence terminal artifact", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      runId: 100,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist-live-100-slot-7", {
          id: 51,
          created_at: "2026-08-06T00:00:03Z"
        }),
        artifact("radius-deploy-status-dev-todolist", {
          id: 52,
          created_at: "2026-08-06T00:00:02Z"
        })
      ],
      downloadArtifact: async (_repo, candidate) =>
        okFiles({
          sequence: candidate.id === 52 ? 9 : 8,
          state: candidate.id === 52 ? "succeeded" : "in_progress"
        })
    });

    const progress = await reader.progress();
    expect(progress?.sequence).toBe(9);
    expect(progress?.state).toBe("succeeded");
  });

  it("rejects a payload whose runId differs from the active run", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      runId: 100,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist-live-100-slot-0")
      ],
      downloadArtifact: async () => okFiles({ runId: 999, sequence: 9 })
    });

    expect(await reader.status()).toBe("malformed");
    expect(await reader.progress()).toBeNull();
  });

  it("rejects environment-only fallbacks within an explicitly identified execution", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      application: "guessed-name",
      allowApplicationFallback: true,
      runId: 100,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-other-live-100-slot-1", {
          id: 41,
          created_at: "2026-08-10T00:00:02Z"
        }),
        artifact("radius-deploy-status-dev-other-live-100-slot-2", {
          id: 42,
          created_at: "2026-08-10T00:00:01Z"
        })
      ],
      downloadArtifact: async (_repo, candidate) =>
        okFiles({ application: "other", sequence: candidate.id - 38 })
    });

    expect(await reader.progress()).toBeNull();
    expect(await reader.status()).toBe("missing");
  });

  it("stops serving a deployment whose artifact was deleted", async () => {
    // Deleting an application deletes its deploy-status artifact, so a
    // repo-wide read that finds nothing is the deletion becoming visible. The
    // reader must retire what it read before rather than keep answering from
    // `lastGood` for the rest of the session.
    let listing: WorkflowArtifact[] = [
      artifact("radius-deploy-status-dev-todolist")
    ];
    const reader = createDeployStatusReader({
      ...baseOptions,
      ttlMs: 0,
      listArtifacts: async () => listing,
      downloadArtifact: async () => ({
        ...okFiles(),
        [DEPLOY_STATUS_FILES.controlPlane]: "recipe log"
      })
    });

    expect((await reader.graph()).graph).toEqual({
      resources: [{ name: "frontend" }]
    });

    listing = [];
    expect(await reader.status()).toBe("missing");
    expect((await reader.graph()).graph).toBeNull();
    expect((await reader.graph()).artifact).toBeNull();
    expect(await reader.progress()).toBeNull();
    expect(await reader.controlPlaneLog()).toBeNull();
  });

  it("retires cached evidence when only a different application's malformed graph remains", async () => {
    let clock = 0;
    let listing = [artifact("radius-deploy-status-dev-todolist")];
    const reader = createDeployStatusReader({
      ...baseOptions,
      now: () => clock,
      listArtifacts: async () => listing,
      downloadArtifact: async (_repo, candidate) => ({
        [DEPLOY_STATUS_FILES.progress]: progressPayload({
          application: candidate.id === 2 ? "other" : "todolist"
        }),
        [DEPLOY_STATUS_FILES.graph]:
          candidate.id === 2 ?
            "{broken"
          : '{"resources":[{"name":"frontend"}]}',
        [DEPLOY_STATUS_FILES.controlPlane]: "recipe log"
      })
    });
    expect((await reader.graph()).graph).toEqual({
      resources: [{ name: "frontend" }]
    });
    expect(reader.sequence).toBe(1);
    clock = 10000;
    listing = [artifact("radius-deploy-status-dev-other", { id: 2 })];
    expect(await reader.status()).toBe("missing");
    expect(await reader.progress()).toBeNull();
    expect(await reader.graph()).toEqual({
      status: "missing",
      graph: null,
      artifact: null
    });
    expect(await reader.controlPlaneLog()).toBeNull();
    expect(reader.sequence).toBe(-1);
  });

  it("accepts a redeploy after the previous artifact was deleted", async () => {
    // Retiring the cache must also reset the monotonic sequence guard: the new
    // run's first snapshot restarts at sequence 1 and would otherwise look like
    // a stale replay of the deployment that was deleted.
    let listing: WorkflowArtifact[] = [
      artifact("radius-deploy-status-dev-todolist")
    ];
    let sequence = 7;
    const reader = createDeployStatusReader({
      ...baseOptions,
      ttlMs: 0,
      listArtifacts: async () => listing,
      downloadArtifact: async () => okFiles({ sequence, runId: 100 })
    });

    expect((await reader.progress())?.sequence).toBe(7);

    listing = [];
    expect(await reader.status()).toBe("missing");

    listing = [artifact("radius-deploy-status-dev-todolist")];
    sequence = 1;
    expect((await reader.progress())?.sequence).toBe(1);
  });

  it("keeps the last good snapshot when a run-scoped read finds no slot", async () => {
    // Live slots rotate by uploading under a new artifact ID, so a run-scoped
    // listing can momentarily come back empty. Blanking the graph on that would
    // flicker resources back to pending mid-deploy.
    let listing: WorkflowArtifact[] = [
      artifact("radius-deploy-status-dev-todolist-live-100-slot-0")
    ];
    const reader = createDeployStatusReader({
      ...baseOptions,
      runId: 100,
      ttlMs: 0,
      listArtifacts: async () => listing,
      downloadArtifact: async () => okFiles({ runId: 100 })
    });

    expect((await reader.graph()).graph).toEqual({
      resources: [{ name: "frontend" }]
    });

    listing = [];
    expect(await reader.status()).toBe("missing");
    expect((await reader.graph()).graph).toEqual({
      resources: [{ name: "frontend" }]
    });
  });

  it("keeps the last good snapshot when the artifact is temporarily unreadable", async () => {
    // A candidate that fails to download proves nothing about whether the
    // deployment still exists. Only a listing that genuinely has nothing for it
    // is a deletion; a transient download failure must not blank a valid graph.
    let downloadFails = false;
    const reader = createDeployStatusReader({
      ...baseOptions,
      ttlMs: 0,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist")
      ],
      downloadArtifact: async () => {
        if (downloadFails) throw new Error("network reset");
        return okFiles();
      }
    });

    expect((await reader.graph()).graph).toEqual({
      resources: [{ name: "frontend" }]
    });

    downloadFails = true;
    // Reported as an error rather than an absence, so the cache survives.
    expect(await reader.status()).toBe("error");
    expect((await reader.graph()).graph).toEqual({
      resources: [{ name: "frontend" }]
    });

    downloadFails = false;
    expect((await reader.graph()).graph).toEqual({
      resources: [{ name: "frontend" }]
    });
  });

  it("keeps the last good snapshot when the artifact download returns nothing", async () => {
    let downloadEmpty = false;
    const reader = createDeployStatusReader({
      ...baseOptions,
      ttlMs: 0,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist")
      ],
      downloadArtifact: async () => (downloadEmpty ? null : okFiles())
    });

    expect((await reader.graph()).graph).toEqual({
      resources: [{ name: "frontend" }]
    });

    downloadEmpty = true;
    expect(await reader.status()).toBe("error");
    expect((await reader.graph()).graph).toEqual({
      resources: [{ name: "frontend" }]
    });
  });

  it("downloads an immutable artifact ID only once across polls", async () => {
    let downloads = 0;
    const reader = createDeployStatusReader({
      ...baseOptions,
      runId: 100,
      ttlMs: 0,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist-live-100-slot-0")
      ],
      downloadArtifact: async () => {
        downloads++;
        return okFiles();
      }
    });

    await reader.read();
    await reader.read();
    expect(downloads).toBe(1);
  });

  it("does not redownload a malformed artifact ID during an active run", async () => {
    let downloads = 0;
    const reader = createDeployStatusReader({
      ...baseOptions,
      runId: 100,
      ttlMs: 0,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist-live-100-slot-0")
      ],
      downloadArtifact: async () => {
        downloads++;
        return { [DEPLOY_STATUS_FILES.progress]: "{not json" };
      }
    });

    expect(await reader.status()).toBe("malformed");
    expect(await reader.status()).toBe("malformed");
    expect(downloads).toBe(1);
  });

  it("prunes cached artifact IDs that drop out of the listing", async () => {
    // Ring slots overwrite by uploading with new artifact IDs. Without
    // pruning, a long-running deploy would retain every payload it has ever
    // downloaded even though the older IDs will never be listed again.
    const downloadedIds: number[] = [];
    let listing: WorkflowArtifact[] = [
      artifact("radius-deploy-status-dev-todolist-live-100-slot-0", { id: 71 })
    ];
    const reader = createDeployStatusReader({
      ...baseOptions,
      runId: 100,
      ttlMs: 0,
      listArtifacts: async () => listing,
      downloadArtifact: async (_repo, candidate) => {
        downloadedIds.push(candidate.id);
        return okFiles({ sequence: candidate.id - 70 });
      }
    });

    await reader.read();
    expect(downloadedIds).toEqual([71]);

    // Slot rotates: old ID gone, new ID present. Cache must forget 71.
    listing = [
      artifact("radius-deploy-status-dev-todolist-live-100-slot-1", { id: 72 })
    ];
    await reader.read();
    expect(downloadedIds).toEqual([71, 72]);

    // Old ID re-appearing (would not happen in practice, but proves 71 was
    // dropped from the cache — otherwise we would see no third download).
    listing = [
      artifact("radius-deploy-status-dev-todolist-live-100-slot-0", { id: 71 })
    ];
    await reader.read();
    expect(downloadedIds).toEqual([71, 72, 71]);
  });

  it("excludes live-slot artifacts from repo-wide reads", async () => {
    // `sequence` restarts at 1 for each run, so a cancelled run's higher-
    // sequenced live slot must not beat a newer completed run's terminal
    // artifact when the reader is not scoped to any run.
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => [
        // Newer completed run: terminal artifact only, sequence 1.
        artifact("radius-deploy-status-dev-todolist", {
          id: 81,
          created_at: "2026-08-10T00:00:02Z",
          workflow_run: { id: 200 }
        }),
        // Older cancelled run: live slot with a higher sequence.
        artifact("radius-deploy-status-dev-todolist-live-100-slot-7", {
          id: 82,
          created_at: "2026-08-10T00:00:01Z",
          workflow_run: { id: 100 }
        })
      ],
      downloadArtifact: async (_repo, candidate) =>
        okFiles({
          runId: candidate.id === 81 ? 200 : 100,
          sequence: candidate.id === 81 ? 1 : 9,
          state: candidate.id === 81 ? "succeeded" : "in_progress"
        })
    });

    const progress = await reader.progress();
    expect(progress?.runId).toBe(200);
    expect(progress?.sequence).toBe(1);
    expect(progress?.state).toBe("succeeded");
  });

  it("reports missing on a repo-wide read that finds only live slots", async () => {
    // Producer spec calls out cancellation: a cancelled run can leave live
    // slots behind without ever publishing a terminal artifact. A repo-wide
    // read must not fall back to a live slot in that case; sequences from a
    // cancelled run are not the current deployment state.
    let downloads = 0;
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist-live-100-slot-0", {
          id: 61
        }),
        artifact("radius-deploy-status-dev-todolist-live-100-slot-1", {
          id: 62
        })
      ],
      downloadArtifact: async () => {
        downloads++;
        return okFiles();
      }
    });

    expect(await reader.status()).toBe("missing");
    expect(downloads).toBe(0);
  });

  it("picks the newest terminal artifact across runs on a repo-wide read", async () => {
    // Two completed runs' fixed-name terminal artifacts. Sequences restart at
    // 1 per run, so `created_at` (list order) picks the newer deployment
    // instead of the greater sequence from an older one.
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist", {
          id: 91,
          created_at: "2026-08-11T00:00:00Z",
          workflow_run: { id: 300 }
        }),
        artifact("radius-deploy-status-dev-todolist", {
          id: 92,
          created_at: "2026-08-10T00:00:00Z",
          workflow_run: { id: 200 }
        })
      ],
      downloadArtifact: async (_repo, candidate) =>
        okFiles({
          runId: candidate.id === 91 ? 300 : 200,
          sequence: candidate.id === 91 ? 1 : 9
        })
    });

    const progress = await reader.progress();
    expect(progress?.runId).toBe(300);
    expect(progress?.sequence).toBe(1);
  });

  it("picks the newest environment-only terminal fallback on a repo-wide read", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      application: "guessed-name",
      allowApplicationFallback: true,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-other", {
          id: 93,
          created_at: "2026-08-12T00:00:00Z",
          workflow_run: { id: 500 }
        }),
        artifact("radius-deploy-status-dev-other", {
          id: 94,
          created_at: "2026-08-11T00:00:00Z",
          workflow_run: { id: 400 }
        })
      ],
      downloadArtifact: async (_repo, candidate) =>
        okFiles({
          application: "other",
          runId: candidate.id === 93 ? 500 : 400,
          sequence: candidate.id === 93 ? 1 : 9
        })
    });

    const progress = await reader.progress();
    expect(progress?.runId).toBe(500);
    expect(progress?.sequence).toBe(1);
  });

  it("caches within the TTL and refetches after it expires", async () => {
    let calls = 0;
    let clock = 1000;
    const reader = createDeployStatusReader({
      ...baseOptions,
      ttlMs: 10000,
      now: () => clock,
      listArtifacts: async () => {
        calls++;
        return [artifact("radius-deploy-status-dev-todolist")];
      },
      downloadArtifact: async () => okFiles()
    });
    await reader.read();
    await reader.read();
    expect(calls).toBe(1);
    clock += 9999;
    await reader.read();
    expect(calls).toBe(1);
    clock += 1;
    await reader.read();
    expect(calls).toBe(2);
  });

  it("de-duplicates concurrent reads into a single fetch", async () => {
    let calls = 0;
    const pending = deferred<WorkflowArtifact[]>();
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => {
        calls++;
        return pending.promise;
      },
      downloadArtifact: async () => okFiles()
    });
    const reads = [reader.read(), reader.read(), reader.read()];
    expect(calls).toBe(1);
    pending.resolve([artifact("radius-deploy-status-dev-todolist")]);
    const results = await Promise.all(reads);
    expect(results.map((result) => result.status)).toEqual(["ok", "ok", "ok"]);
    expect(calls).toBe(1);
  });

  it("clears a rejected flight and retries without resetting sequence protection", async () => {
    const failure = new Error("clock unavailable");
    const now = vi
      .fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValue(1000);
    const listArtifacts = vi.fn(async () => [
      artifact("radius-deploy-status-dev-todolist")
    ]);
    const reader = createDeployStatusReader({
      ...baseOptions,
      now,
      listArtifacts,
      downloadArtifact: async () => okFiles()
    });
    const failedReads = await Promise.allSettled([
      reader.read(),
      reader.read(),
      reader.read()
    ]);
    expect(failedReads).toEqual(
      Array.from({ length: 3 }, () => ({ status: "rejected", reason: failure }))
    );
    expect(listArtifacts).toHaveBeenCalledTimes(1);

    const recovered = await reader.read();
    expect(recovered).toMatchObject({
      status: "stale",
      progressRevalidated: true,
      progress: { sequence: 1 }
    });
    expect(listArtifacts).toHaveBeenCalledTimes(2);
    expect(await reader.read()).toBe(recovered);
    expect(listArtifacts).toHaveBeenCalledTimes(2);
  });

  it("rejects an out-of-order snapshot of the run it is already tracking", async () => {
    let clock = 0;
    let sequence = 5;
    const reader = createDeployStatusReader({
      ...baseOptions,
      ttlMs: 0,
      now: () => clock,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist")
      ],
      downloadArtifact: async () => okFiles({ sequence })
    });
    await reader.read();
    expect(reader.sequence).toBe(5);
    // A stale read arriving after an overwrite must not roll the graph back.
    clock += 1;
    sequence = 3;
    const stale = await reader.read();
    expect(stale.status).toBe("stale");
    expect(stale.progressRevalidated).toBe(false);
    expect(reader.sequence).toBe(5);
    expect(stale.progress?.sequence).toBe(5);
  });

  it.each([
    { changed: false, revalidated: true },
    { changed: true, revalidated: false }
  ])(
    "revalidates only an identical report at the same sequence: $changed",
    async ({ changed, revalidated }) => {
      let clock = 0;
      let failRead = false;
      const reader = createDeployStatusReader({
        ...baseOptions,
        now: () => clock,
        listArtifacts: async () => {
          if (failRead) throw new Error("network unavailable");
          return [artifact("radius-deploy-status-dev-todolist")];
        },
        downloadArtifact: async () =>
          okFiles({
            state: changed && clock > 0 ? "failed" : "succeeded"
          })
      });
      expect((await reader.read()).status).toBe("ok");
      for (const time of [10001, 20002]) {
        clock = time;
        const snapshot = await reader.read();
        expect(snapshot.status).toBe("stale");
        expect(snapshot.progressRevalidated).toBe(revalidated);
        expect(snapshot.progress?.state).toBe("succeeded");
      }
      clock = 30003;
      failRead = true;
      const failed = await reader.read();
      expect(failed.status).toBe("error");
      expect(failed.progressRevalidated).not.toBe(true);
    }
  );

  it("accepts a lower sequence from a different run", async () => {
    let clock = 0;
    let runId = 100;
    let sequence = 9;
    const reader = createDeployStatusReader({
      ...baseOptions,
      ttlMs: 0,
      now: () => clock,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist", {
          workflow_run: { id: runId }
        })
      ],
      downloadArtifact: async () => okFiles({ runId, sequence })
    });
    await reader.read();
    clock += 1;
    runId = 200;
    sequence = 1;
    const next = await reader.read();
    expect(next.status).toBe("ok");
    expect(next.progress?.runId).toBe(200);
    expect(reader.sequence).toBe(1);
  });

  it("accepts each new snapshot when the run cannot be identified", async () => {
    // runId 0 (or absent) means the producer had no GITHUB_RUN_ID, so it
    // identifies nothing. Because `sequence` restarts at 1 for every run,
    // treating "unknown" as a run match would make each new deploy's first
    // snapshot look like a stale replay and pin the graph to an old deployment.
    let clock = 0;
    let state = "in_progress";
    const reader = createDeployStatusReader({
      ...baseOptions,
      ttlMs: 0,
      now: () => clock,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist", { workflow_run: null })
      ],
      downloadArtifact: async () => okFiles({ runId: 0, sequence: 1, state })
    });
    expect((await reader.read()).status).toBe("ok");
    clock += 1;
    state = "succeeded";
    const next = await reader.read();
    expect(next.status).toBe("ok");
    expect(next.progress?.state).toBe("succeeded");
  });

  it("treats runId 0 as unknown rather than as a real run id", () => {
    const parsed = parseDeployProgressArtifact(progressPayload({ runId: 0 }));
    expect(parsed?.runId).toBeUndefined();
  });

  it("passes the environment-scoped prefix to the lister so paging can stop early", async () => {
    let seenPrefix: string | undefined;
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async (_repo, _runId, prefix) => {
        seenPrefix = prefix;
        return [artifact("radius-deploy-status-dev-todolist")];
      },
      downloadArtifact: async () => okFiles()
    });
    await reader.read();
    expect(seenPrefix).toBe("radius-deploy-status-dev-");
  });

  it("reports missing without calling GitHub when no repo is set", async () => {
    let calls = 0;
    const reader = createDeployStatusReader({
      repo: "",
      listArtifacts: async () => {
        calls++;
        return [];
      },
      downloadArtifact: async () => null
    });
    expect(await reader.status()).toBe("missing");
    expect(calls).toBe(0);
  });

  it("returns a null graph when only a progress payload has been uploaded", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist")
      ],
      downloadArtifact: async () => ({
        [DEPLOY_STATUS_FILES.progress]: progressPayload({
          state: "in_progress"
        })
      })
    });
    const { graph, status } = await reader.graph();
    expect(status).toBe("ok");
    expect(graph).toBeNull();
  });
});
