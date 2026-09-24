import { describe, expect, it } from "vitest";
import {
  collectWorkflowFailure,
  observeWorkflowRun
} from "@radius-project/core";
import {
  readWorkflowRun,
  readWorkflowLog,
  type WorkflowExecution,
  type WorkflowRunner
} from "./workflow-reads.js";

describe("non-Canvas workflow caller with real core and shared reads", () => {
  it.each(["success", "failure"])(
    "observes %s with only explicitly targeted reads",
    async (conclusion) => {
      const transcript: unknown[] = [];
      const run: WorkflowRunner = async (args, options) => {
        transcript.push([args, options]);
        if (
          args.join(" ") ===
          "run view 41 --json status,conclusion,jobs --repo org/app"
        ) {
          return {
            code: 0,
            stdout: JSON.stringify({
              status: "completed",
              conclusion,
              jobs: [{ steps: [{ name: "Run rad commands", conclusion }] }]
            }),
            stderr: ""
          };
        }
        if (
          conclusion === "failure" &&
          args.join(" ") === "run view 41 --log --repo org/app"
        ) {
          return { code: 0, stdout: "Error: recipe failed", stderr: "" };
        }
        throw new Error("Unexpected command: " + args.join(" "));
      };
      const execution: WorkflowExecution = { mode: "ambient", run };
      const target = Object.freeze({ repo: "org/app", runId: 41 });
      const observed = await observeWorkflowRun(target, {
        readRun: (repo, runId) => readWorkflowRun(execution, repo, runId)
      });
      expect(observed?.conclusion).toBe(conclusion);
      if (!observed) throw new Error("Expected observation");
      Object.freeze(observed.steps);
      Object.freeze(observed);
      if (conclusion === "failure") {
        const failure = await collectWorkflowFailure(
          target,
          observed,
          { resourcesTouched: true },
          {
            readLog: (repo, runId) => readWorkflowLog(execution, repo, runId),
            readControlPlaneLog: async () => {
              transcript.push("control-plane");
              return null;
            }
          }
        );
        expect(failure.message).toContain("Failed step: Run rad commands.");
        expect(failure.radiusError).toBe("Error: recipe failed");
      }
      expect(transcript).toEqual([
        [
          [
            "run",
            "view",
            "41",
            "--json",
            "status,conclusion,jobs",
            "--repo",
            "org/app"
          ],
          { timeout: 15000 }
        ],
        ...(conclusion === "failure" ?
          [
            [
              ["run", "view", "41", "--log", "--repo", "org/app"],
              { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }
            ],
            "control-plane"
          ]
        : [])
      ]);
    }
  );

  it.each(["ambient", "selected"] as const)(
    "keeps %s combined-read fallback and normalizes only the accepted payload",
    async (mode) => {
      for (const first of ["", "null", "[]", "{", "3"]) {
        const calls: string[][] = [];
        const run: WorkflowRunner = async (args, options) => {
          calls.push(args);
          expect(options).toEqual({ timeout: 15000 });
          return {
            code: 0,
            stdout:
              calls.length === 1 ?
                first
              : '{"status":"completed","conclusion":"success","jobs":[{"steps":[{"name":"ignored"}]}]}',
            stderr: ""
          };
        };
        const execution: WorkflowExecution =
          mode === "ambient" ?
            { mode, run }
          : { mode, executor: { login: "alice", run, errorMessage: String } };
        const result = await observeWorkflowRun(
          { repo: "org/app", runId: 41 },
          {
            readRun: (repo, runId) => readWorkflowRun(execution, repo, runId)
          }
        );
        expect(result).toEqual({
          status: "completed",
          conclusion: "success",
          jobs: [],
          steps: []
        });
        expect(calls.map((args) => args[4])).toEqual([
          "status,conclusion,jobs",
          "status,conclusion"
        ]);
      }
    }
  );

  it("does not probe authorization or an account after ambient failure", async () => {
    const calls: string[][] = [];
    const execution: WorkflowExecution = {
      mode: "ambient",
      run: async (args) => {
        calls.push(args);
        return { code: 1, stdout: "", stderr: "HTTP 404" };
      }
    };
    expect(await readWorkflowRun(execution, "org/app", 41)).toBeNull();
    expect(await readWorkflowLog(execution, "org/app", 41)).toBeNull();
    expect(calls).toEqual([
      [
        "run",
        "view",
        "41",
        "--json",
        "status,conclusion,jobs",
        "--repo",
        "org/app"
      ],
      ["run", "view", "41", "--json", "status,conclusion", "--repo", "org/app"],
      ["run", "view", "41", "--log", "--repo", "org/app"]
    ]);
  });
});
