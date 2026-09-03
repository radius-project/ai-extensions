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

import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STAGING_RUN_RECORD = "run.json";
const REPAIR_ATTEMPT_BUDGET = 5;
const REPAIR_COMPILE_LIMIT = REPAIR_ATTEMPT_BUDGET + 1;

function repairBudgetSpentMessage(attempts) {
  return (
    `The application model was compiled ${attempts} times in this modeling run and still does not build, ` +
    `so the repair budget of ${REPAIR_ATTEMPT_BUDGET} is spent and it was not compiled again. ` +
    "Stop repairing: do not write the origin record and do not publish the run. " +
    "Report to the user which resource and property the compiler rejected, quote the last compiler output verbatim, " +
    "and say that no application definition was written."
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
  // "what the previous attempt failed with", so without a usable count there is
  // no previous attempt for it to describe, and keeping it would report the
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
    "The application model was not compiled, because a budget that cannot be counted cannot be enforced, " +
    "and an uncounted repair loop is what this limit exists to prevent. " +
    "Start the modeling run again with promote-app-model.mjs --begin."
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
      const runResults = run.results ?? [];
      if (!Array.isArray(runResults)) {
        return null;
      }
      results.push(...runResults);
    }
    if (
      !results.every(
        (result) =>
          result !== null &&
          typeof result === "object" &&
          !Array.isArray(result)
      )
    ) {
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

function printDiagnostic(result) {
  const physical = result.locations?.[0]?.physicalLocation;
  const source = physical?.artifactLocation?.uri;
  const line = physical?.region?.startLine;
  let location = "";
  if (typeof source === "string") {
    location = `${source}${Number.isInteger(line) ? `:${line}` : ""}`;
  } else if (Number.isInteger(line)) {
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
  const customTypeHint =
    result.ruleId === "BCP037" && /\bcodeReference\b/u.test(text) ?
      " For a Radius.Resources custom type, add the optional codeReference string property to custom-types.yaml and republish custom-types.tgz before compiling again."
    : "";
  report(
    `${location ? `${location}: ` : ""}${level}${rule}: ${text}${customTypeHint}`
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

const executable = process.platform === "win32" ? "bicep.exe" : "bicep";
const bicep = path.join(
  os.homedir(),
  ".radius",
  "ai-extensions",
  "bin",
  executable
);

// Compiles the model and reports what Bicep rejected. Unchanged from what this
// script has always done; the budget wraps it rather than living inside it.
function check(app) {
  const compiled = spawnSync(
    bicep,
    ["build", app, "--diagnostics-format", "sarif", "--stdout"],
    {
      cwd: path.dirname(app),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      windowsHide: true
    }
  );
  if (compiled.error) {
    report(compiled.error.message);
    return 1;
  }

  const compilerFindings = diagnostics(compiled.stderr ?? "");
  if (compilerFindings === null) {
    report(
      (compiled.stderr ?? "").trim() ||
        "Bicep did not return valid SARIF diagnostics."
    );
    return 1;
  }

  compilerFindings.forEach(printDiagnostic);
  if (compiled.status !== 0) {
    return compiled.status || 1;
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
    return 1;
  }

  const invalidBuildSource = checkContainerImageBuildSources(template, app);
  const invalidSourceReference = checkSourceCodeReferences(template, app);
  const unresolvedRuntimeVariable = checkRuntimeVariableExpansion(
    template,
    app
  );
  return (
      compilerFindings.some(isFailure) ||
        invalidBuildSource ||
        invalidSourceReference ||
        unresolvedRuntimeVariable
    ) ?
      1
    : 0;
}

function main() {
  const app = path.resolve(process.argv[2] || ".radius/app.bicep");
  const run = readRunRecord(app);
  if (run === null) {
    return check(app);
  }

  // Fail closed: a staged run whose record cannot be parsed or read has no
  // trustworthy count, and compiling anyway would grant it an unlimited one.
  if (run.unusable) {
    console.error(brokenRecordMessage(run.file, ""));
    return 1;
  }

  // Refused before the compiler is spawned: once the budget is spent there is
  // nothing more to learn from another identical failure, and compiling anyway
  // would invite one more repair.
  const decision = evaluateRepairAttempt(run.state);
  if (!decision.allowed) {
    console.error(decision.reason);
    return 1;
  }

  // The attempt is charged before the compile, and the run stops if it cannot
  // be, so the budget holds even when the compile never returns.
  const reserved = reserveAttempt(run, run.state.fingerprint);
  if (reserved) {
    console.error(brokenRecordMessage(run.file, reserved));
    return 1;
  }

  const status = check(app);
  const fingerprint =
    status === 0 ? null : fingerprintCompilerOutput(reported.join("\n"));
  if (isRepeatedFailure(run.state, fingerprint)) {
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

  if (status !== 0 && decision.attempt >= REPAIR_COMPILE_LIMIT) {
    console.error(
      `This was compile ${decision.attempt} of ${REPAIR_COMPILE_LIMIT}; the repair budget is now spent and the checker will refuse to compile this run again.`
    );
  }
  return status;
}

process.exitCode = main();
