import { PR_GRAPH_DIFF_MARKDOWN_HEADING } from "../pr-diff-markdown.js";

const TELEMETRY_KEY = "radiusGraphDiff";

export type PullRequestGraphDiffOutcome = "diff" | "unavailable";

export interface PullRequestGraphDiffToolResult {
  textResultForLlm: string;
  resultType: "success" | "failure";
  error?: string;
  toolTelemetry?: {
    radiusGraphDiff: {
      outcome: PullRequestGraphDiffOutcome;
    };
  };
}

export function successfulGraphDiffResult(
  markdown: string
): PullRequestGraphDiffToolResult {
  return {
    textResultForLlm: markdown,
    resultType: "success",
    toolTelemetry: {
      [TELEMETRY_KEY]: {
        outcome: "diff"
      }
    }
  };
}

export function unavailableGraphDiffResult(
  message: string
): PullRequestGraphDiffToolResult {
  return {
    textResultForLlm: message,
    resultType: "success",
    toolTelemetry: {
      [TELEMETRY_KEY]: {
        outcome: "unavailable"
      }
    }
  };
}

export function failedGraphDiffResult(
  message: string
): PullRequestGraphDiffToolResult {
  return {
    textResultForLlm: message,
    resultType: "failure",
    error: message
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

export function graphDiffOutcome(
  toolResult: unknown
): PullRequestGraphDiffOutcome | null {
  const result = record(toolResult);
  if (result.resultType !== "success") return null;
  if (
    typeof result.textResultForLlm === "string" &&
    result.textResultForLlm.startsWith(PR_GRAPH_DIFF_MARKDOWN_HEADING)
  ) {
    return "diff";
  }
  return "unavailable";
}

export function graphDiffResultText(toolResult: unknown): string {
  return String(record(toolResult).textResultForLlm || "");
}
