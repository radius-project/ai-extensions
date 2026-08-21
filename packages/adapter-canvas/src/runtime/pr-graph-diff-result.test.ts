import { describe, expect, it } from "vitest";
import { PR_GRAPH_DIFF_MARKDOWN_HEADING } from "../pr-diff-markdown.js";
import {
  failedGraphDiffResult,
  graphDiffOutcome,
  graphDiffResultText,
  successfulGraphDiffResult,
  unavailableGraphDiffResult
} from "./pr-graph-diff-result.js";

describe("PR graph diff tool results", () => {
  it("classifies a rendered diff through structured telemetry", () => {
    const markdown = `${PR_GRAPH_DIFF_MARKDOWN_HEADING}\n\nDiagram`;
    const result = successfulGraphDiffResult(markdown);

    expect(graphDiffOutcome(result)).toBe("diff");
    expect(graphDiffResultText(result)).toBe(markdown);
  });

  it("classifies an unavailable graph without treating it as a tool failure", () => {
    const result = unavailableGraphDiffResult("No committed model");

    expect(result.resultType).toBe("success");
    expect(graphDiffOutcome(result)).toBe("unavailable");
  });

  it("returns an explicit failure result for execution errors", () => {
    const result = failedGraphDiffResult("rad failed");

    expect(result).toMatchObject({
      textResultForLlm: "rad failed",
      resultType: "failure",
      error: "rad failed"
    });
    expect(graphDiffOutcome(result)).toBeNull();
  });

  it("rejects malformed, failed, and marker-free diff results", () => {
    expect(graphDiffOutcome(null)).toBeNull();
    expect(graphDiffOutcome({ resultType: "failure" })).toBeNull();
    expect(
      graphDiffOutcome({
        resultType: "success",
        textResultForLlm: "not a graph",
        toolTelemetry: { radiusGraphDiff: { outcome: "diff" } }
      })
    ).toBe("unavailable");
    expect(graphDiffResultText({})).toBe("");
  });

  it("classifies successful results when the host strips custom telemetry", () => {
    expect(
      graphDiffOutcome({
        resultType: "success",
        textResultForLlm: `${PR_GRAPH_DIFF_MARKDOWN_HEADING}\n\nDiagram`
      })
    ).toBe("diff");
    expect(
      graphDiffOutcome({
        resultType: "success",
        textResultForLlm: "No committed model"
      })
    ).toBe("unavailable");
  });
});
