// The resolved-type contract show-radius-type.mjs stages for validate-bicep.mjs
// in `<staging-dir>/resolved-types.json`: for every type a modeling run
// resolved, the properties its envelope accepts and the path of every node its
// schema marks sensitive, with whether that node is a read-only output.
//
// The checker compiles offline and has no type catalog, and the compiled
// template keeps no trace of which property is sensitive: a `@secure()`
// parameter is only a `securestring` by then, and both
// `password: securePassword` and `password: secret.id` compile. So the facts
// are staged by the script that already resolved the schemas. Both scripts load
// this one module, so the file name, the version, the path notation, and the
// rule that accepts an entry cannot drift apart.

export const RESOLVED_TYPES_FILE = "resolved-types.json";
export const RESOLVED_TYPES_CONTRACT_VERSION = 2;

// A path uses the notation Radius core uses for the same flag
// (ExtractSensitiveFieldPaths in pkg/schema/annotations.go): property names
// joined by `.`, and `[*]` for every item of an array or every value of a map.
// An open envelope can make `[*]` the first segment. A property whose name
// holds `.`, `[`, or `]` cannot be written in this notation.
const ANY_ENTRY = "[*]";
const PATH_NAME = /^[^.[\]]+$/u;
const SENSITIVE_PATH = /^(?:[^.[\]]+|\[\*\])(?:\.[^.[\]]+|\[\*\])*$/u;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

// The whole shapes a schema node can take, each with whether it is read-only.
// A `oneOf` and a discriminated object are not shapes of their own:
// radius-type-schema.mjs merges a discriminated object's base properties into
// every variant, so each alternative or variant is a whole shape at the same
// path. A node is read-only when it or any node above it is, because the Recipe
// sets everything below an output.
function shapesOf(node, readOnly) {
  if (!isObject(node)) return [];
  const nodeReadOnly = readOnly || node.readOnly === true;
  const alternatives =
    Array.isArray(node.oneOf) ? node.oneOf
    : isObject(node.variants) ? Object.values(node.variants)
    : [];
  if (alternatives.length === 0) return [{ node, readOnly: nodeReadOnly }];
  return alternatives.flatMap((alternative) =>
    shapesOf(alternative, nodeReadOnly)
  );
}

function propertyNames(shapes) {
  return new Set(
    shapes.flatMap(({ node }) =>
      isObject(node.properties) ? Object.keys(node.properties) : []
    )
  );
}

// The node a shape holds for the property `name`: the property itself, or a
// value of the shape's open map when the shape does not name it.
function propertyOf({ node, readOnly }, name) {
  const named =
    isObject(node.properties) && Object.hasOwn(node.properties, name);
  return {
    node: named ? node.properties[name] : node.additionalProperties,
    readOnly
  };
}

// Records `nodePath` when every shape the schema allows there marks it
// sensitive. Recording a path that one shape leaves plain would let a
// `@secure()` parameter into that plain node with no report. Otherwise the walk
// goes on below, leaving out the shapes that mark the node. As in Radius core,
// it stops at a recorded path. The envelope's own flag has no path, so the walk
// always goes below it. A name the notation cannot hold gets a quoted segment,
// so that resolvedTypeEntry can refuse a path through it.
function collectSensitivePaths(declarations, nodePath, found) {
  const shapes = declarations.flatMap(({ node, readOnly }) =>
    shapesOf(node, readOnly)
  );
  if (shapes.length === 0) return;
  const isEnvelope = nodePath === "";
  if (!isEnvelope && shapes.every(({ node }) => node.sensitive === true)) {
    found.push({
      path: nodePath,
      readOnly: shapes.every(({ readOnly }) => readOnly)
    });
    return;
  }
  const open =
    isEnvelope ? shapes : shapes.filter(({ node }) => node.sensitive !== true);
  for (const name of propertyNames(open)) {
    const segment = PATH_NAME.test(name) ? name : `[${JSON.stringify(name)}]`;
    collectSensitivePaths(
      open.map((shape) => propertyOf(shape, name)),
      isEnvelope ? segment : `${nodePath}.${segment}`,
      found
    );
  }
  collectSensitivePaths(
    open.flatMap(({ node, readOnly }) => [
      { node: node.additionalProperties, readOnly },
      { node: node.items, readOnly }
    ]),
    `${nodePath}${ANY_ENTRY}`,
    found
  );
}

// What the checker needs about one resolved type, taken from the schema
// show-radius-type.mjs built: the properties any shape of its envelope names,
// and the path of every node the schema marks sensitive. Throws when a
// sensitive node has no path, because leaving it out would hide a credential
// from the checker.
export function resolvedTypeEntry(schema) {
  const envelope =
    isObject(schema) && isObject(schema.properties) ?
      schema.properties.properties
    : undefined;
  const sensitive = [];
  collectSensitivePaths([{ node: envelope, readOnly: false }], "", sensitive);
  const unwritable = sensitive.find(({ path }) => !SENSITIVE_PATH.test(path));
  if (unwritable) {
    throw new Error(
      `Cannot record the sensitive node ${unwritable.path}: a path cannot name a property whose name is empty or holds ".", "[", or "]".`
    );
  }
  return {
    properties: [...propertyNames(shapesOf(envelope, false))].sort(),
    sensitive: sensitive.sort((left, right) =>
      left.path < right.path ? -1 : 1
    )
  };
}

function isSensitivePathRecord(record) {
  return (
    isObject(record) &&
    hasExactKeys(record, ["path", "readOnly"]) &&
    typeof record.path === "string" &&
    SENSITIVE_PATH.test(record.path) &&
    typeof record.readOnly === "boolean"
  );
}

// Whether `value` is a version 2 contract with a map of types. Its entries are
// checked one at a time with isResolvedTypeEntry, so a reader can name the
// type that is wrong.
export function isResolvedTypesContract(value) {
  return (
    isObject(value) &&
    value.contractVersion === RESOLVED_TYPES_CONTRACT_VERSION &&
    isObject(value.types)
  );
}

export function isResolvedTypeEntry(entry) {
  if (!isObject(entry) || !hasExactKeys(entry, ["properties", "sensitive"])) {
    return false;
  }
  const { properties, sensitive } = entry;
  return (
    Array.isArray(properties) &&
    properties.every((name) => typeof name === "string") &&
    new Set(properties).size === properties.length &&
    Array.isArray(sensitive) &&
    sensitive.every(isSensitivePathRecord) &&
    new Set(sensitive.map((record) => record.path)).size === sensitive.length
  );
}

// Whether `entry` marks the envelope property `property` sensitive. A property
// the envelope names matches only the path that is its own name. Such a path
// is never written for a name that holds `.`, so a property named `x.y` cannot
// match the node `y` below a property `x`. A property the envelope does not
// name can still be a value of an open envelope, whose path is `[*]`.
export function marksPropertySensitive(entry, property) {
  if (!entry.properties.includes(property)) {
    return entry.sensitive.some((record) => record.path === ANY_ENTRY);
  }
  return (
    PATH_NAME.test(property) &&
    entry.sensitive.some((record) => record.path === property)
  );
}
