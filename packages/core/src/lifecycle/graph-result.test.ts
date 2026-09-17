import { describe, expect, it } from "vitest";
import { applicationGraphToResources } from "../graph/appgraph.js";
import { computeGraphDiff } from "../graph/diff.js";
import { compareRadiusGraphs, projectRadiusGraph } from "./graph-result.js";

const definition = ".radius/app.bicep";
const content =
  "resource api 'Radius.Compute/containers@2025-08-01-preview' = {\n  name: 'api'\n}\n";
const hash = (value: string) => `sha256:${value.repeat(64)}`;
const resource = (id: string, diffHash = hash("a")) => ({
  id,
  name: id,
  type: "Radius.Compute/containers",
  diffHash,
  connections: [],
  outputResources: []
});

describe("canonical lifecycle graph projection", () => {
  it("retains compiler hashes and the existing reciprocal-edge and source-location semantics", () => {
    const raw = {
      resources: [
        {
          ...resource("api"),
          connections: [
            { id: "store", direction: "Outbound" },
            { id: "obsolete", direction: "Inbound" }
          ],
          properties: { codeReference: "src/api.ts" }
        },
        resource("store")
      ]
    };
    const before = structuredClone(raw);
    const result = projectRadiusGraph(raw, definition, content);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected canonical graph");
    const existing: unknown[] = applicationGraphToResources(
      raw,
      definition,
      content
    );
    expect(existing).toMatchObject(result.value.resources);
    expect(result.value.resources[0]).toMatchObject({
      diffHash: hash("a"),
      definitionFile: definition,
      definitionLine: 1,
      codeReference: "src/api.ts",
      connections: [{ id: "store", direction: "Outbound" }]
    });
    expect(result.value.resources[1].connections).toEqual([
      { id: "api", direction: "Inbound" }
    ]);
    expect(raw).toEqual(before);
  });

  it.each([[], { resources: [] }])(
    "accepts an observed empty compiler graph, not a missing response",
    (raw) => {
      expect(projectRadiusGraph(raw, definition)).toEqual({
        status: "ok",
        value: { resources: [] }
      });
    }
  );

  it.each([
    null,
    {},
    { resources: null },
    { resources: [null] },
    { resources: [{ ...resource("api"), id: "" }] },
    { resources: [{ ...resource("api"), type: 42 }] },
    { resources: [{ ...resource("api"), diffHash: undefined }] },
    { resources: [{ ...resource("api"), diffHash: hash("A") }] },
    { resources: [{ ...resource("api"), connections: [{ id: 42 }] }] },
    { resources: [{ ...resource("api"), outputResources: [{}] }] },
    { resources: [resource("api"), resource("api")] }
  ])(
    "rejects malformed compiler evidence rather than dropping nodes",
    (raw) => {
      expect(projectRadiusGraph(raw, definition)).toMatchObject({
        status: "failed",
        error: { code: "EVIDENCE_MISMATCH" }
      });
    }
  );

  it("compares through existing Radius hashes and preserves removed edges without mutating either side", () => {
    const base = projectRadiusGraph(
      [
        {
          ...resource("api"),
          connections: [{ id: "store", direction: "Outbound" }]
        },
        resource("store")
      ],
      definition
    );
    const head = projectRadiusGraph(
      [resource("api", hash("b")), resource("queue")],
      definition
    );
    if (base.status !== "ok" || head.status !== "ok")
      throw new Error("Expected canonical fixtures");
    const before = structuredClone({ base, head });
    const expected: unknown = computeGraphDiff(
      structuredClone(base.value.resources),
      structuredClone(head.value.resources)
    );
    const result = compareRadiusGraphs(base.value, head.value);
    expect(result).toEqual({
      status: "ok",
      value: { resources: expected }
    });
    expect(result).toMatchObject({
      value: {
        resources: expect.arrayContaining([
          expect.objectContaining({ id: "api", diffStatus: "modified" }),
          expect.objectContaining({ id: "store", diffStatus: "removed" }),
          expect.objectContaining({ id: "queue", diffStatus: "added" })
        ])
      }
    });
    expect({ base, head }).toEqual(before);
  });

  it("does not manufacture property changes from connection order", () => {
    const raw = [
      {
        ...resource("api"),
        connections: [
          { id: "store", direction: "Outbound" },
          { id: "queue", direction: "Outbound" }
        ]
      },
      resource("store"),
      resource("queue")
    ];
    const base = projectRadiusGraph(raw, definition);
    const head = projectRadiusGraph(
      [
        { ...raw[0], connections: [...raw[0].connections].reverse() },
        raw[1],
        raw[2]
      ],
      definition
    );
    if (base.status !== "ok" || head.status !== "ok")
      throw new Error("Expected canonical fixtures");
    const result = compareRadiusGraphs(base.value, head.value);
    if (result.status !== "ok") throw new Error("Expected comparison");
    expect(result.value.resources.map((item) => item.diffStatus)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged"
    ]);
  });

  it("ignores dangling prototype-named edges without mutating built-in objects", () => {
    const before = Object.getOwnPropertyDescriptor(Object, "connections");
    try {
      expect(
        projectRadiusGraph(
          [
            {
              ...resource("api"),
              connections: [{ id: "constructor", direction: "Outbound" }]
            }
          ],
          definition
        )
      ).toMatchObject({ status: "ok" });
      expect(Object.getOwnPropertyDescriptor(Object, "connections")).toEqual(
        before
      );
    } finally {
      if (!before) Reflect.deleteProperty(Object, "connections");
      else Object.defineProperty(Object, "connections", before);
    }
  });

  it("preserves complete concrete-output evidence while discarding renderer-only properties", () => {
    const output = {
      name: "cache",
      type: "Microsoft.Cache/redisEnterprise",
      displayType: "Redis",
      provider: "azure",
      apiVersion: "2025-01-01"
    };
    expect(
      projectRadiusGraph(
        [
          {
            ...resource("api"),
            outputResources: [{ ...output, icon: "<svg/>" }]
          }
        ],
        definition
      )
    ).toMatchObject({
      status: "ok",
      value: { resources: [{ outputResources: [output] }] }
    });
  });

  it.each([
    { name: null },
    { name: 42 },
    { connections: null },
    { connections: false },
    { connections: [null] },
    { connections: [{ id: "" }] },
    { connections: [{ id: "store", direction: "sideways" }] },
    {
      connections: [
        { id: "store", direction: "Outbound", diffStatus: "modified" }
      ]
    },
    {
      connections: [{ id: "store", direction: "Outbound", diffStatus: "bad" }]
    },
    { outputResources: null },
    { outputResources: false },
    { provisioningState: 42 },
    { definitionFile: 42 },
    { definitionLine: "1" },
    { definitionLine: -1 },
    { definitionLine: 0.5 },
    { codeReference: 42 },
    { diffStatus: "invalid" }
  ])("rejects malformed optional compiler fields", (fields) => {
    expect(
      projectRadiusGraph([{ ...resource("api"), ...fields }], definition)
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  });

  it("uses existing defaults only for omitted compiler fields and rejects unsafe definition paths", () => {
    expect(
      projectRadiusGraph(
        [{ id: "api", type: "Radius.Compute/containers", diffHash: hash("a") }],
        definition
      )
    ).toMatchObject({
      status: "ok",
      value: { resources: [{ name: "", connections: [], outputResources: [] }] }
    });
    expect(
      projectRadiusGraph(
        [
          {
            ...resource("api"),
            connections: [{ id: "store" }],
            definitionLine: 3
          }
        ],
        definition
      )
    ).toMatchObject({
      status: "ok",
      value: {
        resources: [
          {
            definitionLine: 3,
            connections: [{ id: "store", direction: "Outbound" }]
          }
        ]
      }
    });
    expect(projectRadiusGraph([], "../app.bicep")).toMatchObject({
      status: "failed",
      error: { code: "INVALID_REQUEST" }
    });
  });

  it("validates canonical comparison inputs without requiring renderer-only properties", () => {
    const graph = { resources: [resource("api")] };
    expect(compareRadiusGraphs(graph, graph)).toMatchObject({
      status: "ok",
      value: { resources: [{ diffStatus: "unchanged" }] }
    });
    const duplicate = { resources: [resource("api"), resource("api")] };
    expect(compareRadiusGraphs(duplicate, graph)).toMatchObject({
      status: "failed",
      error: { code: "EVIDENCE_MISMATCH" }
    });
    expect(compareRadiusGraphs(graph, duplicate)).toMatchObject({
      status: "failed",
      error: { code: "EVIDENCE_MISMATCH" }
    });
  });
});
