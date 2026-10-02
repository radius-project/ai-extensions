import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyDeployMessages,
  applyDeployStatusToResources,
  buildDeployMessageMap,
  buildDeployStatusMap,
  confirmArtifactIdentity,
  deployStatusArtifactPrefix,
  DEPLOY_CANCELLED_MESSAGE,
  DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE,
  DEPLOY_FAILED_MESSAGE,
  DEPLOY_MONITOR_TIMED_OUT_MESSAGE,
  DEPLOY_TIMED_OUT_MESSAGE,
  MAX_DEPLOY_MESSAGE_LENGTH,
  normalizeProvisioningState,
  parseDeployProgressArtifact,
  resolveResourceStatus,
  settleDeployStatuses,
  unfinishedDeployMessage
} from "./deploy-artifacts.js";
import type { DeployProgress, SettleableResource } from "./deploy-artifacts.js";
import {
  deployStatusKeys,
  lookupDeployStatus,
  projectDeployedGraph
} from "@radius-project/core";
import type { DeployStatus } from "@radius-project/core";
import { DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE as completedUnconfirmedMessage } from "./deploy-messages.js";

it("re-exports the browser-safe completed but unconfirmed message", () => {
  expect(DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE).toBe(
    completedUnconfirmedMessage
  );
});

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

  it("reserves modeled ids before adding shared output aliases", () => {
    const progress = parseDeployProgressArtifact(
      progressPayload({
        resources: [
          {
            id: "id-a",
            name: "a",
            type: "A",
            outputResourceIds: ["id-b"],
            status: "failed",
            message: "alias failure"
          },
          {
            id: "id-b",
            name: "b",
            type: "B",
            status: "success",
            message: "direct success"
          }
        ]
      })
    );
    expect(buildDeployStatusMap(progress).get("id-b")).toBe("success");
    expect(buildDeployMessageMap(progress).get("id-b")).toBe("direct success");
  });

  it("does not attach an alias message to a direct id with no message", () => {
    const progress = parseDeployProgressArtifact(
      progressPayload({
        resources: [
          {
            id: "id-a",
            name: "a",
            type: "A",
            outputResourceIds: ["id-b"],
            message: "alias failure"
          },
          { id: "id-b", name: "b", type: "B", message: "" }
        ]
      })
    );
    expect(buildDeployMessageMap(progress).get("id-b")).toBeUndefined();
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
  it("treats an unannotated modeled resource as pending", () => {
    const resources = [{ name: "api" }];
    expect(
      applyDeployStatusToResources(resources, new Map([["api", "success"]]))
    ).toEqual([{ name: "api", from: "pending", to: "success" }]);
    expect(resources).toEqual([{ name: "api", deployStatus: "success" }]);
  });
  it("keeps an unchanged or earlier status without emitting a transition", () => {
    const resources = [{ name: "api", deployStatus: "in_progress" as const }];
    expect(
      applyDeployStatusToResources(resources, new Map([["api", "in_progress"]]))
    ).toEqual([]);
    expect(
      applyDeployStatusToResources(resources, new Map([["api", "pending"]]))
    ).toEqual([]);
    expect(resources[0].deployStatus).toBe("in_progress");
  });
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

  it("ignores a non-array argument rather than throwing", () => {
    expect(() =>
      settleDeployStatuses(
        undefined as unknown as { deployStatus?: DeployStatus }[],
        "failure"
      )
    ).not.toThrow();
  });
});

