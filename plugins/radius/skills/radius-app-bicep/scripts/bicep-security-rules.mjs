// Refuses a compile in which a Bicep security rule cannot run.
//
// These linter rules are the only enforcement for a hardcoded, defaulted, or
// leaked credential in an application model, and Bicep lets its caller turn
// each of them off without leaving a trace in the output: a rule set to "off"
// in bicepconfig.json, or named by a `#disable-next-line` or
// `#disable-diagnostics` directive, simply reports nothing. A clean compile
// then reads exactly like a model with no violation. So the checker establishes
// that the rules ran before it trusts their silence.
//
// Which files take part in the compile is asked of Bicep itself rather than
// re-derived from the source. Bicep lints every local module and import with
// the nearest bicepconfig.json above that file, accepts a module path with any
// extension, and tolerates comments and escapes around the path, so a scanner
// that guessed at those rules would miss the very file a suppression was moved
// into. `bicep jsonrpc`'s `getFileReferences` returns the exact source files
// and configuration files the compile reads.
//
// What follows mirrors Bicep 0.42's observed behavior:
//
// - The configuration is JSON with comments, and duplicate keys resolve to the
//   last occurrence, which is also what JSON.parse does.
// - A rule's level is parsed leniently: case and surrounding whitespace are
//   ignored, and a numeric string such as "0" also means "off". Rather than
//   reproduce that parser, only "warning" and "error" are accepted, because
//   those are the only levels that fail validation — "info" is reported as a
//   SARIF note, which validate-bicep.mjs does not treat as a failure.
// - A directive is recognized only as the first token on its line and outside
//   a string or comment. Its keyword is matched as a prefix, so text may follow
//   it with no space, and its codes are runs of letters, digits, `_`, and `-`
//   separated by whitespace, ending at the first other character. So
//   `#disable-next-linesecure-parameter-default@secure()` suppresses the rule
//   and still compiles. A multiline string ends at the end of the first run of
//   three or more quotes, so `'''a''''` holds `a'`, and one opened with dollar
//   signs, as in `$'''`, interpolates where a run of at least that many dollar
//   signs is followed by `{`.
// - A `//` comment in the configuration ends at a carriage return as well as at
//   a line feed.
// - Sources are decoded by their byte-order mark, so a UTF-16 or UTF-32 file
//   is read the way the compiler reads it.
//
// Bicep lists a file read with loadTextContent() or a similar function among
// the compile's files, and nothing in its answer tells that data from a module.
// Every listed file other than a configuration is therefore read as Bicep
// source. That can only refuse a data file that happens to hold a directive
// naming a security rule; telling data from source by reading the model would
// reintroduce the guesswork that asking Bicep exists to avoid.
//
// Bicep matches configuration keys and directive codes case-sensitively today.
// This module matches them case-insensitively, so a compiler that relaxed
// either would not reopen the gap; the cost is refusing a spelling that Bicep
// would currently ignore.

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const BICEP_CONFIG_FILE = "bicepconfig.json";

// The rules that catch a credential being written into a sensitive property,
// defaulted into the template, declared without @secure(), returned as an
// output, or evaluated in a nested deployment's outer scope. Rules that apply
// only to resource shapes an application model never contains, such as a
// virtual machine's command-to-execute, are deliberately not listed.
export const SECURITY_RULES = Object.freeze([
  "use-secure-value-for-secure-inputs",
  "secure-parameter-default",
  "secure-secrets-in-params",
  "outputs-should-not-contain-secrets",
  "secure-params-in-nested-deploy"
]);

const ENFORCING_LEVELS = new Set(["warning", "error"]);
const SUPPRESSION_DIRECTIVE =
  /#(disable-next-line|disable-diagnostics)([^\r\n]*)/uy;
// Anything that is neither part of a diagnostic code nor whitespace ends a
// directive's codes, exactly as in Bicep. The one difference is whitespace
// other than a space or tab, which Bicep does not accept between codes but
// this reads as a separator; that can only report more codes, never fewer.
const DIRECTIVE_CODES_END = /[^A-Za-z0-9_\-\s]/u;
const MULTILINE_QUOTE = "'''";
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
const FILE_REFERENCES_REQUEST_ID = 1;
const FILE_REFERENCES_TIMEOUT_MS = 120_000;
const FILE_REFERENCES_KILL_GRACE_MS = 5_000;
const HEADER_SEPARATOR = "\r\n\r\n";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSecurityRule(name) {
  return SECURITY_RULES.includes(name.toLowerCase());
}

