import { describe, expect, it } from "vitest";
import { RadProcessError } from "@radius-project/adapter-shared";
import {
  asGraphModelingFailure,
  graphModelingDiagnostic,
  GraphModelingFailure,
  graphModelingFailureMessage
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
      `${GRAPH_MODELING_FAILURE_MESSAGE} app.bicep line 4, column 2: Missing required property.`
    );
    expect((result as Error).cause).toBe(error);
    expect(graphModelingDiagnostic(error)).toContain("BCP035");
  });

  it.each([
    ["app.bicep(7,17)", "line 7, column 17"],
    ["app.bicep(7)", "line 7"],
    ["app.bicep(7,0)", "line 7"],
    ["app.bicep(0,17)", null],
    ["app.bicep(7,9007199254740992)", "line 7"],
    ["app.bicep(9007199254740992,17)", null]
  ])("uses only safe positions from %s", (location, position) => {
    expect(
      graphModelingFailureMessage(
        `${location}: Warning BCP236: Invalid syntax. [https://example.test/diagnostic]`
      )
    ).toBe(
      position === null ?
        GRAPH_MODELING_FAILURE_MESSAGE
      : `${GRAPH_MODELING_FAILURE_MESSAGE} app.bicep ${position}: Invalid syntax.`
    );
  });

  it("retains every diagnostic and summarizes the first precise location", () => {
    const diagnostic = [
      "/fixture/app.bicep(7,17) : error BCP236: Invalid syntax.",
      "/fixture/app.bicep(7,41) : error BCP236: Invalid syntax."
    ].join("\n");
    const result = asGraphModelingFailure(
      new RadProcessError("rad exited with code 1", diagnostic, "")
    );

    expect(result).toBeInstanceOf(GraphModelingFailure);
    if (!(result instanceof GraphModelingFailure)) {
      throw new Error("Expected a structured modeling failure");
    }
    expect(result.diagnostic).toBe(diagnostic);
    expect(result.message).toBe(
      `${GRAPH_MODELING_FAILURE_MESSAGE} app.bicep line 7, column 17: Invalid syntax.`
    );
  });

  it("does not borrow a later location when the first diagnostic has none", () => {
    expect(
      graphModelingFailureMessage(
        "Error BCP236: Invalid syntax.\napp.bicep(7,41): Error BCP236: Invalid syntax."
      )
    ).toBe(GRAPH_MODELING_FAILURE_MESSAGE);
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
      "unknown resource type",
      'resource type "Applications.Db/redis" not recognized'
    ],
    [
      "unsupported API version",
      "API version '2020-01-01' for type 'Applications.Core/containers' is not supported."
    ],
    ["unknown property", 'property "port" is not allowed by this schema'],
    ["invalid reference", 'referenced resource "redis" does not exist'],
    [
      "wrong credential shape",
      "credentials must be an object keyed by registry host"
    ],
    [
      "Bicep compilation error without a code",
      "Bicep compilation failed while processing app.bicep"
    ]
  ])("classifies a rad-level %s without a BCP code", (_name, diagnostic) => {
    const error = new RadProcessError("rad exited with code 1", diagnostic, "");

    const result = asGraphModelingFailure(error);

    expect(result).toBeInstanceOf(GraphModelingFailure);
    expect((result as Error).message).toBe(GRAPH_MODELING_FAILURE_MESSAGE);
    expect(graphModelingDiagnostic(error)).toBe(diagnostic);
  });

  it("preserves a BCP204 extension-resolution failure", () => {
    const processError = new RadProcessError(
      "rad exited with code 1",
      'Error BCP204: Extension "radius" is not recognized.',
      ""
    );
    const error = new Error(
      "rad app graph failed\nCompiled with radius extension: br:example/radius:1.0",
      { cause: processError }
    );

    expect(asGraphModelingFailure(error)).toBe(error);
    expect(graphModelingDiagnostic(error)).toBeNull();
  });

  it.each([
    [
      "managed CLI failure",
      new RadProcessError("download failed", "", "connection refused")
    ],
    [
      "extension restore failure without a BCP code",
      new RadProcessError(
        "rad exited with code 1",
        "Failed to restore Radius extension from registry",
        ""
      )
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
