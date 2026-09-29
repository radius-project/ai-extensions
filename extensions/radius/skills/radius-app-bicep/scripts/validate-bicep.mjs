#!/usr/bin/env node

// Compiles a generated application model and reports what Bicep rejected, and
// bounds the repair loop that runs while the model is being authored.
//
// The bound lives here rather than in the skill's prose because prose only binds
// an agent that is already following it, and the agent that loops is the one
// that is not. It applies only to a compile inside a staged modeling run: the
// run directory holds a `run.json` whose lifetime is exactly one run, which is
// the right scope for the counter — one that outlived the run would refuse a
// legitimate fresh run because of a stuck one last week. Compiling a file that
// is not in a staged run has no budget and behaves exactly as it always has.
//
// The repair rules below MUST stay behavior-compatible with
// packages/core/src/modeling/app-staging.ts. They are duplicated here rather
// than imported because this script ships inside the installed plugin, where the
// workspace packages do not exist; app-bicep-check.test.ts asserts the copies
// agree.

import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

const STAGING_RUN_RECORD = "run.json";
// The resolved type contract show-radius-type.mjs stages for this run: a map of
// `<type>@<api-version>` to each envelope property's schema sensitivity. This
// script compiles offline and has no type catalog, and the compiled template
// keeps no trace of which property is sensitive, so the flag can only arrive
// from the run that resolved the schemas. The name must stay in step with the
// copy in show-radius-type.mjs; the built-extension smoke test asserts the two
// packaged scripts agree.
const STAGING_RESOLVED_TYPES = "resolved-types.json";
const RESOLVED_TYPES_CONTRACT_VERSION = 1;
const REPAIR_ATTEMPT_BUDGET = 5;
const REPAIR_COMPILE_LIMIT = REPAIR_ATTEMPT_BUDGET + 1;
const EXIT_SUCCESS = 0;
const EXIT_MODEL_INVALID = 1;
const EXIT_CHECK_UNAVAILABLE = 2;

function repairBudgetSpentMessage(attempts) {
  return (
    `This modeling run has reserved ${attempts} validation attempts, so the limit of ${REPAIR_COMPILE_LIMIT} has been reached. ` +
    "No new validation was run. Abort the staged run: do not write the origin record and do not publish the run. " +
    "Report this exact refusal to the user and say that no application definition was written."
  );
}

const REPEATED_FAILURE_MESSAGE =
  "This is the same compiler failure as the previous attempt, so the last fix " +
  "did not address it. Make a materially different fix rather than varying one " +
  "that has already failed, or use the remaining budget to establish why the " +
  "schema cannot express what the source needs.";

// A missing or unusable repair field reads as "no compiles yet" rather than
// being rejected. Unlike the baseline, an unreadable counter cannot destroy
// anything: the worst case is one extra compile, which is a much better failure
// than refusing to compile a run that is fine.
function parseRepairState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { attempts: 0, fingerprint: null };
  }
  const attempts = value.attempts;
  const fingerprint = value.fingerprint;
  // The two fields are read as one fact, not two. A fingerprint only means
  // "the most recent actionable model failure", so without a usable count there
  // is no earlier attempt for it to describe, and keeping it would report the
  // first compile of the run as a repeat.
  if (
    typeof attempts !== "number" ||
    !Number.isInteger(attempts) ||
    attempts <= 0
  ) {
    return { attempts: 0, fingerprint: null };
  }
  return {
    attempts,
    fingerprint:
      typeof fingerprint === "string" && fingerprint.trim() ?
        fingerprint.trim()
      : null
  };
}

function evaluateRepairAttempt(state) {
  const attempt = state.attempts + 1;
  if (state.attempts >= REPAIR_COMPILE_LIMIT) {
    return {
      verdict: "exhausted",
      allowed: false,
      attempt,
      reason: repairBudgetSpentMessage(state.attempts)
    };
  }
  return { verdict: "allowed", allowed: true, attempt, reason: "" };
}

function nextRepairState(state, fingerprint) {
  return { attempts: state.attempts + 1, fingerprint };
}

function isRepeatedFailure(state, fingerprint) {
  return fingerprint !== null && state.fingerprint === fingerprint;
}

// Reduces compiler output to what is the same failure said twice. Line and
// column numbers shift as the model is edited, absolute paths differ between
// machines, and diagnostics do not come back in a stable order, so all three are
// normalized away; what remains is the set of messages.
function fingerprintCompilerOutput(output) {
  const text = typeof output === "string" ? output : "";
  const lines = text
    .split("\n")
    .map((line) =>
      line
        .replace(/\r/gu, "")
        .replace(/:\d+(?::\d+)?(?=:)/gu, ":")
        .replace(/\bline \d+\b/gu, "line")
        .replace(/\s+/gu, " ")
        .trim()
    )
    .filter((line) => line !== "");
  if (lines.length === 0) return "";
  return [...new Set(lines)].sort().join("\n");
}

// The staged run this compile belongs to, or null when the model is not inside
// one. Only the run record's presence makes a directory a staged run: a plain
// `.radius/app.bicep`, or any other caller, has no budget.
//
// `unusable` marks a record that exists but cannot be trusted to hold a count.
// That is a refusal rather than a free pass: an unreadable counter is
// indistinguishable from a spent one, and guessing "not spent" is exactly the
// guess that lets a stuck run compile forever.
function readRunRecord(app) {
  const file = path.join(path.dirname(app), STAGING_RUN_RECORD);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // A record that is absent means this is not a staged run. A record that
    // exists but cannot be read is a staged run whose bookkeeping is broken.
    if (error.code === "ENOENT") return null;
    return { file, record: null, state: null, unusable: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { file, record: null, state: null, unusable: true };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { file, record: null, state: null, unusable: true };
  }
  return {
    file,
    record: parsed,
    state: parseRepairState(parsed.repair),
    unusable: false
  };
}

