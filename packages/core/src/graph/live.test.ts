import { describe, expect, it } from "vitest";
import { graphContextKey, normalizeLiveGraph } from "./live.js";
import { applicationGraphToResources } from "./appgraph.js";

const prefix = "/planes/radius/local/resourceGroups/test/providers/";
const id = (type: string, name: string) => prefix + type + "/" + name;
const context = {
  connectionId: "local-dev",
  plane: { type: "radius", name: "local" },
  applicationId: id("Radius.Core/applications", "application")
};
const web = {
  id: id("Radius.Core/containers", "web"),
  name: "web",
  type: "Radius.Core/containers",
  provisioningState: "Updating"
};
const db = {
  id: id("Radius.Data/databases", "db"),
  name: "db",
  type: "Radius.Data/databases"
};

describe("live UCP graph normalization", () => {
  it("accepts no hashes, keeps full identity and raw status, and does not apply Canvas filtering", () => {
    const image = {
      id: id("Radius.Compute/containerImages", "image"),
      name: "image",
      type: "Radius.Compute/containerImages"
    };
    const result = normalizeLiveGraph({ resources: [web, db, image] }, context);
    expect(result.resources.map((r) => r.id)).toEqual([
      web.id,
      db.id,
      image.id
    ]);
    expect(result.resources[0].provisioningState).toBe("Updating");
    expect(result.resources[0]).not.toHaveProperty("deployStatus");
    expect(result.resources[0]).not.toHaveProperty("diffHash");
    expect(() => applicationGraphToResources({ resources: [web] })).toThrow(
      /diffHash/
    );
  });
  it("retains an explicit empty graph instead of disguising malformed data as empty", () => {
    expect(normalizeLiveGraph({ resources: [] }, context)).toEqual({
      kind: "live",
      context,
      resources: [],
      warnings: []
    });
  });
  it.each(["Radius.Compute", "Radius.Networking"])(
    "normalizes %s Outbound as owner -> target without mutating source meaning",
    (namespace) => {
      const resource = {
        ...web,
        type: `${namespace}/containers`,
        id: id(`${namespace}/containers`, "web"),
        connections: [{ id: db.id, direction: "Outbound" }]
      };
      const input = { resources: [resource, db] };
      const original = structuredClone(input);
      const result = normalizeLiveGraph(input, context);
      expect(result.resources[0].connections).toEqual([
        { id: db.id, direction: "Outbound" }
      ]);
      expect(result.resources[1].connections).toEqual([]);
      expect(input).toEqual(original);
      expect(normalizeLiveGraph(input, context)).toEqual(result);
    }
  );
  it("normalizes Inbound as target -> owner and deduplicates reciprocal edges", () => {
    const result = normalizeLiveGraph(
      {
        resources: [
          { ...web, connections: [{ id: db.id, direction: "Outbound" }] },
          { ...db, connections: [{ id: web.id, direction: "Inbound" }] }
        ]
      },
      context
    );
    expect(result.resources[0].connections).toEqual([
      { id: db.id, direction: "Outbound" }
    ]);
    expect(result.resources[1].connections).toEqual([]);
  });
  it("keeps every target of a source in connection order", () => {
    const cache = {
      id: id("Radius.Data/caches", "cache"),
      name: "cache",
      type: "Radius.Data/caches"
    };
    const result = normalizeLiveGraph(
      {
        resources: [
          {
            ...web,
            connections: [
              { id: db.id, direction: "Outbound" },
              { id: cache.id, direction: "Outbound" }
            ]
          },
          db,
          cache
        ]
      },
      context
    );
    expect(result.resources[0].connections).toEqual([
      { id: db.id, direction: "Outbound" },
      { id: cache.id, direction: "Outbound" }
    ]);
  });
  it("applies no type-specific direction correction to gateways", () => {
    const gateway = {
      id: id("Radius.Networking/gateways", "gateway"),
      name: "gateway",
      type: "Radius.Networking/gateways"
    };
    const result = normalizeLiveGraph(
      {
        resources: [
          { ...web, connections: [{ id: gateway.id, direction: "Inbound" }] },
          gateway
        ]
      },
      context
    );
    expect(result.resources[0].connections).toEqual([]);
    expect(result.resources[1].connections).toEqual([
      { id: web.id, direction: "Outbound" }
    ]);
  });
  it("reports malformed, missing, and GU-06 self-connections without dropping valid resources", () => {
    const result = normalizeLiveGraph(
      {
        resources: [
          {
            ...web,
            connections: [
              null,
              { id: 1 },
              { id: "invalid", direction: "Outbound" },
              { id: db.id, direction: "Outbound" },
              { id: web.id, direction: "Inbound" }
            ]
          }
        ]
      },
      context
    );
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].connections).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "invalid-connection",
      "invalid-connection",
      "unresolved-connection",
      "unresolved-connection",
      "unresolved-connection"
    ]);
    expect(
      result.warnings.every(
        (warning) =>
          warning.resourceId === web.id &&
          warning.severity === "warning" &&
          warning.message.includes(web.id)
      )
    ).toBe(true);
  });
  it("deduplicates identical records but rejects conflicting duplicates", () => {
    expect(
      normalizeLiveGraph({ resources: [web, { ...web }] }, context).warnings
    ).toEqual([
      {
        code: "duplicate-resource",
        severity: "info",
        resourceId: web.id,
        message: `Duplicate resource ignored: ${web.id}`
      }
    ]);
    expect(() =>
      normalizeLiveGraph(
        { resources: [web, { ...web, name: "other" }] },
        context
      )
    ).toThrow(/Conflicting/);
  });
  it("isolates repeated graphs and context snapshots", () => {
    const first = normalizeLiveGraph({ resources: [web] }, context);
    normalizeLiveGraph({ resources: [db] }, context);
    expect(normalizeLiveGraph({ resources: [web] }, context)).toEqual(first);
    expect(first.context).not.toBe(context);
    expect(first.context.plane).not.toBe(context.plane);
  });
  it("keeps identical application names in separate connections, groups and planes distinct", () => {
    const keys = [
      context,
      { ...context, connectionId: "other" },
      {
        ...context,
        applicationId: context.applicationId.replace("/test/", "/other/")
      },
      {
        ...context,
        plane: { type: "radius", name: "prod" },
        applicationId: context.applicationId.replace("/local/", "/prod/")
      }
    ].map(graphContextKey);
    expect(new Set(keys).size).toBe(4);
  });
  it.each([
    null,
    [],
    {},
    { resources: null },
    { resources: [null] },
    { resources: [{ ...web, name: "" }] },
    { resources: [{ ...web, type: 4 }] },
    { resources: [{ ...web, connections: {} }] },
    { resources: [{ ...web, provider: 1 }] },
    { resources: [{ ...web, provisioningState: false }] },
    {
      resources: [
        { ...web, connections: [{ id: db.id, direction: "wrong" }] },
        db
      ]
    },
    { resources: [{ ...web, connections: [{ id: db.id }] }] },
    {
      resources: [{ ...web, connections: [{ id: web.id, direction: "wrong" }] }]
    }
  ])("fails explicitly for malformed payload %#", (input) => {
    expect(() => normalizeLiveGraph(input, context)).toThrow(TypeError);
  });
  it.each([
    { ...context, applicationId: "" },
    { ...context, applicationId: "bad" },
    { ...context, applicationId: web.id },
    {
      ...context,
      applicationId:
        "/subscriptions/0000/resourceGroups/test/providers/Radius.Core/applications/application"
    },
    {
      ...context,
      applicationId: context.applicationId + "/Radius.Core/applications/nested"
    },
    { ...context, connectionId: "" },
    { ...context, plane: { type: "other", name: "local" } },
    { ...context, plane: { type: "radius", name: "other" } }
  ])("rejects invalid or mismatched context %#", (input) => {
    expect(() => graphContextKey(input)).toThrow(TypeError);
  });
  it("renders Azure, AWS and other non-Radius resources as generic resources", () => {
    const azure = {
      id: "/subscriptions/0000/resourceGroups/rg/providers/Microsoft.Cache/redis/cache",
      name: "cache",
      type: "Microsoft.Cache/redis"
    };
    const aws = {
      id: "/planes/aws/aws/accounts/1234/regions/us-west-2/providers/AWS.Kinesis/Stream/events",
      name: "events",
      type: "AWS.Kinesis/Stream"
    };
    const legacy = {
      id: id("Applications.Core/containers", "legacy"),
      name: "legacy",
      type: "Applications.Core/containers"
    };
    const result = normalizeLiveGraph(
      {
        resources: [
          {
            ...web,
            connections: [
              { id: azure.id, direction: "Outbound" },
              { id: aws.id, direction: "Outbound" }
            ]
          },
          azure,
          aws,
          legacy
        ]
      },
      context
    );
    expect(result.resources.map((resource) => resource.type)).toEqual([
      web.type,
      azure.type,
      aws.type,
      legacy.type
    ]);
    expect(result.resources[0].connections).toEqual([
      { id: azure.id, direction: "Outbound" },
      { id: aws.id, direction: "Outbound" }
    ]);
    expect(result.warnings).toEqual([]);
  });
  it("drops only a resource whose ID cannot be parsed and reports it", () => {
    const result = normalizeLiveGraph(
      {
        resources: [
          { ...web, connections: [{ id: "bad", direction: "Outbound" }] },
          { ...db, id: "bad" }
        ]
      },
      context
    );
    expect(result.resources.map((resource) => resource.id)).toEqual([web.id]);
    expect(result.warnings).toEqual([
      {
        code: "invalid-resource-id",
        severity: "warning",
        resourceId: "bad",
        message: "Resource with an unrecognized ID ignored: bad"
      },
      {
        code: "unresolved-connection",
        severity: "warning",
        resourceId: web.id,
        message: `Unresolved or self connection ignored: ${web.id} -> bad`
      }
    ]);
  });
  it("judges support by the declared type, not the ID's provider", () => {
    const nested = {
      id: id("Other.Provider/hosts", "host") + "/containers/web",
      name: "web",
      type: "Radius.Compute/containers"
    };
    expect(
      normalizeLiveGraph({ resources: [nested] }, context).resources[0].id
    ).toBe(nested.id);
  });
  it("matches the selected plane case-insensitively", () => {
    const upper = {
      ...context,
      applicationId: context.applicationId.replace(
        "/planes/radius/local/",
        "/planes/Radius/Local/"
      )
    };
    expect(() => graphContextKey(upper)).not.toThrow();
    expect(
      normalizeLiveGraph({ resources: [web] }, upper).resources
    ).toHaveLength(1);
  });
  it("keys an application ID regardless of type casing", () => {
    const lower = {
      ...context,
      applicationId: id("radius.core/applications", "application")
    };
    expect(JSON.parse(graphContextKey(lower))[3]).toBe(lower.applicationId);
  });
  it("preserves empty optional upstream strings without manufacturing a status", () => {
    const result = normalizeLiveGraph(
      { resources: [{ ...web, provider: "", provisioningState: "" }] },
      context
    );
    expect(result.resources[0].provisioningState).toBe("");
    expect(result.resources[0].provider).toBe("");
  });
  it.each(["Applications.Core/applications", "applications.core/applications"])(
    "accepts a legacy %s context and keeps raw status and edges",
    (type) => {
      const legacy = { ...context, applicationId: id(type, "application") };
      const owner = {
        ...web,
        id: id("Applications.Core/containers", "web"),
        type: "Applications.Core/containers",
        connections: [{ id: db.id, direction: "Outbound" }]
      };
      const result = normalizeLiveGraph({ resources: [owner, db] }, legacy);
      expect(JSON.parse(graphContextKey(legacy))[3]).toBe(legacy.applicationId);
      expect(result.context).toEqual(legacy);
      expect(result.resources[0].provisioningState).toBe("Updating");
      expect(result.resources[0].connections).toEqual([
        { id: db.id, direction: "Outbound" }
      ]);
      expect(result.warnings).toEqual([]);
    }
  );
  it("still rejects a legacy application on another plane or at a nested path", () => {
    const type = "Applications.Core/applications";
    expect(() =>
      graphContextKey({
        ...context,
        applicationId: id(type, "application").replace("/local/", "/other/")
      })
    ).toThrow(TypeError);
    expect(() =>
      graphContextKey({
        ...context,
        applicationId: id(type, "application") + "/Applications.Core/x/y"
      })
    ).toThrow(TypeError);
  });
  describe("resource-definition icons", () => {
    const hash = "a".repeat(64);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
    const withIcon = (iconHash: unknown) => ({
      ...web,
      iconHash
    });
    it("resolves a hashed icon from the response icon map", () => {
      const result = normalizeLiveGraph(
        { resources: [withIcon(hash), db], icons: { [hash]: svg } },
        context
      );
      expect(result.resources[0].icon).toBe(svg);
      expect(result.resources[1]).not.toHaveProperty("icon");
      expect(result.warnings).toEqual([]);
    });
    it("accepts an XML prolog and comments before the svg element", () => {
      const prefixed = `<?xml version="1.0"?>\n<!-- icon -->\n${svg}`;
      const result = normalizeLiveGraph(
        { resources: [withIcon(hash)], icons: { [hash]: prefixed } },
        context
      );
      expect(result.resources[0].icon).toBe(prefixed);
    });
    it.each([
      ["a missing icons map", undefined, hash],
      ["a hash absent from the map", { [`${"b".repeat(64)}`]: svg }, hash],
      ["a non-svg value", { [hash]: "<div>not an icon</div>" }, hash],
      ["a non-string value", { [hash]: 4 }, hash],
      ["a malformed hash", { [hash]: svg }, "not-a-hash"],
      ["a non-string hash", { [hash]: svg }, 4]
    ])("drops an icon with %s and reports it", (_name, icons, iconHash) => {
      const result = normalizeLiveGraph(
        { resources: [withIcon(iconHash)], icons },
        context
      );
      expect(result.resources[0]).not.toHaveProperty("icon");
      expect(result.warnings).toEqual([
        {
          code: "invalid-icon",
          severity: "warning",
          message: `Unresolved resource icon ignored: ${web.id}`,
          resourceId: web.id
        }
      ]);
    });
    it.each([undefined, null])(
      "treats a %s icon hash as no icon without a warning",
      (iconHash) => {
        const result = normalizeLiveGraph(
          { resources: [withIcon(iconHash)], icons: { [hash]: svg } },
          context
        );
        expect(result.resources[0]).not.toHaveProperty("icon");
        expect(result.warnings).toEqual([]);
      }
    );
    it("does not read inherited properties of the icon map", () => {
      const result = normalizeLiveGraph(
        { resources: [withIcon(hash)], icons: Object.create({ [hash]: svg }) },
        context
      );
      expect(result.resources[0]).not.toHaveProperty("icon");
      expect(result.warnings).toHaveLength(1);
    });
  });
});
