// Prints the Recipe that the provider's Recipe pack registers for each named
// resource type, for the Radius release that rad reports: the module that it
// deploys, the parameters it passes, and how the module's outputs map to the
// type's read-only properties and secrets.
//
// Usage: node recipe.mjs [--provider azure] Radius.Data/redisCaches [...]

import { parseArgs } from "node:util";

import { radCommit } from "./common.mjs";

const PACKS = { azure: "azure-aks" };

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);

  return response.text();
}

/** The Recipe pack's Bicep source, at the commit that the Radius release pins. */
async function packSource(packName) {
  const commit = radCommit();

  if (!commit) throw new Error("rad version reports no release commit.");
  const defaults = await fetchText(
    `https://raw.githubusercontent.com/radius-project/radius/${commit}/deploy/manifest/defaults.yaml`
  );
  const entry = new RegExp(
    `-\\s+name:\\s*${packName}\\s*\\n\\s+repo:\\s*github\\.com/(\\S+)\\s*\\n\\s+ref:\\s*([0-9a-f]{40})`
  ).exec(defaults);

  if (!entry)
    throw new Error(
      `The Radius release defaults pin no ${packName} Recipe pack.`
    );

  return fetchText(
    `https://raw.githubusercontent.com/${entry[1]}/${entry[2]}/recipe-packs/${packName}/${packName}.bicep`
  );
}

/** The `'<type>': { ... }` block of the pack, by brace matching. */
function entry(source, type) {
  const start = source.indexOf(`'${type}':`);

  if (start < 0) return undefined;
  let depth = 0;

  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0)
      return source.slice(start, i + 1);
  }

  return undefined;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { provider: { type: "string", default: "azure" } },
    allowPositionals: true
  });
  const pack = PACKS[values.provider];

  if (!pack || positionals.length === 0) {
    console.log(
      `Usage: node recipe.mjs [--provider ${Object.keys(PACKS).join("|")}] <Radius type> [...]`
    );

    return 1;
  }
  const source = await packSource(pack);
  let status = 0;

  for (const type of positionals) {
    const block = entry(source, type.split("@")[0]);

    if (!block) status = 1;
    console.log(
      block ?
        `${block}\n`
      : `${type}: the ${pack} pack has no Recipe for this type.\n`
    );
  }

  return status;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(
    `recipe.mjs: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
}