// Records the attempt BEFORE the compiler runs, so an attempt that dies partway
// — a crash, a timeout, a cancelled turn — has still been counted. Counting
// afterwards meant an interrupted compile left the budget untouched, so the
// very failure mode the bound exists to stop was the one that disabled it.
//
// Written through a temporary file and renamed into place, because a rename
// within a directory either happens or does not: a process killed mid-write
// cannot leave a truncated record that reads as "no attempts yet" and hands the
// run an unbounded budget.
function reserveAttempt(run, fingerprint) {
  const updated = {
    ...run.record,
    repair: nextRepairState(run.state, fingerprint)
  };
  const temporary = `${run.file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    renameSync(temporary, run.file);
    return "";
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may never have been created; nothing to clean up.
    }
    return error.message;
  }
}

// The single statement for a staged run whose bookkeeping cannot be trusted.
// Refusing here costs a compile that might have succeeded, which is recoverable
// and visible; the alternative silently removes the limit.
function brokenRecordMessage(file, detail) {
  return (
    `The repair budget for this modeling run could not be recorded in ${file}${detail ? `: ${detail}` : ""}. ` +
    "Validation did not run, because a budget that cannot be counted cannot be enforced, " +
    "and an uncounted repair loop is what this limit exists to prevent. " +
    "Abort the staged run: do not retry validation, do not modify the current model, do not start another modeling run, " +
    "do not write the origin record, and do not publish the run. " +
    "Report this exact failure to the user and say that no application definition was written."
  );
}

function isUsableDiagnostic(result) {
  if (!isPlainObject(result) || !isPlainObject(result.message)) {
    return false;
  }

  const hasText =
    typeof result.message.text === "string" &&
    result.message.text.trim() !== "";
  const informational = result.level === "note" || result.level === "none";
  return (
    (result.level === undefined ||
      ["none", "note", "warning", "error"].includes(result.level)) &&
    (result.ruleId === undefined || typeof result.ruleId === "string") &&
    (hasText ||
      (informational &&
        ((typeof result.message.markdown === "string" &&
          result.message.markdown.trim() !== "") ||
          (typeof result.message.id === "string" &&
            result.message.id.trim() !== ""))))
  );
}

function diagnostics(output) {
  try {
    const runs = JSON.parse(output).runs;
    if (!Array.isArray(runs) || runs.length === 0) {
      return null;
    }

    const results = [];
    for (const run of runs) {
      if (run === null || typeof run !== "object" || Array.isArray(run)) {
        return null;
      }
      const runResults = run.results === undefined ? [] : run.results;
      if (!Array.isArray(runResults)) {
        return null;
      }
      results.push(...runResults);
    }
    if (!results.every(isUsableDiagnostic)) {
      return null;
    }
    return results;
  } catch {
    return null;
  }
}

// Every message this run reported, so a failure can be fingerprinted and
// compared with the previous attempt's.
const reported = [];

function report(message) {
  reported.push(message);
  console.error(message);
}

// What to write instead, for the diagnostics that have one correct answer.
//
// Bicep says what is wrong but not what to replace it with, and the linter
// findings below carry no SARIF `level`, so they print as "warning" while
// `isFailure` still fails the build. A model that reads one as advice spends
// repair attempts rediscovering a rule the schema already stated, so the remedy
// travels on the line that reports the problem.
//
// The secure-value wording is deliberately exact about what Bicep accepts: a
// `@secure()` parameter referenced by name, directly or through a variable that
// aliases it, stays secure, while any interpolation loses secureness even when
// every operand is secure. Saying "use a variable" or "never use a variable"
// would both send the model at a fix that does not compile.
//
// It is also careful about what it claims to know. These hints key on the rule
// Bicep reported, not on the staged schema, so the remedy describes the
// compiled type's own annotation and names `x-radius-sensitive` only as what
// produces it for a Radius type. Asserting the schema flag outright would state
// a fact this function never checked, and would misattribute the cause for any
// secure-annotated type that does not derive it from `x-radius-sensitive`.
function repairHint(ruleId, text) {
  if (ruleId === "BCP037" && /\bcodeReference\b/u.test(text)) {
    return " For a Radius.Resources custom type, add the optional codeReference string property to custom-types.yaml and republish custom-types.tgz before compiling again.";
  }
  if (ruleId === "use-secure-value-for-secure-inputs") {
    return " The compiled type marks this property secure — for a Radius type, from x-radius-sensitive in its schema — so it takes the value of a @secure() parameter referenced by name. A literal, a parameter declared without @secure(), and any string interpolation — including one whose operands are all secure — are not secure values. Declare a @secure() parameter and assign it directly. A value that must combine the credential with other parts, such as a connection string, cannot be assembled here: bind the parts separately and compose them only through a path the pinned application source proves it supports, and report the contract gap when it supports none.";
  }
  if (ruleId === "secure-secrets-in-params") {
    return " This rule reads the parameter's name, not its value, so it has two different repairs. If the parameter carries the credential itself, add the @secure() decorator. If it carries the resource ID of a Radius.Security/secrets resource, rename it instead — adding @secure() there only trades this finding for a secure-parameter-target failure, because a reference property is not sensitive and must not receive a secure parameter.";
  }
  if (ruleId === "secure-parameter-default") {
    return " Remove the default value: a @secure() parameter is supplied at deployment time, and a default would commit the credential to the application definition.";
  }
  return "";
}

function printDiagnostic(result) {
  const physical = result.locations?.[0]?.physicalLocation;
  const source = physical?.artifactLocation?.uri;
  const region = physical?.region;
  const line = region?.startLine;
  // Bicep 0.42.1, 0.44.1, and 0.47.16 put the 1-based display column in `charOffset`
  // instead of SARIF's `startColumn`. Prefer the standard field when present.
  const column = region?.startColumn ?? region?.charOffset;
  const hasLine = Number.isSafeInteger(line) && line > 0;
  const hasColumn = Number.isSafeInteger(column) && column > 0;
  let location = "";
  if (typeof source === "string") {
    location = `${source}${hasLine ? `:${line}` : ""}`;
    if (hasLine && hasColumn) {
      location += `:${column}`;
    }
  } else if (hasLine) {
    location = `line ${line}`;
  }
  const level = typeof result.level === "string" ? result.level : "warning";
  const rule =
    typeof result.ruleId === "string" && result.ruleId ?
      ` ${result.ruleId}`
    : "";
  const text =
    typeof result.message?.text === "string" && result.message.text ?
      result.message.text
    : "Bicep reported a diagnostic.";
  report(
    `${location ? `${location}: ` : ""}${level}${rule}: ${text}${repairHint(result.ruleId, text)}`
  );
}

function isFailure(result) {
  return result.level !== "note" && result.level !== "none";
}

function parameterValue(name, template, parameterValues) {
  if (parameterValues.has(name)) {
    return parameterValues.get(name);
  }
  const defaultValue = template.parameters?.[name]?.defaultValue;
  return typeof defaultValue === "string" ? defaultValue : null;
}

function resolveTemplateString(value, template, parameterValues) {
  if (typeof value !== "string") {
    return null;
  }
  const parameter = /^\[parameters\('([^']+)'\)\]$/u.exec(value);
  if (parameter !== null) {
    return parameterValue(parameter[1], template, parameterValues);
  }
  const formattedParameter =
    /^\[format\('([^']*\{0\}[^']*)', parameters\('([^']+)'\)\)\]$/u.exec(value);
  if (formattedParameter === null) {
    return value;
  }
  const replacement = parameterValue(
    formattedParameter[2],
    template,
    parameterValues
  );
  return replacement === null ? null : (
      formattedParameter[1].replace("{0}", replacement)
    );
}

function buildSourceRef(source) {
  const question = source.indexOf("?");
  if (question < 0) {
    return "";
  }
  const query = source.slice(question + 1).split("#", 1)[0];
  return new URLSearchParams(query).get("ref") ?? "";
}

function isAbbreviatedCommitRef(ref) {
  // Git's automatic abbreviation uses at least seven characters. A seven-digit
  // ref can still be a SHA, while eight-digit date tags should remain valid.
  return (
    /^[0-9a-f]{7,39}$/iu.test(ref) && (/[a-f]/iu.test(ref) || ref.length === 7)
  );
}

function checkContainerImageBuildSources(
  template,
  app,
  parentPath = "",
  parameterValues = new Map()
) {
  let failed = false;
  for (const [symbol, resource] of Object.entries(template.resources ?? {})) {
    const resourcePath = parentPath ? `${parentPath}.${symbol}` : symbol;
    if (resource?.type === "Microsoft.Resources/deployments") {
      const nestedTemplate = resource?.properties?.template;
      if (
        nestedTemplate !== null &&
        typeof nestedTemplate === "object" &&
        !Array.isArray(nestedTemplate)
      ) {
        const nestedParameterValues = new Map();
        for (const [name, argument] of Object.entries(
          resource?.properties?.parameters ?? {}
        )) {
          nestedParameterValues.set(
            name,
            resolveTemplateString(argument?.value, template, parameterValues)
          );
        }
        if (
          checkContainerImageBuildSources(
            nestedTemplate,
            app,
            resourcePath,
            nestedParameterValues
          )
        ) {
          failed = true;
        }
      }
      continue;
    }

    if (
      typeof resource?.type !== "string" ||
      !resource.type.startsWith("Radius.Compute/containerImages@")
    ) {
      continue;
    }

    const source = resolveTemplateString(
      resource?.properties?.properties?.build?.source,
      template,
      parameterValues
    );
    if (typeof source !== "string" || source.startsWith("[")) {
      continue;
    }

    const ref = buildSourceRef(source);
    if (!isAbbreviatedCommitRef(ref)) {
      continue;
    }

    report(
      `${app}: error container-image-build-source: ${resourcePath}.properties.build.source: build ref "${ref}" looks like an abbreviated commit SHA; use the full 40-character SHA or an explicit tag ref such as "refs/tags/v1.2.3".`
    );
    failed = true;
  }
  return failed;
}

// A container's codeReference must lead to the code the workload runs. These
// packaging files describe how it is built or deployed instead, so they render a
// link that answers the wrong question. Kept in step with the "Always skip" list
// in ../references/source-code-references.md.
const packagingBasenamePatterns = [
  /^dockerfile$/u,
  /^dockerfile\..+$/u,
  /^.+\.dockerfile$/u,
  /^docker-compose.*\.ya?ml$/u,
  /^compose.*\.ya?ml$/u,
  /^chart\.ya?ml$/u,
  /^values\.ya?ml$/u
];

// Decodes each path segment on its own so one malformed escape sequence degrades
// to that segment's raw text instead of discarding the whole pathname.
function decodePathname(pathname) {
  return pathname
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

// Reduces either authored form -- a repo-relative worktree path or a GitHub blob
// URL -- to the file's basename, so one list covers both.
function sourceLocationBasename(codeReference) {
  if (typeof codeReference !== "string") {
    return "";
  }
  let location = codeReference.replace(/#L[1-9]\d*$/u, "");
  if (/^https:\/\//iu.test(location)) {
    try {
      const { pathname } = new URL(location);
      // `pathname` stays percent-encoded, and the host resolves the escapes, so
      // "Docker%66ile" would otherwise slip past a literal basename comparison.
      // A malformed escape falls back to the raw pathname rather than giving up,
      // so a bad sequence elsewhere in the path cannot reopen the bypass.
      location = decodePathname(pathname);
    } catch {
      return "";
    }
  }
  const segments = location.split("/").filter((segment) => segment !== "");
  return segments.length === 0 ?
      ""
    : segments[segments.length - 1].toLowerCase();
}

function isPackagingSourceLocation(codeReference) {
  const basename = sourceLocationBasename(codeReference);
  return (
    basename !== "" &&
    packagingBasenamePatterns.some((pattern) => pattern.test(basename))
  );
}

function checkSourceCodeReferences(
  template,
  app,
  parentPath = "",
  parameterValues = new Map()
) {
  let failed = false;
  for (const [symbol, resource] of Object.entries(template.resources ?? {})) {
    const resourcePath = parentPath ? `${parentPath}.${symbol}` : symbol;
    if (resource?.type === "Microsoft.Resources/deployments") {
      const nestedTemplate = resource?.properties?.template;
      if (
        nestedTemplate !== null &&
        typeof nestedTemplate === "object" &&
        !Array.isArray(nestedTemplate)
      ) {
        const nestedParameterValues = new Map();
        for (const [name, argument] of Object.entries(
          resource?.properties?.parameters ?? {}
        )) {
          nestedParameterValues.set(
            name,
            resolveTemplateString(argument?.value, template, parameterValues)
          );
        }
        if (
          checkSourceCodeReferences(
            nestedTemplate,
            app,
            resourcePath,
            nestedParameterValues
          )
        ) {
          failed = true;
        }
      }
      continue;
    }
    if (
      typeof resource?.type !== "string" ||
      !resource.type.startsWith("Radius.") ||
      resource.type.startsWith("Radius.Core/applications@")
    ) {
      continue;
    }

    const rawCodeReference = resource?.properties?.properties?.codeReference;
    const customTypeHint =
      resource.type.startsWith("Radius.Resources/") ?
        " If this custom type predates the source-reference contract, add the optional codeReference string property to custom-types.yaml and republish custom-types.tgz."
      : "";
    if (typeof rawCodeReference !== "string" || !rawCodeReference.trim()) {
      report(
        `${app}: error source-code-reference: ${resourcePath}.properties.codeReference: every non-application Radius resource must store its verified worktree path or GitHub branch/file URL in app.bicep.${customTypeHint}`
      );
      failed = true;
      continue;
    }
    const codeReference = resolveTemplateString(
      rawCodeReference,
      template,
      parameterValues
    );
    const sourceLocationPattern =
      /^(?!\.{1,2}(?:\/|$))(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000-\u001f\u007f#]+(?:#L[1-9]\d*)?$/u;
    const githubSource = (() => {
      if (typeof codeReference !== "string") {
        return false;
      }
      try {
        const parsed = new URL(codeReference);
        const segments = parsed.pathname
          .split("/")
          .filter((segment) => segment !== "");
        return (
          parsed.protocol === "https:" &&
          parsed.hostname.toLowerCase() === "github.com" &&
          !parsed.username &&
          !parsed.password &&
          !parsed.port &&
          !parsed.search &&
          segments.length >= 5 &&
          segments[2] === "blob" &&
          (parsed.hash === "" || /^#L[1-9]\d*$/u.test(parsed.hash))
        );
      } catch {
        return false;
      }
    })();
    if (
      typeof codeReference !== "string" ||
      codeReference !== codeReference.trim() ||
      /[\u0000-\u001f\u007f]/u.test(codeReference) ||
      codeReference.startsWith("[") ||
      (!githubSource &&
        (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(codeReference) ||
          codeReference.startsWith("/") ||
          codeReference.includes("\\") ||
          !sourceLocationPattern.test(codeReference)))
    ) {
      // An unresolved compiled ARM expression begins with "[". It is not a
      // durable path and would render as a dead source link, so reject it along
      // with malformed literal values.
      report(
        `${app}: error source-code-reference: ${resourcePath}.properties.codeReference: ${JSON.stringify(rawCodeReference)} must resolve to a repo-relative worktree path using forward slashes or an exact https://github.com/<owner>/<repo>/blob/<branch>/<file> URL, optionally followed by #L<line>.${customTypeHint}`
      );
      failed = true;
      continue;
    }

    // containerImages is deliberately exempt: a Dockerfile is that resource's
    // definition site, while for the workload that runs the image it is only
    // packaging.
    if (
      resource.type.startsWith("Radius.Compute/containers@") &&
      isPackagingSourceLocation(codeReference)
    ) {
      report(
        `${app}: error source-code-reference: ${resourcePath}.properties.codeReference: ${JSON.stringify(rawCodeReference)} is a packaging file; point a container at the entrypoint of the process it runs, resolved from its command/args or through the image's Dockerfile.`
      );
      failed = true;
    }
  }
  return failed;
}

