import { describe, expect, it, vi } from "vitest";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import { verificationBypass } from "./verification-bypass.js";
import { createWorkflowObservationScope } from "./workflow-observation-scope.js";
import type { SelectedGhCommandOptions } from "../../gh.js";

function fixture() {
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === "api")
      return { code: 0, stdout: "RADIUS_MANAGED", stderr: "" };
    if (
      args.slice(0, 3).join(" ") === "variable set RADIUS_VERIFICATION_BYPASSED"
    )
      return { code: 0, stdout: "", stderr: "" };
    throw new Error("Unexpected command");
  });
  const executor = successfulSelectedGhExecutor({ run });
  const scope = createWorkflowObservationScope(() => {
    throw new Error("Unexpected artifact read");
  });
  const op = {
    repo: "fixture/app",
    environment: "dev",
    context: { githubLogin: executor.login },
    verification: { runId: "42" }
  };
  const deps: Parameters<typeof verificationBypass>[1] = {
    getOperation: () => op,
    hasCompleteVerificationIdentity: () => true,
    getSelectedGitHubExecutor: () => executor,
    getRunDetail: vi.fn(async () => ({
      status: "completed",
      conclusion: "failure",
      steps: [{ name: "Verify AKS Access", conclusion: "failure" }]
    })),
    fetchRunLog: vi.fn(
      async () => "Error from server (Forbidden): cannot list resource"
    ),
    extractGitHubActionsStepLog: () => "",
    explainOidcEnterpriseClaim: () => "",
    explainNoSubscriptions: () => "",
    envListCacheDelete: vi.fn(),
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  };
  const input = {
    data: {
      operationId: "setup-1",
      repo: op.repo,
      environment: op.environment,
      runId: "42"
    },
    scope,
    isCurrent: () => true,
    permissionsOnly: true
  };
  return { run, scope, deps, input, op };
}

