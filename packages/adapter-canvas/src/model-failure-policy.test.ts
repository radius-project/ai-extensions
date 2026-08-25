import { describe, expect, it } from "vitest";
import {
  INFRASTRUCTURE_FAILURE_CATEGORIES,
  INFRASTRUCTURE_FAILURE_PATTERNS,
  MODEL_FAILURE_CATEGORIES,
  MODEL_FAILURE_PATTERNS,
  formatSummaryList,
  infrastructureFailureSummaryList,
  modelFailureSummaryList
} from "./model-failure-policy.js";

describe("model failure policy", () => {
  it("exposes every category pattern to the classifier", () => {
    expect(MODEL_FAILURE_PATTERNS).toHaveLength(
      MODEL_FAILURE_CATEGORIES.reduce(
        (total, category) => total + category.patterns.length,
        0
      )
    );
    expect(INFRASTRUCTURE_FAILURE_PATTERNS).toHaveLength(
      INFRASTRUCTURE_FAILURE_CATEGORIES.reduce(
        (total, category) => total + category.patterns.length,
        0
      )
    );
  });

  it("names every category in the prose the agent prompt uses", () => {
    const model = modelFailureSummaryList();
    for (const category of MODEL_FAILURE_CATEGORIES) {
      expect(model).toContain(category.summary);
    }
    const infrastructure = infrastructureFailureSummaryList();
    for (const category of INFRASTRUCTURE_FAILURE_CATEGORIES) {
      expect(infrastructure).toContain(category.summary);
    }
  });

  it("separates the summaries with commas and a closing conjunction", () => {
    expect(modelFailureSummaryList()).toMatch(/, or a Bicep parse or compile/u);
    expect(infrastructureFailureSummaryList()).toMatch(/^[^,]+, .*, or /u);
  });

  it("returns a lone summary unchanged", () => {
    expect(formatSummaryList([{ summary: "only this", patterns: [] }])).toBe(
      "only this"
    );
    expect(formatSummaryList([])).toBe("");
  });
});
