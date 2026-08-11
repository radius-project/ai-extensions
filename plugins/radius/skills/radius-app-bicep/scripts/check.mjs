#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  console.error(`${location ? `${location}: ` : ""}${level}${rule}: ${text}`);
}

function isFailure(result) {
  return result.level !== "note" && result.level !== "none";
}

const executable = process.platform === "win32" ? "bicep.exe" : "bicep";
const bicep =
  process.env.BICEP_BINARY ||
  [
    path.join(os.homedir(), ".radius", "ai-extensions", "bin", executable),
    path.join(os.homedir(), ".rad", "bin", executable)
  ].find((candidate) => fs.existsSync(candidate)) ||
  executable;
const app = path.resolve(process.argv[2] || ".radius/app.bicep");

const compiled = spawnSync(
  bicep,
  ["build", app, "--diagnostics-format", "sarif", "--stdout"],
  {
    cwd: path.dirname(app),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120_000,
    windowsHide: true
  }
);

if (compiled.error) {
  console.error(compiled.error.message);
  process.exitCode = 1;
} else {
  const findings = diagnostics(compiled.stderr ?? "");
  if (findings === null) {
    console.error(
      (compiled.stderr ?? "").trim() ||
        "Bicep did not return valid SARIF diagnostics."
    );
    process.exitCode = 1;
  } else {
    findings.forEach(printDiagnostic);
    if (compiled.status === 0 && !findings.some(isFailure)) {
      process.exitCode = 0;
    } else {
      process.exitCode = compiled.status || 1;
    }
  }
}
