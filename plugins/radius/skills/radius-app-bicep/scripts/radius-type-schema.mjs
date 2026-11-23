// Converts Radius' generated Bicep type graph into the compact schema shown to
// the model. This module is deliberately pure: fetching, caching, managed
// binary discovery, and staged Bicep configuration stay in show-radius-type.mjs
// so generated type-shape changes can be understood and tested in isolation.

export class DefinitionNotFoundError extends Error {
  constructor(type) {
    super(
      `Definition for resource type "${type}" was not found in the generated catalog for this Radius release.`
    );
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, context) {
  if (!isObject(value)) throw new Error(`${context} must be an object.`);
  return value;
}

function sortedEntries(value) {
  return Object.entries(value).sort(([left], [right]) => {
    if (left < right) return -1;
    // Distinct entries from an object cannot have equal keys.
    /* v8 ignore next */
    if (left > right) return 1;
    // This return preserves the comparator contract for that unreachable case.
    /* v8 ignore next */
    return 0;
  });
}

export function parseIndexReference(reference) {
  const match = /^([A-Za-z0-9._/-]+\/types\.json)#\/(0|[1-9]\d*)$/u.exec(
    reference
  );
  if (match === null) {
    throw new Error(`Generated resource reference "${reference}" is invalid.`);
  }
  const segments = match[1].split("/");
  if (
    match[1].startsWith("/") ||
    match[1].includes("\\") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`Generated resource reference "${reference}" is unsafe.`);
  }
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index)) {
    throw new Error(`Generated resource reference "${reference}" is invalid.`);
  }
  return { relativePath: match[1], index };
}

function localIndex(reference, context) {
  const match = /^#\/(0|[1-9]\d*)$/u.exec(reference?.$ref);
  if (!isObject(reference) || !match) {
    throw new Error(`${context} must use a local #/N type reference.`);
  }
  return Number(match[1]);
}

function generatedNode(types, index, context) {
  const node = types[index];
  if (!isObject(node) || typeof node.$type !== "string") {
    throw new Error(
      `${context} references missing generated type node ${index}.`
    );
  }
  return node;
}

function referencedNode(types, reference, context) {
  const index = localIndex(reference, context);
  return { index, node: generatedNode(types, index, context) };
}

export function validateGeneratedIndex(index) {
  requireObject(index, "Generated index");
  requireObject(index.resources, "Generated index resources");
}

export function validateGeneratedTypes(types) {
  if (!Array.isArray(types)) {
    throw new Error("Generated types file must contain a JSON array.");
  }
}

export function selectResource(index, selector) {
  validateGeneratedIndex(index);
  const prefix = `${selector.type}@`;
  const availableApiVersions = Object.keys(index.resources)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .sort();

  if (availableApiVersions.length === 0) {
    throw new DefinitionNotFoundError(selector.type);
  }

  let apiVersion = selector.apiVersion;
  if (apiVersion === undefined) {
    if (availableApiVersions.length > 1) {
      throw new Error(
        `Resource type "${selector.type}" has multiple API versions: ${availableApiVersions.join(
          ", "
        )}. Rerun with an exact @<api-version>.`
      );
    }
    [apiVersion] = availableApiVersions;
  }

  const key = `${selector.type}@${apiVersion}`;
  const entry = index.resources[key];
  if (!isObject(entry)) {
    throw new Error(
      `Resource type "${key}" is unavailable. Available versions: ${availableApiVersions.join(
        ", "
      )}.`
    );
  }
  return {
    type: selector.type,
    apiVersion,
    reference: parseIndexReference(entry.$ref)
  };
}

export function decodePropertyFlags(flags, context = "property") {
  if (!Number.isSafeInteger(flags) || flags < 0) {
    throw new Error(
      `${context} contains unsupported property flags "${flags}".`
    );
  }
  return {
    required: (flags & 1) !== 0,
    readable: (flags & 4) === 0,
    writable: (flags & 2) === 0
  };
}

function normalizeProperty(property, types, active, context) {
  requireObject(property, context);
  const flags = decodePropertyFlags(property.flags, context);
  const schema = normalizeTypeReference(property.type, types, active, context);
  if (!flags.readable) schema.writeOnly = true;
  if (!flags.writable) schema.readOnly = true;
  return { required: flags.required, schema };
}

