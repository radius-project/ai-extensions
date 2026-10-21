import { describe, expect, it, vi } from "vitest";
import { successfulSelectedGhExecutor } from "../../test/support/server/selected-gh.js";
import { createProductionDeploymentExecutionOwner } from "./production-deployment-execution-owner.js";

describe("production deployment ownership", () => {
  it.each([
    {
      code: 0,
      stderr: "",
      status: "missing",
      allowApplicationFallback: undefined
    },
    {
      code: 1,
      stderr: "HTTP 403: Forbidden",
      status: "auth",
      allowApplicationFallback: false
    }
  ])(
    "pins artifact reads to the invocation executor and reports $status without ambient fallback",
    async ({ code, stderr, status, allowApplicationFallback }) => {
      const owner = createProductionDeploymentExecutionOwner();
      const target = {
        repo: "fixture/app",
        environment: "dev",
        branch: "feature/model",
        provider: "azure",
        appFile: ".radius/app.bicep",
        githubLogin: "fixture-user"
      };
      const run = vi.fn(async () => ({
        code,
        stderr,
        stdout:
          code === 0 ?
            'HTTP/2 200\n\n{"artifacts":[]}'
          : 'HTTP/2 403\n\n{"message":"Forbidden"}'
      }));
      const executor = successfulSelectedGhExecutor({
        login: target.githubLogin,
        run
      });
      const reservation = owner.reserve(target, "deploy");
      if (!reservation) throw new Error("Expected reservation");
      try {
        const accepted = owner.begin({
          target,
          executor,
          reservation,
          state: {}
        });
        if (accepted.kind !== "resolved") throw new Error(accepted.kind);
        const execution = owner.execution(accepted.invocation);
        if (!execution) throw new Error("Expected execution");
        const reader = execution.observation.reader({
          repo: target.repo,
          environment: target.environment,
          application: "app",
          runId: 42,
          allowApplicationFallback
        });
        expect(await reader.graph()).toMatchObject({ status, graph: null });
        expect(run).toHaveBeenCalledOnce();
        expect(run).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.stringContaining(
              "repos/fixture/app/actions/runs/42/artifacts"
            )
          ]),
          expect.objectContaining({
            signal: expect.any(AbortSignal),
            timeout: expect.any(Number)
          })
        );
      } finally {
        owner.shutdown();
        owner.release(reservation);
      }
    }
  );

  it("constructs isolated observations and identity without opening a server or reading GitHub", () => {
    const first = createProductionDeploymentExecutionOwner();
    const second = createProductionDeploymentExecutionOwner();
    const target = {
      repo: "fixture/app",
      environment: "dev",
      branch: "feature/model",
      provider: "azure",
      appFile: ".radius/app.bicep",
      githubLogin: "fixture-user"
    };
    const reservation = first.reserve(target, "deploy");
    if (!reservation) throw new Error("Expected reservation");
    const attempt = first.begin({
      target,
      reservation,
      state: {},
      executor: successfulSelectedGhExecutor({
        login: target.githubLogin,
        run: async () => {
          throw new Error("Unexpected GitHub read");
        }
      })
    });
    if (attempt.kind !== "resolved") throw new Error(attempt.kind);
    const execution = first.execution(attempt.invocation);
    expect(attempt.invocation.attemptId).not.toBe("");
    expect(second.resolve()).toEqual({ kind: "missing" });
    expect(second.activeReservation(target)).toBeUndefined();
    expect(execution?.observation.stopped).toBe(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      first.subscribe(attempt.invocation, () => {
        throw new Error("projection failed");
      });
      expect(error).toHaveBeenCalledWith(
        "[radius deployment-owner] Callback failed:",
        expect.objectContaining({ message: "projection failed" })
      );
    } finally {
      error.mockRestore();
      first.shutdown();
      second.shutdown();
      first.release(reservation);
    }
    expect(execution?.observation.stopped).toBe(true);
  });
});