describe("settleDeployStatuses messages (Exception 5.1)", () => {
  it("says a cancelled run was cancelled", () => {
    const resources: SettleableResource[] = [
      { deployStatus: "in_progress" as DeployStatus }
    ];
    settleDeployStatuses(resources, "cancelled");
    expect(resources[0].deployMessage).toBe(DEPLOY_CANCELLED_MESSAGE);
  });

  it("says a timed-out run timed out", () => {
    const resources: SettleableResource[] = [
      { deployStatus: "pending" as DeployStatus }
    ];
    settleDeployStatuses(resources, "timed_out");
    expect(resources[0].deployMessage).toBe(DEPLOY_TIMED_OUT_MESSAGE);
  });

  it("passes the exact Radius error through on an ordinary failure", () => {
    const resources: SettleableResource[] = [
      { deployStatus: "pending" as DeployStatus }
    ];
    settleDeployStatuses(
      resources,
      "failure",
      "  Error: containers.demo failed to provision\n"
    );
    expect(resources[0].deployMessage).toBe(
      "Error: containers.demo failed to provision"
    );
  });

  it("falls back to a plain statement when there is no Radius error to show", () => {
    const resources: SettleableResource[] = [
      { deployStatus: "pending" as DeployStatus },
      { deployStatus: "in_progress" as DeployStatus }
    ];
    settleDeployStatuses(resources, "failure", "   ");
    expect(resources.map((r) => r.deployMessage)).toEqual([
      DEPLOY_FAILED_MESSAGE,
      DEPLOY_FAILED_MESSAGE
    ]);
  });

  it("keeps the producer's own message, which names the resource that failed", () => {
    const resources: SettleableResource[] = [
      {
        deployStatus: "failed" as DeployStatus,
        deployMessage: "recipe execution failed for db"
      },
      { deployStatus: "pending" as DeployStatus }
    ];
    settleDeployStatuses(resources, "failure", "run-level error");
    expect(resources.map((r) => r.deployMessage)).toEqual([
      "recipe execution failed for db",
      "run-level error"
    ]);
  });

  it.each(["cancelled", "timed_out", "monitor_timed_out", "failure"] as const)(
    "replaces in-flight progress text on a node the %s run failed",
    (conclusion) => {
      // The producer's last snapshot describes work in flight. Once the run's
      // conclusion decides that work never finished, reporting progress on a red
      // node would tell the user the opposite of what happened.
      const resources: SettleableResource[] = [
        {
          deployStatus: "in_progress" as DeployStatus,
          deployMessage: "creating"
        },
        { deployStatus: "pending" as DeployStatus, deployMessage: "queued" }
      ];
      settleDeployStatuses(resources, conclusion);
      expect(resources.map((r) => r.deployStatus)).toEqual([
        "failed",
        "failed"
      ]);
      const expected = unfinishedDeployMessage(conclusion);
      expect(resources.map((r) => r.deployMessage)).toEqual([
        expected,
        expected
      ]);
    }
  );

  it("explains a node the producer reported failed without a message", () => {
    const resources: SettleableResource[] = [
      { deployStatus: "failed" as DeployStatus }
    ];
    settleDeployStatuses(resources, "cancelled");
    expect(resources[0].deployMessage).toBe(DEPLOY_CANCELLED_MESSAGE);
  });

  it("leaves a node the producer already finished alone", () => {
    const resources: SettleableResource[] = [
      {
        deployStatus: "success" as DeployStatus,
        deployMessage: "provisioned"
      }
    ];
    settleDeployStatuses(resources, "failure", "run-level error");
    expect(resources[0]).toEqual({
      deployStatus: "success",
      deployMessage: "provisioned"
    });
  });

  it("clears a stale failure message when the run ultimately succeeded", () => {
    const resources: SettleableResource[] = [
      {
        deployStatus: "failed" as DeployStatus,
        deployMessage: "transient provisioning error"
      }
    ];
    settleDeployStatuses(resources, "success");
    expect(resources[0].deployStatus).toBe("success");
    expect(resources[0].deployMessage).toBeUndefined();
  });

  it("does not disturb an already-settled node when settled again", () => {
    // The monitor settles on its own timeout and the outcome stage settles on a
    // conclusion. Whichever ran first has already decided this node, so a second
    // pass must leave its message alone rather than relabel a settled failure.
    const resources: SettleableResource[] = [
      { deployStatus: "pending" as DeployStatus }
    ];
    settleDeployStatuses(resources, "failure");
    expect(resources[0].deployMessage).toBe(DEPLOY_FAILED_MESSAGE);
    settleDeployStatuses(resources, "failure", "rad: deployment rejected");
    expect(resources[0].deployMessage).toBe(DEPLOY_FAILED_MESSAGE);
    expect(resources[0].deployStatus).toBe("failed");
  });
});

