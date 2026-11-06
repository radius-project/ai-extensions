import { describe, expect, it } from "vitest";
import {
  selectLatestWorkflowRunId,
  selectWorkflowRunId
} from "./deployment-observation-policy.js";

describe("selectWorkflowRunId", () => {
  const since = Date.parse("2026-08-20T10:00:00Z");
  it.each([null, {}])("returns null for non-array input %j", (runs) => {
    expect(selectWorkflowRunId(runs, since)).toBeNull();
  });
  it("picks the newest run inside the clock-skew window", () => {
    expect(
      selectWorkflowRunId(
        [
          { databaseId: 3, createdAt: "2026-08-20T10:00:05Z" },
          { databaseId: 2, createdAt: "2026-08-20T09:59:59Z" }
        ],
        since
      )
    ).toBe(3);
  });
  it("ignores stale runs and tolerates clock skew including the exact cutoff", () => {
    expect(
      selectWorkflowRunId(
        [{ databaseId: 9, createdAt: "2026-08-20T09:58:00Z" }],
        since
      )
    ).toBeNull();
    expect(
      selectWorkflowRunId(
        [{ databaseId: 7, createdAt: "2026-08-20T09:59:10Z" }],
        since
      )
    ).toBe(7);
    expect(
      selectWorkflowRunId(
        [{ databaseId: 7, createdAt: "2026-08-20T09:59:00Z" }],
        since
      )
    ).toBe(7);
  });
  it("requires the requested correlation id in the display title", () => {
    const runs = [
      {
        databaseId: 5,
        createdAt: "2026-08-20T10:00:06Z",
        displayTitle: "Radius - Delete Environment prod other-id"
      },
      {
        databaseId: 4,
        createdAt: "2026-08-20T10:00:04Z",
        displayTitle: "Radius - Delete Environment prod del-abc-123"
      }
    ];
    expect(selectWorkflowRunId(runs, since, "del-abc-123")).toBe(4);
    expect(selectWorkflowRunId(runs, since, "del-missing")).toBeNull();
    expect(
      selectWorkflowRunId(
        [{ databaseId: 8, createdAt: "2026-08-20T10:00:05Z" }],
        since,
        "missing"
      )
    ).toBeNull();
  });
  it("skips malformed records and missing or nonnumeric ids", () => {
    expect(
      selectWorkflowRunId(
        [
          null,
          [],
          "invalid",
          { createdAt: "2026-08-20T10:00:06Z" },
          { databaseId: "7", createdAt: 12, displayTitle: 42 },
          { databaseId: 8, createdAt: "2026-08-20T10:00:05Z" }
        ],
        since
      )
    ).toBe(8);
  });
  it.each([10, "10"])(
    "uses the smallest id above baseline %s, independent of correlation or clock skew",
    (baseline) => {
      const runs = [
        {},
        { databaseId: 10 },
        { databaseId: 14 },
        { databaseId: 12 },
        { databaseId: 13 }
      ];
      expect(selectWorkflowRunId(runs, since, "ignored", baseline)).toBe(12);
      expect(selectWorkflowRunId(runs, since, undefined, 14)).toBeNull();
    }
  );
  it.each([undefined, null, "", " ", "not-a-number", Infinity, NaN])(
    "falls back to the time window for absent/non-finite baseline %s",
    (baseline) =>
      expect(
        selectWorkflowRunId(
          [{ databaseId: 8, createdAt: "2026-08-20T10:00:05Z" }],
          since,
          undefined,
          baseline
        )
      ).toBe(8)
  );
  it("retains the zero-dispatch-time and missing-date compatibility behavior", () => {
    expect(selectWorkflowRunId([{ databaseId: 1 }], 0)).toBe(1);
  });
});

describe("selectLatestWorkflowRunId", () => {
  it.each([null, {}, []])("returns no baseline for %j", (runs) => {
    expect(selectLatestWorkflowRunId(runs)).toBeNull();
  });
  it("ignores malformed entries and finds the maximum regardless of input order", () => {
    expect(
      selectLatestWorkflowRunId([
        null,
        [],
        {},
        { databaseId: "4" },
        { databaseId: 3 },
        { databaseId: 7 },
        { databaseId: 5 }
      ])
    ).toBe(7);
  });
});