// Kubernetes substitutes `$(NAME)` in a container environment value only from
// variables earlier in the container's environment list, and the containers
// recipe builds that list with `items()`, which sorts by key. So authoring
// order in the `env` map decides nothing, and a plain value that reads another
// plain value whose key does not sort before it is never substituted: the
// workload receives the literal `$(NAME)` text and fails at runtime with a
// value that looks deliberate. That is worth catching here, because the model
// compiles and deploys either way.
//
// Only the case the compiled template proves is reported. A `secretKeyRef`
// variable is emitted ahead of every plain value by that recipe whatever it is
// called, and a name that is not in this `env` map at all may come from the
// image, the platform, or connection projection. Neither can be judged from the
// template, so neither is flagged — this check has no opinion it cannot support.
// The reference grammar the kubelet actually applies: everything between `$(`
// and the first `)` is the name, whatever it contains, because
// tryReadVariableName scans to the closer rather than matching an identifier.
// Kubernetes environment names are wider than C identifiers too (`.` and `-`
// are valid), and Radius does not restrict `env` keys at all, so a narrower
// pattern here would skip `$(DB.PASSWORD)` and let exactly the failure this
// check exists to catch through. Matching the closer keeps the two in step; a
// name that is not a modeled variable is filtered later by `plainValues`.
const RUNTIME_VARIABLE_PATTERN = /(\$*)\$\(([^)]*)\)/gu;

