import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { createRequestContext } from "../../../src/server/request-context.js";
import {
  handleDeploy,
  handleDeployStatus
} from "../../../src/server/routes/deployments.js";
import { createDeploymentFixture } from "../../support/lifecycle-deployment.js";
import type { CanvasState } from "../../../src/shared.js";

it("100 legacy status reads report failure without agent repair or dispatch", async () => {
  const repair = vi.fn(() => false);
  const notice = vi.fn(() => false);
  const server = createServer((request, response) => {
    handleDeployStatus(
      createRequestContext(request, response, "panel", new Map()),
      {
        readInstanceEntry: () => ({
          state: {
            deployStatus: "failed",
            deployError: "Command failed; state-save unavailable."
          }
        }),
        triggerDeployRepairHandoff: repair,
        triggerDeployFailureNotice: notice,
        deployHandoffStatus: () => ({
          state: "idle",
          attempts: 0,
          maxAttempts: 5,
          pending: false
        })
      }
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing HTTP address");
    for (let read = 0; read < 100; read++) {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/deploy-status`
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "failed",
        repairing: false
      });
    }
    expect(repair).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledTimes(100);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

it.each([
  "success",
  "save-failure",
  "missing",
  "foreign",
  "cancelled",
  "timeout"
] as const)(
  "canonical HTTP deployment and 100 status reads preserve %s without repair or redispatch",
  async (scenario) => {
    const fixture = createDeploymentFixture();
    fixture.state.saveFailure = scenario === "save-failure";
    fixture.state.artifact = scenario !== "missing" && scenario !== "cancelled";
    fixture.state.foreign = scenario === "foreign";
    fixture.state.noRuns = scenario === "timeout";
    fixture.state.timedOut = scenario === "timeout";
    fixture.state.conclusion =
      scenario === "cancelled" ? "cancelled" : "success";
    const state: CanvasState = {};
    const entry = { state, deploymentLifecycle: fixture.binding };
    const forbidden = vi.fn(() => {
      throw new Error("Canonical observation attempted legacy work");
    });
    const server = createServer((request, response) => {
      const context = createRequestContext(
        request,
        response,
        "panel",
        new Map()
      );
      const handled =
        request.method === "POST" ?
          handleDeploy(context, {
            readInstanceEntry: () => entry,
            resolveRepoAppName: async () => "app",
            deployRequest: { deploy: forbidden }
          })
        : handleDeployStatus(context, {
            readInstanceEntry: () => entry,
            triggerDeployRepairHandoff: forbidden,
            triggerDeployFailureNotice: forbidden,
            deployHandoffStatus: forbidden
          });
      void handled.catch(() => {
        response.statusCode = 500;
        response.end("Unexpected route failure");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No HTTP address");
      const url = `http://127.0.0.1:${address.port}`;
      const started = await fetch(`${url}/api/deploy`, {
        method: "POST",
        body: JSON.stringify({
          targetRepo: "owner/repo",
          environment: "dev",
          branch: "feature",
          approvalRef: "trusted-approval"
        })
      });
      expect(await started.json()).toMatchObject({
        ok: true,
        status: "unconfirmed"
      });
      expect(started.status).toBe(200);
      const status =
        scenario === "success" ? "success"
        : scenario === "save-failure" ? "failed"
        : scenario === "cancelled" ? "cancelled"
        : "unconfirmed";
      for (let read = 0; read < 100; read++) {
        const response = await fetch(`${url}/api/deploy-status`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          status,
          repairing: false
        });
      }
      expect(fixture.state.dispatches).toHaveLength(1);
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await fixture.close();
    }
  }
);
