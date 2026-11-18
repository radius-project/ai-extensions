import { PR_GRAPH_DIFF_MARKDOWN_HEADING } from "../pr-diff-markdown.js";
import type { GraphSourceIdentity } from "@radius-project/core";

const TELEMETRY_KEY = "radiusGraphDiff";

export type PullRequestGraphDiffOutcome = "diff" | "unavailable";

export interface PullRequestGraphDiffToolResult {
  textResultForLlm: string;
  resultType: "success" | "failure";
  error?: string;
  sources?: { base: GraphSourceIdentity; head: GraphSourceIdentity };
  toolTelemetry?: {
    radiusGraphDiff: {
      outcome: PullRequestGraphDiffOutcome;
    };
  };
}

function withSourceIdentities(
  text: string,
  sources: PullRequestGraphDiffToolResult["sources"]
): string {
  if (!sources) return text;
  const identity = (source: GraphSourceIdentity) =>
    `${source.repo}@${source.revision ?? source.ref}`;
  return `${text}\n\nBase source: \`${identity(sources.base)}\`\n\nHead source: \`${identity(sources.head)}\``;
}

export function successfulGraphDiffResult(
  markdown: string,
  sources?: PullRequestGraphDiffToolResult["sources"]
): PullRequestGraphDiffToolResult {
  return {
    textResultForLlm: withSourceIdentities(markdown, sources),
    resultType: "success",
    ...(sources ? { sources } : {}),
    toolTelemetry: {
      [TELEMETRY_KEY]: {
        outcome: "diff"
      }
    }
  };
}

export function unavailableGraphDiffResult(
  message: string,
  sources?: PullRequestGraphDiffToolResult["sources"]
): PullRequestGraphDiffToolResult {
  return {
    textResultForLlm: withSourceIdentities(message, sources),
    resultType: "success",
    ...(sources ? { sources } : {}),
    toolTelemetry: {
      [TELEMETRY_KEY]: {
        outcome: "unavailable"
      }
    }
  };
}

export function failedGraphDiffResult(
  message: string,
  sources?: PullRequestGraphDiffToolResult["sources"]
): PullRequestGraphDiffToolResult {
  return {
    textResultForLlm: withSourceIdentities(message, sources),
    resultType: "failure",
    ...(sources ? { sources } : {}),
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
