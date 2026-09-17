import { expect, it } from "vitest";
import { createDeploymentFixture } from "../../support/lifecycle-deployment.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";

it.each([
  "success",
  "saveFailure",
  "missing",
  "cancelled",
  "foreign",
  "uncertain"
] as const)(
  "panel-free deployment observes %s without redispatch or repair",
  async (mode) => {
    const fixture = createDeploymentFixture();
    fixture.state.saveFailure = mode === "saveFailure";
    fixture.state.artifact = mode !== "missing";
    fixture.state.conclusion =
      mode === "missing" ? "failure"
      : mode === "cancelled" ? "cancelled"
      : "success";
    fixture.state.foreign = mode === "foreign";
    fixture.state.timedOut = mode === "uncertain";
    fixture.state.noRuns = mode === "uncertain";
    const runtime = await createRuntimeSdkHarness({
      lifecycle: fixture.binding
    });
    try {
      const tool = runtime.extension.tools.find(
        (entry) => entry.name === "radius_lifecycle"
      );
      if (!tool) throw new Error("Missing public lifecycle tool");
      const accepted = JSON.parse(
        String(
          await tool.handler({
            operation: "deployment.start",
            target: fixture.target,
            input: {
              approvalRef: "trusted-approval",
              repairPolicy: { mode: "manual", maxAttempts: 0 }
            }
          })
        )
      );
      expect(accepted).toMatchObject({
        operation: "deployment.start",
        result: { state: "queued" }
      });
      for (let read = 0; read < 100; read++) {
        const result = JSON.parse(
          String(
            await tool.handler({
              operation: "operation.get",
              target: {
                repo: "owner/repo",
                environment: "dev",
                application: "app"
              },
              input: { operationId: accepted.result.operationId }
            })
          )
        );
        expect(result).toMatchObject({
          result: {
            state:
              mode === "success" ? "succeeded"
              : mode === "saveFailure" || mode === "missing" ? "failed"
              : mode === "cancelled" ? "cancelled"
              : "queued"
          }
        });
      }
      const retainedStatus = runtime.extension.tools.find(
        (entry) => entry.name === "radius_deploy_status"
      );
      const retainedStart = runtime.extension.tools.find(
        (entry) => entry.name === "radius_deploy"
      );
      if (!retainedStatus || !retainedStart)
        throw new Error("Missing retained deployment tools");
      expect(
        JSON.parse(String(await retainedStatus.handler({})))
      ).toMatchObject({
        operation: "operation.get",
        result: { operationId: accepted.result.operationId }
      });
      expect(
        JSON.parse(String(await retainedStart.handler({})))
      ).toHaveProperty("error");
      expect(fixture.state.dispatches).toHaveLength(1);
      expect(runtime.getOrCreateServer).not.toHaveBeenCalled();
      expect(runtime.session.rpc.canvas.open).not.toHaveBeenCalled();
    } finally {
      await runtime.extension.shutdown("test");
      await fixture.close();
    }
  }
);
it("rejects changed published source before workflow preparation or dispatch", async () => {
  const fixture = createDeploymentFixture();
  try {
    fixture.state.wrongCommit = true;
    expect(await fixture.start()).toMatchObject({
      error: { code: "SOURCE_CHANGED" }
    });
    expect(fixture.state.dispatches).toEqual([]);
    expect(fixture.state.prepared).toBeUndefined();
  } finally {
    await fixture.close();
  }
});
