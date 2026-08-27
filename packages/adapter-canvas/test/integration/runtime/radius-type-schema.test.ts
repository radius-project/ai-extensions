import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
);
const modulePath = path.join(
  root,
  "plugins",
  "radius",
  "skills",
  "radius-app-bicep",
  "scripts",
  "radius-type-schema.mjs"
);
const fixturePath = path.join(
  root,
  "packages",
  "adapter-canvas",
  "test",
  "fixtures",
  "radius-type-definition",
  "radius",
  "radius.test",
  "2025-08-01-preview",
  "types.json"
);
const normalizer = await import(pathToFileURL(modulePath).href);
const fixtureTypes = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

describe("compact model-facing schemas", () => {
  it("returns canonical inputs and outputs in one recursive schema", () => {
    const schema = normalizer.buildSchema(fixtureTypes, 14);
    const properties = schema.properties.properties.properties;

    expect(Object.keys(schema.properties)).toEqual([
      "apiVersion",
      "id",
      "location",
      "name",
      "properties",
      "type"
    ]);
    expect(schema.properties.application).toBeUndefined();
    expect(schema.required).toEqual(["name", "properties"]);
    expect(schema.properties.name).toEqual({ type: "string" });
    expect(schema.properties.properties.required).toEqual([
      "environment",
      "password",
      "username"
    ]);
    expect(properties.application).toEqual({ type: "string" });
    expect(properties.password).toEqual({
      type: "string",
      sensitive: true
    });
    expect(properties.host).toEqual({ type: "string", readOnly: true });
    expect(properties.port).toEqual({ type: "string", readOnly: true });
    expect(properties.size).toEqual({
      type: "string",
      enum: ["L", "M", "S"]
    });
  });

  it("returns maps, arrays, and canonical compute outputs", () => {
    const image = normalizer.buildSchema(fixtureTypes, 19);
    const imageProperties = image.properties.properties.properties;
    expect(imageProperties.build.required).toEqual(["source"]);
    expect(imageProperties.imageReference.readOnly).toBe(true);

    const containers = normalizer.buildSchema(fixtureTypes, 27);
    const containerProperties = containers.properties.properties.properties;
    expect(containerProperties.containers.additionalProperties).toMatchObject({
      type: "object"
    });
    expect(containerProperties.hosts).toEqual({
      type: "object",
      properties: {},
      additionalProperties: { type: "string" },
      readOnly: true
    });

    const application = normalizer.buildSchema(fixtureTypes, 32);
    expect(JSON.stringify(application)).not.toMatch(/getGraph|functions/u);
  });

  it("normalizes primitives, general unions, and discriminated objects", () => {
    const types = [
      { $type: "AnyType" },
      { $type: "NullType" },
      { $type: "BooleanType" },
      { $type: "IntegerType", minValue: 1, maxValue: 9 },
      {
        $type: "StringType",
        minLength: 2,
        maxLength: 8,
        pattern: "^[a-z]+$"
      },
      { $type: "ArrayType", itemType: { $ref: "#/4" }, minLength: 1 },
      { $type: "UnionType", elements: [{ $ref: "#/2" }, { $ref: "#/4" }] },
      {
        $type: "ObjectType",
        name: "variant",
        properties: {
          value: { flags: 1, type: { $ref: "#/3" } }
        }
      },
      {
        $type: "DiscriminatedObjectType",
        name: "choice",
        discriminator: "kind",
        baseProperties: {
          kind: { flags: 1, type: { $ref: "#/4" } }
        },
        elements: { selected: { $ref: "#/7" } }
      }
    ];

    expect(normalizer.normalizeTypeReference({ $ref: "#/0" }, types)).toEqual({
      type: "any"
    });
    expect(normalizer.normalizeTypeReference({ $ref: "#/1" }, types)).toEqual({
      type: "null"
    });
    expect(normalizer.normalizeTypeReference({ $ref: "#/3" }, types)).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 9
    });
    expect(normalizer.normalizeTypeReference({ $ref: "#/5" }, types)).toEqual({
      type: "array",
      items: {
        type: "string",
        minLength: 2,
        maxLength: 8,
        pattern: "^[a-z]+$"
      },
      minItems: 1
    });
    expect(normalizer.normalizeTypeReference({ $ref: "#/6" }, types)).toEqual({
      oneOf: [
        { type: "boolean" },
        {
          type: "string",
          minLength: 2,
          maxLength: 8,
          pattern: "^[a-z]+$"
        }
      ]
    });
    expect(
      normalizer.normalizeTypeReference({ $ref: "#/8" }, types)
    ).toMatchObject({
      type: "object",
      discriminator: "kind",
      required: ["kind"],
      properties: { kind: { type: "string" } },
      variants: {
        selected: {
          required: ["kind", "value"],
          properties: {
            kind: { type: "string" },
            value: { type: "integer", minimum: 1, maximum: 9 }
          }
        }
      }
    });
  });

  it("ignores unknown property flag bits while decoding known access flags", () => {
    expect(normalizer.decodePropertyFlags(32)).toEqual({
      required: false,
      readable: true,
      writable: true
    });
    expect(normalizer.decodePropertyFlags(32 | 1 | 2 | 4)).toEqual({
      required: true,
      readable: false,
      writable: false
    });
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => normalizer.decodePropertyFlags(invalid)).toThrow(
        /unsupported/u
      );
    }
  });

  it("fails on invalid references, kinds, and cycles", () => {
    expect(() =>
      normalizer.normalizeTypeReference({ $ref: "other.json#/0" }, fixtureTypes)
    ).toThrow(/local #\/N/u);
    expect(() =>
      normalizer.normalizeTypeReference({ $ref: "#/0" }, [
        { $type: "FutureType" }
      ])
    ).toThrow(/unsupported generated type kind/u);
    expect(() =>
      normalizer.normalizeTypeReference({ $ref: "#/0" }, [
        {
          $type: "ObjectType",
          properties: {
            self: { flags: 0, type: { $ref: "#/0" } }
          }
        }
      ])
    ).toThrow(/recursive type cycle/u);
  });

  it("preserves write-only, sensitive, literal, and bounded collection semantics", () => {
    const types = [
      { $type: "StringType", sensitive: true },
      { $type: "StringLiteralType", value: "token", sensitive: true },
      {
        $type: "ArrayType",
        itemType: { $ref: "#/0" },
        maxLength: 3
      },
      {
        $type: "ObjectType",
        sensitive: true,
        properties: {
          secret: { flags: 4, type: { $ref: "#/0" } }
        }
      },
      {
        $type: "UnionType",
        elements: [{ $ref: "#/1" }]
      }
    ];

    expect(normalizer.normalizeTypeReference({ $ref: "#/0" }, types)).toEqual({
      type: "string",
      sensitive: true
    });
    expect(normalizer.normalizeTypeReference({ $ref: "#/1" }, types)).toEqual({
      type: "string",
      const: "token",
      sensitive: true
    });
    expect(normalizer.normalizeTypeReference({ $ref: "#/2" }, types)).toEqual({
      type: "array",
      items: { type: "string", sensitive: true },
      maxItems: 3
    });
    expect(normalizer.normalizeTypeReference({ $ref: "#/3" }, types)).toEqual({
      type: "object",
      properties: {
        secret: { type: "string", sensitive: true, writeOnly: true }
      },
      additionalProperties: false,
      sensitive: true
    });
    expect(normalizer.normalizeTypeReference({ $ref: "#/4" }, types)).toEqual({
      type: "string",
      enum: ["token"],
      sensitive: true
    });
    expect(
      normalizer.normalizeTypeReference({ $ref: "#/0" }, [
        { $type: "IntegerType" }
      ])
    ).toEqual({ type: "integer" });
    expect(() =>
      normalizer.normalizeTypeReference({ $ref: "#/0" }, [
        { $type: "StringLiteralType", value: 7 }
      ])
    ).toThrow(/value must be a string/u);
  });

  it("rejects malformed unions and discriminated object variants", () => {
    expect(() =>
      normalizer.normalizeTypeReference({ $ref: "#/0" }, [
        { $type: "UnionType", elements: [] }
      ])
    ).toThrow(/nonempty array/u);
    expect(() =>
      normalizer.normalizeTypeReference({ $ref: "#/0" }, [
        { $type: "UnionType", elements: [{ $ref: "#/1" }] },
        { $type: "StringLiteralType", value: 7 }
      ])
    ).toThrow(/non-string literal/u);
    expect(() =>
      normalizer.normalizeTypeReference({ $ref: "#/0" }, [
        {
          $type: "DiscriminatedObjectType",
          discriminator: "",
          baseProperties: {},
          elements: {}
        }
      ])
    ).toThrow(/discriminator must be a nonempty string/u);
    expect(() =>
      normalizer.normalizeTypeReference({ $ref: "#/0" }, [
        {
          $type: "DiscriminatedObjectType",
          discriminator: "kind",
          baseProperties: {},
          elements: { invalid: { $ref: "#/1" } }
        },
        { $type: "StringType" }
      ])
    ).toThrow(/must resolve to an object/u);
    expect(() =>
      normalizer.normalizeTypeReference({ $ref: "#/0" }, [
        {
          $type: "DiscriminatedObjectType",
          discriminator: "kind",
          baseProperties: {
            value: { flags: 0, type: { $ref: "#/2" } }
          },
          elements: { invalid: { $ref: "#/1" } }
        },
        {
          $type: "ObjectType",
          properties: {
            value: { flags: 0, type: { $ref: "#/3" } }
          }
        },
        { $type: "StringType" },
        { $type: "BooleanType" }
      ])
    ).toThrow(/redefines property "value" incompatibly/u);

    expect(
      normalizer.normalizeTypeReference({ $ref: "#/0" }, [
        {
          $type: "DiscriminatedObjectType",
          discriminator: "kind",
          baseProperties: {},
          elements: { empty: { $ref: "#/1" } }
        },
        { $type: "ObjectType", properties: {} }
      ])
    ).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
      discriminator: "kind",
      variants: {
        empty: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    });
  });

  it("rejects malformed resource roots and envelopes", () => {
    expect(() => normalizer.buildSchema({}, 0)).toThrow(/JSON array/u);
    expect(() => normalizer.buildSchema([], 0)).toThrow(/missing generated/u);
    expect(() => normalizer.buildSchema([{ $type: "StringType" }], 0)).toThrow(
      /is not ResourceType/u
    );
    expect(() =>
      normalizer.buildSchema(
        [
          { $type: "ResourceType", body: { $ref: "#/1" } },
          { $type: "StringType" }
        ],
        0
      )
    ).toThrow(/body must resolve to ObjectType/u);
    expect(() =>
      normalizer.buildSchema(
        [
          { $type: "ResourceType", body: { $ref: "#/1" } },
          {
            $type: "ObjectType",
            properties: { properties: { flags: 0, type: { $ref: "#/2" } } }
          },
          { $type: "StringType" }
        ],
        0
      )
    ).toThrow(/properties envelope must resolve to ObjectType/u);

    expect(
      normalizer.buildSchema(
        [
          { $type: "ResourceType", body: { $ref: "#/1" } },
          {
            $type: "ObjectType",
            properties: {
              zeta: { flags: 0, type: { $ref: "#/2" } },
              alpha: { flags: 0, type: { $ref: "#/2" } },
              middle: { flags: 0, type: { $ref: "#/2" } }
            },
            additionalProperties: { $ref: "#/2" }
          },
          { $type: "StringType" }
        ],
        0
      )
    ).toEqual({
      type: "object",
      properties: {
        alpha: { type: "string" },
        middle: { type: "string" },
        zeta: { type: "string" }
      },
      additionalProperties: { type: "string" }
    });
  });

  it("emits no compiler internals or redundant model-facing metadata", () => {
    const serialized = JSON.stringify(normalizer.buildSchema(fixtureTypes, 14));
    expect(serialized).not.toMatch(
      /\$ref|"flags"|ObjectType|ResourceType|description|functions|readable|writable/u
    );
    expect(serialized).toContain('"required":["name","properties"]');
  });
});