// Every entry stored under `name`, ignoring case, in key order.
function entriesNamed(object, name) {
  return Object.entries(object).filter(([key]) => key.toLowerCase() === name);
}

function decodeUtf32(bytes, littleEndian) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text = "";
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    const codePoint = view.getUint32(offset, littleEndian);
    text += String.fromCodePoint(codePoint <= 0x10ffff ? codePoint : 0xfffd);
  }
  return text;
}

// Text as the compiler reads it: a byte-order mark selects the encoding, and
// UTF-8 is assumed without one.
export function decodeText(bytes) {
  const [first, second, third, fourth] = bytes;
  if (first === 0xef && second === 0xbb && third === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  if (first === 0xff && second === 0xfe && third === 0 && fourth === 0) {
    return decodeUtf32(bytes.subarray(4), true);
  }
  if (first === 0 && second === 0 && third === 0xfe && fourth === 0xff) {
    return decodeUtf32(bytes.subarray(4), false);
  }
  if (first === 0xff && second === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  if (first === 0xfe && second === 0xff) {
    const units = bytes.subarray(2, bytes.length - (bytes.length % 2));
    return Buffer.from(units).swap16().toString("utf16le");
  }
  return bytes.toString("utf8");
}

// Replaces comments with whitespace outside string literals. Returns null for an
// unterminated block comment, which Bicep also refuses.
function stripJsonComments(text) {
  let output = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const character = text[index];
    if (inString) {
      if (character === "\\") {
        output += text.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (character === '"') inString = false;
      output += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      const end = text.slice(index).search(/[\r\n]/u);
      if (end === -1) break;
      output += " ";
      index += end;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) return null;
      output += " ";
      index = end + 2;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

// The parsed configuration, or why it could not be parsed.
export function parseBicepConfig(text) {
  const json = stripJsonComments(text);
  if (json === null) {
    return { error: "it has an unterminated comment" };
  }
  try {
    return { config: JSON.parse(json) };
  } catch (error) {
    return { error: error.message };
  }
}

function levelProblem(level) {
  if (typeof level !== "string") {
    return `is ${JSON.stringify(level)}, which is not a level`;
  }
  const normalized = level.trim().toLowerCase();
  if (ENFORCING_LEVELS.has(normalized)) return null;
  if (normalized === "off") {
    return `is ${JSON.stringify(level)}, which turns the rule off`;
  }
  if (normalized === "info") {
    return `is ${JSON.stringify(level)}, which reports the rule's findings as notes that do not fail validation`;
  }
  return `is ${JSON.stringify(level)}, which is not a level known to enforce the rule`;
}

const CONFIG_CASE_NOTE =
  "; Bicep matches configuration keys case-sensitively, so this spelling has no effect today, but it is refused anyway because a compiler that matched keys case-insensitively would honor it";

function ruleProblems(rules, prefix, exactPrefix) {
  const problems = [];
  for (const [name, rule] of Object.entries(rules)) {
    if (!isSecurityRule(name)) continue;
    const setting = `${prefix}.${name}`;
    const exactRule = exactPrefix && SECURITY_RULES.includes(name);
    if (!isPlainObject(rule)) {
      problems.push(
        `${setting} is not an object, so whether ${name} runs cannot be established${exactRule ? "" : CONFIG_CASE_NOTE}`
      );
      continue;
    }
    for (const [key, level] of entriesNamed(rule, "level")) {
      const problem = levelProblem(level);
      if (problem !== null) {
        const exact = exactRule && key === "level";
        problems.push(
          `${setting}.${key} ${problem}${exact ? "" : CONFIG_CASE_NOTE}`
        );
      }
    }
  }
  return problems;
}

// Each setting in a parsed configuration that keeps a security rule from
// running, or makes it impossible to tell whether it runs. An absent section is
// Bicep's default, and every security rule is enabled at "warning" by default.
// Each setting is named as it is spelled, and one that only matches when case
// is ignored says that Bicep does not honor it today.
export function configurationProblems(config) {
  if (!isPlainObject(config)) {
    return [
      "the configuration is not a JSON object, so whether the security rules run cannot be established"
    ];
  }
  const problems = [];
  const notObject = (setting, exact) =>
    `${setting} is not an object, so whether the security rules run cannot be established${exact ? "" : CONFIG_CASE_NOTE}`;
  for (const [analyzersKey, analyzers] of entriesNamed(config, "analyzers")) {
    const analyzersExact = analyzersKey === "analyzers";
    if (!isPlainObject(analyzers)) {
      problems.push(notObject(analyzersKey, analyzersExact));
      continue;
    }
    for (const [coreKey, core] of entriesNamed(analyzers, "core")) {
      const corePath = `${analyzersKey}.${coreKey}`;
      const coreExact = analyzersExact && coreKey === "core";
      if (!isPlainObject(core)) {
        problems.push(notObject(corePath, coreExact));
        continue;
      }
      for (const [enabledKey, enabled] of entriesNamed(core, "enabled")) {
        if (enabled !== true) {
          const exact = coreExact && enabledKey === "enabled";
          problems.push(
            `${corePath}.${enabledKey} is ${JSON.stringify(enabled)}, which ${enabled === false ? "turns off the Bicep linter and every security rule with it" : "is not true, so whether the linter runs cannot be established"}${exact ? "" : CONFIG_CASE_NOTE}`
          );
        }
      }
      for (const [rulesKey, rules] of entriesNamed(core, "rules")) {
        const rulesPath = `${corePath}.${rulesKey}`;
        const rulesExact = coreExact && rulesKey === "rules";
        if (!isPlainObject(rules)) {
          problems.push(notObject(rulesPath, rulesExact));
          continue;
        }
        problems.push(...ruleProblems(rules, rulesPath, rulesExact));
      }
    }
  }
  return problems;
}

function isLineBreak(character) {
  return character === "\n" || character === "\r";
}

// The length of the run of `character` starting at `index`.
function runLength(source, index, character) {
  let end = index;
  while (source[end] === character) end += 1;
  return end - index;
}

// Where a single-line string's body stops: after its closing quote, at the
// start of an interpolation, or at the line break or end of text that leaves it
// unterminated, which Bicep reports as an error.
function scanStringBody(source, start) {
  let index = start;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
    } else if (character === "'") {
      return { index: index + 1, interpolation: false };
    } else if (character === "$" && source[index + 1] === "{") {
      return { index: index + 2, interpolation: true };
    } else if (isLineBreak(character)) {
      return { index, interpolation: false };
    } else {
      index += 1;
    }
  }
  return { index: source.length, interpolation: false };
}

// Where a multiline string's body stops: after the run of three or more quotes
// that closes it, whose extra quotes belong to the string, or at the start of
// an interpolation. A string opened with `dollars` dollar signs before its
// quotes, as in `$'''`, interpolates where a run of at least that many dollar
// signs is followed by `{`; one opened without any never does.
function scanMultilineBody(source, start, dollars) {
  let index = start;
  while (index < source.length) {
    const character = source[index];
    if (character === "$") {
      const run = runLength(source, index, "$");
      index += run;
      if (dollars > 0 && run >= dollars && source[index] === "{") {
        return { index: index + 1, interpolation: true };
      }
    } else if (character === "'") {
      const run = runLength(source, index, "'");
      index += run;
      if (run >= MULTILINE_QUOTE.length) {
        return { index, interpolation: false };
      }
    } else {
      index += 1;
    }
  }
  return { index: source.length, interpolation: false };
}

function directiveRules(codes) {
  return codes
    .trim()
    .split(/\s+/u)
    .filter((code) => code !== "" && isSecurityRule(code));
}

// Each directive in a Bicep source that suppresses a security rule, with the
// 1-based line it is on and the security rules it names. The source is walked
// the way Bicep lexes it, so a directive-shaped line inside a string or a
// comment is not one. An interpolation is walked as code.
export function securitySuppressions(source) {
  const suppressions = [];
  // Each open interpolation, innermost last: the string it resumes when it
  // closes, and the depth of object braces opened inside it.
  const interpolations = [];
  let index = 0;
  let lineStart = true;
  const enterString = (start, multiline, dollars) => {
    const body =
      multiline ?
        scanMultilineBody(source, start, dollars)
      : scanStringBody(source, start);
    if (body.interpolation) {
      interpolations.push({ multiline, dollars, depth: 0 });
    }
    index = body.index;
  };
  while (index < source.length) {
    const character = source[index];
    if (isLineBreak(character)) {
      lineStart = true;
      index += 1;
      continue;
    }
    if (character === " " || character === "\t") {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.slice(index).search(/[\r\n]/u);
      index = end === -1 ? source.length : index + end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      lineStart = false;
      continue;
    }
    SUPPRESSION_DIRECTIVE.lastIndex = index;
    const directive = lineStart ? SUPPRESSION_DIRECTIVE.exec(source) : null;
    lineStart = false;
    const dollars = character === "$" ? runLength(source, index, "$") : 0;
    const open = interpolations.at(-1);
    if (directive !== null) {
      const rest = directive[2];
      const end = rest.search(DIRECTIVE_CODES_END);
      const codes = end === -1 ? rest : rest.slice(0, end);
      const rules = directiveRules(codes);
      if (rules.length > 0) {
        suppressions.push({
          line: source.slice(0, index).split(/\r\n|\r|\n/u).length,
          directive: directive[1],
          rules
        });
      }
      // Whatever ends the codes is lexed normally: a comment that opens there
      // is followed to its end, and a decorator is code.
      index += directive[0].length - rest.length + codes.length;
    } else if (source.startsWith(MULTILINE_QUOTE, index + dollars)) {
      enterString(index + dollars + MULTILINE_QUOTE.length, true, dollars);
    } else if (character === "'") {
      enterString(index + 1, false, 0);
    } else if (open !== undefined && character === "{") {
      open.depth += 1;
      index += 1;
    } else if (open !== undefined && character === "}") {
      if (open.depth > 0) {
        open.depth -= 1;
        index += 1;
      } else {
        interpolations.pop();
        enterString(index + 1, open.multiline, open.dollars);
      }
    } else {
      index += Math.max(dollars, 1);
    }
  }
  return suppressions;
}

// The framed JSON-RPC request asking Bicep which files compiling `app` reads.
export function fileReferencesRequest(app) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: FILE_REFERENCES_REQUEST_ID,
    method: "bicep/getFileReferences",
    params: { path: app }
  });
  return `Content-Length: ${Buffer.byteLength(body)}${HEADER_SEPARATOR}${body}`;
}

