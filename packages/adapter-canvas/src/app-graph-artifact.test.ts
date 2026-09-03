import { describe, expect, it } from "vitest";
import { stampAppGraphJson } from "@radius-project/adapter-shared";
import { isAppGraphCurrent } from "./app-graph-artifact.js";

const MODEL = "resource app 'Radius.Core/applications@2025-08-01-preview' = {}";

describe("isAppGraphCurrent", () => {
  it("accepts an artifact stamped from the current app.bicep", () => {
    expect(isAppGraphCurrent(stampAppGraphJson("{}", MODEL), MODEL)).toBe(true);
  });

  it.each([
    [
      "a changed app.bicep",
      stampAppGraphJson("{}", MODEL),
      `${MODEL}\n// edit`
    ],
    ["an unstamped artifact", "{}", MODEL],
    ["malformed JSON", "{not json", MODEL],
    ["a non-object artifact", "[]", MODEL],
    ["non-object provenance", '{"_radius":[]}', MODEL],
    ["a missing graph", null, MODEL],
    ["a missing app.bicep", "{}", null]
  ])("rejects %s", (_label, graph, bicep) => {
    expect(isAppGraphCurrent(graph, bicep)).toBe(false);
  });
});
