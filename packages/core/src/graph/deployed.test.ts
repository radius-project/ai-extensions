import { describe, it, expect } from "vitest";
import {
  deployStatusKeys,
  lookupDeployStatus,
  projectDeployedGraph
} from "./deployed.js";
import type { DeployStatus } from "./deployed.js";
import { buildResourceID } from "../../test/support/resource-id.js";

function makeResource(type: string, name: string, extra: any = {}) {
  return {
    id: buildResourceID(type, name),
    name,
    type,
    connections: [],
    ...extra
  };
}

describe("deployStatusKeys", () => {
  it("yields id, name|type, then name in priority order", () => {
    const resource = makeResource("Radius.Compute/containers", "Frontend");
    expect(deployStatusKeys(resource)).toEqual([
      resource.id,
      "frontend|radius.compute/containers",
      "frontend"
    ]);
  });

  it("strips the API version from the type key", () => {
    expect(
      deployStatusKeys({
        name: "db",
        type: "Radius.Data/postgreSQLDatabases@2025-08-01-preview"
      })
    ).toEqual(["db|radius.data/postgresqldatabases", "db"]);
  });

  it("omits keys it cannot build", () => {
    expect(deployStatusKeys({ name: "solo" })).toEqual(["solo"]);
    expect(deployStatusKeys({ id: "  " })).toEqual([]);
    expect(deployStatusKeys(null)).toEqual([]);
  });
});

describe("lookupDeployStatus", () => {
  const resource = makeResource("Radius.Compute/containers", "frontend");

  it("prefers an id match over name and name|type", () => {
    const map = new Map<string, DeployStatus>([
      [resource.id, "success"],
      ["frontend|radius.compute/containers", "failed"],
      ["frontend", "failed"]
    ]);
    expect(lookupDeployStatus(resource, map)).toBe("success");
  });

  it("falls back to name|type when the id is absent from the map", () => {
    const map = new Map<string, DeployStatus>([
      ["frontend|radius.compute/containers", "in_progress"],
      ["frontend", "failed"]
    ]);
    expect(lookupDeployStatus(resource, map)).toBe("in_progress");
  });

  it("falls back to the bare name last", () => {
    expect(
      lookupDeployStatus(resource, new Map([["frontend", "failed"]]))
    ).toBe("failed");
  });

  it("returns undefined when the resource is absent, so callers can keep the current status", () => {
    expect(lookupDeployStatus(resource, new Map())).toBeUndefined();
  });

  it("accepts a plain object map as well as a Map", () => {
    expect(lookupDeployStatus(resource, { frontend: "success" })).toBe(
      "success"
    );
  });
});

describe("projectDeployedGraph", () => {
  it("strips output resources from every node", () => {
    const resources = [
      makeResource("Radius.Compute/containers", "api", {
        outputResources: [
          { id: "/subscriptions/x", type: "Microsoft.Web/sites" }
        ]
      })
    ];
    const projected = projectDeployedGraph(resources);
    expect(projected[0].outputResources).toEqual([]);
    // The input is never mutated.
    expect(resources[0].outputResources).toHaveLength(1);
  });

  it("defaults every unknown resource to pending", () => {
    const projected = projectDeployedGraph([
      makeResource("Radius.Compute/containers", "api")
    ]);
    expect(projected[0].deployStatus).toBe("pending");
  });

  it("copies statuses in by id, by name|type, and by name", () => {
    const api = makeResource("Radius.Compute/containers", "api");
    const db = makeResource("Radius.Data/postgreSQLDatabases", "db");
    const cache = makeResource("Radius.Data/redisCaches", "cache");
    const projected = projectDeployedGraph([api, db, cache], {
      [api.id]: "success",
      "db|radius.data/postgresqldatabases": "in_progress",
      cache: "failed"
    });
    expect(projected.map((r) => r.deployStatus)).toEqual([
      "success",
      "in_progress",
      "failed"
    ]);
  });

  it("keeps a status a resource already carries when the map does not mention it", () => {
    // Projecting a just-deployed application against an empty map (an artifact
    // read that came back empty) must not repaint it as pending.
    const projected = projectDeployedGraph(
      [
        makeResource("Radius.Compute/containers", "api", {
          deployStatus: "success"
        }),
        makeResource("Radius.Data/redisCaches", "cache", {
          deployStatus: "failed"
        })
      ],
      new Map()
    );
    expect(projected.map((r) => r.deployStatus)).toEqual(["success", "failed"]);
  });

  it("lets the status map override a status the resource already carries", () => {
    const api = makeResource("Radius.Compute/containers", "api", {
      deployStatus: "in_progress"
    });
    const projected = projectDeployedGraph([api], { api: "success" });
    expect(projected[0].deployStatus).toBe("success");
  });

  it("applies the visualization filter before projecting (#145, #149)", () => {
    const api = makeResource("Radius.Compute/containers", "api");
    const image = makeResource("Radius.Compute/containerImages", "apiImage");
    const secret = makeResource(
      "Radius.Security/secrets",
      "radius-ghcr-registry-creds",
      { connections: [{ id: image.id, direction: "Outbound" }] }
    );
    const projected = projectDeployedGraph([api, image, secret]);
    expect(projected.map((r) => r.name)).toEqual(["api"]);
  });

  it("clones connections so the projection cannot mutate the modeled graph", () => {
    const api = makeResource("Radius.Compute/containers", "api", {
      connections: [{ id: "db", direction: "Outbound" }]
    });
    const projected = projectDeployedGraph([api]);
    projected[0].connections[0].direction = "Inbound";
    expect(api.connections[0].direction).toBe("Outbound");
  });

  it("normalizes a missing connections array to an empty one", () => {
    const projected = projectDeployedGraph([
      { id: "a", name: "a", type: "Radius.Compute/containers" }
    ]);
    expect(projected[0].connections).toEqual([]);
  });

  it("returns an empty array for non-array input", () => {
    expect(projectDeployedGraph(undefined as any)).toEqual([]);
    expect(projectDeployedGraph(null as any)).toEqual([]);
  });
});