function normalizeProperties(properties, types, active, context) {
  requireObject(properties, context);
  const result = { properties: {}, required: [] };
  for (const [name, property] of sortedEntries(properties)) {
    const normalized = normalizeProperty(
      property,
      types,
      active,
      `${context}.${name}`
    );
    result.properties[name] = normalized.schema;
    if (normalized.required) result.required.push(name);
  }
  return result;
}

function objectSchema(normalized, additionalProperties, sensitive = false) {
  const result = { type: "object" };
  if (normalized.required.length > 0) result.required = normalized.required;
  result.properties = normalized.properties;
  result.additionalProperties = additionalProperties;
  if (sensitive) result.sensitive = true;
  return result;
}

function normalizeObject(node, types, active, context) {
  return objectSchema(
    normalizeProperties(
      node.properties,
      types,
      active,
      `${context}.properties`
    ),
    node.additionalProperties === undefined ?
      false
    : normalizeTypeReference(
        node.additionalProperties,
        types,
        active,
        `${context}.additionalProperties`
      ),
    node.sensitive === true
  );
}

function mergeObjectSchemas(base, variant, context) {
  const properties = {};
  const names = [
    ...new Set([
      ...Object.keys(base.properties),
      ...Object.keys(variant.properties)
    ])
  ].sort();
  for (const name of names) {
    if (
      base.properties[name] !== undefined &&
      variant.properties[name] !== undefined &&
      JSON.stringify(base.properties[name]) !==
        JSON.stringify(variant.properties[name])
    ) {
      throw new Error(`${context} redefines property "${name}" incompatibly.`);
    }
    properties[name] = variant.properties[name] ?? base.properties[name];
  }
  const result = { ...variant, properties };
  const required = [
    ...new Set([...(base.required ?? []), ...(variant.required ?? [])])
  ].sort();
  if (required.length > 0) result.required = required;
  return result;
}

function normalizeDiscriminatedObject(node, types, active, context) {
  if (typeof node.discriminator !== "string" || node.discriminator === "") {
    throw new Error(`${context}.discriminator must be a nonempty string.`);
  }
  const base = objectSchema(
    normalizeProperties(
      node.baseProperties,
      types,
      active,
      `${context}.baseProperties`
    ),
    false
  );
  const variants = {};
  for (const [name, reference] of sortedEntries(
    requireObject(node.elements, `${context}.elements`)
  )) {
    const variant = normalizeTypeReference(
      reference,
      types,
      active,
      `${context}.elements.${name}`
    );
    if (variant.type !== "object") {
      throw new Error(`${context}.elements.${name} must resolve to an object.`);
    }
    variants[name] = mergeObjectSchemas(
      base,
      variant,
      `${context}.elements.${name}`
    );
  }
  return { ...base, discriminator: node.discriminator, variants };
}

function literalUnion(node, types, context) {
  if (!Array.isArray(node.elements) || node.elements.length === 0) {
    throw new Error(`${context}.elements must be a nonempty array.`);
  }
  const literals = node.elements.map((reference, index) =>
    referencedNode(types, reference, `${context}.elements[${index}]`)
  );
  if (literals.some(({ node: item }) => item.$type !== "StringLiteralType")) {
    return null;
  }
  const result = {
    type: "string",
    enum: [...new Set(literals.map(({ node: item }) => item.value))].sort()
  };
  for (const { node: item } of literals) {
    if (typeof item.value !== "string") {
      throw new Error(`${context} contains a non-string literal.`);
    }
    if (item.sensitive === true) result.sensitive = true;
  }
  return result;
}

