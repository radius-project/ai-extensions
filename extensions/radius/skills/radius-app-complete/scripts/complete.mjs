// Stage 3 of Radius modeling: makes a model ready to deploy. `begin` starts a
// staged run in .radius/ and lists the problems to fix. `check` checks the
// model in the staging directory: it compiles with zero warnings, the Stage 1
// and Stage 2 values and the connections between non-secret resources did not
// change, and build platforms, the registry secret, and provider username rules
// hold. When `check` passes, the script writes the origin record and publishes
// the run into .radius/. `abort` deletes the run. Run it from the
// application's directory.
//
// Usage: node complete.mjs begin
//        node complete.mjs check|abort <staging-dir>
// Exit code 0 when the command succeeds, 1 when it has problems.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  abortRun,
  beginRun,
  buildCustomTypes,
  ensureBicepConfig,
  findBicep,
  publishRun,
  run,
  runDir,
  writeOrigin
} from "./common.mjs";

const DIAGNOSTIC =
  /^(.*)\((\d+),(\d+)\) : (Error|Warning|Info) ([\w-]+): (.*?)(?: \[https?:\/\/\S+\])?$/;
const SECRET_TYPE = "Radius.Security/secrets";
const REGISTRY_SECRET = "radius-ghcr-registry-creds";
// Properties that Stage 3 owns. A value under one of them may change.
const STAGE_3_KEYS = new Set([
  "env",
  "command",
  "args",
  "readinessProbe",
  "livenessProbe",
  "volumeMounts",
  "workingDir",
  "resources",
  "username",
  "password",
  "platforms",
  "connections",
  "volumes",
  "codeReference",
  "secrets"
]);
// Azure administrator username rules, from the Azure documentation for each service.
const USERNAME_RULES = {
  "Radius.Data/postgreSqlDatabases": {
    rule: "1 to 63 ASCII letters or digits, not azure_superuser, azure_pg_admin, azuresu, admin, administrator, root, guest, or public, and not starting with pg_",
    ok: (v) =>
      /^[A-Za-z0-9]{1,63}$/.test(v) &&
      ![
        "azure_superuser",
        "azure_pg_admin",
        "azuresu",
        "admin",
        "administrator",
        "root",
        "guest",
        "public"
      ].includes(v.toLowerCase())
  },
  "Radius.Data/mySqlDatabases": {
    rule: "1 to 32 characters, not azure_superuser, admin, administrator, root, guest, sa, or public",
    ok: (v) =>
      v.length >= 1 &&
      v.length <= 32 &&
      ![
        "azure_superuser",
        "admin",
        "administrator",
        "root",
        "guest",
        "sa",
        "public"
      ].includes(v)
  },
  "Radius.Data/sqlServerDatabases": {
    rule: "1 to 128 characters, not admin, administrator, sa, root, dbmanager, loginmanager, dbo, guest, or public, in any case",
    ok: (v) =>
      v.length >= 1 &&
      v.length <= 128 &&
      ![
        "admin",
        "administrator",
        "sa",
        "root",
        "dbmanager",
        "loginmanager",
        "dbo",
        "guest",
        "public"
      ].includes(v.toLowerCase())
  }
};

/** Compiles a model with zero warnings allowed. */
function compile(bicep, file) {
  // Bicep writes a .bicep folder where it runs, so it runs outside the repository.
  const build = run(bicep, ["build", file, "--stdout"], { cwd: os.tmpdir() });
  const problems = [];

  for (const line of build.stderr.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(line.trim());

    if (match && match[4] !== "Info")
      problems.push(`line ${match[2]}: ${match[4]} ${match[5]}: ${match[6]}`);
  }

  if (build.status !== 0) {
    if (problems.length === 0)
      problems.push(`bicep build failed: ${build.stderr.trim()}`);

    return { template: undefined, problems };
  }

  return { template: JSON.parse(build.stdout), problems };
}

const typeOf = (resource) => String(resource?.type).split("@")[0];
const nameOf = (resource, symbol) => resource?.properties?.name ?? symbol;

/** Connections between resources other than the application and secrets. */
function edges(template) {
  const resources = template?.resources ?? {};
  const skip = (r) =>
    !r || typeOf(r) === SECRET_TYPE || typeOf(r) === "Radius.Core/applications";
  const result = new Set();

  for (const [symbol, resource] of Object.entries(resources))
    for (const dependency of resource.dependsOn ?? [])
      if (!skip(resource) && !skip(resources[dependency]))
        result.add(
          `${nameOf(resource, symbol)} -> ${nameOf(resources[dependency], dependency)}`
        );

  return result;
}

/** Each leaf value of `value` that Stage 1 or Stage 2 owns, by path. */
function ownedLeaves(value, prefix = "", out = new Map()) {
  if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      if (!STAGE_3_KEYS.has(key))
        ownedLeaves(child, prefix ? `${prefix}.${key}` : key, out);
    }
  else out.set(prefix, value);

  return out;
}

/** A literal value, or the literal behind a variables() or parameters() default. */
function literal(template, value) {
  const match = /^\[(variables|parameters)\('([^']+)'\)\]$/.exec(String(value));

  if (!match)
    return typeof value === "string" && !value.startsWith("[") ?
        value
      : undefined;
  const found =
    match[1] === "variables" ?
      template.variables?.[match[2]]
    : template.parameters?.[match[2]]?.defaultValue;

  return typeof found === "string" ? found : undefined;
}

