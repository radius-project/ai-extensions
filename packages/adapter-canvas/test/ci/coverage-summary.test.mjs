import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatCoverageMarkdown,
  summarizeCoverage
} from "../../../../scripts/coverage-summary.mjs";

const summary = JSON.parse(
  readFileSync(
    new URL("../fixtures/coverage-summary.json", import.meta.url),
    "utf8"
  )
);
const baseline = {
  aggregate: {
    statements: 70,
    branches: 70,
    functions: 70,
    lines: 70
  },
  packages: {
    "adapter-canvas": {
      statements: 75,
      branches: 75,
      functions: 75,
      lines: 75
    },
    "adapter-shared": {
      statements: 65,
      branches: 65,
      functions: 65,
      lines: 65
    },
    core: {
      statements: 75,
      branches: 75,
      functions: 75,
      lines: 75
    }
  },
  newlyExtracted: {
    runtime: {
      branches: 70,
      functions: 80,
      lines: 80
    }
  }
};

describe("coverage summary", () => {
  it("calculates aggregate and per-package percentages and baseline deltas", () => {
    const rows = summarizeCoverage(summary, baseline);

    expect(rows).toEqual([
      {
        scope: "aggregate",
        metrics: {
          statements: { current: 75, baseline: 70, delta: 5 },
          branches: { current: 75, baseline: 70, delta: 5 },
          functions: { current: 75, baseline: 70, delta: 5 },
          lines: { current: 75, baseline: 70, delta: 5 }
        }
      },
      {
        scope: "adapter-canvas",
        metrics: {
          statements: { current: 80, baseline: 75, delta: 5 },
          branches: { current: 80, baseline: 75, delta: 5 },
          functions: { current: 80, baseline: 75, delta: 5 },
          lines: { current: 80, baseline: 75, delta: 5 }
        }
      },
      {
        scope: "adapter-shared",
        metrics: {
          statements: { current: 70, baseline: 65, delta: 5 },
          branches: { current: 60, baseline: 65, delta: -5 },
          functions: { current: 60, baseline: 65, delta: -5 },
          lines: { current: 70, baseline: 65, delta: 5 }
        }
      },
      {
        scope: "core",
        metrics: {
          statements: { current: 75, baseline: 75, delta: 0 },
          branches: { current: 80, baseline: 75, delta: 5 },
          functions: { current: 80, baseline: 75, delta: 5 },
          lines: { current: 75, baseline: 75, delta: 0 }
        }
      },
      {
        scope: "runtime",
        metrics: {
          statements: { current: 80, baseline: null, delta: null },
          branches: { current: 80, baseline: 70, delta: 10 },
          functions: { current: 80, baseline: 80, delta: 0 },
          lines: { current: 80, baseline: 80, delta: 0 }
        }
      }
    ]);
  });

  it("renders a deterministic GitHub job-summary table", () => {
    const markdown = formatCoverageMarkdown(
      summarizeCoverage(summary, baseline)
    );

    expect(markdown).toContain("## Coverage");
    expect(markdown).toContain(
      "| Aggregate | 75.00% | +5.00 pp | 75.00% | +5.00 pp |"
    );
    expect(markdown).toContain(
      "| `adapter-shared` | 70.00% | +5.00 pp | 60.00% | -5.00 pp |"
    );
    expect(markdown).toContain(
      "| `runtime` | 80.00% | — | 80.00% | +10.00 pp |"
    );
  });
});
