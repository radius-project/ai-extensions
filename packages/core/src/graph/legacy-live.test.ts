import { describe, expect, it } from "vitest";
import { normalizeLegacyLiveGraph } from "./legacy-live.js";
import { normalizeLiveGraph } from "./live.js";

const prefix = "/planes/radius/local/resourceGroups/demo/providers/";
const web = {
  id: prefix + "Applications.Core/containers/web",
  name: "web",
  type: "Applications.Core/containers",
  provisioningState: "RawPending"
};
const context = {
  connectionId: "selected",
  plane: { type: "radius", name: "local" },
  applicationId: prefix + "Applications.Core/applications/app"
};

describe("explicit legacy live graph adaptation", () => {
  it("retains response icons through both legacy overloads and keeps edge direction", () => {
    const hash = "b".repeat(64);
    const icon = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const dependency = {
      ...web,
      id: prefix + "Contoso/widgets/dependency",
      name: "dependency"
    };
    const input = {
      resources: [
        {
          ...web,
          iconHash: hash,
          connections: [{ id: dependency.id, direction: "Outbound" }]
        },
        dependency
      ],
      icons: { [hash]: icon }
    };
    const before = structuredClone(input);
    for (const result of [
      normalizeLegacyLiveGraph(input),
      normalizeLegacyLiveGraph(input, context)
    ]) {
      expect(result.resources[0].icon).toBe(icon);
      expect(result.resources[1].connections).toEqual([
        { id: web.id, direction: "Outbound" }
      ]);
    }
    expect(input).toEqual(before);
  });
  it.each([
    ["Applications.Core/gateways", undefined, false],
    ["Radius.Compute/routes", undefined, false],
    ["APPLICATIONS.CORE/GATEWAYS", "Other/widgets", false],
    ["Radius.Compute/routes", "Contoso.Net/routes", false],
    ["Contoso.Net/gateways", "Applications.Core/gateways", true],
    ["Contoso.Net/routes", "Radius.Compute/routes", true],
    [
      "Applications.Core/gateways/parent/children",
      "Applications.Core/gateways",
      true
    ]
  ])(
    "uses ID type %s instead of supplied type %s",
    (idType, suppliedType, ownerFirst) => {
      const dependency = {
        id: prefix + idType + "/dependency",
        name: "dependency",
        type: "Unrelated/displayType"
      };
      const input = {
        resources: [
          {
            ...web,
            connections: [
              {
                id: dependency.id,
                direction: "Inbound",
                ...(suppliedType === undefined ? {} : { type: suppliedType })
              }
            ]
          },
          dependency
        ]
      };
      const before = structuredClone(input);
      const result = normalizeLegacyLiveGraph(input);
      expect(result.resources[ownerFirst ? 0 : 1].connections).toEqual([
        { id: ownerFirst ? dependency.id : web.id, direction: "Outbound" }
      ]);
      expect(input).toEqual(before);
    }
  );
  it.each([
    ["Applications.Datastores/redisCaches", "Outbound", false],
    ["Applications.Datastores/redisCaches", "Inbound", true],
    ["Applications.Core/gateways", "Inbound", false],
    ["APPLICATIONS.CORE/GATEWAYS", "Inbound", false],
    ["Radius.Compute/routes", "Inbound", false],
    ["radius.compute/ROUTES", "Inbound", false],
    ["Radius.Compute/routes", "Outbound", false],
    ["Contoso.Net/gateways", "Inbound", true],
    ["Contoso.Net/routes", "Inbound", true],
    ["Radius.Networking/gateways", "Inbound", true],
    ["Applications.Core/mygateways", "Inbound", true]
  ])(
    "adapts %s %s once without source mutation",
    (type, direction, ownerFirst) => {
      const dependency = {
        id: prefix + type + "/dependency",
        name: "dependency",
        type
      };
      const input = {
        name: "app",
        resources: [
          { ...web, connections: [{ id: dependency.id, type, direction }] },
          dependency
        ]
      };
      const before = structuredClone(input);
      const result = normalizeLegacyLiveGraph(input);
      const source = ownerFirst ? result.resources[0] : result.resources[1];
      expect(source.connections).toEqual([
        { id: ownerFirst ? dependency.id : web.id, direction: "Outbound" }
      ]);
      expect(result.kind).toBe("legacy-live");
      expect(result).not.toHaveProperty("context");
      expect(result.resources[0].provisioningState).toBe("RawPending");
      expect(result.resources[0]).not.toHaveProperty("diffHash");
      expect(input).toEqual(before);
      expect(normalizeLegacyLiveGraph(input)).toEqual(result);
      const selected = normalizeLegacyLiveGraph(input, context);
      expect(selected.context).toEqual(context);
      expect(selected.resources).toEqual(result.resources);
    }
  );
  it("does not change default live direction semantics", () => {
    const other = { ...web, id: prefix + "Other/widgets/other", name: "other" };
    const input = {
      resources: [
        { ...web, connections: [{ id: other.id, direction: "Outbound" }] },
        other
      ]
    };
    expect(
      normalizeLiveGraph(input, context).resources[0].connections[0].id
    ).toBe(other.id);
    expect(normalizeLegacyLiveGraph(input).resources[1].connections[0].id).toBe(
      web.id
    );
  });
  it("retains actual current compute IDs while applying the exact current route rule", () => {
    const owner = {
      ...web,
      id: prefix + "Radius.Compute/containers/web",
      type: "Radius.Compute/containers"
    };
    const route = {
      id: prefix + "Radius.Compute/routes/edge",
      name: "edge",
      type: "Radius.Compute/routes"
    };
    const result = normalizeLegacyLiveGraph({
      resources: [
        { ...owner, connections: [{ ...route, direction: "Inbound" }] },
        route
      ]
    });
    expect(result.resources.map((resource) => resource.id)).toEqual([
      owner.id,
      route.id
    ]);
    expect(result.resources[0].connections).toEqual([]);
    expect(result.resources[1].connections).toEqual([
      { id: owner.id, direction: "Outbound" }
    ]);
  });
  it("keeps arbitrary Dapr records and deduplicates reciprocal legacy edges without filtering", () => {
    const dependency = {
      id: prefix + "Dapr.StateStores/components/cache_v2",
      name: "cache_v2",
      type: "Dapr.StateStores/components",
      provisioningState: "UnrecognizedRawState"
    };
    const result = normalizeLegacyLiveGraph({
      resources: [
        {
          ...web,
          type: "Radius.Compute/containers",
          connections: [
            { id: dependency.id, direction: "Outbound" },
            { id: dependency.id, direction: "Outbound" }
          ]
        },
        { ...dependency, connections: [{ id: web.id, direction: "Inbound" }] }
      ]
    });
    expect(result.resources).toEqual([
      expect.objectContaining({
        id: web.id,
        type: "Radius.Compute/containers",
        connections: []
      }),
      expect.objectContaining({
        ...dependency,
        connections: [{ id: web.id, direction: "Outbound" }]
      })
    ]);
    expect(result.warnings).toEqual([]);
  });
  it("corrects self, dangling and duplicate records explicitly with warnings", () => {
    const input = {
      resources: [
        {
          ...web,
          connections: [
            null,
            { id: web.id, direction: "Inbound" },
            { id: prefix + "Other/widgets/missing", direction: "Outbound" }
          ]
        },
        {
          ...web,
          connections: [
            null,
            { id: web.id, direction: "Inbound" },
            { id: prefix + "Other/widgets/missing", direction: "Outbound" }
          ]
        }
      ]
    };
    const result = normalizeLegacyLiveGraph(input);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].connections).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "duplicate-resource",
      "invalid-connection",
      "unresolved-connection",
      "unresolved-connection"
    ]);
  });
  it("does not trust a special supplied type when the connection ID is missing or invalid", () => {
    const result = normalizeLegacyLiveGraph({
      resources: [
        {
          ...web,
          connections: [
            { type: "Applications.Core/gateways", direction: "Inbound" },
            {
              id: "invalid-id",
              type: "Radius.Compute/routes",
              direction: "Inbound"
            }
          ]
        }
      ]
    });
    expect(result.resources[0].connections).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "invalid-connection",
      "unresolved-connection"
    ]);
  });
  it.each([
    null,
    {},
    { resources: null },
    { resources: [null] },
    { resources: [{ ...web, connections: [{ id: web.id }] }] },
    { resources: [{ ...web, connections: "bad" }] }
  ])("fails explicitly for malformed payload %#", (value) => {
    expect(() => normalizeLegacyLiveGraph(value)).toThrow(TypeError);
  });
  it("retains empty graphs and rejects selected-context mismatches", () => {
    expect(normalizeLegacyLiveGraph({ resources: [] })).toEqual({
      kind: "legacy-live",
      resources: [],
      warnings: []
    });
    expect(() =>
      normalizeLegacyLiveGraph(
        { resources: [] },
        { ...context, plane: { type: "radius", name: "other" } }
      )
    ).toThrow(TypeError);
  });
});
