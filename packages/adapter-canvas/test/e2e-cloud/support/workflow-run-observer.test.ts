import { describe, expect, it } from "vitest";
import type { CloudCommandResult } from "./cloud-command-port.js";
import { runCleanupSteps } from "./create-environment-journey.js";
import { quiesceOwnedWorkflowRuns } from "./deploy-journey.js";
import { findNewWorkflowRunId } from "./workflow-run-discovery.js";
import { createWorkflowRunObserver } from "./workflow-run-observer.js";

const REPOSITORY = "example/cloud-fixture";
const WORKFLOW = "radius-delete-environment.yml";
const EPOCH = Date.parse("2026-01-01T00:00:00Z");

function success(payload: unknown): CloudCommandResult {
  return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
}

function setup(results: readonly CloudCommandResult[]) {
  let time = EPOCH;
  const calls: string[][] = [];
  const waits: number[] = [];
  const queue = [...results];
  const observer = createWorkflowRunObserver(REPOSITORY, {
    commands: {
      runGh: async (args) => {
        calls.push([...args]);
        const result = queue.shift();
        if (!result) throw new Error("Unexpected GitHub command.");
        time += 25;
        return result;
      }
    },
    now: () => new Date(time),
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      time += milliseconds;
    },
    credentials: ["offline-redaction-marker"]
  });
  return { observer, calls, waits };
}

