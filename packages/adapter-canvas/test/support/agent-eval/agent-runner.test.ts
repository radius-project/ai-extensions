import { describe, expect, it } from "vitest";
import { agentArguments, evaluationMatrix } from "./agent-runner.js";
import { MODELING_CASES } from "./modeling-cases.js";

describe("headless model matrix", () => {
  it("runs all six cases against each distinct requested model", () => {
    const matrix = evaluationMatrix(MODELING_CASES, [
      "model-a",
      "model-b",
      "model-a"
    ]);
    expect(matrix).toHaveLength(12);
    expect(new Set(matrix.map((entry) => entry.artifactId)).size).toBe(12);
    for (const model of ["model-a", "model-b"]) {
      expect(
        matrix
          .filter((entry) => entry.model === model)
          .map((entry) => entry.testCase.id)
      ).toEqual(MODELING_CASES.map((testCase) => testCase.id));
    }
  });

  it("uses the CLI default when no model is requested", () => {
    expect(
      evaluationMatrix(MODELING_CASES).map((entry) => entry.model)
    ).toEqual(Array.from({ length: 6 }, () => undefined));
  });

  it("filters the case for every model without changing expected outcomes", () => {
    const matrix = evaluationMatrix(
      MODELING_CASES,
      ["model-a", "model-b"],
      "named-unverified"
    );
    expect(matrix).toHaveLength(2);
    expect(matrix.map((entry) => entry.testCase.expected)).toEqual([
      { status: "blocked", blocker: "registration" },
      { status: "blocked", blocker: "registration" }
    ]);
  });

  it("rejects unknown cases and empty model identifiers", () => {
    expect(() => evaluationMatrix(MODELING_CASES, [], "missing")).toThrow(
      "Unknown evaluation case"
    );
    expect(() => evaluationMatrix(MODELING_CASES, [" "])).toThrow(
      "must not be empty"
    );
  });

  it("passes the model as one argv entry and exposes only evaluation tools", () => {
    const args = agentArguments(
      "A prompt with spaces",
      "http://127.0.0.1:1234/mcp",
      "model-with-options; ignored"
    );
    expect(args.slice(-2)).toEqual(["--model", "model-with-options; ignored"]);
    expect(args).toContain("--disable-builtin-mcps");
    expect(args).not.toContain("--allow-all-tools");
    const configIndex = args.indexOf("--additional-mcp-config");
    expect(JSON.parse(args[configIndex + 1])).toEqual({
      mcpServers: {
        "radius-eval": {
          type: "http",
          url: "http://127.0.0.1:1234/mcp",
          tools: ["*"]
        }
      }
    });
    expect(agentArguments("prompt", "url")).not.toContain("--model");
  });
});
