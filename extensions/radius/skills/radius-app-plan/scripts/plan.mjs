// Stage 2 of Radius modeling: plans a model for a cloud provider. `begin`
// starts a staged run in .radius/ and checks the model: the provider's Recipe
// pack for the installed Radius release must have a Recipe for each resource
// type, and each value the provider limits, such as a database name, must meet
// the provider's rule. `check` checks the model in the staging directory again
// and confirms that only those values changed. When the plan passes, the
// script writes the origin record and publishes the run into .radius/. `abort`
// deletes the run. Run it from the application's directory.
//
// Usage: node plan.mjs begin [--provider azure]
//        node plan.mjs check|abort [--provider azure] <staging-dir>
// Exit code 0 when the plan passes, 1 when it has problems.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  abortRun,
  beginRun,
  buildCustomTypes,
  ensureBicepConfig,
  findBicep,
  publishRun,
  radCommit,
  run,
  runDir,
  writeOrigin
} from "./common.mjs";

const DIAGNOSTIC =
  /^(.*)\((\d+),(\d+)\) : (Error|Warning|Info) ([\w-]+): (.*?)(?: \[https?:\/\/\S+\])?$/;

/** The Recipe pack for each provider, and the values that the provider limits. */
const PROVIDERS = {
  azure: {
    pack: "azure-aks",
    rules: {
      "Radius.Data/postgreSqlDatabases": {
        property: "database",
        rule: "1 to 63 characters: an ASCII letter or underscore, then letters, digits, hyphens, or underscores. Not postgres, azure_maintenance, azure_sys, template0, or template1, which already exist on the server, so the Recipe cannot create them.",
        ok: (v) =>
          /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(v) &&
          ![
            "postgres",
            "azure_maintenance",
            "azure_sys",
            "template0",
            "template1"
          ].includes(v)
      },
      "Radius.Data/mySqlDatabases": {
        property: "database",
        rule: "Not information_schema, mysql, performance_schema, or sys, in any case. Azure creates these schemas on every server.",
        ok: (v) =>
          ![
            "information_schema",
            "mysql",
            "performance_schema",
            "sys"
          ].includes(v.toLowerCase())
      },
      "Radius.Data/sqlServerDatabases": {
        property: "database",
        rule: "1 to 128 characters, none of <>*%&:\\/? or control characters, no period or space at the end, and not master or tempdb in any case.",
        ok: (v) =>
          v.length <= 128 &&
          !/[<>*%&:\\/?]/.test(v) &&
          ![...v].some((c) => c.charCodeAt(0) < 32) &&
          !/[. ]$/.test(v) &&
          !["master", "tempdb"].includes(v.toLowerCase())
      },
      "Radius.Data/mongoDatabases": {
        property: "database",
        rule: "1 to 42 letters, digits, underscores, periods, parentheses, or hyphens.",
        ok: (v) => /^[A-Za-z0-9_.()-]{1,42}$/.test(v)
      },
      "Radius.Storage/objectStorage": {
        property: "containerName",
        rule: "3 to 63 lowercase letters, digits, or hyphens. It starts and ends with a letter or digit, and has no two hyphens in a row.",
        ok: (v) => /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(v)
      },
      "Radius.Messaging/kafka": {
        property: "topic",
        rule: "1 to 249 letters, digits, periods, underscores, or hyphens. It starts and ends with a letter or digit.",
        ok: (v) =>
          v.length <= 249 &&
          /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(v)
      },
      "Radius.AI/models": {
        property: "model",
        rule: "gpt-5, gpt-5-mini, or gpt-5-nano: the models that the Recipe's fixed model version, 2025-08-07, supports.",
        ok: (v) => ["gpt-5", "gpt-5-mini", "gpt-5-nano"].includes(v)
      }
    }
  }
};

/** Compiles a model and returns the ARM template and the problems. */
function compile(bicep, file) {
  // Bicep writes a .bicep folder where it runs, so it runs outside the repository.
  const build = run(bicep, ["build", file, "--stdout"], { cwd: os.tmpdir() });
  const problems = [];

  for (const line of build.stderr.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(line.trim());

    if (match && match[4] !== "Info" && match[5] !== "BCP035")
      problems.push(`line ${match[2]}: ${match[4]} ${match[5]}: ${match[6]}`);
  }

  if (build.status !== 0) {
    if (problems.length === 0)
      problems.push(`bicep build failed: ${build.stderr.trim()}`);

    return { template: undefined, problems };
  }

  return { template: JSON.parse(build.stdout), problems };
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);

  return response.text();
}

