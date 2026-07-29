import { describe, it, expect } from "vitest";
import { projectDeployedGraph, type DeployStatus } from "./deployed.js";
import { buildResourceID } from "./model.js";

function makeResource(type: string, name: string, extra: any = {}) {
  return {
    id: buildResourceID(type, name),
    name,
    type,
    connections: [],
    outputResources: [],
    ...extra,
  };
}

describe("projectDeployedGraph", () => {
  it("returns an empty array for empty input", () => {
    expect(projectDeployedGraph([])).toEqual([]);
  });

  it("strips outputResources from every resource", () => {
    const resources = [
      makeResource("Radius.Data/postgreSqlDatabases", "postgresql", {
        outputResources: [
          { id: "/subscriptions/x/resourceGroups/y/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg", name: "pg", type: "Microsoft.DBforPostgreSQL/flexibleServers" },
        ],
      }),
    ];
    const result = projectDeployedGraph(resources);
    expect(result).toHaveLength(1);
    expect(result[0].outputResources).toEqual([]);
  });

  it("defaults every node's deployStatus to 'pending' when statusById is empty", () => {
    const resources = [
      makeResource("Applications.Core/containers", "frontend"),
      makeResource("Radius.Data/postgreSqlDatabases", "postgresql"),
    ];
    const result = projectDeployedGraph(resources);
    expect(result.map((r) => r.deployStatus)).toEqual(["pending", "pending"]);
  });

  it("copies statusById entries keyed by id onto the matching node", () => {
    const container = makeResource("Applications.Core/containers", "frontend");
    const db = makeResource("Radius.Data/postgreSqlDatabases", "postgresql");
    const statusById: Record<string, DeployStatus> = {
      [container.id]: "success",
      [db.id]: "failed",
    };
    const result = projectDeployedGraph([container, db], statusById);
    expect(result[0].deployStatus).toBe("success");
    expect(result[1].deployStatus).toBe("failed");
  });

  it("falls back to name-keyed statusById entries when the resource has no id", () => {
    const noId = { name: "frontend", type: "Applications.Core/containers", connections: [], outputResources: [] };
    const result = projectDeployedGraph([noId], { frontend: "in_progress" });
    expect(result[0].deployStatus).toBe("in_progress");
  });

  it("defaults unknown status keys to 'pending' without throwing", () => {
    const container = makeResource("Applications.Core/containers", "frontend");
    const result = projectDeployedGraph([container], { "some/other/id": "success" });
    expect(result[0].deployStatus).toBe("pending");
  });

  it("runs filterGraphVisualizationResources first so containerImages are dropped", () => {
    const resources = [
      makeResource("Applications.Core/containers", "frontend"),
      makeResource("Radius.Compute/containerImages", "frontendImage"),
    ];
    const result = projectDeployedGraph(resources);
    expect(result.map((r) => r.type)).toEqual(["Applications.Core/containers"]);
  });

  it("does not mutate the input resources", () => {
    const resources = [
      makeResource("Radius.Data/postgreSqlDatabases", "postgresql", {
        outputResources: [{ id: "some/output", name: "pg", type: "x/y" }],
      }),
    ];
    const before = JSON.stringify(resources);
    projectDeployedGraph(resources, { [resources[0].id]: "success" });
    expect(JSON.stringify(resources)).toBe(before);
  });

  it("preserves connections, codeReference and other Modeled fields", () => {
    const container = makeResource("Applications.Core/containers", "frontend", {
      connections: [{ id: "db/id", direction: "Outbound" }],
      codeReference: ".radius/app.bicep#L42",
      definitionFile: ".radius/app.bicep",
      definitionLine: 42,
      icon: "https://example.com/icon.svg",
    });
    const result = projectDeployedGraph([container]);
    expect(result[0].connections).toEqual([{ id: "db/id", direction: "Outbound" }]);
    expect(result[0].codeReference).toBe(".radius/app.bicep#L42");
    expect(result[0].definitionFile).toBe(".radius/app.bicep");
    expect(result[0].definitionLine).toBe(42);
    expect(result[0].icon).toBe("https://example.com/icon.svg");
  });
});