describe("unfinishedDeployMessage", () => {
  it.each([
    ["cancelled", undefined, DEPLOY_CANCELLED_MESSAGE],
    ["timed_out", undefined, DEPLOY_TIMED_OUT_MESSAGE],
    ["monitor_timed_out", undefined, DEPLOY_MONITOR_TIMED_OUT_MESSAGE],
    ["monitor_timed_out", "ignored detail", DEPLOY_MONITOR_TIMED_OUT_MESSAGE],
    ["timed_out", "ignored detail", DEPLOY_TIMED_OUT_MESSAGE],
    ["cancelled", "ignored detail", DEPLOY_CANCELLED_MESSAGE],
    ["failure", "rad error", "rad error"],
    ["failure", undefined, DEPLOY_FAILED_MESSAGE],
    ["failure", "", DEPLOY_FAILED_MESSAGE],
    ["failure", " \t\r\n ", DEPLOY_FAILED_MESSAGE],
    ["failure", " \t\r\n Radius error \t\r\n ", "Radius error"],
    ["unknown", "rad error", "rad error"],
    [undefined, undefined, DEPLOY_FAILED_MESSAGE],
    [null, undefined, DEPLOY_FAILED_MESSAGE]
  ] as const)("maps %s / %s", (conclusion, radiusError, expected) => {
    expect(unfinishedDeployMessage(conclusion, radiusError)).toBe(expected);
  });

  it.each([
    MAX_DEPLOY_MESSAGE_LENGTH - 1,
    MAX_DEPLOY_MESSAGE_LENGTH,
    MAX_DEPLOY_MESSAGE_LENGTH + 1
  ])("bounds a %i-character run-level error after trimming", (length) => {
    const detail = "x".repeat(length);
    const message = unfinishedDeployMessage("failure", ` \n${detail}\t `);
    expect(message).toBe(
      length > MAX_DEPLOY_MESSAGE_LENGTH ?
        "x".repeat(MAX_DEPLOY_MESSAGE_LENGTH - 3) + "..."
      : detail
    );
    expect(message.length).toBe(Math.min(length, MAX_DEPLOY_MESSAGE_LENGTH));
  });

  it("bounds multiline run-level copies without shortening producer failures", () => {
    const radiusError = "Error: recipe failed\n".repeat(200);
    const producerError = "Resource-specific diagnostic\n".repeat(40);
    const resources: SettleableResource[] = [
      {},
      { deployStatus: "pending" },
      { deployStatus: "in_progress", deployMessage: "creating" },
      { deployStatus: "failed", deployMessage: " \t\n " },
      { deployStatus: "failed", deployMessage: producerError }
    ];

    settleDeployStatuses(resources, "failure", radiusError);

    const expected =
      radiusError.slice(0, MAX_DEPLOY_MESSAGE_LENGTH - 3) + "...";
    expect(resources.map((resource) => resource.deployMessage)).toEqual([
      expected,
      expected,
      expected,
      expected,
      producerError
    ]);
    expect(expected).toHaveLength(MAX_DEPLOY_MESSAGE_LENGTH);
    expect(expected).toContain("\n");
  });
});

// A real payload, captured verbatim from a run of the producer's
// publish-deploy-status step (radius-project/ai-extensions). The producer has the
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

  it("indexes status and messages by exact output resource ids", () => {
    const progress = parseDeployProgressArtifact(
      progressPayload({
        resources: [
          {
            id: "parent",
            name: "api",
            type: "Radius.Compute/containers",
            outputResourceIds: ["apps/deployments/api", "core/services/api"],
            status: "success",
            message: "deployed"
          }
        ]
      })
    );
    expect(buildDeployStatusMap(progress)).toEqual(
      new Map([
        ["parent", "success"],
        ["apps/deployments/api", "success"],
        ["core/services/api", "success"],
        ["api|radius.compute/containers", "success"],
        ["api", "success"]
      ])
    );
    expect(buildDeployMessageMap(progress).get("apps/deployments/api")).toBe(
      "deployed"
    );
    const resources = [
      {
        id: "locally-synthesized-parent",
        name: "different-local-name",
        type: "Radius.Compute/containers",
        outputResources: [{ id: "apps/deployments/api" }],
        deployStatus: "in_progress" as const
      }
    ];
    expect(
      applyDeployStatusToResources(resources, buildDeployStatusMap(progress))
    ).toEqual([
      {
        name: "different-local-name",
        from: "in_progress",
        to: "success"
      }
    ]);
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