function normalizeTypeNode(node, types, active, context) {
  switch (node.$type) {
    case "AnyType":
      return { type: "any" };
    case "NullType":
      return { type: "null" };
    case "BooleanType":
      return { type: "boolean" };
    case "IntegerType": {
      const result = { type: "integer" };
      if (node.minValue !== undefined) result.minimum = node.minValue;
      if (node.maxValue !== undefined) result.maximum = node.maxValue;
      return result;
    }
    case "StringType": {
      const result = { type: "string" };
      if (node.minLength !== undefined) result.minLength = node.minLength;
      if (node.maxLength !== undefined) result.maxLength = node.maxLength;
      if (node.pattern !== undefined) result.pattern = node.pattern;
      if (node.sensitive === true) result.sensitive = true;
      return result;
    }
    case "StringLiteralType": {
      if (typeof node.value !== "string") {
        throw new Error(`${context}.value must be a string.`);
      }
      const result = { type: "string", const: node.value };
      if (node.sensitive === true) result.sensitive = true;
      return result;
    }
    case "ArrayType": {
      const result = {
        type: "array",
        items: normalizeTypeReference(
          node.itemType,
          types,
          active,
          `${context}.itemType`
        )
      };
      if (node.minLength !== undefined) result.minItems = node.minLength;
      if (node.maxLength !== undefined) result.maxItems = node.maxLength;
      return result;
    }
    case "ObjectType":
      return normalizeObject(node, types, active, context);
    case "DiscriminatedObjectType":
      return normalizeDiscriminatedObject(node, types, active, context);
    case "UnionType": {
      const literals = literalUnion(node, types, context);
      if (literals !== null) return literals;
      return {
        oneOf: node.elements.map((reference, index) =>
          normalizeTypeReference(
            reference,
            types,
            active,
            `${context}.elements[${index}]`
          )
        )
      };
    }
    default:
      throw new Error(
        `${context} uses unsupported generated type kind "${node.$type}".`
      );
  }
}

export function normalizeTypeReference(
  reference,
  types,
  active = new Set(),
  context = "type"
) {
  const index = localIndex(reference, context);
  if (active.has(index)) {
    throw new Error(
      `${context} contains a recursive type cycle at node ${index}.`
    );
  }
  const node = generatedNode(types, index, context);
  active.add(index);
  try {
    return normalizeTypeNode(node, types, active, `generated type ${index}`);
  } finally {
    active.delete(index);
  }
}

function sameReference(left, right) {
  return (
    isObject(left) &&
    isObject(right) &&
    Object.keys(left).length === 1 &&
    Object.keys(right).length === 1 &&
    left.$ref === right.$ref
  );
}

export function buildSchema(types, rootIndex) {
  validateGeneratedTypes(types);
  const root = generatedNode(types, rootIndex, "resource root");
  if (root.$type !== "ResourceType") {
    throw new Error(
      `Generated resource root ${rootIndex} is not ResourceType.`
    );
  }
  const bodyRef = referencedNode(types, root.body, "generated resource body");
  const body = bodyRef.node;
  if (body.$type !== "ObjectType") {
    throw new Error("Generated resource body must resolve to ObjectType.");
  }
  requireObject(body.properties, "Generated resource body properties");

  let nestedProperties = {};
  const propertiesEnvelope = body.properties.properties;
  if (propertiesEnvelope !== undefined) {
    const nested = referencedNode(
      types,
      propertiesEnvelope.type,
      "generated resource properties envelope"
    ).node;
    if (nested.$type !== "ObjectType") {
      throw new Error(
        "Generated properties envelope must resolve to ObjectType."
      );
    }
    nestedProperties = requireObject(
      nested.properties,
      "Generated nested resource properties"
    );
  }

  const normalized = { properties: {}, required: [] };
  const active = new Set([rootIndex, bodyRef.index]);
  for (const [name, property] of sortedEntries(body.properties)) {
    requireObject(property, `Generated resource body property "${name}"`);
    const flags = decodePropertyFlags(
      property.flags,
      `Generated resource body property "${name}"`
    );
    // Radius repeats read-only properties at the body root when the same type
    // already appears in the properties envelope. Omit only those exact mirrors
    // so the model sees one output path without hiding anything it can author.
    if (
      name !== "properties" &&
      !flags.writable &&
      isObject(nestedProperties[name]) &&
      sameReference(property.type, nestedProperties[name].type)
    ) {
      continue;
    }
    const propertySchema = normalizeProperty(
      property,
      types,
      active,
      `Generated resource body property "${name}"`
    );
    normalized.properties[name] = propertySchema.schema;
    if (propertySchema.required) normalized.required.push(name);
  }

  return objectSchema(
    normalized,
    body.additionalProperties === undefined ?
      false
    : normalizeTypeReference(
        body.additionalProperties,
        types,
        active,
        "generated resource body additionalProperties"
      ),
    body.sensitive === true
  );
}
