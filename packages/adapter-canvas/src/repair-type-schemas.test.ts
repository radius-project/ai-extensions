import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface SchemaModule {
  typeArchive(bytes: Buffer): Map<string, Buffer>;
  repairTypeSchemas(
    dependencies: Record<string, { boundary?: string } | null>,
    read: (file: string) => Buffer
  ): { status: string; types: Record<string, Record<string, boolean>> };
}
const schemas: SchemaModule = await import(
  pathToFileURL(
    path.resolve(
      import.meta.dirname,
      "../../../extensions/radius/skills/radius-app-bicep/scripts/repair-type-schemas.mjs"
    )
  ).href
);
function archive(
  entries: [string, Buffer][],
  change?: (header: Buffer) => void
) {
  const blocks: Buffer[] = [];
  for (const [name, content] of entries) {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
    header[156] = 48;
    change?.(header);
    header.fill(32, 148, 156);
    header.write(
      [...header]
        .reduce((sum, value) => sum + value, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148
    );
    blocks.push(
      header,
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512)
    );
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const fixture = path.resolve(
  import.meta.dirname,
  "../test/fixtures/radius-type-definition"
);
const resourcePath = "radius/radius.test/2025-08-01-preview/types.json";
const graph = fs.readFileSync(path.join(fixture, resourcePath));
const index = fs.readFileSync(path.join(fixture, "index.json"));
const definitions: [string, Buffer][] = [
  ["index.json", index],
  [resourcePath, graph]
];

function pax(records: [string, string][]) {
  return Buffer.from(
    records
      .map(([key, value]) => {
        const body = `${key}=${value}\n`;
        let size = Buffer.byteLength(body) + 2;
        for (;;) {
          const next = Buffer.byteLength(`${size} ${body}`);
          if (next === size) return `${size} ${body}`;
          size = next;
        }
      })
      .join("")
  );
}
function withPax(content: Buffer, name = "file", bytes = Buffer.from("{}")) {
  return archive(
    [
      ["./PaxHeaders/.", content],
      [name, bytes]
    ],
    (header) => {
      if (header.toString("utf8", 0, 100).startsWith("./PaxHeaders/."))
        header[156] = 120;
    }
  );
}

describe("compiler-backed repair type sensitivity", () => {
  it("accepts a custom extension with its type graph at the archive root", () => {
    const rooted = Buffer.from(
      index.toString().replaceAll(resourcePath, "types.json")
    );
    const contract = schemas.repairTypeSchemas(
      { "types.tgz": { boundary: "cache" } },
      () =>
        archive([
          ["index.json", rooted],
          ["types.json", graph]
        ])
    );
    expect(
      contract.types["Radius.Data/postgreSqlDatabases@2025-08-01-preview"]
        .password
    ).toBe(true);
  });
  it.each([
    null,
    "invalid",
    "types.json#/9007199254740992",
    "../types.json#/0"
  ])("rejects invalid or unconfined type references %j", (reference) => {
    const customIndex = Buffer.from(
      JSON.stringify({ resources: { "Custom/type@v1": { $ref: reference } } })
    );
    expect(() =>
      schemas.repairTypeSchemas({ "types.tgz": { boundary: "cache" } }, () =>
        archive([
          ["index.json", customIndex],
          ["types.json", graph]
        ])
      )
    ).toThrow();
  });
  it("honors the real compiler's PAX paths, byte lengths and metadata", () => {
    const bytes = withPax(
      pax([
        ["path", "nested/é.json"],
        ["mtime", "123.5"],
        ["size", "2"]
      ])
    );
    expect(schemas.typeArchive(bytes).get("nested/é.json")?.toString()).toBe(
      "{}"
    );
    expect(
      schemas
        .typeArchive(withPax(pax([["mtime", "123"]])))
        .get("file")
        ?.toString()
    ).toBe("{}");
  });
  it.each(["bad record", "99 path=short\n", "0 path=zero\n", "3 x\n"])(
    "rejects malformed PAX framing %j",
    (record) => {
      expect(() => schemas.typeArchive(withPax(Buffer.from(record)))).toThrow(
        "Invalid extension PAX"
      );
    }
  );
  it.each(
    (
      [
        [["unknown", "value"]],
        [
          ["path", "a"],
          ["path", "b"]
        ],
        [["size", "-1"]]
      ] as [string, string][][]
    ).map((records) => ({ records }))
  )("rejects unsupported or ambiguous PAX attributes %j", ({ records }) => {
    expect(() => schemas.typeArchive(withPax(pax(records)))).toThrow(
      "extension PAX"
    );
  });
  it("rejects dangling or consecutive PAX headers", () => {
    const entries: [string, Buffer][] = [["pax", pax([["path", "file"]])]];
    expect(() =>
      schemas.typeArchive(
        archive(entries, (header) => {
          header[156] = 120;
        })
      )
    ).toThrow("Unconsumed");
    expect(() =>
      schemas.typeArchive(
        archive([...entries, ...entries], (header) => {
          header[156] = 120;
        })
      )
    ).toThrow("Ambiguous");
  });
  it.each([false, true])(
    "reads the actual local/restored archive without changing files (nested=%s)",
    (nested) => {
      const bytes = archive(definitions);
      const result = schemas.repairTypeSchemas(
        {
          [path.join("cache", "types.tgz")]: { boundary: "cache" },
          ignored: null
        },
        () => (nested ? archive([["types.tgz", bytes]]) : bytes)
      );
      expect(result.status).toBe("ready");
      expect(
        result.types["Radius.Data/postgreSqlDatabases@2025-08-01-preview"]
      ).toHaveProperty("password", true);
      expect(
        result.types["Radius.Core/applications@2025-08-01-preview"]
      ).toHaveProperty("environment", false);
    }
  );
  it("ignores ordinary model inputs rather than treating them as type archives", () => {
    expect(
      schemas.repairTypeSchemas(
        { "types.tgz": {}, "model.bicep": { boundary: "repo" } },
        () => {
          throw new Error("Must not read non-artifacts");
        }
      ).types
    ).toEqual({});
  });
  it.each([
    "missing-index",
    "missing-graph",
    "invalid-index",
    "invalid-graph",
    "malformed-json"
  ] as const)("refuses an incomplete schema contract (%s)", (scenario) => {
    const entries: [string, Buffer][] =
      scenario === "missing-index" ?
        []
      : [
          [
            "index.json",
            scenario === "invalid-index" ? Buffer.from("{}")
            : scenario === "malformed-json" ? Buffer.from("{")
            : index
          ]
        ];
    if (scenario !== "missing-graph")
      entries.push([
        resourcePath,
        scenario === "invalid-graph" ? Buffer.from("{}") : graph
      ]);
    expect(() =>
      schemas.repairTypeSchemas({ "types.tgz": { boundary: "cache" } }, () =>
        archive(entries)
      )
    ).toThrow();
  });
  it("rejects conflicting same-name schemas instead of guessing an extension", () => {
    const altered = JSON.parse(graph.toString()) as Array<{
      sensitive?: boolean;
    }>;
    for (const node of altered)
      if (node.sensitive === true) node.sensitive = false;
    expect(() =>
      schemas.repairTypeSchemas(
        {
          [path.join("first", "types.tgz")]: { boundary: "cache" },
          [path.join("second", "types.tgz")]: { boundary: "cache" }
        },
        (file) =>
          file.startsWith("first") ?
            archive(definitions)
          : archive([
              ["index.json", index],
              [resourcePath, Buffer.from(JSON.stringify(altered))]
            ])
      )
    ).toThrow("Ambiguous repair type schema");
  });
  it.each(["../bad", "/bad", "a\\b", "a//b", "./bad"])(
    "rejects unsafe archive entries (%s)",
    (name) => {
      expect(() =>
        schemas.typeArchive(archive([[name, Buffer.from("x")]]))
      ).toThrow("Unsafe");
    }
  );
  it("rejects duplicate paths and non-regular entries", () => {
    expect(() =>
      schemas.typeArchive(
        archive([
          ["same", Buffer.alloc(0)],
          ["same", Buffer.alloc(0)]
        ])
      )
    ).toThrow("Duplicate");
    expect(() =>
      schemas.typeArchive(
        archive([["link", Buffer.alloc(0)]], (header) => {
          header[156] = 50;
        })
      )
    ).toThrow("Unsupported");
  });
  it("rejects truncated headers, data and malformed numbers", () => {
    expect(() => schemas.typeArchive(gzipSync(Buffer.from("partial")))).toThrow(
      "Truncated"
    );
    expect(() =>
      schemas.typeArchive(
        archive([["large", Buffer.alloc(0)]], (header) => {
          header.write("77777777777\0", 124);
        })
      )
    ).toThrow("Truncated");
    expect(() =>
      schemas.typeArchive(
        archive([["invalid", Buffer.alloc(0)]], (header) => {
          header.write("invalid", 124);
        })
      )
    ).toThrow("Invalid extension archive number");
  });
  it("checks the header checksum and supports USTAR prefixes and NUL regular-file flags", () => {
    const bytes = archive([["file.json", Buffer.from("{}")]], (header) => {
      header.write("nested", 345);
      header[156] = 0;
    });
    expect(schemas.typeArchive(bytes).get("nested/file.json")?.toString()).toBe(
      "{}"
    );
    const corrupt = Buffer.alloc(512, 1);
    corrupt.write("00000000000\0", 124);
    corrupt.write("000000\0 ", 148);
    expect(() => schemas.typeArchive(gzipSync(corrupt))).toThrow("checksum");
  });
});
