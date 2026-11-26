// Loaded through NODE_OPTIONS into each Node process that the stage skill
// script tests start. The tests make `bicep` and `rad` links to Node, so in a
// process started under one of those names this module answers as that CLI and
// exits before Node runs a script. In any other process it replaces fetch.
// Node answers `bicep --version` itself, with exit code 0, before this module
// loads, which is all that a lookup on PATH needs.
//
// The fake Bicep compiles a file to the result on its `// fake-bicep` line:
// `{"template": <ARM template>, "stderr": ["(line,column) : Warning CODE: ..."]}`.
// The fake rad prints FAKE_RAD_VERSION for `rad version`. Its
// `bicep publish-extension` fails with the message on a `# fake-rad-error: `
// line of the schema, and otherwise writes the call, `["bicep", ...]`, as the
// extension. Fetch answers each URL in FAKE_FETCH_RESPONSES with its body, or
// with its HTTP status when it is a number. Anything else fails the process.

import fs from "node:fs";
import path from "node:path";

const MARKER = "// fake-bicep ";
const RAD_ERROR = "# fake-rad-error: ";

function exit(status, stdout = "", stderr = "") {
  // process.exit can drop buffered writes to a pipe, so write synchronously.
  fs.writeSync(1, stdout);
  fs.writeSync(2, stderr);
  process.exit(status);
}

function lineAfter(file, prefix) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .find((text) => text.startsWith(prefix))
    ?.slice(prefix.length);
}

function build(file) {
  const result = lineAfter(file, MARKER);

  if (result === undefined)
    exit(1, "", `fake bicep: ${file} has no ${MARKER.trim()} line\n`);
  const { template, stderr = [] } = JSON.parse(result);
  const failed = stderr.some((diagnostic) => diagnostic.includes(" : Error "));

  exit(
    failed ? 1 : 0,
    failed ? "" : JSON.stringify(template),
    stderr.map((diagnostic) => `${file}${diagnostic}\n`).join("")
  );
}

function publishExtension(call) {
  const error = lineAfter(call[call.indexOf("--from-file") + 1], RAD_ERROR);

  if (error !== undefined) exit(1, "", `${error}\n`);
  fs.writeFileSync(call[call.indexOf("--target") + 1], JSON.stringify(call));
  exit(0);
}

const tool = path
  .basename(process.argv0)
  .toLowerCase()
  .replace(/\.exe$/u, "");
// Node has already taken the subcommand as a script path and made it absolute.
const command = path.basename(process.argv[1] ?? "");
const args = process.argv.slice(2);

if (tool === "bicep" || tool === "rad") {
  if (tool === "bicep" && command === "build") build(args[0]);

  if (tool === "rad" && command === "version")
    exit(0, process.env.FAKE_RAD_VERSION ?? "");

  if (tool === "rad" && command === "bicep" && args[0] === "publish-extension")
    publishExtension([command, ...args]);
  exit(
    1,
    "",
    `fake ${tool}: unexpected call: ${[command, ...args].join(" ")}\n`
  );
}

const responses = JSON.parse(process.env.FAKE_FETCH_RESPONSES ?? "{}");

globalThis.fetch = async (input) => {
  const url = String(input);

  if (!Object.hasOwn(responses, url))
    exit(99, "", `fake fetch: unexpected request for ${url}\n`);

  const answer = responses[url];

  return typeof answer === "number" ?
      new Response(null, { status: answer })
    : new Response(answer);
};
