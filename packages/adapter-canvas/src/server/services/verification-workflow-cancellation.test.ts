import { describe, expect, it } from "vitest";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import {
  cancelVerificationWorkflow,
  readVerificationWorkflowIdentity,
  readVerificationWorkflowState
} from "./verification-workflow-cancellation.js";

const identity = { repo: "contoso/store", runId: "42" };
const executor = successfulSelectedGhExecutor();

describe("verification workflow cancellation", () => {
  it("requires the exact persisted repository and run id", () => {
    expect(
      readVerificationWorkflowIdentity({
        repo: "contoso/store",
        verification: { runId: 42 }
      })
    ).toEqual(identity);
    expect(readVerificationWorkflowIdentity({ repo: "contoso/store" })).toBe(
      null
    );
  });

  it("classifies active and completed workflow states", async () => {
    await expect(
      readVerificationWorkflowState(executor, identity, {
        run: async () => ({
          code: 0,
          stdout: '{"status":"queued"}',
          stderr: ""
        })
      })
    ).resolves.toBe("active");
    await expect(
      readVerificationWorkflowState(executor, identity, {
        run: async () => ({
          code: 0,
          stdout: '{"status":"completed"}',
          stderr: ""
        })
      })
    ).resolves.toBe("inactive");
  });

  it("surfaces failed and malformed status reads", async () => {
    await expect(
      readVerificationWorkflowState(executor, identity, {
        run: async () => ({ code: 1, stdout: "", stderr: "denied" })
      })
    ).rejects.toThrow("denied");
    await expect(
      readVerificationWorkflowState(executor, identity, {
        run: async () => ({ code: 0, stdout: "{}", stderr: "" })
      })
    ).rejects.toThrow("no workflow status");
    await expect(
      readVerificationWorkflowState(executor, identity, {
        run: async () => ({ code: 0, stdout: "{", stderr: "" })
      })
    ).rejects.toThrow("unreadable workflow status");
  });

  it("cancels only the exact run and waits until it is inactive", async () => {
    const calls: string[][] = [];
    let reads = 0;
    await expect(
      cancelVerificationWorkflow(executor, identity, {
        run: async (_executor, args) => {
          calls.push(args);
          if (args[0] === "api") return { code: 0, stdout: "", stderr: "" };
          reads += 1;
          return {
            code: 0,
            stdout: JSON.stringify({
              status: reads < 3 ? "in_progress" : "completed"
            }),
            stderr: ""
          };
        },
        sleep: async () => {}
      })
    ).resolves.toBe("inactive");
    expect(calls).toContainEqual([
      "api",
      "--method",
      "POST",
      "repos/contoso/store/actions/runs/42/cancel"
    ]);
  });

  it("is idempotent when the run already finished", async () => {
    const calls: string[][] = [];
    await expect(
      cancelVerificationWorkflow(executor, identity, {
        run: async (_executor, args) => {
          calls.push(args);
          return {
            code: 0,
            stdout: '{"status":"completed"}',
            stderr: ""
          };
        },
        sleep: async () => {}
      })
    ).resolves.toBe("inactive");
    expect(calls).toHaveLength(1);
  });

  it("reports a still-active accepted cancellation", async () => {
    await expect(
      cancelVerificationWorkflow(executor, identity, {
        run: async (_executor, args) =>
          args[0] === "api" ?
            { code: 0, stdout: "", stderr: "" }
          : { code: 0, stdout: '{"status":"in_progress"}', stderr: "" },
        sleep: async () => {}
      })
    ).resolves.toBe("cancelling");
  });

  it("rechecks a failed cancellation in case the exact run already finished", async () => {
    let reads = 0;
    await expect(
      cancelVerificationWorkflow(executor, identity, {
        run: async (_executor, args) => {
          if (args[0] === "api") {
            return { code: 1, stdout: "", stderr: "cannot cancel" };
          }
          reads += 1;
          return {
            code: 0,
            stdout: JSON.stringify({
              status: reads === 1 ? "in_progress" : "completed"
            }),
            stderr: ""
          };
        },
        sleep: async () => {}
      })
    ).resolves.toBe("inactive");
  });

  it("surfaces a failed cancellation while the exact run remains active", async () => {
    await expect(
      cancelVerificationWorkflow(executor, identity, {
        run: async (_executor, args) =>
          args[0] === "api" ?
            { code: 1, stdout: "", stderr: "cannot cancel" }
          : { code: 0, stdout: '{"status":"in_progress"}', stderr: "" },
        sleep: async () => {}
      })
    ).rejects.toThrow("cannot cancel");
  });
});
