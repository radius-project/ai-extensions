import { describe, it, expect } from "vitest";
import {
  applicationGraphToResources,
  findResourceDefinitionLines
} from "./appgraph.js";
import { buildResourceID } from "../../test/support/resource-id.js";

const frontendId = buildResourceID("Radius.Compute/containers", "frontend");
const cacheId = buildResourceID("Radius.Data/redisCaches", "cache");
const databaseId = buildResourceID(
  "Radius.Data/postgreSQLDatabases",
  "database"
);
const frontendHash = `sha256:${"a".repeat(64)}`;
const cacheHash = `sha256:${"b".repeat(64)}`;
const databaseHash = `sha256:${"c".repeat(64)}`;
const alternateHash = `sha256:${"d".repeat(64)}`;
const frontendIconHash = `sha256:${"e".repeat(64)}`;
const frontendIcon = '<svg><path d="M0 0h16v16H0z"/></svg>';
const outputIconHash = `sha256:${"f".repeat(64)}`;
const outputIcon = '<svg><circle cx="8" cy="8" r="8"/></svg>';

function sampleAppGraph(): { resources: any[]; icons: Record<string, string> } {
  return {
    resources: [
      {
        id: frontendId,
        name: "frontend",
        type: "Radius.Compute/containers",
        provisioningState: "NotSpecified",
        connections: [{ id: cacheId, direction: "Outbound" }],
        outputResources: [
          {
            id: `${frontendId}/output`,
            name: "frontend-output",
            type: "Microsoft.App/containerApps",
            iconHash: outputIconHash,
            portalUrl:
              "https://portal.azure.com/#@tenant/resource/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/frontend"
          }
        ],
        diffHash: frontendHash,
        iconHash: frontendIconHash
      },
      {
        id: cacheId,
        name: "cache",
        type: "Radius.Data/redisCaches",
        provisioningState: "NotSpecified",
        connections: [],
        outputResources: [],
        diffHash: cacheHash
      }
    ],
    icons: {
      [frontendIconHash]: frontendIcon,
      [outputIconHash]: outputIcon
    }
  };
}

