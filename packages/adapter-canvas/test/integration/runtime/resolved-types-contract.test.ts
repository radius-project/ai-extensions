import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface SensitivePath {
  path: string;
  readOnly: boolean;
}

interface ResolvedTypeEntry {
  properties: string[];
  sensitive: SensitivePath[];
}

interface ResolvedTypesContractModule {
  RESOLVED_TYPES_FILE: string;
  RESOLVED_TYPES_CONTRACT_VERSION: number;
  resolvedTypeEntry(schema: unknown): ResolvedTypeEntry;
  isResolvedTypesContract(value: unknown): boolean;
  isResolvedTypeEntry(entry: unknown): boolean;
  marksPropertySensitive(entry: ResolvedTypeEntry, property: string): boolean;
}

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
);
const modulePath = path.join(
  root,
  "extensions",
  "radius",
  "skills",
  "radius-app-bicep",
  "scripts",
  "resolved-types-contract.mjs"
);
const contract = (await import(
  pathToFileURL(modulePath).href
)) as ResolvedTypesContractModule;

const secret = { type: "string", sensitive: true };

// A resolved type schema whose properties envelope is `envelope`, in the shape
// radius-type-schema.mjs produces.
function schemaWithEnvelope(envelope: object): object {
  return { type: "object", properties: { properties: envelope } };
}

function sensitivePaths(envelope: object): SensitivePath[] {
  return contract.resolvedTypeEntry(schemaWithEnvelope(envelope)).sensitive;
}

function input(nodePath: string): SensitivePath {
  return { path: nodePath, readOnly: false };
}

// A discriminated object as radius-type-schema.mjs builds it: the
// discriminator is in the base properties and in every variant, because each
// variant is merged with the base. The variants named in `wholeSecret` mark
// their whole object sensitive.
function discriminated(
  variants: Record<string, Record<string, object>>,
  wholeSecret: string[] = []
): object {
  const kind = { type: "string" };
  return {
    type: "object",
    properties: { kind },
    discriminator: "kind",
    variants: Object.fromEntries(
      Object.entries(variants).map(([name, properties]) => [
        name,
        {
          type: "object",
          properties: { kind, ...properties },
          ...(wholeSecret.includes(name) ? { sensitive: true } : {})
        }
      ])
    )
  };
}

