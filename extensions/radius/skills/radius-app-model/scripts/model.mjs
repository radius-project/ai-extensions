// Stage 1 of Radius modeling. `begin` starts a staged run in .radius/ and
// prints its directory. `check` checks the model in that directory: it
// compiles the model, allows only BCP035 warnings (database credentials, which
// Stage 3 adds), checks each image build and source reference against the git
// checkout, and prints the resources and connections. When the model passes,
// it writes the origin record and publishes the run into .radius/. `abort`
// deletes the run. Run it from the application's directory.
//
// Usage: node model.mjs begin
//        node model.mjs check|abort <staging-dir>
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
const BLOB_URL =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/([^#]+)(?:#L(\d+)(?:-L?(\d+))?)?$/;
const GIT_SOURCE =
  /^git::https:\/\/github\.com\/([^/]+)\/([^/?]+?)(?:\.git)?(?:\/\/([^?]+))?\?ref=([0-9a-f]{40})$/;
// Properties that a later stage owns. Stage 1 leaves them out.
const LATER_STAGE_CONTAINER_KEYS = [
  "env",
  "command",
  "args",
  "readinessProbe",
  "livenessProbe",
  "volumeMounts",
  "workingDir"
];

function git(cwd, args) {
  const result = run("git", ["-C", cwd, ...args]);

  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** owner/repo of a GitHub remote URL. */
function gitHubRepo(remote) {
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(
    remote ?? ""
  );

  return match ? `${match[1]}/${match[2]}` : undefined;
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function lineCount(file) {
  try {
    const text = fs.readFileSync(file, "utf8");

    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return undefined;
  }
}

function main() {
  const [command, arg] = process.argv.slice(2);

  if (command === "begin") {
    const dir = beginRun();

    console.log(
      `Staging directory: ${dir}\nNext: write the model in ${path.join(dir, "app.bicep")}${fs.existsSync(path.join(dir, "app.bicep")) ? ", which starts as a copy of the current model" : ""}. Do not edit .radius/ directly. Then run \`model.mjs check ${dir}\`.`
    );

    return 0;
  }
  const dir = runDir(arg);

  if (!["check", "abort"].includes(command) || !dir) {
    console.log(
      "Usage: node model.mjs begin\n       node model.mjs check|abort <staging directory that begin printed>"
    );

    return 1;
  }

  if (command === "abort") {
    console.log(abortRun(dir));

    return 0;
  }
  const file = path.join(dir, "app.bicep");
  const problems = [];
  const notes = [];

  if (!fs.existsSync(file)) {
    console.log(
      `${file} does not exist.\nNext: write the model there, then run this check again.`
    );

    return 1;
  }
  const configNote = ensureBicepConfig(path.dirname(file));

  if (configNote) notes.push(configNote);
  const bicep = findBicep();

  if (!bicep) {
    console.log(
      "No Bicep CLI found, and `rad bicep download` failed.\nNext: install the Radius CLI, then run this check again."
    );

    return 1;
  }

  const customTypes = buildCustomTypes(dir);

  if (customTypes) problems.push(customTypes);

  // Bicep writes a .bicep folder where it runs, so it runs outside the repository.
  const build = run(bicep, ["build", file, "--stdout"], { cwd: os.tmpdir() });
  let credentialWarnings = 0;

  for (const line of build.stderr.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(line.trim());

    if (!match) continue;
    const [, , row, , level, code, message] = match;

    if (level === "Warning" && code === "BCP035") credentialWarnings += 1;
    else if (level !== "Info")
      problems.push(`line ${row}: ${level} ${code}: ${message}`);
  }

  if (build.status !== 0 && problems.length === 0)
    problems.push(
      `bicep build failed: ${build.stderr.trim() || build.stdout.trim()}`
    );

  let template;

  try {
    template = build.status === 0 ? JSON.parse(build.stdout) : undefined;
  } catch {
    problems.push("bicep build printed something that is not an ARM template.");
  }

  const root = git(path.dirname(file), ["rev-parse", "--show-toplevel"]);
  const head = root && git(root, ["rev-parse", "HEAD"]);
  const repo = root && gitHubRepo(git(root, ["remote", "get-url", "origin"]));
  const resources = Object.entries(template?.resources ?? {});
  const graph = [];
  const edges = [];
  const laterStage = new Set();

  for (const [symbol, resource] of resources) {
    const type = String(resource.type ?? "").split("@")[0];
    const props = resource.properties?.properties ?? {};
    const where = `${symbol} (${type})`;
    graph.push(`  ${type} ${resource.properties?.name ?? symbol}`);

    if (type === "Radius.Core/applications") continue;

    for (const dependency of resource.dependsOn ?? []) {
      const target = template.resources[dependency];

      if (String(target?.type).startsWith("Radius.Core/applications")) continue;
      edges.push(
        `  ${resource.properties?.name ?? symbol} -> ${target?.properties?.name ?? dependency}`
      );
    }

    if (type === "Radius.Security/secrets")
      laterStage.add(`secret ${resource.properties?.name}`);

    for (const [key, container] of Object.entries(props.containers ?? {})) {
      for (const later of LATER_STAGE_CONTAINER_KEYS)
        if (container?.[later] !== undefined)
          laterStage.add(`${later} on ${key}`);

      const image = container?.image;

      // The last path segment of a published image names a tag or digest.
      if (
        typeof image === "string" &&
        !image.startsWith("[") &&
        !/[:@]/.test(image.split("/").at(-1))
      )
        problems.push(
          `${where}: image '${image}' on ${key} has no tag or digest. Fix: use the tag that the source publishes. If no registry publishes it, such as a compose image name next to build:, build it with a containerImages resource.`
        );
    }

    const ref = props.codeReference;

    if (ref === undefined)
      problems.push(
        `${where}: no codeReference. Fix: point it to the file and line that defines the resource.`
      );
    else if (typeof ref === "string" && !ref.startsWith("[") && root) {
      const url = BLOB_URL.exec(ref);
      const [, owner, name, commit, refPath, line] = url ?? [];

      if (url && same(`${owner}/${name}`, repo)) {
        if (commit !== head)
          problems.push(
            `${where}: codeReference uses ${commit}, not the checked-out commit. Fix: use .../blob/${head}/${refPath}.`
          );
        const lines = lineCount(path.join(root, decodeURIComponent(refPath)));

        if (lines === undefined)
          problems.push(
            `${where}: codeReference file ${refPath} does not exist at ${head}.`
          );
        else if (line && Number(line) > lines)
          problems.push(
            `${where}: codeReference line ${line} is past the end of ${refPath} (${lines} lines).`
          );
      } else if (!url && !/^https?:/.test(ref)) {
        const relative = ref.split("#")[0];
        const exists = [root, process.cwd()].some((base) =>
          fs.existsSync(path.join(base, relative))
        );

        if (!exists && relative !== ".radius/app.bicep")
          problems.push(
            `${where}: codeReference path ${relative} does not exist in the repository.`
          );
      }
    }

    const source = props.build?.source;

    if (
      type === "Radius.Compute/containerImages" &&
      typeof source === "string" &&
      !source.startsWith("[")
    ) {
      const match = GIT_SOURCE.exec(source);
      const subdir = match?.[3] ? `//${match[3]}` : "";
      const expected =
        repo && head ?
          `git::https://github.com/${repo}.git${subdir}?ref=${head}`
        : "git::https://github.com/<owner>/<repo>.git?ref=<full commit SHA>";

      if (!match)
        problems.push(
          `${where}: build.source is not a git source pinned to a full commit SHA. Fix: use '${expected}', with //<folder> before ?ref= when the build context is a folder.`
        );
      else if (
        (repo && !same(`${match[1]}/${match[2]}`, repo)) ||
        (head && match[4] !== head)
      )
        problems.push(
          `${where}: build.source is not this repository at the checked-out commit. Fix: use '${expected}'.`
        );

      // build.dockerfile is relative to the build context.
      const dockerfile = props.build?.dockerfile ?? "Dockerfile";

      if (
        root &&
        match &&
        typeof dockerfile === "string" &&
        !fs.existsSync(path.join(root, match[3] ?? "", dockerfile))
      )
        problems.push(
          `${where}: ${path.posix.join(match[3] ?? "", dockerfile)} does not exist in the repository. Fix: set build.dockerfile to the Dockerfile's path from the build context.`
        );
    }
  }

  if (!root)
    notes.push(
      "This is not a git checkout, so image sources and source references were not checked."
    );

  console.log(`Resources:\n${graph.join("\n") || "  none"}`);
  console.log(`Connections:\n${edges.join("\n") || "  none"}`);

  if (credentialWarnings > 0)
    notes.push(
      `${credentialWarnings} BCP035 warning(s) for missing credentials are expected. Stage 3 adds them.`
    );

  if (laterStage.size > 0)
    notes.push(
      `The model has content that a later stage owns: ${[...laterStage].join(", ")}. A new Stage 1 model leaves it out; keep it only if the model already had it.`
    );

  let published = false;

  if (problems.length === 0) {
    notes.push(writeOrigin(file, { stage: "model" }));
    const result = publishRun(dir);

    if (!result.ok) problems.push(result.message);
    else notes.push(result.message);
    published = result.published;
  }

  for (const note of notes) console.log(`Note: ${note}`);

  if (problems.length === 0) {
    console.log(
      `Problems: none\nNext: the model passes the Stage 1 checks${published ? " and is published in .radius/" : ""}. Describe it to the user.`
    );

    return 0;
  }
  console.log(
    `Problems:\n${problems.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}`
  );
  if (fs.existsSync(dir))
    console.log(
      `Staging directory: ${dir}\nNext: fix each problem in ${file}, then run \`model.mjs check ${dir}\` again. To stop, run \`model.mjs abort ${dir}\`.`
    );

  return 1;
}

process.exitCode = main();
