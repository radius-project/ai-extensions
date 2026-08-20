import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyDeployMessages,
  applyDeployStatusToResources,
  buildDeployMessageMap,
  buildDeployStatusMap,
  confirmArtifactIdentity,
  createDeployStatusReader,
  DEPLOY_STATUS_ARTIFACT_PREFIX,
  DEPLOY_STATUS_FILES,
  deployStatusArtifactPrefix,
  isLiveSlotArtifactName,
  MAX_ARTIFACT_CANDIDATES,
  normalizeProvisioningState,
  parseDeployProgressArtifact,
  resolveResourceStatus,
  sanitizeArtifactSegment,
  selectDeployStatusArtifacts,
  settleDeployStatuses
} from "./deploy-artifacts.js";
import type {
  ArtifactFiles,
  DeployProgress,
  WorkflowArtifact
} from "./deploy-artifacts.js";
import {
  deployStatusKeys,
  lookupDeployStatus,
  projectDeployedGraph
} from "@radius-project/core";
import type { DeployStatus } from "@radius-project/core";

function progressPayload(overrides: Partial<DeployProgress> = {}): string {
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
      parseDeployProgressArtifact(
        progressPayload({ resources: undefined as any })
      )
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
        ] as any
      })
    );
    expect(parsed?.resources.map((r) => r.name)).toEqual(["db"]);
  });

  it("discards a status value outside the four known ones", () => {
    const parsed = parseDeployProgressArtifact(
      progressPayload({
        resources: [
          { name: "db", type: "Radius.Data/x", status: "weird" }
        ] as any
      })
    );
    expect(parsed?.resources[0].status).toBeUndefined();
  });

  it("rejects a payload without a finite positive-integer sequence", () => {
    // The producer contract starts sequences at 1 and increments by 1.
    // Accepting a bogus value would let malformed uploads win the
    // greatest-sequence selection against a legitimate terminal artifact.
    expect(
      parseDeployProgressArtifact(
        progressPayload({ sequence: undefined as any })
      )
    ).toBeNull();
    expect(
      parseDeployProgressArtifact(progressPayload({ sequence: "1" as any }))
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

describe("normalizeProvisioningState", () => {
  it("maps Succeeded to success", () => {
    expect(normalizeProvisioningState("Succeeded")).toBe("success");
  });

  it("maps Failed and both spellings of cancelled to failed", () => {
    expect(normalizeProvisioningState("Failed")).toBe("failed");
    expect(normalizeProvisioningState("Canceled")).toBe("failed");
    expect(normalizeProvisioningState("Cancelled")).toBe("failed");
  });

  it("maps the in-flight states to in_progress", () => {
    for (const state of ["Accepted", "Provisioning", "Updating", "Deleting"])
      expect(normalizeProvisioningState(state)).toBe("in_progress");
  });

  it("maps an unknown or absent state to in_progress, never failed", () => {
    // A provisioning state a future Radius release adds must not paint the
    // graph red.
    expect(normalizeProvisioningState("Reconciling")).toBe("in_progress");
    expect(normalizeProvisioningState("")).toBe("in_progress");
    expect(normalizeProvisioningState(null)).toBe("in_progress");
  });
});

describe("resolveResourceStatus", () => {
  it("prefers the producer's normalized status", () => {
    expect(
      resolveResourceStatus({
        name: "a",
        type: "t",
        status: "failed",
        provisioningState: "Succeeded"
      })
    ).toBe("failed");
  });

  it("falls back to the raw provisioningState when status is absent", () => {
    expect(
      resolveResourceStatus({
        name: "a",
        type: "t",
        provisioningState: "Succeeded"
      })
    ).toBe("success");
  });

  it("falls back to in_progress when neither is usable", () => {
    expect(resolveResourceStatus({ name: "a", type: "t" })).toBe("in_progress");
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

describe("buildDeployStatusMap", () => {
  it("indexes by id, name|type, and name", () => {
    const map = buildDeployStatusMap(
      parseDeployProgressArtifact(progressPayload())
    );
    expect(
      map.get(
        "/planes/radius/local/resourcegroups/default/providers/Radius.Compute/containers/frontend"
      )
    ).toBe("success");
    expect(map.get("frontend|radius.compute/containers")).toBe("success");
    expect(map.get("frontend")).toBe("success");
  });

  it("strips the API version from the type key", () => {
    const map = buildDeployStatusMap(
      parseDeployProgressArtifact(
        progressPayload({
          resources: [
            {
              name: "db",
              type: "Radius.Data/postgreSQLDatabases@2025-08-01-preview",
              status: "in_progress"
            }
          ] as any
        })
      )
    );
    expect(map.get("db|radius.data/postgresqldatabases")).toBe("in_progress");
  });

  it("keeps the first entry when two resources collide on a weaker key", () => {
    const map = buildDeployStatusMap(
      parseDeployProgressArtifact(
        progressPayload({
          resources: [
            { id: "id-a", name: "dup", type: "A", status: "success" },
            { id: "id-b", name: "dup", type: "B", status: "failed" }
          ] as any
        })
      )
    );
    expect(map.get("id-a")).toBe("success");
    expect(map.get("id-b")).toBe("failed");
    expect(map.get("dup")).toBe("success");
  });

  it("returns an empty map for a null payload", () => {
    expect(buildDeployStatusMap(null).size).toBe(0);
  });

  it("keys entries exactly as the lookup side derives them", () => {
    // The map and the lookup must share one key derivation. If they diverged,
    // the map would be populated with keys the lookup never queries and every
    // node would silently fall back to pending.
    const progress = parseDeployProgressArtifact(progressPayload())!;
    const map = buildDeployStatusMap(progress);
    for (const resource of progress.resources) {
      expect(lookupDeployStatus(resource, map)).toBe(
        resolveResourceStatus(resource)
      );
      for (const key of deployStatusKeys(resource)) {
        expect(map.has(key)).toBe(true);
      }
    }
  });
});

describe("applyDeployStatusToResources", () => {
  const statusMap = (entries: Array<[string, DeployStatus]>) =>
    new Map<string, DeployStatus>(entries);

  it("advances a pending resource and reports the change", () => {
    const resources = [
      {
        name: "web",
        type: "Radius.Compute/containers",
        deployStatus: "pending" as DeployStatus
      }
    ];
    const changes = applyDeployStatusToResources(
      resources,
      statusMap([["web", "success"]])
    );
    expect(resources[0].deployStatus).toBe("success");
    expect(changes).toEqual([{ name: "web", from: "pending", to: "success" }]);
  });

  it("never downgrades a resource that already failed", () => {
    const resources = [
      { name: "web", type: "t", deployStatus: "failed" as DeployStatus }
    ];
    applyDeployStatusToResources(resources, statusMap([["web", "success"]]));
    expect(resources[0].deployStatus).toBe("failed");
  });

  it("regresses success only on an explicit failure", () => {
    const resources = [
      { name: "web", type: "t", deployStatus: "success" as DeployStatus }
    ];
    applyDeployStatusToResources(
      resources,
      statusMap([["web", "in_progress"]])
    );
    expect(resources[0].deployStatus).toBe("success");
    applyDeployStatusToResources(resources, statusMap([["web", "failed"]]));
    expect(resources[0].deployStatus).toBe("failed");
  });

  it("leaves a resource missing from the map untouched", () => {
    // A payload that does not mention a resource says nothing about it and must
    // not reset a node that has already advanced.
    const resources = [
      { name: "web", type: "t", deployStatus: "in_progress" as DeployStatus },
      { name: "db", type: "t", deployStatus: "pending" as DeployStatus }
    ];
    applyDeployStatusToResources(resources, statusMap([["db", "success"]]));
    expect(resources[0].deployStatus).toBe("in_progress");
    expect(resources[1].deployStatus).toBe("success");
  });

  it("does nothing at all for an empty map", () => {
    const resources = [
      { name: "web", type: "t", deployStatus: "in_progress" as DeployStatus }
    ];
    expect(applyDeployStatusToResources(resources, new Map())).toEqual([]);
    expect(resources[0].deployStatus).toBe("in_progress");
  });

  it("matches by id before name", () => {
    const resources = [
      {
        id: "rid",
        name: "web",
        type: "t",
        deployStatus: "pending" as DeployStatus
      }
    ];
    applyDeployStatusToResources(
      resources,
      statusMap([
        ["rid", "success"],
        ["web", "failed"]
      ])
    );
    expect(resources[0].deployStatus).toBe("success");
  });
});

describe("settleDeployStatuses", () => {
  it("forces every node green on a successful run", () => {
    const resources = [
      { deployStatus: "pending" as DeployStatus },
      { deployStatus: "failed" as DeployStatus }
    ];
    settleDeployStatuses(resources, "success");
    expect(resources.map((r) => r.deployStatus)).toEqual([
      "success",
      "success"
    ]);
  });

  it("fails anything unfinished on a non-success conclusion, keeping terminal values", () => {
    const resources = [
      { deployStatus: "pending" as DeployStatus },
      { deployStatus: "in_progress" as DeployStatus },
      { deployStatus: "success" as DeployStatus }
    ];
    settleDeployStatuses(resources, "failure");
    expect(resources.map((r) => r.deployStatus)).toEqual([
      "failed",
      "failed",
      "success"
    ]);
  });

  it("treats a cancelled run like any other non-success conclusion", () => {
    const resources = [{ deployStatus: "in_progress" as DeployStatus }];
    settleDeployStatuses(resources, "cancelled");
    expect(resources[0].deployStatus).toBe("failed");
  });
});

// A real payload, captured verbatim from a run of the producer's
// publish-deploy-status step (radius-project/radius). The producer has the
// mirror-image test asserting it still emits this shape. Together they close the
// loop on a one-sided contract change, which would otherwise fail silently:
// an empty Deployed graph with nothing red anywhere.
//
// See ./fixtures/README.md before changing anything here.
const REAL_PROGRESS = readFileSync(
  new URL("./fixtures/deploy-progress.json", import.meta.url),
  "utf8"
);

describe("the producer's real payload", () => {
  const parsed = parseDeployProgressArtifact(REAL_PROGRESS);

  it("carries every field the contract documents as required", () => {
    // This assertion exists because a fixture reached this repo with
    // `updatedAt` dropped in transit, and the missing field was briefly taken
    // as evidence that the producer did not emit it — nearly weakening the
    // documented contract to match a corrupted sample. A fixture is only
    // trustworthy if it is checked against the contract rather than treated as
    // the definition of it. Assert the top-level shape structurally, so a
    // truncated or hand-edited fixture fails loudly instead of silently
    // relaxing what this reader expects.
    const raw = JSON.parse(REAL_PROGRESS);
    expect(Object.keys(raw).sort()).toEqual([
      "application",
      "environment",
      "resources",
      "runId",
      "schemaVersion",
      "sequence",
      "state",
      "updatedAt"
    ]);
    for (const resource of raw.resources) {
      // `id` and `message` are always present too, though they may be empty.
      expect(Object.keys(resource).sort()).toEqual([
        "id",
        "message",
        "name",
        "provisioningState",
        "status",
        "type"
      ]);
    }
  });

  it("emits updatedAt as an RFC 3339 UTC timestamp", () => {
    // The producer emits this unconditionally (`updatedAt: $updatedAt` in its
    // jq construction), so the freshness line always has a real value to show.
    expect(parsed?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Number.isNaN(Date.parse(parsed!.updatedAt!))).toBe(false);
  });

  it("parses", () => {
    expect(parsed).not.toBeNull();
    expect(parsed?.application).toBe("todolist");
    expect(parsed?.environment).toBe("dev");
    expect(parsed?.runId).toBe(30940461732);
    expect(parsed?.sequence).toBe(1);
    expect(parsed?.updatedAt).toBe("2026-08-06T22:52:42Z");
    expect(parsed?.state).toBe("succeeded");
    expect(parsed?.resources).toHaveLength(3);
  });

  it("yields a status map covering all three resources", () => {
    const map = buildDeployStatusMap(parsed);
    expect(map.get("web")).toBe("success");
    expect(map.get("db")).toBe("failed");
    expect(map.get("queue")).toBe("in_progress");
  });

  it("never turns the empty-string id into a map key", () => {
    // The producer emits "" rather than omitting the field. If "" became a key,
    // every id-less resource in a payload would collide on one entry.
    const map = buildDeployStatusMap(parsed);
    expect(map.has("")).toBe(false);
  });

  it("resolves the id-less resource through the name|strippedType tier", () => {
    const map = buildDeployStatusMap(parsed);
    expect(map.get("queue|radius.messaging/rabbitmqqueues")).toBe(
      "in_progress"
    );
    // A modeled node carries a locally synthesized id the producer never
    // reported, so matching has to fall past the id tier.
    expect(
      lookupDeployStatus(
        {
          id: "/planes/radius/local/resourcegroups/default/providers/Radius.Messaging/rabbitMQQueues/queue",
          name: "queue",
          type: "Radius.Messaging/rabbitMQQueues@2025-08-01-preview"
        },
        map
      )
    ).toBe("in_progress");
  });

  it("carries the failure message onto the node so the popup can show it", () => {
    const messages = buildDeployMessageMap(parsed);
    expect(messages.get("db")).toBe(
      "recipe execution failed: image pull backoff"
    );
    const resources = [
      { name: "db", type: "Radius.Data/postgres" } as Record<string, unknown>,
      { name: "web", type: "Radius.Compute/containers" } as Record<
        string,
        unknown
      >
    ];
    applyDeployMessages(resources as any, messages);
    expect(resources[0].deployMessage).toBe(
      "recipe execution failed: image pull backoff"
    );
    // A healthy resource's message is "" in the payload, which is not a message.
    expect(resources[1].deployMessage).toBeUndefined();
  });

  it("projects onto a modeled graph with the right per-node status", () => {
    // End to end: payload -> status map -> the resources the tab renders.
    const modeled = [
      { name: "web", type: "Radius.Compute/containers" },
      { name: "db", type: "Radius.Data/postgres" },
      { name: "queue", type: "Radius.Messaging/rabbitMQQueues" }
    ];
    const projected = projectDeployedGraph(
      modeled,
      buildDeployStatusMap(parsed)
    );
    expect(projected.map((r) => r.deployStatus)).toEqual([
      "success",
      "failed",
      "in_progress"
    ]);
    expect(projected.every((r) => r.outputResources.length === 0)).toBe(true);
  });

  it("confirms identity against the artifact name for this run", () => {
    // Artifact name for this run: radius-deploy-status-dev-todolist
    expect(
      confirmArtifactIdentity(parsed, {
        environment: "dev",
        application: "todolist"
      })
    ).toBe(true);
    expect(deployStatusArtifactPrefix(parsed!.environment)).toBe(
      "radius-deploy-status-dev-"
    );
  });

  it("rejects a future schemaVersion instead of silently accepting it", () => {
    const bumped = JSON.parse(REAL_PROGRESS);
    bumped.schemaVersion = 2;
    expect(parseDeployProgressArtifact(JSON.stringify(bumped))).toBeNull();
  });

  it("maps an unrecognized provisioningState to in_progress, never failed", () => {
    const unknown = JSON.parse(REAL_PROGRESS);
    unknown.resources = [
      {
        id: "",
        name: "queue",
        type: "Radius.Messaging/rabbitMQQueues",
        provisioningState: "Reconciling",
        message: ""
      }
    ];
    const map = buildDeployStatusMap(
      parseDeployProgressArtifact(JSON.stringify(unknown))
    );
    // A provisioning state added by a future Radius release must not paint the
    // graph red.
    expect(map.get("queue")).toBe("in_progress");
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

  it("still returns an environment match when no artifact names the expected app", async () => {
    // The caller's application name can be a guess: it falls back to the
    // repository's short name when app.bicep cannot be read. Treating a
    // mismatch as fatal would blank the tab over a name this side never knew.
    const reader = createDeployStatusReader({
      ...baseOptions,
      application: "guessed-from-repo-name",
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

    expect(await reader.status()).toBe("missing");
    expect(await reader.progress()).toBeNull();
  });

  it("selects the greatest sequence from environment-only fallbacks", async () => {
    const reader = createDeployStatusReader({
      ...baseOptions,
      application: "guessed-name",
      runId: 100,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-other-live-100-slot-1", {
          id: 41
        }),
        artifact("radius-deploy-status-dev-other-live-100-slot-2", {
          id: 42
        })
      ],
      downloadArtifact: async (_repo, candidate) =>
        okFiles({ application: "other", sequence: candidate.id - 38 })
    });

    expect((await reader.progress())?.sequence).toBe(4);
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
    clock += 10001;
    await reader.read();
    expect(calls).toBe(2);
  });

  it("de-duplicates concurrent reads into a single fetch", async () => {
    let calls = 0;
    const reader = createDeployStatusReader({
      ...baseOptions,
      listArtifacts: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return [artifact("radius-deploy-status-dev-todolist")];
      },
      downloadArtifact: async () => okFiles()
    });
    await Promise.all([reader.read(), reader.read(), reader.read()]);
    expect(calls).toBe(1);
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
    expect(reader.sequence).toBe(5);
    expect(stale.progress?.sequence).toBe(5);
  });

  it("accepts a lower sequence from a different run", async () => {
    let clock = 0;
    let runId = 100;
    let sequence = 9;
    const reader = createDeployStatusReader({
      ...baseOptions,
      ttlMs: 0,
      now: () => clock,
      listArtifacts: async () => [
        artifact("radius-deploy-status-dev-todolist")
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
        artifact("radius-deploy-status-dev-todolist")
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