describe("shared verification bypass", () => {
  it.each([
    "shutdown",
    "stale",
    "repo",
    "environment",
    "run",
    "login",
    "missing-run",
    "missing-login",
    "replacement",
    "removal"
  ] as const)(
    "refuses %s at the final executor boundary without invalidating the listing",
    async (change) => {
      const h = fixture();
      const original = h.deps.getSelectedGitHubExecutor("setup-1");
      if (!original) throw new Error("Missing executor");
      let current = true;
      h.input.isCurrent = () => current;
      let entered = () => {};
      let release = () => {};
      const boundary = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.deps.getSelectedGitHubExecutor = () => ({
        ...original,
        run: async (args: string[], options?: SelectedGhCommandOptions) => {
          if (args[0] === "variable") {
            entered();
            await gate;
            options?.beforeExecute?.();
          }
          return original.run(args, options);
        }
      });
      try {
        const pending = verificationBypass(h.input, h.deps);
        await boundary;
        if (change === "shutdown") h.scope.stop();
        if (change === "stale") current = false;
        if (change === "repo") h.op.repo = "fixture/other";
        if (change === "environment") h.op.environment = "other";
        if (change === "run") h.op.verification.runId = "43";
        if (change === "login") h.op.context.githubLogin = "other-account";
        if (change === "missing-run")
          Object.assign(h.op, { verification: null });
        if (change === "missing-login") Object.assign(h.op, { context: null });
        if (change === "replacement") {
          const replacement = structuredClone(h.op);
          h.deps.getOperation = () => replacement;
        }
        if (change === "removal") h.deps.getOperation = () => null;
        release();
        expect(await pending).toMatchObject({
          status: 503,
          body: { code: "workflow-observation-stopped" }
        });
        expect(h.run.mock.calls.some(([args]) => args[0] === "variable")).toBe(
          false
        );
        expect(h.deps.envListCacheDelete).not.toHaveBeenCalled();
      } finally {
        release();
        h.scope.stop();
      }
    }
  );
  it("does not write when observation stops during failure classification", async () => {
    const h = fixture();
    h.deps.explainNoSubscriptions = () => {
      h.scope.stop();
      return "";
    };
    try {
      expect(await verificationBypass(h.input, h.deps)).toMatchObject({
        status: 503,
        body: { error: "Workflow observation stopped." }
      });
      expect(h.run.mock.calls.some(([args]) => args[0] === "variable")).toBe(
        false
      );
      expect(h.deps.envListCacheDelete).not.toHaveBeenCalled();
    } finally {
      h.scope.stop();
    }
  });
  it.each(["missing-steps", "oidc-help"] as const)(
    "does not authorize bypass from %s evidence",
    async (evidence) => {
      const h = fixture();
      if (evidence === "missing-steps")
        vi.mocked(h.deps.getRunDetail).mockResolvedValue({
          status: "completed",
          conclusion: "failure"
        });
      else
        h.deps.explainOidcEnterpriseClaim = () =>
          "Repair the enterprise OIDC claim.";
      try {
        expect((await verificationBypass(h.input, h.deps)).status).toBe(409);
        expect(h.run.mock.calls.some(([args]) => args[0] === "variable")).toBe(
          false
        );
      } finally {
        h.scope.stop();
      }
    }
  );
  it.each([true, false])(
    "preserves Canvas reachability bypass while permissionsOnly=%s fences tools",
    async (permissionsOnly) => {
      const h = fixture();
      h.input.permissionsOnly = permissionsOnly;
      vi.mocked(h.deps.fetchRunLog).mockResolvedValue(
        "Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout"
      );
      try {
        expect(await verificationBypass(h.input, h.deps)).toMatchObject({
          status: permissionsOnly ? 409 : 200
        });
        expect(h.run.mock.calls.some(([args]) => args[0] === "variable")).toBe(
          !permissionsOnly
        );
      } finally {
        h.scope.stop();
      }
    }
  );
  it.each(["missing-run", "missing-login"] as const)(
    "refuses recovered records with %s",
    async (missing) => {
      const h = fixture();
      h.deps.getOperation = () => ({
        ...h.op,
        ...(missing === "missing-run" ?
          { verification: null }
        : { context: {} })
      });
      try {
        expect((await verificationBypass(h.input, h.deps)).status).toBe(409);
        expect(h.run).not.toHaveBeenCalled();
      } finally {
        h.scope.stop();
      }
    }
  );
  it.each(["stdout", "empty"] as const)(
    "preserves a failed marker write with %s error output",
    async (output) => {
      const h = fixture();
      h.run.mockImplementation(async (args) =>
        args[0] === "api" ?
          { code: 0, stdout: "RADIUS_MANAGED", stderr: "" }
        : {
            code: 1,
            stdout: output === "stdout" ? "write refused" : "",
            stderr: ""
          }
      );
      try {
        expect(await verificationBypass(h.input, h.deps)).toMatchObject({
          status: 500,
          body: {
            error: expect.stringContaining(
              output === "stdout" ? "write refused" : "gh variable set failed"
            )
          }
        });
        expect(h.deps.envListCacheDelete).not.toHaveBeenCalled();
      } finally {
        h.scope.stop();
      }
    }
  );
  it.each(["stdout", "empty"] as const)(
    "fails closed when environment lookup fails with %s output",
    async (output) => {
      const h = fixture();
      h.run.mockResolvedValue({
        code: 1,
        stdout: output === "stdout" ? "read refused" : "",
        stderr: ""
      });
      try {
        expect(await verificationBypass(h.input, h.deps)).toMatchObject({
          status: 502,
          body: {
            error: expect.stringContaining(
              output === "stdout" ? "read refused" : "gh api failed"
            )
          }
        });
        expect(h.deps.getRunDetail).not.toHaveBeenCalled();
      } finally {
        h.scope.stop();
      }
    }
  );
  it("refuses an empty managed-environment response", async () => {
    const h = fixture();
    h.run.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    try {
      expect((await verificationBypass(h.input, h.deps)).status).toBe(409);
      expect(h.deps.getRunDetail).not.toHaveBeenCalled();
    } finally {
      h.scope.stop();
    }
  });
  it("rechecks permissions evidence and writes only the exact saved run marker", async () => {
    const h = fixture();
    try {
      expect(await verificationBypass(h.input, h.deps)).toEqual({
        status: 200,
        body: { success: true, category: "permissions" }
      });
      expect(h.run).toHaveBeenLastCalledWith(
        [
          "variable",
          "set",
          "RADIUS_VERIFICATION_BYPASSED",
          "--body",
          "42",
          "--env",
          "dev",
          "--repo",
          "fixture/app"
        ],
        { timeout: 20000, beforeExecute: expect.any(Function) }
      );
      expect(h.deps.envListCacheDelete).toHaveBeenCalledExactlyOnceWith(
        "fixture/app"
      );
    } finally {
      h.scope.stop();
    }
  });
  it.each(["before", "after-log"])(
    "refuses a stale command %s",
    async (when) => {
      const h = fixture();
      let current = when !== "before";
      h.input.isCurrent = () => current;
      vi.mocked(h.deps.fetchRunLog).mockImplementation(async () => {
        current = false;
        return "Error from server (Forbidden): cannot list resource";
      });
      try {
        expect((await verificationBypass(h.input, h.deps)).status).toBe(503);
        expect(h.run.mock.calls.some(([args]) => args[0] === "variable")).toBe(
          false
        );
      } finally {
        h.scope.stop();
      }
    }
  );
  it("does not extend tool bypass eligibility to a generic or unreadable failure", async () => {
    const h = fixture();
    vi.mocked(h.deps.fetchRunLog).mockResolvedValue("");
    try {
      expect((await verificationBypass(h.input, h.deps)).status).toBe(409);
      expect(h.run.mock.calls.some(([args]) => args[0] === "variable")).toBe(
        false
      );
    } finally {
      h.scope.stop();
    }
  });
});