// The file list from Bicep's framed JSON-RPC output, an error when the response
// cannot be used, or null when the response has not fully arrived yet. Frames
// other than the response, such as notifications, are skipped.
export function parseFileReferencesResponse(output) {
  let rest = output;
  for (;;) {
    const separator = rest.indexOf(HEADER_SEPARATOR);
    if (separator === -1) return null;
    const header = rest.subarray(0, separator).toString("latin1");
    const length = /^Content-Length:[ \t]*(\d+)[ \t]*$/imu.exec(header);
    if (length === null) {
      return { error: "Bicep returned a JSON-RPC frame without a length" };
    }
    const start = separator + HEADER_SEPARATOR.length;
    const end = start + Number(length[1]);
    if (rest.length < end) return null;
    let message;
    try {
      message = JSON.parse(rest.subarray(start, end).toString("utf8"));
    } catch {
      return { error: "Bicep returned a JSON-RPC frame that is not JSON" };
    }
    rest = rest.subarray(end);
    if (!isPlainObject(message) || message.id !== FILE_REFERENCES_REQUEST_ID) {
      continue;
    }
    if (message.error !== undefined) {
      const detail = message.error?.data?.message ?? message.error?.message;
      return {
        error:
          typeof detail === "string" && detail.trim() ?
            detail.trim()
          : "Bicep could not list the files the compile reads"
      };
    }
    const filePaths = message.result?.filePaths;
    if (
      !Array.isArray(filePaths) ||
      !filePaths.every((file) => typeof file === "string" && file !== "")
    ) {
      return { error: "Bicep returned file references in an unexpected shape" };
    }
    return { filePaths };
  }
}

