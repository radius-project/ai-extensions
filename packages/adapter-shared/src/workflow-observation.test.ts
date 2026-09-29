import { describe, expect, it } from "vitest";
import {
  collectWorkflowFailure,
  confirmedWorkflowConclusion,
  observeWorkflowRun,
  type WorkflowJob
} from "@radius-project/core";
import {
  readWorkflowRun,
  readWorkflowLog,
  type WorkflowExecution,
  type WorkflowRunner
} from "./workflow-reads.js";

function restRun(args: string[], conclusion: string, jobs: WorkflowJob[]) {
  return (
    "HTTP/2 200\n\n" +
    JSON.stringify(
      args[1].includes("/jobs") ?
        { jobs, total_count: jobs.length }
      : { status: "completed", conclusion }
    )
  );
}

describe("non-Canvas workflow caller with real core and shared reads", () => {
  it.each([
    { name: "in-progress", status: "in_progress", fallback: false },
    { name: "missing status", status: undefined, fallback: false },
    {
      name: "completed status-only fallback",
      status: "completed",
      fallback: true
    }
  ])(
    "requires observed completion before collecting $name diagnostics",
    async ({ status, fallback }) => {
      const calls: string[] = [];
      const execution: WorkflowExecution = {
        mode: "ambient",
        run: async (args) => {
          calls.push(args.join(" "));
          if (
            args[0] === "api" &&
            args[1].endsWith("/jobs?per_page=100&page=1")
          ) {
            if (fallback)
              return { code: 1, stderr: "Jobs unavailable", stdout: "" };
            return {
              code: 0,
              stderr: "",
              stdout:
                "HTTP/2 200\n\n" + JSON.stringify({ jobs: [], total_count: 0 })
            };
          }
          if (args[0] === "api")
            return {
              code: 0,
              stderr: "",
              stdout:
                "HTTP/2 200\n\n" +
                JSON.stringify({ status, conclusion: "failure" })
            };
          if (args[3] === "--log")
            return { code: 0, stderr: "", stdout: "Error: observed failure" };
          throw new Error("Unexpected command");
        }
      };
      const target = { repo: "org/app", runId: 41 };
      const observed = await observeWorkflowRun(target, {
        readRun: (repo, runId) => readWorkflowRun(execution, repo, runId)
      });
      if (!observed) throw new Error("Expected observation");
      const result = await collectWorkflowFailure(
        target,
        observed,
        { resourcesTouched: false },
        {
          readLog: (repo, runId) => readWorkflowLog(execution, repo, runId),
          readControlPlaneLog: async () => {
            calls.push("control-plane");
            return null;
          }
        }
      );
      expect(calls).toEqual([
        "api repos/org/app/actions/runs/41 --include --method GET",
        "api repos/org/app/actions/runs/41/jobs?per_page=100&page=1 --include --method GET",
        ...(status === "completed" ?
          ["run view 41 --log --repo org/app", "control-plane"]
        : [])
      ]);
      expect(result).toEqual(
        status === "completed" ?
          {
            message:
              "Deployment failed (failure).\n\nError: observed failure\n\nView the full run: https://github.com/org/app/actions/runs/41",
            radiusError: "Error: observed failure",
            authDriftMessage: "",
            narration: [
              "",
              "──────── failure details ────────",
              "  Error: observed failure",
              "─────────────────────────────────"
            ]
          }
        : {
            message:
              "Workflow outcome is unconfirmed. View the full run: https://github.com/org/app/actions/runs/41",
            radiusError: "",
            authDriftMessage: "",
            narration: []
          }
      );
    }
  );

  it.each(["throw", "null", "primary"] as const)(
    "retains observed primary failure across %s diagnostics and secondary artifact failure",
    async (mode) => {
      const calls: string[] = [];
      const execution: WorkflowExecution = {
        mode: "ambient",
        run: async (args) => {
          calls.push(args.join(" "));
          if (args[0] === "api")
            return {
              code: 0,
              stderr: "",
              stdout: restRun(args, "failure", [
                {
                  name: "deploy",
                  steps: [
                    { name: "Run rad commands", conclusion: "failure" },
                    {
                      name: "Persist Radius state (rad shutdown)",
                      conclusion: "failure"
                    }
                  ]
                }
              ])
            };
          if (args[3] !== "--log") throw new Error("unexpected command");
          if (mode === "throw")
            throw new Error("fixture-private-command-detail");
          return {
            code: mode === "null" ? 1 : 0,
            stderr: "",
            stdout: [
              "deploy\tRun rad commands\t2026-01-01 Error: { primary quota }",
              "deploy\tPersist Radius state (rad shutdown)\t2026-01-01 Error: { shutdown secondary }"
            ].join("\n")
          };
        }
      };
      const target = { repo: "org/app", runId: 41 };
      const observed = await observeWorkflowRun(target, {
        readRun: (repo, runId) => readWorkflowRun(execution, repo, runId)
      });
      if (!observed) throw new Error("expected observed run");
      expect(confirmedWorkflowConclusion(observed)).toBe("failure");
      const result = await collectWorkflowFailure(
        target,
        observed,
        { resourcesTouched: true },
        {
          readLog: (repo, runId) => readWorkflowLog(execution, repo, runId),
          readControlPlaneLog: () => {
            calls.push("control-plane");
            throw new Error("fixture-private-artifact-detail");
          }
        }
      );
      expect(result.message).toContain(
        "Failed step: Run rad commands, Persist Radius state (rad shutdown)."
      );
      expect(result.message).toContain(
        "The control-plane log could not be read."
      );
      expect(
        result.message.includes("The workflow log could not be read.")
      ).toBe(mode === "throw");
      expect(result.radiusError).toBe(
        mode === "primary" ? "Error: { primary quota }" : ""
      );
      expect(JSON.stringify(result)).not.toContain("fixture-private");
      expect(calls).toEqual([
        "api repos/org/app/actions/runs/41 --include --method GET",
        "api repos/org/app/actions/runs/41/jobs?per_page=100&page=1 --include --method GET",
        "run view 41 --log --repo org/app",
        "control-plane"
      ]);
    }
  );

  it.each(["success", "failure"])(
    "observes %s with only explicitly targeted reads",
    async (conclusion) => {
      const transcript: unknown[] = [];
      const job: WorkflowJob = {
        steps: [{ name: "Run rad commands", conclusion }]
      };
      const run: WorkflowRunner = async (args, options) => {
        transcript.push(args);
        if (args[0] === "api") {
          return {
            code: 0,
            stdout: restRun(args, conclusion, [job]),
            stderr: ""
          };
        }
        if (
          conclusion === "failure" &&
          args.join(" ") === "run view 41 --log --repo org/app"
        ) {
          expect(options).toEqual({
            timeout: 30000,
            maxBuffer: 20 * 1024 * 1024
          });
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
          "api",
          "repos/org/app/actions/runs/41",
          "--include",
          "--method",
          "GET"
        ],
        [
          "api",
          "repos/org/app/actions/runs/41/jobs?per_page=100&page=1",
          "--include",
          "--method",
          "GET"
        ],
        ...(conclusion === "failure" ?
          [["run", "view", "41", "--log", "--repo", "org/app"], "control-plane"]
        : [])
      ]);
    }
  );

  it.each(["ambient", "selected"] as const)(
    "leaves malformed %s run evidence unavailable without retrying",
    async (mode) => {
      for (const first of ["", "null", "[]", "{", "3"]) {
        const calls: string[][] = [];
        const run: WorkflowRunner = async (args, options) => {
          calls.push(args);
          expect(options.timeout).toBeGreaterThan(0);
          expect(options.timeout).toBeLessThanOrEqual(15000);
          return {
            code: 0,
            stdout: `HTTP/2 200\n\n${first}`,
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
        expect(result).toBeNull();
        expect(calls).toEqual([
          [
            "api",
            "repos/org/app/actions/runs/41",
            "--include",
            "--method",
            "GET"
          ]
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
      ["api", "repos/org/app/actions/runs/41", "--include", "--method", "GET"],
      ["run", "view", "41", "--log", "--repo", "org/app"]
    ]);
  });
});
