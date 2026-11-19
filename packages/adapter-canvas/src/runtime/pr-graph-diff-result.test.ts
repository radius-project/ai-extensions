import { describe, expect, it } from "vitest";
import type { GraphSourceIdentity } from "@radius-project/core";
import { PR_GRAPH_DIFF_MARKDOWN_HEADING } from "../pr-diff-markdown.js";
import {
  failedGraphDiffResult,
  graphDiffOutcome,
  graphDiffResultText,
  successfulGraphDiffResult,
  unavailableGraphDiffResult
} from "./pr-graph-diff-result.js";

describe("PR graph diff tool results", () => {
  const sources: { base: GraphSourceIdentity; head: GraphSourceIdentity } = {
    base: {
      kind: "github",
      repo: "acme/widgets",
      ref: "main",
      revision: "a".repeat(40),
      definitionPath: ".radius/app.bicep"
    },
    head: {
      kind: "github",
      repo: "acme/widgets",
      ref: "feature",
      revision: "b".repeat(40),
      definitionPath: "app.bicep"
    }
  };

  it("delivers source provenance in SDK text without changing headings, outcomes, or failures", () => {
    const markdown = `${PR_GRAPH_DIFF_MARKDOWN_HEADING}\n\nDiagram`;
    const diff = successfulGraphDiffResult(markdown, sources);
    const absent = unavailableGraphDiffResult("No committed model", sources);
    const failure = failedGraphDiffResult("compile failed", sources);

    expect(diff.sources).toEqual(sources);
    expect(graphDiffResultText(diff)).toBe(
      `${markdown}\n\nBase source: \`acme/widgets@${"a".repeat(40)}\`\n\nHead source: \`acme/widgets@${"b".repeat(40)}\``
    );
    expect(graphDiffOutcome(diff)).toBe("diff");
    expect(absent.sources).toEqual(sources);
    expect(graphDiffOutcome(absent)).toBe("unavailable");
    expect(failure.sources).toEqual(sources);
    expect(failure.error).toBe("compile failed");
    expect(graphDiffOutcome(failure)).toBeNull();
    for (const result of [diff, absent, failure]) {
      const sdkResult = {
        textResultForLlm: result.textResultForLlm,
        resultType: result.resultType
      };
      expect(graphDiffResultText(sdkResult)).toContain(
        `Base source: \`acme/widgets@${"a".repeat(40)}\``
      );
      expect(graphDiffResultText(sdkResult)).toContain(
        `Head source: \`acme/widgets@${"b".repeat(40)}\``
      );
      expect(graphDiffOutcome(sdkResult)).toBe(graphDiffOutcome(result));
    }
    expect(diff.toolTelemetry).toEqual({
      radiusGraphDiff: { outcome: "diff" }
    });
    expect(absent.toolTelemetry).toEqual({
      radiusGraphDiff: { outcome: "unavailable" }
    });
    expect(failure.toolTelemetry).toBeUndefined();
  });

  it("labels unresolved source refs without inventing a committed revision", () => {
    const result = failedGraphDiffResult("Cannot resolve head", {
      base: sources.base,
      head: {
        kind: "github",
        repo: "acme/widgets",
        ref: "feature",
        definitionPath: "app.bicep"
      }
    });

    expect(result.textResultForLlm).toContain(
      `Base source: \`acme/widgets@${"a".repeat(40)}\``
    );
    expect(result.textResultForLlm).toContain(
      "Head source: unresolved ref `feature` in `acme/widgets`"
    );
  });
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
