import { describe, expect, it } from "vitest";
import {
  observeWorkflowRun,
  confirmedWorkflowConclusion,
  type WorkflowRunRead
} from "./workflow-observation.js";

describe("confirmed workflow conclusion", () => {
  it.each([
    "success",
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "neutral",
    "skipped",
    "stale",
    "startup_failure"
  ])("accepts GitHub's completed %s conclusion", (conclusion) => {
    expect(
      confirmedWorkflowConclusion({ status: "completed", conclusion })
    ).toBe(conclusion);
  });

  it.each([
    { status: "completed", conclusion: null },
    { status: "completed", conclusion: undefined },
    { status: "completed", conclusion: "" },
    { status: "completed", conclusion: "future_conclusion" },
    { status: "waiting", conclusion: null },
    { status: "in_progress", conclusion: "success" },
    { status: "queued", conclusion: "failure" },
    { status: undefined, conclusion: "failure" }
  ])("does not invent an outcome from %j", (run) => {
    expect(confirmedWorkflowConclusion(run)).toBeNull();
  });
});

describe("one-shot workflow observation", () => {
  it("normalizes once without mutating the raw run or selecting another execution", async () => {
    const steps = Object.freeze([
      Object.freeze({
        name: "deploy",
        status: "completed",
        conclusion: "failure",
        number: 3
      })
    ]);
    const jobs = Object.freeze([Object.freeze({ steps }), null, [], 3]);
    const data = Object.freeze({
      status: "completed",
      conclusion: "failure",
      jobs
    });
    const calls: unknown[] = [];
    const result = await observeWorkflowRun(
      { repo: "org/app", runId: "41" },
      {
        readRun: async (...args) => {
          calls.push(args);
          return { data, includeJobs: true };
        }
      }
    );
    expect(calls).toEqual([["org/app", "41"]]);
    expect(result).toEqual({
      status: "completed",
      conclusion: "failure",
      jobs: [jobs[0]],
      steps: [{ name: "deploy", status: "completed", conclusion: "failure" }]
    });
    expect(result?.steps[0]).not.toBe(steps[0]);
  });

  it.each([
    [null, null],
    [
      { data: {}, includeJobs: true },
      { status: undefined, conclusion: undefined, jobs: [], steps: [] }
    ],
    [
      { data: { status: 2, conclusion: null, jobs: [{}] }, includeJobs: true },
      { status: undefined, conclusion: null, jobs: [{}], steps: [] }
    ],
    [
      {
        data: { conclusion: 3, jobs: [{ steps: [{ name: "ignored" }] }] },
        includeJobs: false
      },
      { status: undefined, conclusion: undefined, jobs: [], steps: [] }
    ]
  ] satisfies [WorkflowRunRead | null, unknown][])(
    "preserves the existing acceptance of %j",
    async (read, expected) => {
      expect(
        await observeWorkflowRun(
          { repo: "org/app", runId: 41 },
          {
            readRun: async () => read
          }
        )
      ).toEqual(expected);
    }
  );

  it("does not hide unexpected read or malformed-step failures", async () => {
    const error = new Error("read failed");
    await expect(
      observeWorkflowRun(
        { repo: "org/app", runId: 41 },
        {
          readRun: () => Promise.reject(error)
        }
      )
    ).rejects.toBe(error);
    await expect(
      observeWorkflowRun(
        { repo: "org/app", runId: 41 },
        {
          readRun: async () => ({
            data: { jobs: [{ steps: 3 }] },
            includeJobs: true
          })
        }
      )
    ).rejects.toThrow();
  });
});