function expandedVariableNames(value) {
  // A name repeated in one value is one fact about that value, so it is
  // reported once rather than once per occurrence.
  const names = new Set();
  for (const match of value.matchAll(RUNTIME_VARIABLE_PATTERN)) {
    // Kubernetes collapses `$$` to a literal `$`, so `$$(NAME)` is text rather
    // than an expansion. An odd number of leading `$` leaves one unpaired to
    // open the expansion; an even number does not.
    if (match[1].length % 2 === 0) {
      names.add(match[2]);
    }
  }
  return names;
}

// Whether `referenced` is emitted at or after `name`, and therefore cannot be
// substituted into it. The recipe sorts with `items()`, so this asks where the
// two keys fall in that sort — but the check fails a build, so it answers only
// when the answer does not depend on how the sort treats letter case. Ordinary
// environment names settle it either way; a pair that disagrees stays silent
// rather than risk rejecting a model that would have deployed.
function emittedAtOrAfter(referenced, name) {
  if (referenced === name) {
    return true;
  }
  return (
    referenced > name &&
    referenced.toUpperCase() > name.toUpperCase() &&
    referenced.toLowerCase() > name.toLowerCase()
  );
}

function emittedBefore(referenced, name) {
  return (
    referenced < name &&
    referenced.toUpperCase() < name.toUpperCase() &&
    referenced.toLowerCase() < name.toLowerCase()
  );
}

function plainEnvironmentValues(env) {
  const values = new Map();
  for (const [name, entry] of Object.entries(env)) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      "value" in entry
    ) {
      values.set(name, entry.value);
    }
  }
  return values;
}

// Any expression whose outermost call is reference(...) and whose result is
// .properties.secrets.name is a managed Secret name. The argument may select a
// literal resource or a loop instance through format(...). Expressions wrapped
// in another operation remain outside this deliberately narrow match.
//
// This assumes the predefined Radius producer semantics documented by the
// skill. A future expression parser could identify a direct producer's type and
// distinguish custom Radius.Resources/* properties without broadening this rule.
const MANAGED_SECRET_NAME_REFERENCE =
  /^\[reference\(.+\)\.properties\.secrets\.name\]$/u;

// resolveTemplateString follows whole string parameters and the one supported
// format pass-through. It deliberately does not trace object properties, module
// outputs, variables, or general ARM expression data flow.
function checkConnectionSources(
  template,
  app,
  parentPath = "",
  parameterValues = new Map()
) {
  let failed = false;
  for (const [symbol, resource] of Object.entries(template.resources ?? {})) {
    const resourcePath = parentPath ? `${parentPath}.${symbol}` : symbol;
    if (resource?.type === "Microsoft.Resources/deployments") {
      const nestedTemplate = resource?.properties?.template;
      if (isPlainObject(nestedTemplate)) {
        const nestedParameterValues = new Map();
        for (const [name, argument] of Object.entries(
          resource?.properties?.parameters ?? {}
        )) {
          nestedParameterValues.set(
            name,
            resolveTemplateString(argument?.value, template, parameterValues)
          );
        }
        if (
          checkConnectionSources(
            nestedTemplate,
            app,
            resourcePath,
            nestedParameterValues
          )
        ) {
          failed = true;
        }
      }
      continue;
    }
    // #676 is scoped to the container connection projection that consumes
    // producer IDs. Other Radius resource types remain outside this check.
    if (
      typeof resource?.type !== "string" ||
      !resource.type.startsWith("Radius.Compute/containers@")
    ) {
      continue;
    }
    const connections = resource?.properties?.properties?.connections;
    if (!isPlainObject(connections)) {
      continue;
    }
    for (const [name, connection] of Object.entries(connections)) {
      if (!isPlainObject(connection)) {
        continue;
      }
      const source = resolveTemplateString(
        connection.source,
        template,
        parameterValues
      );
      if (
        typeof source !== "string" ||
        !MANAGED_SECRET_NAME_REFERENCE.test(source)
      ) {
        continue;
      }
      report(
        `${app}: error connection-source: ${resourcePath}.properties.connections.${name}.source: this Radius container connection uses a managed Kubernetes Secret name; use the producer resource ID (<producer>.id) as the connection source instead. Use <producer>.properties.secrets.name only as valueFrom.secretKeyRef.secretName for an explicit Kubernetes environment binding.`
      );
      failed = true;
    }
  }
  return failed;
}