/**
 * The resource types that the provider's Recipe pack registers, for the
 * Radius release that rad reports. The release's deploy/manifest/defaults.yaml
 * pins the pack's repository and commit.
 */
async function packTypes(packName) {
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
  const pack = await fetchText(
    `https://raw.githubusercontent.com/${entry[1]}/${entry[2]}/recipe-packs/${packName}/${packName}.bicep`
  );

  return new Set(
    [...pack.matchAll(/'(Radius\.[A-Za-z]+\/[A-Za-z]+)'\s*:\s*\{/g)].map(
      (m) => m[1]
    )
  );
}

/**
 * The Recipe source of each type in the run's custom Recipe pack,
 * custom-recipe-pack.bicep, and the problems in that file and in each authored
 * Recipe, `<name>-recipe.bicep`.
 */
function customRecipes(bicep, dir) {
  const sources = new Map();
  const problems = [];
  const authored = fs
    .readdirSync(dir)
    .filter((name) => /^[A-Za-z0-9-]+-recipe\.bicep$/.test(name));

  for (const name of ["custom-recipe-pack.bicep", ...authored]) {
    if (!fs.existsSync(path.join(dir, name))) continue;
    const built = compile(bicep, path.join(dir, name));

    problems.push(...built.problems.map((problem) => `${name} ${problem}`));

    for (const resource of Object.values(built.template?.resources ?? {}))
      if (String(resource.type).startsWith("Radius.Core/recipePacks@"))
        for (const [type, recipe] of Object.entries(
          resource.properties?.properties?.recipes ?? {}
        ))
          sources.set(type, String(recipe?.source ?? ""));
  }

  return { sources, problems, authored };
}

/** Whether a Recipe source names one version: a tag, a digest, or a git commit. */
function isPinned(source) {
  return /(?::(?!latest$)[\w.-]+|@sha256:[0-9a-f]{64}|[?&]ref=[0-9a-f]{40})$/.test(
    source
  );
}

/** A resource with the provider-limited property removed, as stable JSON. */
function comparable(resource, rules) {
  const copy = structuredClone(resource);
  const rule = rules[String(copy.type).split("@")[0]];

  if (rule && copy.properties?.properties)
    delete copy.properties.properties[rule.property];
  const sort = (value) =>
    Array.isArray(value) ? value.map(sort)
    : value && typeof value === "object" ?
      Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sort(value[key])])
      )
    : value;

  return JSON.stringify(sort(copy));
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { provider: { type: "string", default: "azure" } },
    allowPositionals: true
  });
  const [command, arg] = positionals;
  const provider = PROVIDERS[values.provider];
  const usage = `Usage: node plan.mjs begin [--provider ${Object.keys(PROVIDERS).join("|")}]\n       node plan.mjs check|abort [--provider ${Object.keys(PROVIDERS).join("|")}] <staging directory that begin printed>`;

  if (!["begin", "check", "abort"].includes(command) || !provider) {
    console.log(usage);

    return 1;
  }

  if (
    command === "begin" &&
    !fs.existsSync(path.resolve(".radius", "app.bicep"))
  ) {
    console.log(
      ".radius/app.bicep does not exist.\nNext: model the app first with the Stage 1 skill, radius-app-model."
    );

    return 1;
  }
  const dir = command === "begin" ? beginRun() : runDir(arg);

  if (!dir) {
    console.log(usage);

    return 1;
  }

  if (command === "abort") {
    console.log(abortRun(dir));

    return 0;
  }
  const file = path.join(dir, "app.bicep");
  // The model that the run started from, which `check` compares with.
  const start = path.join(dir, "start.bicep");
  const notes = [];
  const configNote = ensureBicepConfig(dir);

  if (configNote) notes.push(configNote);
  const bicep = findBicep();

  if (!bicep) {
    console.log(
      "No Bicep CLI found, and `rad bicep download` failed.\nNext: install the Radius CLI, then run this again."
    );

    return 1;
  }
  const customTypes = buildCustomTypes(dir);
  const { template, problems } = compile(bicep, file);

  if (customTypes) problems.unshift(customTypes);

  if (command === "check" && template) {
    // Stage 2 changes only provider-limited values. Compare everything else.
    const before = compile(bicep, start).template?.resources ?? {};
    const after = template.resources ?? {};

    for (const symbol of new Set([
      ...Object.keys(before),
      ...Object.keys(after)
    ])) {
      if (!before[symbol])
        problems.push(
          `${symbol} was added. Fix: remove it. Stage 2 adds no resources.`
        );
      else if (!after[symbol])
        problems.push(
          `${symbol} was removed. Fix: restore it. Stage 2 removes no resources.`
        );
      else if (
        comparable(before[symbol], provider.rules) !==
        comparable(after[symbol], provider.rules)
      )
        problems.push(
          `${symbol} changed in more than the value that ${values.provider} limits. Fix: restore everything else from the start model.`
        );
    }
  }

  const resources = Object.entries(template?.resources ?? {});
  const custom = customRecipes(bicep, dir);
  let recipeTypes;

  problems.push(...custom.problems);

  try {
    recipeTypes = await packTypes(provider.pack);
  } catch (error) {
    problems.push(
      `Could not read the ${provider.pack} Recipe pack, so Recipes were not checked: ${error.message} Fix: check the network connection, then run \`plan.mjs check\` again.`
    );
  }

  console.log(`Plan for ${values.provider} (${provider.pack} Recipe pack):`);

  for (const [symbol, resource] of resources) {
    const type = String(resource.type).split("@")[0];

    if (type === "Radius.Core/applications") continue;
    const source = custom.sources.get(type);
    const recipe =
      source ? `custom Recipe ${source}`
      : !recipeTypes ? ""
      : recipeTypes.has(type) ? "Recipe found"
      : "NO RECIPE";

    if (source && !isPinned(source))
      problems.push(
        `${symbol}: the custom Recipe source '${source}' names no fixed version. Fix: pin a version tag or digest, never latest.`
      );

    if (recipe === "NO RECIPE")
      problems.push(
        type.startsWith("Radius.Resources/") ?
          `${symbol}: the custom type ${type} has no Recipe. Fix: add one to custom-recipe-pack.bicep in the staging directory, as references/custom-recipes.md shows.`
        : `${symbol}: the ${provider.pack} pack has no Recipe for ${type}. Fix: tell the user; the Environment needs a Recipe for it.`
      );
    const rule = provider.rules[type];
    let value = "";

    if (rule) {
      const raw = resource.properties?.properties?.[rule.property];

      if (raw === undefined)
        value = `${rule.property} unset: the Recipe default applies`;
      else if (typeof raw !== "string" || raw.startsWith("["))
        value = `${rule.property} is not a literal, so it was not checked`;
      else if (rule.ok(raw)) value = `${rule.property} '${raw}' meets the rule`;
      else {
        value = `${rule.property} '${raw}' BREAKS THE RULE`;
        problems.push(
          `${symbol}: ${rule.property} '${raw}' breaks the ${values.provider} rule: ${rule.rule} Fix: if a setting in the source can change it, change it here; if code or the image fixes it, keep it and tell the user.`
        );
      }
    }
    console.log(
      `  ${type} ${resource.properties?.name ?? symbol}: ${[recipe, value].filter(Boolean).join("; ")}`
    );
  }

  let published = false;

  if (problems.length === 0) {
    notes.push(
      writeOrigin(file, {
        stage: "plan",
        provider: values.provider,
        start: fs.readFileSync(start, "utf8")
      })
    );
    const result = publishRun(dir);

    if (!result.ok) problems.push(result.message);
    else notes.push(result.message);
    published = result.published;
  }

  if (custom.authored.length > 0)
    notes.push(
      `${custom.authored.join(", ")} must be published to the source that custom-recipe-pack.bicep names before the app deploys. See references/custom-recipes.md.`
    );

  for (const note of notes) console.log(`Note: ${note}`);

  if (problems.length === 0) {
    console.log(
      `Problems: none\nNext: ${command === "begin" ? "no change is needed, and the plan is published. Tell the user that the model is ready for the provider." : `the plan passes${published ? " and is published" : ""}. Tell the user what changed and why.`}`
    );

    return 0;
  }
  console.log(
    `Problems:\n${problems.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}`
  );

  if (fs.existsSync(dir))
    console.log(
      `Staging directory: ${dir}\nNext: fix each problem that a setting in the source allows in ${file}, run \`plan.mjs check ${dir}\`, and report the rest. To stop, run \`plan.mjs abort ${dir}\`.`
    );

  return 1;
}

process.exitCode = await main();