// Whether `filePaths` names `file`. Bicep reports the path it was given, but a
// path spelled through a symlink is compared by the file it resolves to.
function listsFile(filePaths, file) {
  const target = path.resolve(file);
  const resolved = realPath(target);
  return filePaths.some(
    (listed) =>
      path.resolve(listed) === target ||
      (resolved !== null && realPath(listed) === resolved)
  );
}

function realPath(file) {
  try {
    return realpathSync.native(file);
  } catch {
    return null;
  }
}

// Asks the managed Bicep for the files compiling `app` reads, and refuses an
// answer that leaves the model itself out: such a list cannot describe this
// compile, and an empty one would inspect nothing. Resolves with
// `{ filePaths }` or `{ error }`; it never rejects.
export async function requestFileReferences(bicep, app, options) {
  const references = await queryFileReferences(bicep, app, options);
  if (
    references.filePaths !== undefined &&
    !listsFile(references.filePaths, app)
  ) {
    return {
      error: "Bicep did not list the model among the files the compile reads"
    };
  }
  return references;
}

// The server only answers while its input is open, so the request is written,
// the response is awaited, and only then is the input closed so the server
// exits.
//
// Every outcome waits for the process to exit, so nothing is left running with
// the model's directory as its working directory. A server that is still
// running at the timeout is asked to stop, and one that ignores that is killed
// outright after a grace period.
function queryFileReferences(
  bicep,
  app,
  {
    timeoutMs = FILE_REFERENCES_TIMEOUT_MS,
    killGraceMs = FILE_REFERENCES_KILL_GRACE_MS
  } = {}
) {
  return new Promise((resolve) => {
    const chunks = [];
    let stderr = "";
    let response = null;
    let timedOut = false;
    let settled = false;
    let timer;
    let graceTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve(value);
    };
    // A server that answered but did not exit still gave a complete answer.
    const outcome = (code, signal) =>
      response ??
      (timedOut ?
        {
          error: `Bicep did not list the files the compile reads within ${timeoutMs} ms`
        }
      : {
          error:
            stderr.trim() ||
            `Bicep exited with status ${code === null ? "null" : code}${signal ? ` after receiving signal ${signal}` : ""} without listing the files the compile reads`
        });
    const child = spawn(bicep, ["jsonrpc", "--stdio"], {
      cwd: path.dirname(app),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      graceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          stream.destroy();
        }
        finish(outcome(null, null));
      }, killGraceMs);
    }, timeoutMs);
    child.on("error", (error) => finish({ error: error.message }));
    // A server that exits before reading the request closes the pipe; the
    // outcome is reported from the exit instead.
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      if (response !== null) return;
      response = parseFileReferencesResponse(Buffer.concat(chunks));
      if (response !== null) child.stdin.end();
    });
    child.on("close", (code, signal) => finish(outcome(code, signal)));
    child.stdin.write(fileReferencesRequest(app));
  });
}

