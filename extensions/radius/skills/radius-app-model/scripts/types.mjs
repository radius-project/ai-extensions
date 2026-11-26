// Prints the Radius resource types of the installed radius Bicep extension,
// or a card for each named type: its properties, which ones are required or
// read-only, and their types. Run it from the application's directory.
//
// Usage: node types.mjs                       lists the types
//        node types.mjs Radius.Compute/containers Radius.Data/redisCaches

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { findBicep, radiusExtensionRef, run } from "./common.mjs";

const FLAGS = [
  [1, "required"],
  [2, "read-only"],
  [4, "write-only"]
];
const MAX_DEPTH = 3;

/** The files in a tar archive, by path. Reads only regular files. */
function untar(buffer) {
  const files = new Map();

  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);

    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0[\s\S]*$/, "");
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join("/");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const kind = field(156, 1);
    offset += 512;

    if (kind === "0" || kind === "")
      files.set(
        name.replace(/^\.\//, ""),
        buffer.subarray(offset, offset + size)
      );
    offset += Math.ceil(size / 512) * 512;
  }

  return files;
}

/**
 * The radius extension to read: the installed rad release, or else the one
 * that .radius/bicepconfig.json pins. Writes nothing.
 */
function extensionRef() {
  const ref = radiusExtensionRef();

  if (ref) return ref;
  const configFile = path.resolve(".radius", "bicepconfig.json");

  try {
    return JSON.parse(fs.readFileSync(configFile, "utf8"))?.extensions?.radius;
  } catch {
    throw new Error(
      "No Radius CLI was found, and .radius/bicepconfig.json names no radius extension. Install the Radius CLI."
    );
  }
}

/** Restores the radius extension and returns the files in its types package. */
function loadTypes() {
  const ref = extensionRef();
  const match = /^br:([^/]+)\/(.+):([^:]+)$/.exec(String(ref));

  if (!match)
    throw new Error(`The radius extension '${ref}' is not a br: reference.`);
  const [, registry, repository, tag] = match;
  const cached = path.join(
    os.homedir(),
    ".bicep",
    "br",
    registry,
    repository,
    `${tag}$`,
    "types.tgz"
  );

  if (!fs.existsSync(cached)) {
    const bicep = findBicep();

    if (!bicep)
      throw new Error("No Bicep CLI found, and rad could not download one.");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radius-types-"));
    fs.writeFileSync(
      path.join(dir, "bicepconfig.json"),
      JSON.stringify({
        experimentalFeaturesEnabled: { extensibility: true },
        extensions: { radius: ref }
      })
    );
    fs.writeFileSync(path.join(dir, "main.bicep"), "extension radius\n");
    const restore = run(bicep, ["restore", path.join(dir, "main.bicep")], {
      cwd: dir
    });
    fs.rmSync(dir, { recursive: true, force: true });

    if (!fs.existsSync(cached))
      throw new Error(
        `bicep restore did not download ${ref}: ${restore.stderr.trim()}`
      );
  }

  return untar(gunzipSync(fs.readFileSync(cached)));
}

function firstSentence(text) {
  const clean = String(text ?? "")
    .replace(/^\((Optional|Required|Read Only)\)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  // A sentence ends at . ! or ? before a capital letter, so "e.g." does not end one.
  const sentence = /^.*?[.!?](?=\s+[A-Z]|$)/.exec(clean)?.[0] ?? clean;

  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

/** Prints one type's properties as an indented tree. */
function card(files, typeName, typesFile, index) {
  const types = JSON.parse(files.get(typesFile).toString("utf8"));
  const resolve = (ref) => types[Number(String(ref.$ref).replace("#/", ""))];
  const lines = [`${typeName}`];

  const label = (type) => {
    switch (type.$type) {
      case "StringType":
        return "string";
      case "IntegerType":
        return "int";
      case "BooleanType":
        return "bool";
      case "StringLiteralType":
        return `'${type.value}'`;
      case "UnionType":
        return type.elements
          .map((element) => label(resolve(element)))
          .join(" | ");
      case "ArrayType":
        return `${label(resolve(type.itemType))}[]`;
      case "ObjectType":
        if (Object.keys(type.properties ?? {}).length > 0) return "object";

        return type.additionalProperties ?
            `map of ${label(resolve(type.additionalProperties))}`
          : "object";
      default:
        return type.$type.replace(/Type$/, "").toLowerCase();
    }
  };

  const children = (type, indent, depth) => {
    if (depth > MAX_DEPTH) return;

    if (type.$type === "ArrayType")
      children(resolve(type.itemType), indent, depth);
    else if (type.$type === "ObjectType") {
      const properties = Object.entries(type.properties ?? {});

      if (properties.length === 0 && type.additionalProperties)
        children(resolve(type.additionalProperties), indent, depth);

      for (const [name, property] of properties) {
        const propertyType = resolve(property.type);
        const flags = FLAGS.filter(([bit]) => (property.flags ?? 0) & bit).map(
          ([, word]) => word
        );
        const note = firstSentence(property.description);
        lines.push(
          `${indent}${name}: ${label(propertyType)}${flags.length ? ` (${flags.join(", ")})` : ""}${note ? ` - ${note}` : ""}`
        );
        children(propertyType, `${indent}  `, depth + 1);
      }
    }
  };

  const body = resolve(resolve({ $ref: `#/${index}` }).body);
  const properties = body.properties?.properties;

  lines.push(`  name: string (required)`);

  if (properties) {
    lines.push(`  properties: object`);
    children(resolve(properties.type), "    ", 1);
  }

  return lines.join("\n");
}

function main() {
  const files = loadTypes();
  const index = JSON.parse(files.get("index.json").toString("utf8")).resources;
  const names = Object.keys(index).filter((name) => name.startsWith("Radius."));
  const wanted = process.argv.slice(2);

  if (wanted.length === 0) {
    console.log("Radius resource types in the installed extension:");

    for (const name of names.sort()) console.log(`  ${name}`);
    console.log(
      "Next: print the cards you need, such as: node types.mjs Radius.Compute/containers"
    );

    return;
  }

  for (const want of wanted) {
    const name = names
      .filter((n) => n === want || n.startsWith(`${want}@`))
      .sort()
      .at(-1);

    if (!name) {
      console.log(
        `${want}: not a type in this extension. Run node types.mjs to list the types.\n`
      );
      process.exitCode = 1;
      continue;
    }
    const [typesFile, ref] = String(index[name].$ref).split("#/");
    console.log(`${card(files, name, typesFile, ref)}\n`);
  }
}

try {
  main();
} catch (error) {
  console.error(
    `types.mjs: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
}
