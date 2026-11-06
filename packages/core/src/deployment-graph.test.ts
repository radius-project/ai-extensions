import { describe, expect, it } from "vitest";
import {
  deploymentGraphResources,
  projectDeploymentGraph
} from "./deployment-graph.js";

describe("deployment graph projection", () => {
  it("normalizes resource and connection fields without discarding metadata", () => {
    expect(
      deploymentGraphResources([
        null,
        [],
        {
          id: "id",
          name: "app",
          type: "type",
          marker: "kept",
          connections: [null, { id: "db", name: 3, direction: "outbound" }]
        }
      ])
    ).toEqual([
      { id: "", name: "", type: "" },
      { id: "", name: "", type: "" },
      {
        id: "id",
        name: "app",
        type: "type",
        marker: "kept",
        connections: [
          { id: "", name: "", direction: "" },
          { id: "db", name: "", direction: "outbound" }
        ]
      }
    ]);
  });

  it("uses safe metadata projection before publishing workflow graph resources", () => {
    expect(projectDeploymentGraph(null)).toEqual([]);
    expect(
      projectDeploymentGraph({
        resources: [
          {
            id: "id",
            name: "app",
            type: "Radius.Core/applications",
            unexpected: "discard"
          }
        ]
      })
    ).toEqual([
      {
        id: "id",
        name: "app",
        type: "Radius.Core/applications",
        connections: [],
        outputResources: []
      }
    ]);
  });
});
