import { describe, expect, it } from "vitest";
import { deployedGraphResources } from "./deployed-graph-state.js";

describe("deployed graph state boundary", () => {
  it("unwraps graph envelopes and preserves validated resource metadata", () => {
    const resources = [
      {
        id: "web",
        name: "web",
        type: "container",
        deployStatus: "success",
        connections: [{ id: "db", direction: "outbound" }],
        outputResources: [{ name: "pod" }],
        providerMetadata: { region: "west" }
      }
    ];
    expect(deployedGraphResources({ resources, application: "app" })).toBe(
      resources
    );
    expect(deployedGraphResources(resources)).toBe(resources);
    expect(deployedGraphResources([])).toEqual([]);
  });

  it.each([
    null,
    "invalid",
    {},
    [null],
    [{ name: 2 }],
    [{ deployStatus: "unknown" }],
    [{ connections: {} }],
    [{ connections: [null] }],
    [{ connections: [{ id: 2 }] }],
    [{ outputResources: {} }],
    [{ outputResources: [{ name: 2 }] }]
  ])("refuses graph data incompatible with shared state: %j", (graph) => {
    expect(deployedGraphResources(graph)).toBeNull();
  });

  it.each(["pending", "in_progress", "success", "failed"])(
    "accepts %s resource state",
    (deployStatus) => {
      expect(deployedGraphResources([{ deployStatus }])).toEqual([
        { deployStatus }
      ]);
    }
  );
});
