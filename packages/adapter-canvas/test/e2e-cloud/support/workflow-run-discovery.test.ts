import { describe, expect, it } from "vitest";

import {
  findNewWorkflowRunId,
  readWorkflowRunIds
} from "./workflow-run-discovery.js";

describe("workflow run discovery", () => {
  it("reads exact positive workflow run database ids", () => {
    expect(
      readWorkflowRunIds([{ databaseId: 11 }, { databaseId: 12 }])
    ).toEqual(new Set(["11", "12"]));
  });

  it.each([
    null,
    {},
    [null],
    [{}],
    [{ databaseId: 0 }],
    [{ databaseId: -1 }],
    [{ databaseId: 1.5 }],
    [{ databaseId: "11" }]
  ])("rejects malformed workflow run listing %#", (payload) => {
    expect(() => readWorkflowRunIds(payload)).toThrow();
  });

  it("finds the only run added after dispatch", () => {
    expect(findNewWorkflowRunId(new Set(["10"]), new Set(["12", "10"]))).toBe(
      "12"
    );
    expect(
      findNewWorkflowRunId(new Set(["10"]), new Set(["10"]))
    ).toBeUndefined();
  });

  it("rejects ambiguous concurrent workflow dispatches", () => {
    expect(() =>
      findNewWorkflowRunId(new Set(["10"]), new Set(["12", "11", "10"]))
    ).toThrow(/cannot prove/);
  });
});