describe("resolved type entry", () => {
  it.each([
    {
      name: "a leaf inside a nested object",
      envelope: {
        type: "object",
        properties: {
          tls: {
            type: "object",
            properties: { ca: { type: "string" }, clientKey: secret }
          }
        }
      },
      sensitive: [input("tls.clientKey")]
    },
    {
      name: "a field of each array item",
      envelope: {
        type: "object",
        properties: {
          certificates: {
            type: "array",
            items: { type: "object", properties: { key: secret } }
          }
        }
      },
      sensitive: [input("certificates[*].key")]
    },
    {
      name: "each array item",
      envelope: {
        type: "object",
        properties: { tokens: { type: "array", items: secret } }
      },
      sensitive: [input("tokens[*]")]
    },
    {
      name: "each value of an open envelope",
      envelope: {
        type: "object",
        properties: {},
        additionalProperties: secret
      },
      sensitive: [input("[*]")]
    },
    {
      name: "a field of each value of an open envelope",
      envelope: {
        type: "object",
        properties: {},
        additionalProperties: { type: "object", properties: { value: secret } }
      },
      sensitive: [input("[*].value")]
    },
    {
      name: "a sensitive object, without the nodes inside it",
      envelope: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            sensitive: true,
            properties: { token: secret }
          }
        }
      },
      sensitive: [input("settings")]
    },
    {
      name: "a property every oneOf alternative marks",
      envelope: {
        type: "object",
        properties: {
          credential: {
            oneOf: [secret, { type: "object", properties: {}, sensitive: true }]
          }
        }
      },
      sensitive: [input("credential")]
    },
    {
      name: "a node inside one oneOf alternative",
      envelope: {
        type: "object",
        properties: {
          credential: {
            oneOf: [
              { type: "string" },
              { type: "object", properties: { key: secret } }
            ]
          }
        }
      },
      sensitive: [input("credential.key")]
    },
    {
      name: "a read-only output",
      envelope: {
        type: "object",
        properties: { accessToken: { ...secret, readOnly: true } }
      },
      sensitive: [{ path: "accessToken", readOnly: true }]
    },
    {
      name: "a leaf inside a read-only object",
      envelope: {
        type: "object",
        properties: {
          status: {
            type: "object",
            readOnly: true,
            properties: { token: secret }
          }
        }
      },
      sensitive: [{ path: "status.token", readOnly: true }]
    },
    {
      name: "the nodes below an envelope that is itself marked",
      envelope: {
        type: "object",
        sensitive: true,
        properties: { password: secret }
      },
      sensitive: [input("password")]
    }
  ])("records the sensitive path of $name", ({ envelope, sensitive }) => {
    expect(sensitivePaths(envelope)).toEqual(sensitive);
  });

  it.each([
    { name: "only the first is", readOnly: [true, false], merged: false },
    { name: "only the second is", readOnly: [false, true], merged: false },
    { name: "both are", readOnly: [true, true], merged: true }
  ])(
    "records a path every variant marks as read-only when $name",
    ({ readOnly: [first, second], merged }) => {
      const credential = (isReadOnly: boolean) => ({
        ...secret,
        ...(isReadOnly ? { readOnly: true } : {})
      });

      expect(
        sensitivePaths({
          type: "object",
          properties: {
            auth: discriminated({
              first: { credential: credential(first) },
              second: { credential: credential(second) }
            })
          }
        })
      ).toEqual([{ path: "auth.credential", readOnly: merged }]);
    }
  );

  it.each([
    {
      name: "another variant takes a plain value there",
      envelope: {
        type: "object",
        properties: {
          auth: discriminated({
            managed: { token: { ...secret, readOnly: true } },
            supplied: { token: { type: "string" } }
          })
        }
      }
    },
    {
      name: "another variant takes it as a plain value of its open map",
      envelope: {
        type: "object",
        properties: {
          auth: {
            oneOf: [
              { type: "object", properties: { token: secret } },
              {
                type: "object",
                properties: {},
                additionalProperties: { type: "string" }
              }
            ]
          }
        }
      }
    },
    {
      name: "a oneOf alternative leaves it plain",
      envelope: {
        type: "object",
        properties: {
          credential: {
            oneOf: [secret, { type: "object", properties: {} }]
          }
        }
      }
    },
    {
      name: "an object holds a plain node where a variant's whole object is secret",
      envelope: {
        type: "object",
        properties: {
          auth: discriminated(
            { whole: { token: secret }, parts: { token: { type: "string" } } },
            ["whole"]
          )
        }
      }
    }
  ])("records nothing at a path when $name", ({ envelope }) => {
    expect(sensitivePaths(envelope)).toEqual([]);
  });

  it("records a nested object once when its only variant is wholly secret", () => {
    const auth = discriminated({ whole: { token: secret } }, ["whole"]);

    expect(sensitivePaths({ type: "object", properties: { auth } })).toEqual([
      input("auth")
    ]);
  });

  it("records a node below an object that only some variants mark whole", () => {
    const auth = discriminated(
      { whole: { token: { type: "string" } }, parts: { token: secret } },
      ["whole"]
    );

    expect(sensitivePaths({ type: "object", properties: { auth } })).toEqual([
      input("auth.token")
    ]);
  });

  it("keeps a named plain property of an open envelope apart from its marked values", () => {
    const entry = contract.resolvedTypeEntry(
      schemaWithEnvelope({
        type: "object",
        properties: { mode: { type: "string" }, token: { type: "string" } },
        additionalProperties: secret
      })
    );

    expect(entry).toEqual({
      properties: ["mode", "token"],
      sensitive: [input("[*]")]
    });
    expect(contract.marksPropertySensitive(entry, "token")).toBe(false);
    expect(contract.marksPropertySensitive(entry, "apiKey")).toBe(true);
  });

  const unwritableNames = ["tls.ca", "keys[0]", "x]", ""];

  it.each(unwritableNames)(
    "lists the plain property name %j, which no path can name",
    (name) => {
      expect(
        contract.resolvedTypeEntry(
          schemaWithEnvelope({
            type: "object",
            properties: {
              [name]: {
                type: "object",
                properties: { key: { type: "string" } }
              },
              password: secret
            }
          })
        )
      ).toEqual({
        properties: [name, "password"].sort(),
        sensitive: [input("password")]
      });
    }
  );

  it.each(
    unwritableNames.flatMap((name) => [
      { name, label: JSON.stringify(name), where: "at", node: secret },
      {
        name,
        label: JSON.stringify(name),
        where: "below",
        node: { type: "object", properties: { key: secret } }
      }
    ])
  )(
    "refuses a sensitive node $where the property name $label, which no path can name",
    ({ name, node }) => {
      expect(() =>
        sensitivePaths({ type: "object", properties: { [name]: node } })
      ).toThrow(`Cannot record the sensitive node [${JSON.stringify(name)}]`);
    }
  );

  // A property name that holds a dot renders as the same string as a nested
  // path, so it must not decide whether that nested node is sensitive.
  it("keeps a nested output apart from a property named like its path", () => {
    expect(
      sensitivePaths({
        type: "object",
        properties: {
          x: {
            type: "object",
            readOnly: true,
            properties: { y: secret }
          },
          "x.y": { type: "string" }
        }
      })
    ).toEqual([{ path: "x.y", readOnly: true }]);
  });

  it("sorts the sensitive paths of a type", () => {
    expect(
      sensitivePaths({
        type: "object",
        properties: {
          zone: { type: "object", properties: { key: secret } },
          alpha: secret,
          beta: secret
        }
      })
    ).toEqual([input("alpha"), input("beta"), input("zone.key")]);
  });

  it.each([
    { name: "a schema that is not an object", schema: null },
    { name: "no properties at all", schema: { type: "object" } },
    {
      name: "no properties envelope",
      schema: { type: "object", properties: { name: { type: "string" } } }
    },
    {
      name: "an envelope with no properties",
      schema: schemaWithEnvelope({ type: "object" })
    },
    {
      name: "a variant with no properties",
      schema: schemaWithEnvelope({
        type: "object",
        properties: {
          auth: { type: "object", properties: {}, variants: { a: {} } }
        }
      }),
      expected: { properties: ["auth"], sensitive: [] }
    },
    {
      name: "a variant that is not an object",
      schema: schemaWithEnvelope({
        type: "object",
        properties: {
          auth: { type: "object", properties: {}, variants: { a: null } }
        }
      }),
      expected: { properties: ["auth"], sensitive: [] }
    },
    {
      name: "a property that is not an object",
      schema: schemaWithEnvelope({
        type: "object",
        properties: { size: null }
      }),
      expected: { properties: ["size"], sensitive: [] }
    }
  ])(
    "derives no sensitive path from $name",
    ({ schema, expected = { properties: [], sensitive: [] } }) => {
      expect(contract.resolvedTypeEntry(schema)).toEqual(expected);
    }
  );
});

