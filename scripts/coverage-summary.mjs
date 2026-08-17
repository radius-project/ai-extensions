import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const METRICS = ["statements", "branches", "functions", "lines"];

function percentage(covered, total) {
  return total === 0 ? 100 : Math.floor((covered * 10_000) / total) / 100;
}

function metricTotals(entries, metric) {
  return entries.reduce(
    (total, entry) => ({
      covered: total.covered + entry[metric].covered,
      total: total.total + entry[metric].total
    }),
    { covered: 0, total: 0 }
  );
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

export function summarizeCoverage(summary, baseline) {
  if (!summary.total) {
    throw new Error("Coverage summary is missing its total entry.");
  }

  const fileEntries = Object.entries(summary)
    .filter(([path]) => path !== "total")
    .map(([path, value]) => [normalizePath(path), value]);
  const scopes = {
    aggregate: Object.fromEntries(
      METRICS.map((metric) => [metric, summary.total[metric].pct])
    )
  };

  for (const packageName of Object.keys(baseline.packages)) {
    const marker = `/packages/${packageName}/src/`;
    const entries = fileEntries
      .filter(([path]) => path.includes(marker))
      .map(([, value]) => value);
    if (entries.length === 0) {
      throw new Error(`Coverage summary has no files for ${packageName}.`);
    }
    scopes[packageName] = Object.fromEntries(
      METRICS.map((metric) => {
        const totals = metricTotals(entries, metric);
        return [metric, percentage(totals.covered, totals.total)];
      })
    );
  }

  for (const scope of Object.keys(baseline.newlyExtracted)) {
    const entries = fileEntries
      .filter(([path]) =>
        path.includes(`/packages/adapter-canvas/src/${scope}/`)
      )
      .map(([, value]) => value);
    if (entries.length === 0) {
      throw new Error(`Coverage summary has no files for ${scope}.`);
    }
    scopes[scope] = Object.fromEntries(
      METRICS.map((metric) => {
        const totals = metricTotals(entries, metric);
        return [metric, percentage(totals.covered, totals.total)];
      })
    );
  }

  return Object.entries(scopes).map(([scope, current]) => {
    const accepted =
      scope === "aggregate" ? baseline.aggregate
      : baseline.newlyExtracted[scope] ? baseline.newlyExtracted[scope]
      : baseline.packages[scope];
    return {
      scope,
      metrics: Object.fromEntries(
        METRICS.map((metric) => {
          const acceptedMetric = accepted[metric] ?? null;
          return [
            metric,
            {
              current: current[metric],
              baseline: acceptedMetric,
              delta:
                acceptedMetric === null ? null : (
                  Math.round((current[metric] - acceptedMetric) * 100) / 100
                )
            }
          ];
        })
      )
    };
  });
}

function percent(value) {
  return `${value.toFixed(2)}%`;
}

function delta(value) {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} pp`;
}

export function formatCoverageMarkdown(rows) {
  const header = [
    "## Coverage",
    "",
    "| Scope | Statements | Delta | Branches | Delta | Functions | Delta | Lines | Delta |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  const body = rows.map(({ scope, metrics }) => {
    const label = scope === "aggregate" ? "Aggregate" : `\`${scope}\``;
    return `| ${label} | ${percent(metrics.statements.current)} | ${delta(metrics.statements.delta)} | ${percent(metrics.branches.current)} | ${delta(metrics.branches.delta)} | ${percent(metrics.functions.current)} | ${delta(metrics.functions.delta)} | ${percent(metrics.lines.current)} | ${delta(metrics.lines.delta)} |`;
  });
  return [...header, ...body, ""].join("\n");
}

function run(argv = process.argv.slice(2), env = process.env) {
  const summaryPath = resolve(argv[0] || "coverage/coverage-summary.json");
  const baselinePath = resolve(argv[1] || "coverage-baseline.json");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const markdown = formatCoverageMarkdown(summarizeCoverage(summary, baseline));

  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  } else {
    process.stdout.write(markdown);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  run();
}
