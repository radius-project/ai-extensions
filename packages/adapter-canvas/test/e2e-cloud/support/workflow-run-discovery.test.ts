import { describe, expect, it } from "vitest";

import {
  findNewWorkflowRunId,
  readWorkflowDispatchRunId,
  readWorkflowRunIds
} from "./workflow-run-discovery.js";

describe("workflow run discovery", () => {
  it("uses the exact workflow run URL returned by gh dispatch", () => {
    expect(
      readWorkflowDispatchRunId(
        "https://github.com/fixture-owner/fixture-repo/actions/runs/42\r\n",
        "fixture-owner/fixture-repo"
      )
    ).toBe("42");
  });

  it.each(["", " \r\n"])(
    "allows discovery when gh emits no URL %#",
    (output) => {
      expect(
        readWorkflowDispatchRunId(output, "fixture-owner/fixture-repo")
      ).toBeUndefined();
    }
  );

  it.each([
    "https://github.com/another/repository/actions/runs/42",
    "https://example.com/fixture-owner/fixture-repo/actions/runs/42",
    "https://github.com/fixture-owner/fixture-repo/actions/runs/0",
    "https://github.com/fixture-owner/fixture-repo/actions/runs/42/jobs/1",
    "https://github.com/fixture-owner/fixture-repo/actions/runs/42\nhttps://github.com/fixture-owner/fixture-repo/actions/runs/43",
    "Created workflow dispatch"
  ])(
    "rejects an untrusted dispatch result instead of guessing %#",
    (output) => {
      expect(() =>
        readWorkflowDispatchRunId(output, "fixture-owner/fixture-repo")
      ).toThrow();
    }
  );

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