function checkRuntimeVariableExpansion(
  template,
  app,
  parentPath = "",
  parameterValues = new Map()
) {
  let failed = false;
  for (const [symbol, resource] of Object.entries(template.resources ?? {})) {
    const resourcePath = parentPath ? `${parentPath}.${symbol}` : symbol;
    if (resource?.type === "Microsoft.Resources/deployments") {
      const nestedTemplate = resource?.properties?.template;
      if (
        nestedTemplate !== null &&
        typeof nestedTemplate === "object" &&
        !Array.isArray(nestedTemplate)
      ) {
        const nestedParameterValues = new Map();
        for (const [name, argument] of Object.entries(
          resource?.properties?.parameters ?? {}
        )) {
          nestedParameterValues.set(
            name,
            resolveTemplateString(argument?.value, template, parameterValues)
          );
        }
        if (
          checkRuntimeVariableExpansion(
            nestedTemplate,
            app,
            resourcePath,
            nestedParameterValues
          )
        ) {
          failed = true;
        }
      }
      continue;
    }
    if (
      typeof resource?.type !== "string" ||
      !resource.type.startsWith("Radius.Compute/containers@")
    ) {
      continue;
    }
    const containers = resource?.properties?.properties?.containers;
    if (
      containers === null ||
      typeof containers !== "object" ||
      Array.isArray(containers)
    ) {
      continue;
    }
    for (const [containerKey, container] of Object.entries(containers)) {
      const env = container?.env;
      if (env === null || typeof env !== "object" || Array.isArray(env)) {
        continue;
      }
      const plainValues = plainEnvironmentValues(env);
      for (const [name, rawValue] of plainValues) {
        const value = resolveTemplateString(
          rawValue,
          template,
          parameterValues
        );
        if (typeof value !== "string") {
          continue;
        }
        for (const referenced of expandedVariableNames(value)) {
          // Not a plain value in this container: emitted ahead of every plain
          // value, or supplied from outside the template. Nothing to prove.
          if (!plainValues.has(referenced)) {
            continue;
          }
          if (!emittedAtOrAfter(referenced, name)) {
            continue;
          }
          const advice =
            referenced === name ?
              "a variable cannot read itself"
            : `bind it with valueFrom.secretKeyRef, which the Kubernetes Container Recipe emits ahead of every plain value, using an authored or reused Secret for a developer-supplied credential or the declared Recipe secret for a Recipe-generated credential. A verified compatible Kubernetes Secret connection can provide a secret-backed generated variable instead. If an explicit schema-supported or legacy @secure() env.value fallback must stay plain, its key must sort before ${JSON.stringify(name)} — report the conflict when the application dictates both names`;
          report(
            `${app}: error runtime-variable: ${resourcePath}.properties.containers.${containerKey}.env.${name}: reads $(${referenced}), which the containers recipe emits at or after it, so it is never substituted; ${advice}.`
          );
          failed = true;
        }
      }
    }
  }
  return failed;
}

// A Recipe-managed secret key can name an aggregate representation while an
// app-native variable names one of its parts. Those values are both strings, so
// Bicep accepts the assignment even though the application parser receives the
// wrong syntax. The source-reading rules remain authoritative; this check is a
// conservative backstop for the contradiction the compiled model itself proves.
//
// It intentionally applies only to a `properties.secrets.name` reference. An
// authored Secret may use any key chosen to match the application contract, so
// its key name alone says nothing about the value's representation.
const MANAGED_SECRET_REFERENCE =
  /^\[reference\('([^']+)'(?:,[^)]*)?\)\.properties\.secrets\.name\]$/u;
const AGGREGATE_SECRET_KEYS = new Set([
  "connectionstring",
  "dsn",
  "uri",
  "url"
]);
// Both vocabularies are deliberately exact and conservative. They do not infer
// embedded words such as `primaryConnectionString` or undelimited names such as
// `REDISADDR`; adding one requires evidence that it identifies the same contract
// across generated models rather than merely containing a familiar substring.
const ADDRESS_PART_TOKENS = new Set([
  "addr",
  "address",
  "host",
  "hostname",
  "port"
]);

function configurationNameTokens(name) {
  if (typeof name !== "string") {
    return [];
  }
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token !== "");
}

function managedAggregateSecretFinding(entry, template, parameterValues) {
  if (!isPlainObject(entry) || !isPlainObject(entry.valueFrom)) {
    return null;
  }
  const reference = entry.valueFrom.secretKeyRef;
  if (!isPlainObject(reference)) {
    return null;
  }
  const secretName = resolveTemplateString(
    reference.secretName,
    template,
    parameterValues
  );
  const key = resolveTemplateString(reference.key, template, parameterValues);
  if (
    typeof secretName !== "string" ||
    MANAGED_SECRET_REFERENCE.exec(secretName) === null ||
    typeof key !== "string"
  ) {
    return null;
  }
  const secretKey = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (!AGGREGATE_SECRET_KEYS.has(secretKey)) {
    return null;
  }
  return {
    key,
    secretName
  };
}

function managedAggregateSecretSource(
  name,
  env,
  template,
  parameterValues,
  visited = new Set()
) {
  if (visited.has(name)) {
    return null;
  }
  const entry = env[name];
  const direct = managedAggregateSecretFinding(
    entry,
    template,
    parameterValues
  );
  if (direct !== null) {
    return { ...direct, helpers: [], passThrough: true };
  }
  if (!isPlainObject(entry) || !("value" in entry)) {
    return null;
  }
  const value = resolveTemplateString(entry.value, template, parameterValues);
  if (typeof value !== "string") {
    return null;
  }
  const nextVisited = new Set(visited);
  nextVisited.add(name);
  for (const helper of expandedVariableNames(value)) {
    const helperEntry = env[helper];
    if (
      isPlainObject(helperEntry) &&
      "value" in helperEntry &&
      !emittedBefore(helper, name)
    ) {
      continue;
    }
    const finding = managedAggregateSecretSource(
      helper,
      env,
      template,
      parameterValues,
      nextVisited
    );
    if (finding !== null) {
      return {
        ...finding,
        helpers: [helper, ...finding.helpers],
        passThrough: finding.passThrough && value.trim() === `$(${helper})`
      };
    }
  }
  return null;
}

