import { describe, expect, it, vi } from "vitest";
import { createDeploymentAbandonmentViewService } from "./deployment-abandonment-view.js";
import type { DeploymentAbandonmentService } from "./deployment-abandonment.js";
import { createTestDeploymentRuntime } from "../../../test/support/server/deployment-runtime.js";
import { createDeferred } from "../../../test/support/browser/fakes.js";
import { createDeploymentViews } from "./deployment-views.js";
import type { CanvasState } from "../../shared.js";

function harness() {
  const runtime = createTestDeploymentRuntime();
  const views = createDeploymentViews(runtime);
  function begin(environment = "production") {
    const target = {
      repo: "acme/app",
      environment,
      branch: "feature",
      provider: "azure",
      appFile: ".radius/app.bicep"
    };
    const reservation = runtime.owner.reserve(target, "deploy");
    if (!reservation) throw new Error("Unexpected conflict");
    const invocation = runtime.owner.begin(
      target,
      {
        deployStatus: "failed",
        deployAppName: " APP ",
        deployError: "Original evidence"
      },
      reservation
    );
    invocation.state.deployAttempt = {
      id: invocation.attemptId,
      targetRepo: target.repo,
      environment
    };
    runtime.owner.release(reservation);
    return invocation;
  }
  const first = begin();
  const other = begin("staging");
  const state: CanvasState = {};
  views.attach("view", state, first);
  const abandon = vi.fn<DeploymentAbandonmentService["abandon"]>(async () => ({
    status: 200,
    body: { outcome: "abandoned" }
  }));
  const retire = vi.fn(views.retire);
  const service = createDeploymentAbandonmentViewService({
    service: { abandon },
    owner: runtime.owner,
    retire
  });
  return { runtime, first, other, state, abandon, retire, service, begin };
}

const request = {
  instanceId: "different-view",
  payload: {
    repo: " ACME/app ",
    environment: " PRODUCTION ",
    application: "app"
  }
};

describe("abandonment owner retirement", () => {
  it.each([
    ["https://github.com/acme/app/actions/runs/42", 42, true],
    ["https://github.com/acme/app/actions/runs/42", 43, false],
    [undefined, 42, false]
  ])(
    "retires unknown local identity only for the exact attested run %j / %s",
    async (runUrl, runId, retired) => {
      const h = harness();
      h.first.state.deployAppName = undefined;
      h.first.state.deployRunUrl = runUrl;
      expect(
        await h.service.abandon({
          instanceId: "view",
          payload: {
            repo: "acme/app",
            environment: "production",
            application: "",
            runId
          }
        })
      ).toEqual({ status: 200, body: { outcome: "abandoned" } });
      expect(h.retire.mock.calls).toEqual(retired ? [[h.first]] : []);
      expect(h.runtime.owner.isCurrent(h.first)).toBe(!retired);
      expect(h.runtime.owner.isCurrent(h.other)).toBe(true);
    }
  );

  it("retains local evidence when the service rejects a malformed run identifier", async () => {
    const h = harness();
    h.abandon.mockResolvedValue({
      status: 400,
      body: { error: "Invalid run identifier" }
    });
    const input = {
      ...request,
      payload: { ...request.payload, runId: "42" }
    };
    expect((await h.service.abandon(input)).status).toBe(400);
    expect(h.abandon).toHaveBeenCalledWith(input);
    expect(h.retire).not.toHaveBeenCalled();
    expect(h.runtime.owner.isCurrent(h.first)).toBe(true);
  });

  it.each(["other-app", "", " ", undefined])(
    "preserves evidence for an unrelated or unknown application %j",
    async (application) => {
      const h = harness();
      h.first.state.deployAppName = application;
      expect((await h.service.abandon(request)).status).toBe(200);
      expect(h.retire).not.toHaveBeenCalled();
      expect(h.runtime.owner.isCurrent(h.first)).toBe(true);
      expect(h.state.deployError).toBe("Original evidence");
    }
  );

  it("preserves evidence whose application changes while abandonment is pending", async () => {
    const h = harness();
    const finished =
      createDeferred<
        Awaited<ReturnType<DeploymentAbandonmentService["abandon"]>>
      >();
    h.abandon.mockReturnValue(finished.promise);
    const result = h.service.abandon(request);
    h.first.state.deployAppName = "another-app";
    finished.resolve({ status: 200, body: { outcome: "abandoned" } });
    expect((await result).status).toBe(200);
    expect(h.retire).not.toHaveBeenCalled();
  });

  it("retires only the captured matching target after remote success, across views", async () => {
    const h = harness();
    expect(await h.service.abandon(request)).toEqual({
      status: 200,
      body: { outcome: "abandoned" }
    });
    expect(h.abandon).toHaveBeenCalledWith(request);
    expect(h.retire).toHaveBeenCalledWith(h.first);
    expect(h.runtime.owner.isCurrent(h.first)).toBe(false);
    expect(h.runtime.owner.isCurrent(h.other)).toBe(true);
    expect(h.state.deployStatus).toBeUndefined();
  });

  it.each([400, 409, 502, 503] as const)(
    "preserves evidence on remote refusal/failure %s",
    async (status) => {
      const h = harness();
      const result = { status, body: { error: "Remote guard refused" } };
      h.abandon.mockResolvedValue(result);
      expect(await h.service.abandon(request)).toEqual(result);
      expect(h.retire).not.toHaveBeenCalled();
      expect(h.first.state.deployError).toBe("Original evidence");
      expect(h.runtime.owner.isCurrent(h.first)).toBe(true);
    }
  );

  it("propagates an unexpected remote failure without retiring evidence", async () => {
    const h = harness();
    h.abandon.mockRejectedValue(new Error("GitHub unavailable"));
    await expect(h.service.abandon(request)).rejects.toThrow(
      "GitHub unavailable"
    );
    expect(h.retire).not.toHaveBeenCalled();
  });

  it("does not retire a newer invocation admitted while the earlier operation was pending", async () => {
    const h = harness();
    const finished =
      createDeferred<
        Awaited<ReturnType<DeploymentAbandonmentService["abandon"]>>
      >();
    h.abandon.mockReturnValue(finished.promise);
    const result = h.service.abandon(request);
    const next = h.begin();
    finished.resolve({ status: 200, body: { outcome: "abandoned" } });
    expect((await result).status).toBe(200);
    expect(h.retire).toHaveBeenCalledWith(h.first);
    expect(h.runtime.owner.isCurrent(next)).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { repo: 7 },
    { repo: "acme/app", environment: 9 },
    { repo: " ", environment: "production" },
    { repo: "acme/app", environment: " " },
    { repo: "other/app", environment: "production" },
    { repo: "acme/app", environment: "production", application: 7 },
    { repo: "acme/app", environment: "production", application: " " }
  ])(
    "leaves validation to the existing service and never retires an unrelated target: %j",
    async (payload) => {
      const h = harness();
      await h.service.abandon({ instanceId: "view", payload });
      expect(h.abandon).toHaveBeenCalledWith({ instanceId: "view", payload });
      expect(h.retire).not.toHaveBeenCalled();
      expect(h.runtime.owner.isCurrent(h.first)).toBe(true);
      expect(h.runtime.owner.isCurrent(h.other)).toBe(true);
    }
  );
});