describe("cloud workflow observations", () => {
  it("records dispatch, empty lookups, and delayed visibility with timestamps", async () => {
    const { observer, calls } = setup([
      success([{ databaseId: 10 }]),
      success([{ databaseId: 10 }]),
      success([
        { databaseId: 10 },
        {
          databaseId: 11,
          displayTitle: "Delete environment correlation-11",
          status: "requested",
          createdAt: "2026-01-01T00:00:00Z"
        }
      ])
    ]);
    const before = await observer.listRunIds(WORKFLOW);
    observer.record("dispatch", { workflow: WORKFLOW });
    expect(
      findNewWorkflowRunId(before, await observer.listRunIds(WORKFLOW))
    ).toBeUndefined();
    expect(
      findNewWorkflowRunId(before, await observer.listRunIds(WORKFLOW))
    ).toBe("11");
    const evidence = observer.serialize();
    expect(evidence).toContain('"at": "2026-01-01T00:00:00.025Z"');
    expect(evidence).toContain('"durationMs": 25');
    expect(evidence).toContain('"kind": "dispatch"');
    expect(evidence).toContain("Delete environment correlation-11");
    expect(evidence).toContain('"status": "requested"');
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual([
      "run",
      "list",
      "--repo",
      REPOSITORY,
      "--workflow",
      WORKFLOW,
      "--event",
      "workflow_dispatch",
      "--limit",
      "100",
      "--json",
      "databaseId,displayTitle,status,conclusion,createdAt,startedAt,updatedAt,url"
    ]);
  });

  it("reconnects a read-only lookup after two connection resets and records both failures", async () => {
    const reset = {
      code: 1,
      stdout: "",
      stderr: "read: Connection reset by peer"
    };
    const { observer, calls, waits } = setup([
      reset,
      reset,
      success([{ databaseId: 11 }])
    ]);
    expect(await observer.listRunIds(WORKFLOW)).toEqual(new Set(["11"]));
    expect(waits).toEqual([2_000, 4_000]);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[1]).toEqual(calls[2]);
    expect(
      observer.serialize().match(/Connection reset by peer/g)
    ).toHaveLength(2);
    expect(observer.serialize()).toContain('"attempt": 3');
  });

  it("retains the final connection reset after exhausting the read limit", async () => {
    const reset = { code: 1, stdout: "", stderr: "connection reset by peer" };
    const { observer, calls, waits } = setup([reset, reset, reset]);
    await expect(observer.listRunIds(WORKFLOW)).rejects.toThrow(
      "connection reset by peer"
    );
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([2_000, 4_000]);
  });

  it.each([
    { code: 1, stdout: "", stderr: "HTTP 403: access denied" },
    { code: 1, stdout: "", stderr: "HTTP 404: workflow not found" },
    {
      code: 1,
      stdout: "",
      stderr: "connection reset by peer",
      timedOut: true
    },
    { code: 130, stdout: "", stderr: "connection reset by peer" },
    { code: -1, stdout: "", stderr: "connection reset by peer" },
    { code: 0, stdout: "[]", stderr: "", timedOut: true }
  ])("does not reconnect a different failure %#", async (result) => {
    const { observer, calls, waits } = setup([result]);
    await expect(observer.listRunIds(WORKFLOW)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(observer.serialize()).toContain('"kind": "command"');
  });

  it.each(["not-json", "{}", '[{"databaseId":0}]'])(
    "reports malformed successful read %s without retry",
    async (stdout) => {
      const { observer, calls, waits } = setup([
        { code: 0, stdout, stderr: "" }
      ]);
      await expect(observer.listRunIds(WORKFLOW)).rejects.toThrow();
      expect(calls).toHaveLength(1);
      expect(waits).toEqual([]);
    }
  );

  it("records the exact owned run's child jobs and step timing", async () => {
    const timing = {
      databaseId: 11,
      status: "completed",
      conclusion: "success",
      createdAt: "2026-01-01T00:00:00Z",
      startedAt: "2026-01-01T00:00:23Z",
      jobs: [
        {
          name: "Delete environment",
          startedAt: "2026-01-01T00:00:23Z",
          completedAt: "2026-01-01T00:04:42Z",
          steps: [
            {
              name: "Start control plane",
              startedAt: "2026-01-01T00:00:41Z",
              completedAt: "2026-01-01T00:03:08Z"
            }
          ]
        }
      ]
    };
    const { observer, calls } = setup([success(timing)]);
    await observer.readRunTiming("11");
    expect(observer.serialize()).toContain('"kind": "run-timing"');
    expect(observer.serialize()).toContain("Start control plane");
    expect(observer.serialize()).toContain("2026-01-01T00:03:08Z");
    expect(calls[0]).toEqual([
      "run",
      "view",
      "11",
      "--repo",
      REPOSITORY,
      "--json",
      "databaseId,url,status,conclusion,createdAt,startedAt,updatedAt,jobs"
    ]);
  });

  it.each(["0", "-1", "11/attempts/1", "1.5", "9007199254740992"])(
    "rejects an invalid owned run id %s before invoking GitHub",
    async (runId) => {
      const { observer, calls } = setup([]);
      await expect(observer.readRunTiming(runId)).rejects.toThrow(
        "exact positive run id"
      );
      expect(calls).toEqual([]);
    }
  );

  it("rejects timing from a different run", async () => {
    const { observer } = setup([success({ databaseId: 12 })]);
    await expect(observer.readRunTiming("11")).rejects.toThrow(
      "different run than the owned run 11"
    );
    expect(observer.serialize()).not.toContain('"kind": "run-timing"');
  });

  it("redacts diagnostic text and does not retain prior observer state", async () => {
    const { observer } = setup([
      {
        code: 1,
        stdout: "",
        stderr: "access denied: offline-redaction-marker"
      }
    ]);
    observer.record("failure", { message: "offline-redaction-marker" });
    await expect(observer.listRunIds(WORKFLOW)).rejects.toThrow();
    expect(observer.serialize()).not.toContain("offline-redaction-marker");
    expect(observer.serialize()).toContain("[REDACTED]");
    expect(setup([]).observer.serialize()).not.toContain('"kind":');
  });

  it("retains the original product failure after delayed run discovery and terminal cleanup", async () => {
    const { observer } = setup([
      success([]),
      success([]),
      success([{ databaseId: 11 }])
    ]);
    const before = await observer.listRunIds(WORKFLOW);
    const failure = new Error("Product operation ended failed_partial.");
    observer.record("operation", { state: "failed_partial" });
    expect(
      findNewWorkflowRunId(before, await observer.listRunIds(WORKFLOW))
    ).toBeUndefined();
    const runId = findNewWorkflowRunId(
      before,
      await observer.listRunIds(WORKFLOW)
    );
    if (!runId) throw new Error("Expected the delayed fixture run.");
    const calls: string[] = [];
    await quiesceOwnedWorkflowRuns(new Set([runId]), {
      readStatus: async () => "in_progress",
      cancel: async () => {
        calls.push("cancel owned run");
      },
      waitUntilCompleted: async () => {
        calls.push("completed");
      }
    });
    await expect(
      runCleanupSteps(
        [
          {
            label: "read child timing",
            run: async () => {
              throw new Error("GitHub timing unavailable");
            }
          },
          {
            label: "fixture cleanup",
            run: async () => {
              calls.push("cleanup");
            }
          }
        ],
        failure
      )
    ).rejects.toMatchObject({
      errors: [
        failure,
        expect.objectContaining({
          message: expect.stringContaining("GitHub timing unavailable")
        })
      ]
    });
    expect(calls).toEqual(["cancel owned run", "completed", "cleanup"]);
    expect(observer.serialize()).toContain('"state": "failed_partial"');
  });
});
