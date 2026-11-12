import { describe, expect, it, vi } from "vitest";
import { createWorkflowObservationScope } from "@radius-project/adapter-shared";
import { createTestDeploymentRuntime } from "../../support/server/deployment-runtime.js";
import { createFakeDeploymentRuntime } from "../../support/runtime/deployment.js";

const target = {
  repo: "acme/app",
  branch: "feature",
  environment: "production",
  appFile: ".radius/app.bicep"
};

describe.each([
  ["server", createTestDeploymentRuntime],
  ["runtime", createFakeDeploymentRuntime]
] as const)("%s harness production policy parity", (_name, createRuntime) => {
  it.each([
    "../app.bicep",
    "/app.bicep",
    "models/../../app.bicep",
    "C:\\app.bicep"
  ])("refuses unsafe model input %s through admission", async (appFile) => {
    const resolveDeployment = vi.fn(async () => null);
    const runtime = createRuntime({ resolveDeployment });
    const result = await runtime.start({ ...target, appFile });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(resolveDeployment).not.toHaveBeenCalled();
    expect(runtime.owner.lookup()).toEqual({ kind: "missing" });
  });

  it.each(["pending", "in_progress", "deleting"])(
    "refuses the production blocking status %s",
    async (status) => {
      const createExecution = vi.fn(() => {
        throw new Error("Blocked admission must not execute");
      });
      const runtime = createRuntime({
        resolveDeployment: async () => ({ status }),
        createExecution
      });
      expect(await runtime.start(target)).toMatchObject({
        ok: false,
        status: 409,
        error: "A remote deployment operation is already in progress."
      });
      expect(createExecution).not.toHaveBeenCalled();
      expect(runtime.owner.lookup()).toEqual({ kind: "missing" });
    }
  );

  it("normalizes a valid model and permits a settled target", async () => {
    const runtime = createRuntime({
      resolveDeployment: async () => ({ status: "success" }),
      createExecution: () => ({
        observation: createWorkflowObservationScope(() => {
          throw new Error("Unexpected artifact read");
        }),
        monitor: {
          run: async ({ entry }) => {
            entry.state.deployStatus = "success";
          }
        }
      })
    });
    try {
      const result = await runtime.start({
        ...target,
        appFile: "./models/app.bicep"
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.invocation.target.appFile).toBe("models/app.bicep");
    } finally {
      await runtime.owner.shutdown(1000);
    }
  });
});