function aggregateSecretAliasFinding(name, env, template, parameterValues) {
  const targetTokens = configurationNameTokens(name);
  if (!targetTokens.some((token) => ADDRESS_PART_TOKENS.has(token))) {
    return null;
  }
  return managedAggregateSecretSource(name, env, template, parameterValues);
}

function checkAggregateSecretAliases(
  template,
  app,
  parentPath = "",
  parameterValues = new Map()
) {
  let failed = false;
  for (const [symbol, resource] of Object.entries(template.resources ?? {})) {
    const resourcePath = parentPath ? `${parentPath}.${symbol}` : symbol;
    if (resource?.type === "Microsoft.Resources/deployments") {
      const nestedTemplate = resource?.properties?.template;
      if (isPlainObject(nestedTemplate)) {
        const nestedParameterValues = new Map();
        for (const [name, argument] of Object.entries(
          resource?.properties?.parameters ?? {}
        )) {
          nestedParameterValues.set(
            name,
            resolveTemplateString(argument?.value, template, parameterValues)
          );
        }
        if (
          checkAggregateSecretAliases(
            nestedTemplate,
            app,
            resourcePath,
            nestedParameterValues
          )
        ) {
          failed = true;
        }
      }
      continue;
    }
    if (
      typeof resource?.type !== "string" ||
      !resource.type.startsWith("Radius.Compute/containers@")
    ) {
      continue;
    }
    const containers = resource?.properties?.properties?.containers;
    if (!isPlainObject(containers)) {
      continue;
    }
    for (const [containerKey, container] of Object.entries(containers)) {
      if (!isPlainObject(container) || !isPlainObject(container.env)) {
        continue;
      }
      for (const name of Object.keys(container.env)) {
        const finding = aggregateSecretAliasFinding(
          name,
          container.env,
          template,
          parameterValues
        );
        if (finding === null) {
          continue;
        }
        const binding =
          finding.helpers.length === 0 ?
            ""
          : ` through helper chain ${finding.helpers.map((helper) => JSON.stringify(helper)).join(" -> ")}`;
        const transformationAdvice =
          finding.passThrough ?
            "A pass-through helper does not convert the value."
          : "Embedding the aggregate in a larger value does not prove that the resulting syntax is compatible.";
        report(
          `${app}: error aggregate-secret-alias: ${resourcePath}.properties.containers.${containerKey}.env.${name}: Recipe-managed secret key ${JSON.stringify(finding.key)} is an aggregate value${binding}, but ${JSON.stringify(name)} names an address part. The model cannot establish that the application parser accepts the aggregate syntax. Trace the setting through checked-in source and either bind a matching aggregate input, perform a real runtime transformation from schema-declared parts, or stop without publishing the model. ${transformationAdvice} If the fixed address-shaped name itself accepts the aggregate syntax, use another source-supported aggregate input or report this conservative checker limitation rather than renaming either side.`
        );
        failed = true;
      }
    }
  }
  return failed;
}

// Two Radius types can name a property `password` and mean opposite things.
// `Radius.Data/mySqlDatabases.password` is marked sensitive and takes the
// credential itself; `Radius.Messaging/rabbitMQ.password` is a plain string that
// takes the resource ID of a `Radius.Security/secrets` resource. Assigning a
// `@secure()` parameter to the second one compiles and deploys, and then fails
// in the cluster: the Recipe takes the last path segment of that value as the
// Kubernetes Secret name for `secretKeyRef`, so the password becomes a Secret
// name and Kubernetes rejects the Deployment because it is not a lowercase RFC
// 1123 subdomain.
//
// The only sound discriminator is the schema's sensitivity flag. A rule keyed on
// the property's name, or one that objected to any secure parameter reaching any
// resource, would reject the prescribed `mySqlDatabases` spelling, which is the
// correct way to supply that credential. So this check asks the run's staged
// resolved types, and reports nothing it cannot support with that evidence.
//
// What it inspects is exactly one shape: a property of a Radius resource's
// properties envelope whose compiled value is a whole reference to a
// `securestring` parameter of the template that declares it. A credential that
// arrives through a variable, a string interpolation, or a nested object is not
// this shape and is not reported, because the template no longer proves where
// the value came from. `securestring` also keeps the check to the string
// credentials the guidance prescribes: a `@secure()` object compiles to
// `secureObject` and legitimately carries a Secret's whole `data` map, whose
// enclosing property is not itself marked sensitive.
const SECURE_PARAMETER_REFERENCE = /^\[parameters\('([^']+)'\)\]$/u;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The staged resolved types, or why they cannot be used. `unstaged` is a compile
// that is not part of a modeling run at all, which is the same thing the repair
// budget does with a missing run record: a plain `.radius/app.bicep` never had a
// staged contract to consult, so there is nothing to enforce against it.
function readResolvedTypes(app, staged) {
  const file = path.join(path.dirname(app), STAGING_RESOLVED_TYPES);
  if (!staged) {
    return { status: "unstaged", file, types: {} };
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { status: "absent", file, types: {} };
    }
    return { status: "unusable", file, types: {}, detail: error.message };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      status: "unusable",
      file,
      types: {},
      detail: "it is not valid JSON"
    };
  }
  if (
    !isPlainObject(parsed) ||
    parsed.contractVersion !== RESOLVED_TYPES_CONTRACT_VERSION ||
    !isPlainObject(parsed.types)
  ) {
    return {
      status: "unusable",
      file,
      types: {},
      detail: `it is not a version ${RESOLVED_TYPES_CONTRACT_VERSION} resolved-type contract`
    };
  }
  for (const [type, entry] of Object.entries(parsed.types)) {
    if (
      !isPlainObject(entry) ||
      Object.values(entry).some((sensitive) => typeof sensitive !== "boolean")
    ) {
      return {
        status: "unusable",
        file,
        types: {},
        detail: `"${type}" does not map each property to a boolean`
      };
    }
  }
  return { status: "ready", file, types: parsed.types };
}

function secureParameterNames(template) {
  const names = new Set();
  for (const [name, declaration] of Object.entries(template.parameters ?? {})) {
    if (isPlainObject(declaration) && declaration.type === "securestring") {
      names.add(name);
    }
  }
  return names;
}

