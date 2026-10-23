import { describe, expect, it } from "vitest";
import { canvasGraphResources } from "./canvas-graph-resources.js";

describe("Canvas graph resource projection", () => {
  it("retains graph metadata without mutating producer objects", () => {
    const resource = {
      id: "app",
      name: "App",
      type: "Applications.Core/applications",
      custom: "metadata",
      connections: [{ id: "db", name: "Database", direction: "out", custom: 1 }]
    };
    const result = canvasGraphResources([resource]);
    expect(result).toEqual([resource]);
    expect(result[0]).not.toBe(resource);
    expect(result[0].connections?.[0]).not.toBe(resource.connections[0]);
  });

  it("normalizes missing and malformed resource and connection identity", () => {
    expect(
      canvasGraphResources([
        null,
        [],
        { id: 2, name: false, type: {}, connections: [null, { id: "db" }] },
        { id: "empty", connections: [] }
      ])
    ).toEqual([
      { id: "", name: "", type: "" },
      { id: "", name: "", type: "" },
      {
        id: "",
        name: "",
        type: "",
        connections: [
          { id: "", name: "", direction: "" },
          { id: "db", name: "", direction: "" }
        ]
      },
      { id: "empty", name: "", type: "", connections: [] }
    ]);
    expect(canvasGraphResources([])).toEqual([]);
  });
});
