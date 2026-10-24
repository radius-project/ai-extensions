import { expect, it, vi } from "vitest";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createDeploymentPipelineRunner } from "../../support/runtime/deployment.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";

it.each(["template-unavailable", "update-denied"] as const)(
  "refuses selected production HTTP deployment with stale workflows and %s",
  async (failure) => {
    const pipeline = createDeploymentPipelineRunner("failure");
    const writes: Array<{ branch: string; content: string }> = [];
    const run = vi.fn(
      async (...[args, options]: Parameters<typeof pipeline.run>) => {
        if (
          failure === "template-unavailable" &&
          args[1]?.includes("/contents/.github/extension/run-rad-commands")
        ) {
          return { code: 1, stdout: "", stderr: "HTTP 503: template unavailable" };
        }
        if (args.includes("PUT")) {
          writes.push(JSON.parse(String(options?.stdin)));
          return { code: 1, stdout: "", stderr: "HTTP 403: protected branch" };
        }
        return pipeline.run(args, options);
      }
    );
    const executor = successfulSelectedGhExecutor({
      login: "writer",
      requiresKeyringSwitch: true,
      run
    });
    const account = vi.fn(async () => ({
      state: "selected" as const,
      login: executor.login,
      executor
    }));
    const owner = createEnvironmentExecutionOwner();
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      deploymentAccount: account
    });
    const entry = await runtime.getOrCreateServer("workflow-sync", "deploying");
    const target = { repo: "fixture/app", environment: "Preview East" };
    try {
      const response = await fetch(`${entry.baseUrl}/api/deploy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: entry.baseUrl,
          "Sec-Fetch-Site": "same-origin",
          "X-Radius-Mutation-Nonce": String(entry.state.browserMutationNonce)
        },
        body: JSON.stringify({
          targetRepo: target.repo,
          environment: target.environment,
          branch: "feature/model&review=1",
          provider: "aws"
        })
      });
      expect(response.status).toBe(200);
      await response.text();
      await vi.waitFor(
        () => {
          expect(entry.state.deployStatus).toBe("failed");
          expect(runtime.deploymentOwner.activeReservation(target)).toBeUndefined();
        },
        { timeout: 10000 }
      );
      expect(pipeline.unexpected).toEqual([]);
      expect(writes.map(({ branch }) => branch)).toEqual(
        failure === "template-unavailable" ?
          []
        : ["trunk", "trunk", "feature/model&review=1", "feature/model&review=1"]
      );
      expect(entry.state.deployError).toContain("Could not prepare deployment workflows");
      expect(entry.state.deployDispatchEvidence).toBe("refused");
      const status = await fetch(`${entry.baseUrl}/api/deploy-status`);
      expect(status.status).toBe(200);
      const body = await status.json();
      expect(body).toMatchObject({
        status: "failed",
        error: expect.stringContaining("Could not prepare deployment workflows")
      });
      expect(body).not.toHaveProperty("generationFailures");
      expect(body).not.toHaveProperty("synchronized");
      expect(run.mock.calls.filter(([args]) => args[0] === "workflow")).toEqual([]);
      expect(run.mock.calls.some(([args]) => args[0] === "auth")).toBe(false);
      expect(account).toHaveBeenCalledOnce();
      expect(run.mock.calls.filter(([args]) => args[1]?.includes("/contents/.radius/app.bicep"))).toEqual([
        [
          ["api", "/repos/fixture/app/contents/.radius/app.bicep?ref=feature%2Fmodel%26review%3D1"],
          { timeout: 15000 }
        ]
      ]);
    } finally {
      owner.shutdown();
      await runtime.stopServer("workflow-sync", true);
    }
  }
);