// A file's bytes, or null when nothing readable is there: absent, or a
// directory. Any other failure is thrown, because a file that exists but cannot
// be read cannot be shown to leave the rules enabled.
export function readFileIfPresent(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    if (ABSENT_CODES.has(error.code)) return null;
    throw error;
  }
}

function isInside(directory, file) {
  const relative = path.relative(directory, file);
  return (
    relative !== "" &&
    relative.split(path.sep)[0] !== ".." &&
    !path.isAbsolute(relative)
  );
}

// What a directive does to the security rules it names. A code spelled in a
// different case is refused like the rest, but Bicep matches codes
// case-sensitively, so saying it suppresses the rule would tell the agent a
// directive worked when it did not.
function suppressionSummary(directive, rules) {
  const exact = rules.filter((rule) => SECURITY_RULES.includes(rule));
  const inexact = rules.filter((rule) => !SECURITY_RULES.includes(rule));
  const sentences = [];
  if (exact.length > 0) {
    sentences.push(`#${directive} suppresses ${exact.join(", ")}.`);
  }
  if (inexact.length > 0) {
    sentences.push(
      `${exact.length > 0 ? "It also names" : `#${directive} names`} ${inexact.join(", ")}, which has no effect today because Bicep matches diagnostic codes case-sensitively, but is refused anyway because a compiler that matched codes case-insensitively would honor it.`
    );
  }
  return sentences.join(" ");
}