describe("resolved type contract", () => {
  it.each([
    {
      name: "a version 2 contract",
      value: { contractVersion: 2, types: {} },
      accepted: true
    },
    {
      name: "another version",
      value: { contractVersion: 1, types: {} },
      accepted: false
    },
    { name: "no type map", value: { contractVersion: 2 }, accepted: false },
    {
      name: "a type list",
      value: { contractVersion: 2, types: [] },
      accepted: false
    },
    { name: "an array", value: [], accepted: false },
    { name: "null", value: null, accepted: false }
  ])("accepts $name only when it is version 2", ({ value, accepted }) => {
    expect(contract.isResolvedTypesContract(value)).toBe(accepted);
  });

  it.each([
    { name: "no properties", entry: { properties: [], sensitive: [] } },
    {
      name: "sensitive inputs and outputs",
      entry: {
        properties: ["data", "password", "token"],
        sensitive: [input("data[*].value"), { path: "token", readOnly: true }]
      }
    },
    {
      name: "paths through array items and open maps",
      entry: {
        properties: ["certificates"],
        sensitive: [input("certificates[*]"), input("[*].value")]
      }
    },
    {
      name: "a property name that no path can name",
      entry: { properties: ["x.y"], sensitive: [] }
    }
  ])("accepts an entry with $name", ({ entry }) => {
    expect(contract.isResolvedTypeEntry(entry)).toBe(true);
  });

  it.each([
    { name: "not an object", entry: "password" },
    { name: "null", entry: null },
    { name: "an array", entry: [] },
    { name: "a version 1 property map", entry: { password: false } },
    {
      name: "carrying an extra key",
      entry: { properties: [], sensitive: [], password: false }
    },
    {
      name: "missing its sensitive list",
      entry: { properties: [], password: false }
    },
    {
      name: "listing properties in a string",
      entry: { properties: "password", sensitive: [] }
    },
    {
      name: "listing a property name that is not a string",
      entry: { properties: [1], sensitive: [] }
    },
    {
      name: "listing a property twice",
      entry: { properties: ["password", "password"], sensitive: [] }
    },
    {
      name: "holding sensitive nodes in an object",
      entry: { properties: [], sensitive: { password: true } }
    },
    {
      name: "holding a sensitive node that is not an object",
      entry: { properties: [], sensitive: ["password"] }
    },
    {
      name: "holding a sensitive node with an extra key",
      entry: {
        properties: [],
        sensitive: [{ path: "password", readOnly: false, secure: true }]
      }
    },
    {
      name: "holding a sensitive node with no path",
      entry: { properties: [], sensitive: [{ readOnly: false, name: "a" }] }
    },
    {
      name: "holding a path that is not a string",
      entry: { properties: [], sensitive: [{ path: 1, readOnly: false }] }
    },
    ...["", "data..value", "data.", ".data", "data[0]", "data.[*]"].map(
      (badPath) => ({
        name: `holding the path ${JSON.stringify(badPath)}`,
        entry: { properties: [], sensitive: [input(badPath)] }
      })
    ),
    {
      name: "holding a read-only flag that is not a boolean",
      entry: {
        properties: [],
        sensitive: [{ path: "password", readOnly: "false" }]
      }
    },
    {
      name: "holding a path twice",
      entry: {
        properties: [],
        sensitive: [input("password"), { path: "password", readOnly: true }]
      }
    }
  ])("refuses an entry $name", ({ entry }) => {
    expect(contract.isResolvedTypeEntry(entry)).toBe(false);
  });
});

describe("property sensitivity", () => {
  it.each([
    {
      name: "a property the entry marks",
      entry: { properties: ["password"], sensitive: [input("password")] },
      property: "password",
      marked: true
    },
    {
      name: "a property the entry leaves plain",
      entry: { properties: ["password"], sensitive: [] },
      property: "password",
      marked: false
    },
    {
      name: "an object property with a sensitive node inside it",
      entry: { properties: ["tls"], sensitive: [input("tls.clientKey")] },
      property: "tls",
      marked: false
    },
    {
      name: "a property named like a nested sensitive path",
      entry: { properties: ["x", "x.y"], sensitive: [input("x.y")] },
      property: "x.y",
      marked: false
    },
    {
      name: "a value of an open envelope that is marked",
      entry: { properties: [], sensitive: [input("[*]")] },
      property: "apiKey",
      marked: true
    },
    {
      name: "a value of an open envelope with a sensitive node inside it",
      entry: { properties: [], sensitive: [input("[*].value")] },
      property: "apiKey",
      marked: false
    }
  ])("reports whether $name is sensitive", ({ entry, property, marked }) => {
    expect(contract.marksPropertySensitive(entry, property)).toBe(marked);
  });
});
