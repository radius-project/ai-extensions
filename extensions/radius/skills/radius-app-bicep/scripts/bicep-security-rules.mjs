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
//   a string or comment, and its codes end where a `//` or `/*` comment starts,
//   even with no space before it. A multiline string ends at the last quote of
//   a run of three or more, so `'''a''''` holds `a'`.
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
import { readFileSync } from "node:fs";
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
  /#(disable-next-line|disable-diagnostics)\b([^\r\n]*)/uy;
const MULTILINE_QUOTE = "'''";
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
const FILE_REFERENCES_REQUEST_ID = 1;
const FILE_REFERENCES_TIMEOUT_MS = 120_000;
const HEADER_SEPARATOR = "\r\n\r\n";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSecurityRule(name) {
  return SECURITY_RULES.includes(name.toLowerCase());
}

// Every value stored under `name`, ignoring case, in key order.
function valuesNamed(object, name) {
  return Object.entries(object)
    .filter(([key]) => key.toLowerCase() === name)
    .map(([, value]) => value);
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

function ruleProblems(rules) {
  const problems = [];
  for (const [name, rule] of Object.entries(rules)) {
    if (!isSecurityRule(name)) continue;
    const setting = `analyzers.core.rules.${name}`;
    if (!isPlainObject(rule)) {
      problems.push(
        `${setting} is not an object, so whether ${name} runs cannot be established`
      );
      continue;
    }
    for (const [key, level] of Object.entries(rule)) {
      if (key.toLowerCase() !== "level") continue;
      const problem = levelProblem(level);
      if (problem !== null) {
        problems.push(`${setting}.${key} ${problem}`);
      }
    }
  }
  return problems;
}

// Each setting in a parsed configuration that keeps a security rule from
// running, or makes it impossible to tell whether it runs. An absent section is
// Bicep's default, and every security rule is enabled at "warning" by default.
export function configurationProblems(config) {
  if (!isPlainObject(config)) {
    return [
      "the configuration is not a JSON object, so whether the security rules run cannot be established"
    ];
  }
  const problems = [];
  for (const analyzers of valuesNamed(config, "analyzers")) {
    if (!isPlainObject(analyzers)) {
      problems.push(
        "analyzers is not an object, so whether the security rules run cannot be established"
      );
      continue;
    }
    for (const core of valuesNamed(analyzers, "core")) {
      if (!isPlainObject(core)) {
        problems.push(
          "analyzers.core is not an object, so whether the security rules run cannot be established"
        );
        continue;
      }
      for (const enabled of valuesNamed(core, "enabled")) {
        if (enabled !== true) {
          problems.push(
            `analyzers.core.enabled is ${JSON.stringify(enabled)}, which ${enabled === false ? "turns off the Bicep linter and every security rule with it" : "is not true, so whether the linter runs cannot be established"}`
          );
        }
      }
      for (const rules of valuesNamed(core, "rules")) {
        if (!isPlainObject(rules)) {
          problems.push(
            "analyzers.core.rules is not an object, so whether the security rules run cannot be established"
          );
          continue;
        }
        problems.push(...ruleProblems(rules));
      }
    }
  }
  return problems;
}

function isLineBreak(character) {
  return character === "\n" || character === "\r";
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

// The index just past a multiline string whose body starts at `start`. It
// closes at the end of the first run of three or more quotes, and the extra
// quotes belong to the string.
function skipMultilineString(source, start) {
  const close = source.indexOf(MULTILINE_QUOTE, start);
  if (close === -1) return source.length;
  let end = close + MULTILINE_QUOTE.length;
  while (source[end] === "'") end += 1;
  return end;
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
  // Brace depth inside each open interpolation, innermost last.
  const interpolations = [];
  let index = 0;
  let lineStart = true;
  const enterString = (start) => {
    const body = scanStringBody(source, start);
    if (body.interpolation) interpolations.push(0);
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
    if (directive !== null) {
      const codes = directive[2].split(/\/[/*]/u, 1)[0];
      const rules = directiveRules(codes);
      if (rules.length > 0) {
        suppressions.push({
          line: source.slice(0, index).split(/\r\n|\r|\n/u).length,
          directive: directive[1],
          rules
        });
      }
      // A comment after the codes is lexed normally, so one that opens a block
      // comment is followed to its end.
      index += directive[0].length - directive[2].length + codes.length;
    } else if (source.startsWith(MULTILINE_QUOTE, index)) {
      index = skipMultilineString(source, index + MULTILINE_QUOTE.length);
    } else if (character === "'") {
      enterString(index + 1);
    } else if (interpolations.length > 0 && character === "{") {
      interpolations[interpolations.length - 1] += 1;
      index += 1;
    } else if (interpolations.length > 0 && character === "}") {
      const depth = interpolations.pop();
      if (depth > 0) {
        interpolations.push(depth - 1);
        index += 1;
      } else {
        enterString(index + 1);
      }
    } else {
      index += 1;
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

// Asks the managed Bicep for the files compiling `app` reads. The server only
// answers while its input is open, so the request is written, the response is
// awaited, and only then is the input closed so the server exits. Resolves with
// `{ filePaths }` or `{ error }`; it never rejects.
export function requestFileReferences(
  bicep,
  app,
  { timeoutMs = FILE_REFERENCES_TIMEOUT_MS } = {}
) {
  return new Promise((resolve) => {
    const chunks = [];
    let stderr = "";
    let response = null;
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(bicep, ["jsonrpc", "--stdio"], {
      cwd: path.dirname(app),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    // A server that answered but did not exit still gave a complete answer.
    timer = setTimeout(() => {
      child.kill();
      finish(
        response ?? {
          error: `Bicep did not list the files the compile reads within ${timeoutMs} ms`
        }
      );
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
    child.on("close", (code, signal) => {
      finish(
        response ?? {
          error:
            stderr.trim() ||
            `Bicep exited with status ${code === null ? "null" : code}${signal ? ` after receiving signal ${signal}` : ""} without listing the files the compile reads`
        }
      );
    });
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
// not be read. A file that has disappeared since Bicep listed it is skipped;
// the compile that follows reports it.
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
    if (bytes === null) continue;
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
        `${file}:${line}: error security-rule-suppressed: #${directive} suppresses ${rules.join(", ")}. ${remedy(file, stagingDir, modelConfig)}`
      );
    }
  }
  return { findings, unavailable: null };
}
