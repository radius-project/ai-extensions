import { expect, it } from "vitest";
import { createDeploymentFixture } from "../../test/support/lifecycle-deployment.js";
import { createLifecycleFixture } from "../../test/support/lifecycle.js";
import { lifecycleDeployTool } from "./lifecycle-deploy-tools.js";

it("keeps legacy selection until canonical admission and never fabricates a current operation", async () => {
  const legacy = createLifecycleFixture();
  const canonical = createDeploymentFixture();
  try {
    expect(
      await lifecycleDeployTool(legacy.binding, "start", {})
    ).toBeUndefined();
    expect(
      await lifecycleDeployTool(canonical.binding, "status", {})
    ).toContain("OPERATION_UNAVAILABLE");
    canonical.state.cancelQualification = true;
    expect(await canonical.start()).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(canonical.state.dispatches).toHaveLength(0);
    expect(
      await canonical.binding.execute({
        operation: "operation.get",
        target: { repo: "owner/repo", environment: "dev", application: "app" },
        input: { operationId: "unknown-operation" }
      })
    ).toMatchObject({ error: { code: "OPERATION_UNAVAILABLE" } });
  } finally {
    await legacy.binding.close();
    await canonical.close();
  }
});

it("retains panel-free status for an exact attempt without repair or repeated dispatch", async () => {
  const f = createDeploymentFixture();
  try {
    const started = await f.start();
    if ("error" in started) throw new Error("Deployment unavailable");
    const attemptId = f.identity().attemptId;
    expect(await lifecycleDeployTool(f.binding, "start", {})).toContain(
      "DISPATCH_UNCONFIRMED"
    );
    for (let read = 0; read < 100; read++)
      expect(
        JSON.parse(
          (await lifecycleDeployTool(f.binding, "status", { attemptId })) ??
            "{}"
        )
      ).toMatchObject({
        operation: "operation.get",
        result: { state: "succeeded" }
      });
    expect(
      await lifecycleDeployTool(f.binding, "start", { attemptId })
    ).toContain("CAPABILITY_UNAVAILABLE");
    expect(
      await lifecycleDeployTool(f.binding, "status", { attemptId: "unknown" })
    ).toContain("OPERATION_UNAVAILABLE");
    for (const args of [
      { repo: "other/repo" },
      { environment: "other" },
      { appFile: "other.bicep" },
      { branch: "other" },
      { provider: "azure" }
    ])
      expect(await lifecycleDeployTool(f.binding, "start", args)).toContain(
        "PRECONDITION_FAILED"
      );
    // Repeating a terminal command still needs a new trusted source-bound approval.
    expect(await lifecycleDeployTool(f.binding, "start", {})).toContain(
      "FORBIDDEN"
    );
    expect(
      await f.binding.execute({
        operation: "operation.list",
        target: { repo: "owner/repo" },
        input: {}
      })
    ).toMatchObject({
      operation: "operation.list",
      result: {
        items: expect.arrayContaining([
          expect.objectContaining({
            operationId: f.identity().operationId,
            state: "succeeded"
          })
        ])
      }
    });
    expect(
      await f.binding.execute({
        operation: "operation.list",
        target: { repo: "owner/repo" },
        input: { continuationToken: "unknown" }
      })
    ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    f.binding.routing.transition("deployment", {
      writer: "legacy",
      readers: ["legacy", "lifecycle"],
      controllers: ["legacy", "lifecycle"]
    });
    expect(f.binding.routing.selection("deployment").writer).toBe("legacy");
    expect(
      await lifecycleDeployTool(f.binding, "status", { attemptId })
    ).toContain('"state":"succeeded"');
    expect(await lifecycleDeployTool(f.binding, "start", {})).toContain(
      "PRECONDITION_FAILED"
    );
    expect(await f.start()).toMatchObject({
      error: { code: "CAPABILITY_UNAVAILABLE" }
    });
    expect(f.state.dispatches).toHaveLength(1);
  } finally {
    await f.close();
  }
});