function main() {
  const [command, arg] = process.argv.slice(2);
  const usage =
    "Usage: node complete.mjs begin\n       node complete.mjs check|abort <staging directory that begin printed>";

  if (!["begin", "check", "abort"].includes(command)) {
    console.log(usage);

    return 1;
  }

  if (
    command === "begin" &&
    !fs.existsSync(path.resolve(".radius", "app.bicep"))
  ) {
    console.log(
      ".radius/app.bicep does not exist.\nNext: model and plan the app first, with radius-app-model and radius-app-plan."
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
  const resources = template?.resources ?? {};

  if (command === "check" && template) {
    const before = compile(bicep, start).template;

    for (const [symbol, resource] of Object.entries(before?.resources ?? {})) {
      if (typeOf(resource) === SECRET_TYPE) continue;
      const after = resources[symbol];

      if (!after) {
        problems.push(
          `${symbol} was removed. Fix: restore it. Stage 3 removes no resources; if the app does not need it, tell the user to correct the model with Stage 1.`
        );
        continue;
      }
      // dependsOn is compared as connections below.
      const was = ownedLeaves(resource.properties);
      const now = ownedLeaves(after.properties);

      for (const [leaf, value] of was)
        if (JSON.stringify(now.get(leaf)) !== JSON.stringify(value))
          problems.push(
            `${symbol}: ${leaf} changed from ${JSON.stringify(value)} to ${JSON.stringify(now.get(leaf))}. Fix: restore it. Stage 1 and Stage 2 own this value.`
          );

      for (const [leaf, value] of now)
        if (!was.has(leaf))
          problems.push(
            `${symbol}: ${leaf} was added as ${JSON.stringify(value)}. Fix: remove it. Stage 1 and Stage 2 own this value; if the app needs it, tell the user to add it with Stage 1.`
          );
    }

    for (const [symbol, resource] of Object.entries(resources))
      if (!before?.resources?.[symbol] && typeOf(resource) !== SECRET_TYPE)
        problems.push(
          `${symbol} (${typeOf(resource)}) was added. Fix: remove it. Stage 3 adds only secrets; if the app needs it, tell the user to add it with Stage 1.`
        );

    const startEdges = edges(before);
    const endEdges = edges(template);

    for (const edge of endEdges)
      if (!startEdges.has(edge))
        problems.push(
          `New connection ${edge}. Fix: remove the reference. Stage 3 adds no connections; if the app needs it, tell the user to add it with Stage 1.`
        );

    for (const edge of startEdges)
      if (!endEdges.has(edge))
        problems.push(
          `Connection ${edge} is gone. Fix: keep a reference, a connection, or dependsOn for it.`
        );
  }

  const images = Object.entries(resources).filter(
    ([, r]) => typeOf(r) === "Radius.Compute/containerImages"
  );
  const registry = Object.entries(resources).find(
    ([, r]) =>
      typeOf(r) === SECRET_TYPE && r.properties?.name === REGISTRY_SECRET
  );

  for (const [symbol, image] of images) {
    if (!(image.properties?.properties?.build?.platforms?.length > 0))
      problems.push(
        `${symbol}: build.platforms is missing. Fix: set it, for example ['linux/amd64']. Without it the Recipe builds for both amd64 and arm64, and it cannot emulate, so a Dockerfile that does not cross-compile fails.`
      );

    if (registry && !(image.dependsOn ?? []).includes(registry[0]))
      problems.push(
        `${symbol}: does not depend on the ${REGISTRY_SECRET} secret. Fix: add dependsOn: [${registry[0]}].`
      );
  }

  if (images.length > 0 && !registry)
    problems.push(
      `The model builds images but has no Radius.Security/secrets resource named '${REGISTRY_SECRET}'. Fix: add it, with username and password from @secure() parameters. The deploy workflow configures the containerImages Recipe to read it by that name.`
    );

  for (const [symbol, resource] of Object.entries(resources)) {
    const rule = USERNAME_RULES[typeOf(resource)];
    const raw = resource.properties?.properties?.username;
    const username = raw === undefined ? undefined : literal(template, raw);

    if (rule && username !== undefined && !rule.ok(username))
      problems.push(
        `${symbol}: username '${username}' breaks the Azure rule: ${rule.rule}. Fix: use another name, such as myadmin.`
      );
  }

  console.log(
    `Resources: ${Object.keys(resources).length}. Connections between non-secret resources: ${edges(template).size}.`
  );

  let published = false;

  if (problems.length === 0 && command === "check") {
    notes.push(
      writeOrigin(file, {
        stage: "complete",
        start: fs.readFileSync(start, "utf8")
      })
    );
    const result = publishRun(dir);

    if (!result.ok) problems.push(result.message);
    else notes.push(result.message);
    published = result.published;
  }

  for (const note of notes) console.log(`Note: ${note}`);

  if (problems.length === 0 && command === "check") {
    console.log(
      `Problems: none\nNext: the model passes the Stage 3 checks${published ? " and is published in .radius/" : ""}. Reply to the user.`
    );

    return 0;
  }

  if (problems.length > 0)
    console.log(
      `Problems:\n${problems.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}`
    );

  if (fs.existsSync(dir))
    console.log(
      `${problems.length === 0 ? "Problems: none\n" : ""}Staging directory: ${dir}\nNext: edit ${file}, check each setting against its parser, then run \`complete.mjs check ${dir}\`. To stop, run \`complete.mjs abort ${dir}\`.`
    );

  return problems.length === 0 ? 0 : 1;
}

process.exitCode = main();
