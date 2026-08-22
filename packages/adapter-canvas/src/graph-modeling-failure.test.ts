import { describe, expect, it } from "vitest";
import { RadProcessError } from "@radius-project/adapter-shared";
import {
  asGraphModelingFailure,
  graphModelingDiagnostic,
  GraphModelingFailure
} from "./graph-modeling-failure.js";
import { GRAPH_MODELING_FAILURE_MESSAGE } from "./graph-progress-contract.js";

describe("graph modeling failure classification", () => {
  it("classifies a nested rad process failure carrying Bicep diagnostics", () => {
    const processError = new RadProcessError(
      "rad exited with code 1",
      "app.bicep(4,2): Error BCP035: Missing required property.",
      ""
    );
    const error = new Error("rad app graph failed", { cause: processError });

    const result = asGraphModelingFailure(error);

    expect(result).toBeInstanceOf(GraphModelingFailure);
    expect((result as Error).message).toBe(
      `${GRAPH_MODELING_FAILURE_MESSAGE} app.bicep line 4: Missing required property.`
    );
    expect((result as Error).cause).toBe(error);
    expect(graphModelingDiagnostic(error)).toContain("BCP035");
  });

  it("falls back to the concise message when a BCP diagnostic has no source location", () => {
    const error = new RadProcessError(
      "rad exited with code 1",
      "Error BCP062: Invalid reference.",
      ""
    );

    expect((asGraphModelingFailure(error) as Error).message).toBe(
      GRAPH_MODELING_FAILURE_MESSAGE
    );
  });

  it("logs the diagnostic stream instead of unrelated stderr", () => {
    const error = new RadProcessError(
      "rad exited with code 1",
      "Error BCP062: Invalid reference.",
      "telemetry upload failed"
    );

    expect(graphModelingDiagnostic(error)).toBe(
      "Error BCP062: Invalid reference."
    );
  });

  it.each([
    [
      "managed CLI failure",
      new RadProcessError("download failed", "", "connection refused")
    ],
    ["malformed graph JSON", new SyntaxError("Unexpected end of JSON input")],
    ["non-Error rejection", "offline"]
  ])("preserves a %s", (_name, error) => {
    expect(asGraphModelingFailure(error)).toBe(error);
    expect(graphModelingDiagnostic(error)).toBeNull();
  });

  it("terminates safely when an error cause chain contains a cycle", () => {
    const error = new Error("cycle");
    Object.defineProperty(error, "cause", { value: error });

    expect(asGraphModelingFailure(error)).toBe(error);
  });
});