describe("applicationGraphToResources", () => {
  it("converts an ApplicationGraphResponse into the canvas resource array", () => {
    const resources = applicationGraphToResources(
      sampleAppGraph(),
      ".radius/app.bicep"
    );
    expect(resources).toHaveLength(2);
    const frontend = resources.find((r) => r.id === frontendId);
    expect(frontend.name).toBe("frontend");
    expect(frontend.type).toBe("Radius.Compute/containers");
    expect(frontend.definitionFile).toBe(".radius/app.bicep");
    expect(frontend.diffHash).toBe(frontendHash);
    expect(frontend.iconHash).toBe(frontendIconHash);
    expect(frontend.icon).toBe(frontendIcon);
    expect(frontend.outputResources[0].icon).toBe(outputIcon);
    expect(frontend.outputResources[0].portalUrl).toBe(
      "https://portal.azure.com/#@tenant/resource/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/frontend"
    );
  });

  it("preserves outbound edges and rebuilds inbound edges", () => {
    const resources = applicationGraphToResources(sampleAppGraph());
    const frontend = resources.find((r) => r.id === frontendId);
    const cache = resources.find((r) => r.id === cacheId);
    expect(frontend.connections).toContainEqual({
      id: cacheId,
      direction: "Outbound"
    });
    // cache had no connections in the input; inbound edge is synthesized.
    expect(cache.connections).toContainEqual({
      id: frontendId,
      direction: "Inbound"
    });
  });

  it("does not duplicate inbound edges already present in the input", () => {
    const graph = sampleAppGraph();
    // rad emits both directions; the converter must drop the incoming inbound
    // edge and rebuild it, not keep both.
    graph.resources[1].connections.push({
      id: frontendId,
      direction: "Inbound"
    });
    const resources = applicationGraphToResources(graph);
    const cache = resources.find((r) => r.id === cacheId);
    const inbound = cache.connections.filter(
      (c: any) => c.direction === "Inbound"
    );
    expect(inbound).toHaveLength(1);
  });

  it("sorts outbound edges by id", () => {
    const graph = sampleAppGraph();
    graph.resources[0].connections = [
      { id: cacheId, direction: "Outbound" },
      { id: databaseId, direction: "Outbound" }
    ];
    graph.resources.push({
      id: databaseId,
      name: "database",
      type: "Radius.Data/postgreSQLDatabases",
      provisioningState: "NotSpecified",
      connections: [],
      outputResources: [],
      diffHash: databaseHash
    });

    const resources = applicationGraphToResources(graph);
    const frontend = resources.find((r) => r.id === frontendId);
    expect(frontend.connections).toEqual([
      { id: databaseId, direction: "Outbound" },
      { id: cacheId, direction: "Outbound" }
    ]);
  });

  it("accepts a bare resources array", () => {
    const resources = applicationGraphToResources(sampleAppGraph().resources);
    expect(resources).toHaveLength(2);
  });

  it("returns an empty array for empty or malformed input", () => {
    expect(applicationGraphToResources({ resources: [] })).toEqual([]);
    expect(applicationGraphToResources([])).toEqual([]);
    expect(applicationGraphToResources(null)).toEqual([]);
    expect(applicationGraphToResources({})).toEqual([]);
  });

  it("skips entries missing an id or type", () => {
    const resources = applicationGraphToResources([
      { name: "no-id", type: "Radius.Compute/containers" },
      { id: "x", name: "no-type" },
      {
        id: frontendId,
        name: "frontend",
        type: "Radius.Compute/containers",
        diffHash: frontendHash
      }
    ]);
    expect(resources).toHaveLength(1);
    expect(resources[0].id).toBe(frontendId);
  });

  it("throws when the input lacks a diffHash", () => {
    expect(() =>
      applicationGraphToResources([
        {
          id: frontendId,
          name: "frontend",
          type: "Radius.Compute/containers",
          properties: { image: "node:18" }
        }
      ])
    ).toThrow(/missing a valid diffHash/);
  });

  it.each([
    "sha256:",
    "sha256:abc",
    `sha256:${"g".repeat(64)}`,
    `SHA256:${"a".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
    `sha256:${"a".repeat(65)}`
  ])("throws when the input has malformed diffHash %s", (diffHash) => {
    expect(() =>
      applicationGraphToResources([
        {
          id: frontendId,
          name: "frontend",
          type: "Radius.Compute/containers",
          diffHash
        }
      ])
    ).toThrow(/missing a valid diffHash/);
  });

  it("orders synthesized inbound edges deterministically regardless of input order", () => {
    // cache is targeted by two sources listed in reverse-sorted order; the
    // inbound edges must come out sorted by id so computeGraphDiff is stable.
    const resources = applicationGraphToResources([
      {
        id: frontendId,
        name: "frontend",
        type: "Radius.Compute/containers",
        connections: [{ id: cacheId, direction: "Outbound" }],
        diffHash: frontendHash
      },
      {
        id: databaseId,
        name: "database",
        type: "Radius.Data/postgreSQLDatabases",
        connections: [{ id: cacheId, direction: "Outbound" }],
        diffHash: databaseHash
      },
      {
        id: cacheId,
        name: "cache",
        type: "Radius.Data/redisCaches",
        connections: [],
        diffHash: cacheHash
      }
    ]);
    const cache = resources.find((r) => r.id === cacheId);
    const sorted = [...cache.connections].sort((a: any, b: any) =>
      String(a.id).localeCompare(String(b.id))
    );
    expect(cache.connections).toEqual(sorted);
  });

  it("preserves diffHash from input even when dependsOn is present", () => {
    const resources = applicationGraphToResources([
      {
        id: frontendId,
        name: "frontend",
        type: "Radius.Compute/containers",
        properties: { image: "node:18" },
        dependsOn: [cacheId, databaseId],
        diffHash: alternateHash
      }
    ]);
    expect(resources[0].diffHash).toBe(alternateHash);
  });

  it("reads codeReference from resource properties (rad app graph shape)", () => {
    const resources = applicationGraphToResources([
      {
        id: frontendId,
        name: "frontend",
        type: "Radius.Compute/containers",
        diffHash: frontendHash,
        properties: { codeReference: "src/index.js#L18" }
      }
    ]);
    expect(resources[0].codeReference).toBe("src/index.js#L18");
  });

  it("derives definition lines from resource symbols and literal names", () => {
    const content = [
      "extension radius",
      "",
      "resource frontend 'Radius.Compute/containers@2023-10-01-preview' = {",
      "  name: 'web'",
      "}",
      "",
      "resource database 'Radius.Data/sqlDatabases@2023-10-01-preview' = {",
      "  name: app.name",
      "}"
    ].join("\n");

    expect(findResourceDefinitionLines(content)).toEqual(
      new Map([
        ["frontend", 3],
        ["web", 3],
        ["database", 7]
      ])
    );
  });

  it("adds the authored resource line when rad omits definitionLine", () => {
    const graph = sampleAppGraph();
    const content = [
      "resource frontend 'Radius.Compute/containers@2023-10-01-preview' = {",
      "  name: 'frontend'",
      "}",
      "resource cache 'Radius.Data/redisCaches@2023-10-01-preview' = {",
      "  name: 'cache'",
      "}"
    ].join("\n");

    const resources = applicationGraphToResources(
      graph,
      ".radius/app.bicep",
      content
    );

    expect(resources.find((r) => r.name === "frontend").definitionLine).toBe(1);
    expect(resources.find((r) => r.name === "cache").definitionLine).toBe(4);
  });

  it("preserves a definitionLine emitted by rad", () => {
    const graph = sampleAppGraph();
    graph.resources[0].definitionLine = 42;
    const content =
      "resource frontend 'Radius.Compute/containers@2023-10-01-preview' = {}";

    const resources = applicationGraphToResources(
      graph,
      ".radius/app.bicep",
      content
    );

    expect(resources[0].definitionLine).toBe(42);
  });

  it("prefers the codeReference in properties over a legacy top-level one", () => {
    const resources = applicationGraphToResources([
      {
        id: frontendId,
        name: "frontend",
        type: "Radius.Compute/containers",
        diffHash: frontendHash,
        codeReference: "legacy.js#L1",
        properties: { codeReference: "src/index.js#L18" }
      }
    ]);
    expect(resources[0].codeReference).toBe("src/index.js#L18");
  });

  it("falls back to a legacy top-level codeReference when properties lacks one", () => {
    const resources = applicationGraphToResources([
      {
        id: frontendId,
        name: "frontend",
        type: "Radius.Compute/containers",
        diffHash: frontendHash,
        codeReference: "legacy.js#L1",
        properties: { image: "node:18" }
      }
    ]);
    expect(resources[0].codeReference).toBe("legacy.js#L1");
  });

  it("defaults codeReference to an empty string when absent", () => {
    const resources = applicationGraphToResources([
      {
        id: frontendId,
        name: "frontend",
        type: "Radius.Compute/containers",
        diffHash: frontendHash
      }
    ]);
    expect(resources[0].codeReference).toBe("");
  });

  it("throws when diffHash is missing even with dependsOn present", () => {
    expect(() =>
      applicationGraphToResources([
        {
          id: frontendId,
          name: "frontend",
          type: "Radius.Compute/containers",
          properties: { image: "node:18" },
          dependsOn: [cacheId]
        }
      ])
    ).toThrow(/missing a valid diffHash/);
  });
});

describe("applicationGraphToResources — icon resolution", () => {
  function graphWithIcons(resource: any, icons: unknown) {
    return applicationGraphToResources({
      resources: [
        {
          id: frontendId,
          name: "frontend",
          type: "Radius.Compute/containers",
          diffHash: frontendHash,
          ...resource
        }
      ],
      icons
    });
  }

  it("prefers an inline icon over the shared icon map", () => {
    const inline = "<svg><rect/></svg>";
    const resources = graphWithIcons(
      { icon: inline, iconHash: frontendIconHash },
      { [frontendIconHash]: frontendIcon }
    );

    expect(resources[0].icon).toBe(inline);
  });

  it("falls back to the icon map when the inline icon is an empty string", () => {
    const resources = graphWithIcons(
      { icon: "", iconHash: frontendIconHash },
      { [frontendIconHash]: frontendIcon }
    );

    expect(resources[0].icon).toBe(frontendIcon);
  });

  it("falls back to the icon map when the inline icon is not a string", () => {
    const resources = graphWithIcons(
      { icon: 42, iconHash: frontendIconHash },
      { [frontendIconHash]: frontendIcon }
    );

    expect(resources[0].icon).toBe(frontendIcon);
  });

  it.each([
    ["a missing icons map", undefined],
    ["a null icons map", null],
    ["an array icons map", [frontendIcon]],
    ["a non-object icons map", "not-a-map"]
  ])("resolves no icon for %s", (_label, icons) => {
    const resources = graphWithIcons({ iconHash: frontendIconHash }, icons);

    expect(resources[0].icon).toBe("");
    expect(resources[0].iconHash).toBe(frontendIconHash);
  });

  it("resolves no icon when the hash is absent from the map", () => {
    const resources = graphWithIcons(
      { iconHash: `sha256:${"9".repeat(64)}` },
      { [frontendIconHash]: frontendIcon }
    );

    expect(resources[0].icon).toBe("");
  });

  it.each([
    ["a non-string icon hash", { iconHash: 7 }],
    ["no icon hash at all", {}]
  ] as Array<[string, Record<string, unknown>]>)(
    "defaults the icon and hash to empty strings for %s",
    (_label, extra) => {
      const resources = graphWithIcons(extra, {
        [frontendIconHash]: frontendIcon
      });

      expect(resources[0].icon).toBe("");
      expect(resources[0].iconHash).toBe(extra.iconHash ?? "");
    }
  );

  it("resolves no icon when the mapped entry is not a string", () => {
    const resources = graphWithIcons(
      { iconHash: frontendIconHash },
      { [frontendIconHash]: { svg: frontendIcon } }
    );

    expect(resources[0].icon).toBe("");
  });

  it("resolves output-resource icons through the same map", () => {
    const resources = graphWithIcons(
      {
        outputResources: [
          { id: "out-1", name: "out", iconHash: outputIconHash },
          { id: "out-2", name: "inline", icon: "<svg/>" },
          { id: "out-3", name: "none" }
        ]
      },
      { [outputIconHash]: outputIcon }
    );

    expect(resources[0].outputResources.map((o: any) => o.icon)).toEqual([
      outputIcon,
      "<svg/>",
      ""
    ]);
  });
});

describe("applicationGraphToResources — input normalization", () => {
  const base = {
    id: frontendId,
    type: "Radius.Compute/containers",
    diffHash: frontendHash
  };

  it("skips non-object entries in the resources array", () => {
    const resources = applicationGraphToResources([
      null,
      undefined,
      "container",
      42,
      base
    ]);

    expect(resources).toHaveLength(1);
    expect(resources[0].id).toBe(frontendId);
  });

  it("defaults a missing name and provisioning state", () => {
    const resources = applicationGraphToResources([base]);

    expect(resources[0].name).toBe("");
    expect(resources[0].provisioningState).toBe("NotSpecified");
  });

  it("preserves a provisioning state reported by rad", () => {
    const resources = applicationGraphToResources([
      { ...base, provisioningState: "Succeeded" }
    ]);

    expect(resources[0].provisioningState).toBe("Succeeded");
  });

  it.each([
    ["a non-array connections value", { connections: "cache" }],
    ["a missing connections value", {}]
  ])("treats %s as no connections", (_label, extra) => {
    const resources = applicationGraphToResources([{ ...base, ...extra }]);

    expect(resources[0].connections).toEqual([]);
  });

  it("drops connection entries with no id and non-outbound entries", () => {
    const resources = applicationGraphToResources([
      {
        ...base,
        connections: [
          null,
          { direction: "Outbound" },
          { id: cacheId, direction: "Inbound" },
          { id: databaseId }
        ]
      },
      { id: cacheId, type: "Radius.Data/redisCaches", diffHash: cacheHash },
      {
        id: databaseId,
        type: "Radius.Data/postgreSQLDatabases",
        diffHash: databaseHash
      }
    ]);

    const frontend = resources.find((r) => r.id === frontendId);
    // A connection without an explicit direction defaults to Outbound.
    expect(frontend.connections).toEqual([
      { id: databaseId, direction: "Outbound" }
    ]);
  });

  it("treats a non-array outputResources value as empty", () => {
    const resources = applicationGraphToResources([
      { ...base, outputResources: { id: "out" } }
    ]);

    expect(resources[0].outputResources).toEqual([]);
  });

  it("ignores a non-positive definitionLine emitted by rad", () => {
    const resources = applicationGraphToResources([
      { ...base, name: "frontend", definitionLine: 0 },
      { ...base, id: cacheId, name: "cache", definitionLine: -3 }
    ]);

    expect(resources.map((r) => r.definitionLine)).toEqual([0, 0]);
  });

  it("defaults the definition file when the caller supplies none", () => {
    const resources = applicationGraphToResources([base]);

    expect(resources[0].definitionFile).toBe(".radius/app.bicep");
  });

  it("falls back to the id leaf when matching authored definition lines", () => {
    const content = [
      "param x string",
      "",
      "resource frontend 'T' = {",
      "}"
    ].join("\n");
    const resources = applicationGraphToResources(
      [{ ...base, name: "" }],
      ".radius/app.bicep",
      content
    );

    expect(resources[0].definitionLine).toBe(3);
  });
});

describe("findResourceDefinitionLines", () => {
  it("returns an empty map for empty content", () => {
    expect(findResourceDefinitionLines("")).toEqual(new Map());
  });

  it("records the declaration line for an existing resource", () => {
    const content = [
      "resource cluster 'Radius.Compute/clusters@2025-01-01' existing = {",
      "  name: 'shared'",
      "}"
    ].join("\n");

    const lines = findResourceDefinitionLines(content);

    expect(lines.get("cluster")).toBe(1);
    expect(lines.get("shared")).toBe(1);
  });

  it("keeps the first declaration when two resources share a literal name", () => {
    const content = [
      "resource first 'T' = {",
      "  name: 'shared'",
      "}",
      "resource second 'T' = {",
      "  name: 'shared'",
      "}"
    ].join("\n");

    const lines = findResourceDefinitionLines(content);

    expect(lines.get("shared")).toBe(1);
    expect(lines.get("second")).toBe(4);
  });

  it("ignores a name inside a comment", () => {
    const content = [
      "resource api 'T' = {",
      "  // name: 'commented'",
      "  name: 'real'",
      "}"
    ].join("\n");

    const lines = findResourceDefinitionLines(content);

    expect(lines.has("commented")).toBe(false);
    expect(lines.get("real")).toBe(1);
  });

  it("ignores a name nested below the resource's own property level", () => {
    // Only the resource's top-level `name` identifies it; a `name` inside a
    // nested object (e.g. a container spec) must not claim the declaration line.
    const content = [
      "resource api 'T' = {",
      "  name: 'api'",
      "  properties: {",
      "    container: {",
      "      name: 'nested'",
      "    }",
      "  }",
      "}"
    ].join("\n");

    const lines = findResourceDefinitionLines(content);

    expect(lines.get("api")).toBe(1);
    expect(lines.has("nested")).toBe(false);
  });

  it("handles a single-line resource declaration", () => {
    const content = "resource api 'T' = { name: 'inline' }";

    const lines = findResourceDefinitionLines(content);

    expect(lines.get("api")).toBe(1);
    expect(lines.get("inline")).toBe(1);
  });

  it("normalizes CRLF line endings", () => {
    const content =
      "param x string\r\nresource api 'T' = {\r\n  name: 'api'\r\n}";

    const lines = findResourceDefinitionLines(content);

    expect(lines.get("api")).toBe(2);
  });

  it("records nothing when the content declares no resources", () => {
    expect(findResourceDefinitionLines("param name string\nvar x = 1")).toEqual(
      new Map()
    );
  });
});
