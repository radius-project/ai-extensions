const RESOURCE_TYPES_CONTRIB_REPOSITORY =
  "radius-project/resource-types-contrib";
const COMMIT = /^[0-9a-f]{40}$/iu;
const PREDEFINED_RESOURCE_TYPE =
  /^Radius(?:\.[A-Za-z][A-Za-z0-9]*)+\/[A-Za-z][A-Za-z0-9]*$/u;
// Radius releases before the azure-aks rename (resource-types-contrib#292)
// publish the AKS pack as `azure`. Prefer the new entry and fall back so the
// skill works against both older and newer Radius releases.
const AZURE_RECIPE_PACKS = [
  { name: "azure-aks", path: "recipe-packs/azure-aks/azure-aks.bicep" },
  { name: "azure", path: "recipe-packs/azure/aks-recipepack.bicep" }
];

function parseCatalogEntries(source, sectionName) {
  if (typeof source !== "string") {
    throw new Error("Radius release defaults must be text.");
  }

  const entries = [];
  let sectionIndent;
  let current;
  let currentIndent;
  for (const line of source.replaceAll("\r\n", "\n").split("\n")) {
    if (sectionIndent === undefined) {
      const section = new RegExp(`^([ \\t]*)${sectionName}:\\s*$`, "u").exec(
        line
      );
      if (section === null) continue;
      sectionIndent = section[1].length;
      continue;
    }
    const trimmed = line.trim();
    const indentation = /^[ \t]*/u.exec(line)[0].length;
    const nameMatch = /^([ \t]*)-\s+name:\s*(\S+)\s*$/u.exec(line);
    const indentationlessEntry =
      nameMatch !== null && indentation === sectionIndent;
    if (
      trimmed !== "" &&
      !trimmed.startsWith("#") &&
      indentation <= sectionIndent &&
      !indentationlessEntry
    ) {
      break;
    }

    const name = nameMatch?.[2];
    if (name !== undefined) {
      if (current !== undefined) entries.push(current);
      current = { name };
      currentIndent = nameMatch[1].length;
      continue;
    }
    if (current === undefined) continue;

    const field = /^([ \t]*)(repo|ref):\s*(\S+)\s*$/u.exec(line);
    if (field !== null && field[1].length > currentIndent) {
      const property = field[2] === "repo" ? "repository" : "commit";
      if (current[property] !== undefined) {
        throw new Error(
          'Radius release catalog entry contains a duplicate "repo" or "ref" field.'
        );
      }
      current[property] = field[3];
    }
  }
  if (current !== undefined) entries.push(current);
  return entries;
}

export function parseResourceTypeCommit(source, resourceType) {
  const namespace = resourceType.split("/")[0];
  const entries = parseCatalogEntries(source, "resourceTypes").filter(
    (entry) => entry.name === namespace
  );
  if (
    entries.length !== 1 ||
    !/^[0-9a-f]{40}$/u.test(entries[0].commit ?? "")
  ) {
    throw new Error(
      `Recipe release defaults must contain exactly one resourceTypes entry for "${namespace}" with a lowercase full commit SHA.`
    );
  }
  return entries[0].commit;
}

export function parseAzureRecipePackPin(source) {
  const entries = parseCatalogEntries(source, "recipePacks");

  const pack = AZURE_RECIPE_PACKS.find((candidate) =>
    entries.some((entry) => entry.name === candidate.name)
  );
  if (pack === undefined) {
    throw new Error(
      "Radius release defaults do not contain an Azure Recipe pack."
    );
  }
  const azureEntries = entries.filter((entry) => entry.name === pack.name);
  if (azureEntries.length !== 1) {
    throw new Error(
      "Radius release defaults contain multiple Azure Recipe packs."
    );
  }
  const azure = azureEntries[0];
  const expectedRepository = `github.com/${RESOURCE_TYPES_CONTRIB_REPOSITORY}`;
  if (azure.repository !== expectedRepository) {
    throw new Error(
      `The Azure Recipe pack must come from ${expectedRepository}.`
    );
  }
  if (typeof azure.commit !== "string" || !COMMIT.test(azure.commit)) {
    throw new Error("The Azure Recipe pack ref must be a full commit SHA.");
  }
  return {
    repository: RESOURCE_TYPES_CONTRIB_REPOSITORY,
    commit: azure.commit.toLowerCase(),
    name: pack.name,
    path: pack.path
  };
}

export function extractRecipeDefinition(source, resourceType) {
  if (typeof source !== "string") {
    throw new Error("The Azure Recipe pack must be text.");
  }
  if (
    typeof resourceType !== "string" ||
    !PREDEFINED_RESOURCE_TYPE.test(resourceType) ||
    resourceType.startsWith("Radius.Resources/")
  ) {
    throw new Error(
      `Recipe lookup requires an exact predefined resource type, received "${resourceType}".`
    );
  }
  const escapedType = resourceType.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const starts = [
    ...source.matchAll(
      new RegExp(
        `^([ \\t]*)'${escapedType}'[ \\t]*:[ \\t]*\\{[ \\t]*(?:\\/\\/[^\\r\\n]*)?(?=\\r?$)`,
        "gmu"
      )
    )
  ];
  if (starts.length === 0) return undefined;
  if (starts.length > 1) {
    throw new Error(
      `The Azure Recipe pack contains multiple Recipe definitions for "${resourceType}".`
    );
  }

  const start = starts[0];
  const indentation = start[1].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const boundary = new RegExp(
    `^${indentation}(?:'Radius(?:\\.[A-Za-z][A-Za-z0-9]*)+\\/[A-Za-z][A-Za-z0-9]*'[ \\t]*:[ \\t]*\\{|\\})[ \\t]*(?:\\/\\/[^\\r\\n]*)?(?=\\r?$)`,
    "gmu"
  );
  boundary.lastIndex = start.index + start[0].length;
  const end = boundary.exec(source);
  if (end === null || end[0].trimStart().startsWith("'")) {
    throw new Error(
      `The Azure Recipe pack contains an incomplete Recipe definition for "${resourceType}".`
    );
  }
  return source.slice(start.index, end.index + end[0].length);
}

export function validateAzureRecipePack(source) {
  if (typeof source !== "string" || source.trim() === "") {
    throw new Error("The Azure Recipe pack must be non-empty text.");
  }
  if (
    !/^[ \t]*resource[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]+'Radius\.Core\/recipePacks@[A-Za-z0-9.-]+'[ \t]*=[ \t]*\{[ \t]*(?:\/\/[^\r\n]*)?(?=\r?$)/mu.test(
      source
    ) ||
    !/^[ \t]*recipes[ \t]*:[ \t]*\{[ \t]*(?:\/\/[^\r\n]*)?(?=\r?$)/mu.test(
      source
    ) ||
    !/^[ \t]+'Radius(?:\.[A-Za-z][A-Za-z0-9]*)+\/[A-Za-z][A-Za-z0-9]*'[ \t]*:[ \t]*\{[ \t]*(?:\/\/[^\r\n]*)?(?=\r?$)/mu.test(
      source
    )
  ) {
    throw new Error(
      "The Azure Recipe pack does not contain the expected Recipe-pack structure."
    );
  }
}
