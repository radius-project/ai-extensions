import { gunzipSync } from "node:zlib";
import path from "node:path";
import {
  buildSchema,
  propertySensitivity,
  validateGeneratedIndex,
  validateGeneratedTypes
} from "./radius-type-schema.mjs";

// Read compiler-produced archives in memory; never extract their paths.
export function typeArchive(bytes) {
  const data = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  const entries = new Map();
  let attributes = null;
  for (let offset = 0; offset < data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.length !== 512)
      throw new Error("Truncated extension type archive.");
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/su, "");
    const numeric = (text) => {
      if (!/^[0-7]+$/u.test(text.trim()))
        throw new Error("Invalid extension archive number.");
      return Number.parseInt(text.trim(), 8);
    };
    const headerSize = numeric(field(124, 136));
    const checksum = numeric(field(148, 156));
    let actual = 0;
    for (let index = 0; index < 512; index++)
      actual += index >= 148 && index < 156 ? 32 : header[index];
    if (actual !== checksum)
      throw new Error("Invalid extension archive checksum.");
    const extended = header[156] === 120;
    const size =
      !extended && attributes?.size !== undefined ?
        Number(attributes.size)
      : headerSize;
    const end = offset + 512 + size;
    if (
      !Number.isSafeInteger(size) ||
      !Number.isSafeInteger(end) ||
      end > data.length
    )
      throw new Error("Truncated extension type entry.");
    const content = data.subarray(offset + 512, end);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (extended) {
      if (attributes !== null)
        throw new Error("Ambiguous extension PAX headers.");
      attributes = {};
      for (let cursor = 0; cursor < content.length;) {
        const space = content.indexOf(32, cursor);
        const count = content.subarray(cursor, space).toString("ascii");
        const length = Number(count);
        const limit = cursor + length;
        if (
          space < cursor ||
          !/^[1-9]\d*$/u.test(count) ||
          !Number.isSafeInteger(limit) ||
          limit > content.length ||
          limit <= space + 1 ||
          content[limit - 1] !== 10
        )
          throw new Error("Invalid extension PAX record.");
        const record = content.subarray(space + 1, limit - 1).toString("utf8");
        const separator = record.indexOf("=");
        const key = record.slice(0, separator);
        const value = record.slice(separator + 1);
        if (
          separator < 1 ||
          Object.hasOwn(attributes, key) ||
          ![
            "path",
            "size",
            "mtime",
            "atime",
            "ctime",
            "uid",
            "gid",
            "uname",
            "gname",
            "comment"
          ].includes(key)
        )
          throw new Error("Unsupported extension PAX attribute.");
        if (key === "size" && !/^\d+$/u.test(value))
          throw new Error("Invalid extension PAX size.");
        attributes[key] = value;
        cursor = limit;
      }
      continue;
    }
    const name =
      attributes?.path ??
      [field(345, 500), field(0, 100)].filter(Boolean).join("/");
    attributes = null;
    if (
      !name ||
      name.includes("\\") ||
      name.split("/").some((part) => !part || part === ".." || part === ".")
    )
      throw new Error("Unsafe extension archive path.");
    if (header[156] !== 0 && header[156] !== 48)
      throw new Error("Unsupported extension archive entry.");
    if (entries.has(name))
      throw new Error("Duplicate extension archive entry.");
    entries.set(name, content);
  }
  if (attributes !== null) throw new Error("Unconsumed extension PAX header.");
  return entries;
}

export function repairTypeSchemas(dependencies, readFile) {
  const types = {};
  for (const [file, fingerprint] of Object.entries(dependencies)) {
    if (!fingerprint?.boundary || path.basename(file) !== "types.tgz") continue;
    let entries = typeArchive(readFile(file));
    if (entries.has("types.tgz"))
      entries = typeArchive(entries.get("types.tgz"));
    const json = (name) => {
      const bytes = entries.get(name);
      if (!bytes) throw new Error(`Missing extension type file: ${name}`);
      return JSON.parse(bytes.toString("utf8"));
    };
    const index = json("index.json");
    validateGeneratedIndex(index);
    for (const [type, entry] of Object.entries(index.resources)) {
      const reference =
        typeof entry?.$ref === "string" ?
          /^(.*)#\/(0|[1-9]\d*)$/u.exec(entry.$ref)
        : null;
      if (!reference || !Number.isSafeInteger(Number(reference[2])))
        throw new Error("Invalid repair type reference.");
      // Every name in this map has already passed archive confinement.
      const graph = json(reference[1]);
      validateGeneratedTypes(graph);
      const sensitivity = propertySensitivity(
        buildSchema(graph, Number(reference[2]))
      );
      if (
        Object.hasOwn(types, type) &&
        JSON.stringify(types[type]) !== JSON.stringify(sensitivity)
      )
        throw new Error(`Ambiguous repair type schema: ${type}`);
      types[type] = sensitivity;
    }
  }
  return {
    status: "ready",
    file: "the fingerprinted compiler extension types",
    types
  };
}