// What is wrong with assigning `parameter` to `type`.`property`, or null when
// nothing is. Every branch that is not "the schema marks it sensitive" reports,
// because the alternative is to treat an unknown property as sensitive, which is
// exactly the assumption that shipped the broken model.
function secureTargetFinding(contract, type, property, parameter) {
  const lead = `parameter ${JSON.stringify(parameter)} is @secure()`;
  if (contract.status === "absent") {
    return (
      `${lead}, but this modeling run staged no resolved type schemas, so no property's sensitivity could be checked. ` +
      "Resolve every predefined type the model uses with show-radius-type.mjs before assigning a credential to one of its properties."
    );
  }
  const entry = contract.types[type];
  if (entry === undefined) {
    return (
      `${lead}, but "${type}" was not resolved in this modeling run, so nothing establishes whether ${property} is a sensitive inline value or a plain Radius.Security/secrets resource ID. ` +
      "Resolve the type with show-radius-type.mjs and assign the credential the way its schema requires."
    );
  }
  const sensitive = entry[property];
  if (sensitive === true) {
    return null;
  }
  if (sensitive === undefined) {
    return (
      `${lead}, but the resolved schema for "${type}" does not describe ${property}, so its sensitivity is unknown. ` +
      "Assign a credential only to a property the resolved schema marks sensitive."
    );
  }
  return (
    `${lead}, but the resolved schema for "${type}" does not mark ${property} sensitive, so it holds a plain string rather than the credential. ` +
    "A non-sensitive credential property takes the resource ID of a Radius.Security/secrets resource: author or reuse that Secret with the @secure() parameter in its data and assign <secret>.id here. " +
    "Assigned raw, the credential becomes the Kubernetes Secret name the Recipe looks up in secretKeyRef and the deployment fails."
  );
}

function scanSecureParameterTargets(template, app, contract, parentPath = "") {
  let failed = false;
  const secure = secureParameterNames(template);
  for (const [symbol, resource] of Object.entries(template.resources ?? {})) {
    const resourcePath = parentPath ? `${parentPath}.${symbol}` : symbol;
    if (resource?.type === "Microsoft.Resources/deployments") {
      const nestedTemplate = resource?.properties?.template;
      if (isPlainObject(nestedTemplate)) {
        // A module declares its own parameters, so the nested template states
        // for itself which of them are secure; nothing has to be carried down.
        if (
          scanSecureParameterTargets(
            nestedTemplate,
            app,
            contract,
            resourcePath
          )
        ) {
          failed = true;
        }
      }
      continue;
    }
    if (
      typeof resource?.type !== "string" ||
      !resource.type.startsWith("Radius.") ||
      // A generated custom type is never in the staged contract, because
      // show-radius-type.mjs resolves only predefined types and refuses
      // `Radius.Resources` selectors. Its schema may legitimately mark a
      // property sensitive, so reporting it here would fail a correct model on
      // evidence this script does not have.
      resource.type.startsWith("Radius.Resources/")
    ) {
      continue;
    }
    const properties = resource?.properties?.properties;
    if (!isPlainObject(properties)) {
      continue;
    }
    for (const [property, value] of Object.entries(properties)) {
      if (typeof value !== "string") {
        continue;
      }
      const reference = SECURE_PARAMETER_REFERENCE.exec(value);
      if (reference === null || !secure.has(reference[1])) {
        continue;
      }
      const finding = secureTargetFinding(
        contract,
        resource.type,
        property,
        reference[1]
      );
      if (finding === null) {
        continue;
      }
      report(
        `${app}: error secure-parameter-target: ${resourcePath}.properties.${property}: ${finding}`
      );
      failed = true;
    }
  }
  return failed;
}

function checkSecureParameterTargets(template, app, contract) {
  if (contract.status === "unstaged") {
    return false;
  }
  return scanSecureParameterTargets(template, app, contract);
}

const executable = process.platform === "win32" ? "bicep.exe" : "bicep";
const bicep = path.join(
  os.homedir(),
  ".radius",
  "ai-extensions",
  "bin",
  executable
);

// Whether every Bicep security rule runs for the files this compile reads. A
// model that does not exist has nothing to inspect, and the compile reports it
// exactly as it did before this check existed. Never rejects, so the compile
// running alongside it is always awaited rather than left behind.
async function inspectCompiledFiles(securityRules, app, staged) {
  if (!existsSync(app)) {
    return { findings: [], unavailable: null };
  }
  try {
    const references = await securityRules.requestFileReferences(bicep, app);
    if (references.error !== undefined) {
      return { findings: [], unavailable: references.error };
    }
    return securityRules.inspectSecurityRules(references.filePaths, {
      stagingDir: staged ? path.dirname(app) : null
    });
  } catch (error) {
    return { findings: [], unavailable: error.message };
  }
}

const COMPILE_TIMEOUT_MS = 120_000;
const COMPILE_OUTPUT_LIMIT = 16 * 1024 * 1024;

// Compiles the model in a child process, resolving with the fields a
// spawnSync() result carries: `error` when Bicep could not be started, ran
// past the timeout, or wrote more output than the limit, and otherwise its
// exit status, signal, and output. Asynchronous so the security-rule
// inspection, which needs its own Bicep process, runs alongside it.
function compileModel(app) {
  return new Promise((resolve) => {
    const output = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let error = null;
    let settled = false;
    let timer;
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        error,
        status,
        signal,
        stdout: Buffer.concat(output.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr).toString("utf8")
      });
    };
    const child = spawn(
      bicep,
      ["build", app, "--diagnostics-format", "sarif", "--stdout"],
      {
        cwd: path.dirname(app),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
    const stop = (reason) => {
      error ??= reason;
      child.kill();
    };
    timer = setTimeout(() => {
      stop(
        new Error(
          `Bicep did not finish compiling within ${COMPILE_TIMEOUT_MS} ms.`
        )
      );
    }, COMPILE_TIMEOUT_MS);
    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", (chunk) => {
        sizes[stream] += chunk.length;
        if (sizes[stream] > COMPILE_OUTPUT_LIMIT) {
          stop(
            new Error(
              `Bicep wrote more than ${COMPILE_OUTPUT_LIMIT} bytes to ${stream}.`
            )
          );
          return;
        }
        output[stream].push(chunk);
      });
    }
    child.on("error", (reason) => {
      error ??= reason;
      // A process that never started emits no exit to wait for.
      if (child.pid === undefined) finish(null, null);
    });
    child.on("close", finish);
  });
}

