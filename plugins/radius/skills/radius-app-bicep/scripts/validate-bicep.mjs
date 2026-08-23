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
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STAGING_RUN_RECORD = "run.json";
const REPAIR_ATTEMPT_BUDGET = 5;

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
  if (state.attempts >= REPAIR_ATTEMPT_BUDGET) {
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
function readRunRecord(app) {
  const file = path.join(path.dirname(app), STAGING_RUN_RECORD);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A record that exists but cannot be parsed still marks a staged run. It is
    // not rewritten, because overwriting it would destroy the baseline the
    // publish check needs; the run simply gets no budget enforcement.
    return { file, record: null, state: parseRepairState(null) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { file, record: null, state: parseRepairState(null) };
  }
  return { file, record: parsed, state: parseRepairState(parsed.repair) };
}

// Records the attempt back into the run record. A failure to write is reported
// but does not fail an otherwise successful compile: the budget is a guard rail,
// and losing it must not turn a model that compiles into a modeling failure.
function recordAttempt(run, fingerprint) {
  if (run.record === null) return;
  const updated = {
    ...run.record,
    repair: nextRepairState(run.state, fingerprint)
  };
  try {
    writeFileSync(run.file, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error(
      `Could not record this compile in ${run.file}: ${error.message}. The repair budget is not being counted for this run.`
    );
  }
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
  report(`${location ? `${location}: ` : ""}${level}${rule}: ${text}`);
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
  return compilerFindings.some(isFailure) || invalidBuildSource ? 1 : 0;
}

function main() {
  const app = path.resolve(process.argv[2] || ".radius/app.bicep");
  const run = readRunRecord(app);
  if (run === null) {
    return check(app);
  }

  // Refused before the compiler is spawned: once the budget is spent there is
  // nothing more to learn from another identical failure, and compiling anyway
  // would invite one more repair.
  const decision = evaluateRepairAttempt(run.state);
  if (!decision.allowed) {
    console.error(decision.reason);
    return 1;
  }

  const status = check(app);
  const fingerprint =
    status === 0 ? null : fingerprintCompilerOutput(reported.join("\n"));
  if (isRepeatedFailure(run.state, fingerprint)) {
    console.error(REPEATED_FAILURE_MESSAGE);
  }
  recordAttempt(run, fingerprint);
  if (status !== 0 && decision.attempt >= REPAIR_ATTEMPT_BUDGET) {
    console.error(
      `This was attempt ${decision.attempt} of ${REPAIR_ATTEMPT_BUDGET}; the repair budget is now spent and the checker will refuse to compile this run again.`
    );
  }
  return status;
}

process.exitCode = main();
