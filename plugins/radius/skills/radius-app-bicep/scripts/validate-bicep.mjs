#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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

    console.error(
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

function main() {
  const app = path.resolve(process.argv[2] || ".radius/app.bicep");
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
    console.error(compiled.error.message);
    return 1;
  }

  const compilerFindings = diagnostics(compiled.stderr ?? "");
  if (compilerFindings === null) {
    console.error(
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
    console.error(`${app}: error: Bicep did not return valid compiled JSON.`);
    return 1;
  }

  const invalidBuildSource = checkContainerImageBuildSources(template, app);
  return compilerFindings.some(isFailure) || invalidBuildSource ? 1 : 0;
}

process.exitCode = main();