// Compiles the model and distinguishes model diagnostics from a check that
// could not produce a reliable verdict. The budget wraps it rather than living
// inside it.
async function check(app, staged) {
  // Loaded before anything is spawned rather than imported statically, so an
  // installation missing the sibling module reaches the catch below main() and
  // reports the check as unavailable (exit 2) instead of failing to load
  // (exit 1), without leaving a compile running.
  const securityRuleModule = await import("./bicep-security-rules.mjs");
  // A security rule that was turned off reports nothing, so a clean compile is
  // only evidence once the rules are known to have run. The inspection runs
  // alongside the compile, and its findings are reported first; a finding
  // still lets the compile's own diagnostics through, so one attempt reports
  // everything the model has to fix.
  const [securityRules, compiled] = await Promise.all([
    inspectCompiledFiles(securityRuleModule, app, staged),
    compileModel(app)
  ]);
  securityRules.findings.forEach(report);
  if (securityRules.unavailable !== null) {
    report(
      `${app}: error checker-unavailable: whether the Bicep security rules run could not be established: ${securityRules.unavailable}. ` +
        "No model-policy verdict was produced. Abort the staged run: do not retry validation, do not modify the current model, " +
        "do not start another modeling run, do not write the origin record, and do not publish the run. " +
        "Report this exact failure to the user and say that no application definition was written."
    );
    return EXIT_CHECK_UNAVAILABLE;
  }
  const securityRuleDisabled = securityRules.findings.length > 0;

  if (compiled.error) {
    report(compiled.error.message);
    return EXIT_CHECK_UNAVAILABLE;
  }

  const compilerFindings = diagnostics(compiled.stderr ?? "");
  if (compilerFindings === null) {
    report(
      (compiled.stderr ?? "").trim() ||
        "Bicep did not return valid SARIF diagnostics."
    );
    return EXIT_CHECK_UNAVAILABLE;
  }

  compilerFindings.forEach(printDiagnostic);
  const compilerFailed = compilerFindings.some(isFailure);
  if (compiled.status !== EXIT_SUCCESS) {
    if (compilerFailed) {
      return EXIT_MODEL_INVALID;
    }
    report(
      `Bicep exited with status ${compiled.status === null ? "null" : compiled.status}` +
        `${compiled.signal ? ` after receiving signal ${compiled.signal}` : ""} without returning an actionable warning or error diagnostic.`
    );
    return EXIT_CHECK_UNAVAILABLE;
  }

  let template;
  try {
    template = JSON.parse(compiled.stdout ?? "");
  } catch {
    template = null;
  }
  if (
    template === null ||
    typeof template !== "object" ||
    Array.isArray(template)
  ) {
    report(`${app}: error: Bicep did not return valid compiled JSON.`);
    return EXIT_CHECK_UNAVAILABLE;
  }

  const resolvedTypes = readResolvedTypes(app, staged);
  if (resolvedTypes.status === "unusable") {
    report(
      `${app}: error checker-unavailable: the resolved type schemas staged in ${resolvedTypes.file} could not be read: ${resolvedTypes.detail}. ` +
        "No model-policy verdict was produced. Abort the staged run: do not retry validation, do not modify the current model, " +
        "do not start another modeling run, do not write the origin record, and do not publish the run. " +
        "Report this exact failure to the user and say that no application definition was written."
    );
    return EXIT_CHECK_UNAVAILABLE;
  }

  const invalidBuildSource = checkContainerImageBuildSources(template, app);
  const invalidSourceReference = checkSourceCodeReferences(template, app);
  const invalidConnectionSource = checkConnectionSources(template, app);
  const unresolvedRuntimeVariable = checkRuntimeVariableExpansion(
    template,
    app
  );
  const incompatibleAggregateSecretAlias = checkAggregateSecretAliases(
    template,
    app
  );
  const misplacedSecureParameter = checkSecureParameterTargets(
    template,
    app,
    resolvedTypes
  );
  return (
      securityRuleDisabled ||
        compilerFailed ||
        invalidBuildSource ||
        invalidSourceReference ||
        invalidConnectionSource ||
        unresolvedRuntimeVariable ||
        incompatibleAggregateSecretAlias ||
        misplacedSecureParameter
    ) ?
      EXIT_MODEL_INVALID
    : EXIT_SUCCESS;
}

async function main() {
  const app = path.resolve(process.argv[2] || ".radius/app.bicep");
  const run = readRunRecord(app);
  if (run === null) {
    return await check(app, false);
  }

  // Fail closed: a staged run whose record cannot be parsed or read has no
  // trustworthy count, and compiling anyway would grant it an unlimited one.
  if (run.unusable) {
    console.error(brokenRecordMessage(run.file, ""));
    return EXIT_CHECK_UNAVAILABLE;
  }

  // Refused before the compiler is spawned: every reserved validation counts,
  // including an unavailable one, so another compile would exceed the cap.
  const decision = evaluateRepairAttempt(run.state);
  if (!decision.allowed) {
    console.error(decision.reason);
    return EXIT_CHECK_UNAVAILABLE;
  }

  // The attempt is charged before the compile, and the run stops if it cannot
  // be, so the budget holds even when the compile never returns.
  const reserved = reserveAttempt(run, run.state.fingerprint);
  if (reserved) {
    console.error(brokenRecordMessage(run.file, reserved));
    return EXIT_CHECK_UNAVAILABLE;
  }

  const status = await check(app, true);
  // An unavailable check produced no new model verdict, so keep the last model
  // failure for comparison with the next completed validation. Success clears
  // it because there is no longer a failed model to compare.
  const fingerprint =
    status === EXIT_MODEL_INVALID ?
      fingerprintCompilerOutput(reported.join("\n"))
    : status === EXIT_SUCCESS ? null
    : run.state.fingerprint;
  if (
    status === EXIT_MODEL_INVALID &&
    isRepeatedFailure(run.state, fingerprint)
  ) {
    console.error(REPEATED_FAILURE_MESSAGE);
  }

  // The reservation above recorded the attempt with the previous fingerprint,
  // because this compile's was not known yet. Store the real one now. A failure
  // here costs only the repeat detection, since the attempt is already counted,
  // so it is reported without failing a compile that otherwise passed.
  const recorded = reserveAttempt(
    { ...run, state: { ...run.state, attempts: decision.attempt - 1 } },
    fingerprint
  );
  if (recorded) {
    console.error(
      `Could not record what this compile reported in ${run.file}: ${recorded}. The attempt is counted, but a repeated failure may not be recognized.`
    );
  }

  if (
    status === EXIT_MODEL_INVALID &&
    decision.attempt >= REPAIR_COMPILE_LIMIT
  ) {
    console.error(
      `This was compile ${decision.attempt} of ${REPAIR_COMPILE_LIMIT}; the repair budget is now spent and the checker will refuse to compile this run again.`
    );
  }
  return status;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error);
  process.exitCode = EXIT_CHECK_UNAVAILABLE;
}