function isBicepConfig(file) {
  return path.basename(file).toLowerCase() === BICEP_CONFIG_FILE;
}

// The listed configuration Bicep applies to the staged model itself: the one in
// the nearest directory at or above the staging directory.
function stagedModelConfig(filePaths, stagingDir) {
  let nearest = null;
  for (const file of filePaths) {
    if (!isBicepConfig(file)) continue;
    const directory = path.dirname(file);
    if (directory !== stagingDir && !isInside(directory, stagingDir)) continue;
    if (nearest === null || isInside(path.dirname(nearest), directory)) {
      nearest = file;
    }
  }
  return nearest;
}

const REMEDY =
  "A security rule cannot be turned off or suppressed for a Radius application model: remove this so the rule runs, then fix what it reports in the model itself.";

// What can be done about a finding in `file` depends on whether the run owns
// the file. One outside the staging directory is never edited in place: the
// model inherits the configuration above it only until the run stages its own,
// and a module outside the run is not the run's to change.
function remedy(file, stagingDir, modelConfig) {
  if (stagingDir === null || isInside(stagingDir, file)) return REMEDY;
  if (file === modelConfig) {
    return `${REMEDY} ${file} is outside this modeling run's staging directory, and the staged model inherits it only because the run has no bicepconfig.json of its own: do not edit it in place, but give the run a staged bicepconfig.json without this setting, which takes precedence over it. show-radius-type.mjs writes one.`;
  }
  return `${REMEDY} ${file} belongs to a module outside this modeling run's staging directory, which the run cannot change: do not edit it, and do not try to repair it in the staged bicepconfig.json, which does not apply to that module. Stop referencing the module, or stop and report that it turns off a security rule.`;
}

// Every finding that keeps a security rule from running, among the files Bicep
// reported for the compile, formatted for the checker's output. `unavailable`
// is set, and the findings so far are incomplete, when a file that exists could
// not be read. A listed file that does not exist is a finding rather than
// skipped: Bicep lists a missing loadTextContent() target, which the model can
// repair, and a file that disappeared after the compile read it must not pass
// unchecked.
export function inspectSecurityRules(
  filePaths,
  { stagingDir = null, readFile = readFileIfPresent } = {}
) {
  const findings = [];
  const modelConfig =
    stagingDir === null ? null : stagedModelConfig(filePaths, stagingDir);
  for (const file of new Set(filePaths)) {
    let bytes;
    try {
      bytes = readFile(file);
    } catch (error) {
      return { findings, unavailable: `${file}: ${error.message}` };
    }
    if (bytes === null) {
      findings.push(
        `${file}: error compile-file-missing: Bicep reads this file for the compile, but it does not exist, so whether it disables or suppresses a security rule cannot be established. Add the file or remove the reference to it.`
      );
      continue;
    }
    const text = decodeText(bytes);
    if (isBicepConfig(file)) {
      const parsed = parseBicepConfig(text);
      if (parsed.error !== undefined) {
        findings.push(
          `${file}: error bicep-config-invalid: the Bicep configuration could not be parsed (${parsed.error}), so whether the security rules run cannot be established. Make it valid JSON; comments are allowed and trailing commas are not.`
        );
        continue;
      }
      for (const problem of configurationProblems(parsed.config)) {
        findings.push(
          `${file}: error security-rule-disabled: ${problem}. ${remedy(file, stagingDir, modelConfig)}`
        );
      }
      continue;
    }
    for (const { line, directive, rules } of securitySuppressions(text)) {
      findings.push(
        `${file}:${line}: error security-rule-suppressed: ${suppressionSummary(directive, rules)} ${remedy(file, stagingDir, modelConfig)}`
      );
    }
  }
  return { findings, unavailable: null };
}
