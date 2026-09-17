import { expect, it, vi } from "vitest";
import { createDeploymentFixture } from "../../../test/support/lifecycle-deployment.js";
import { createLifecycleDeploymentHttp } from "./lifecycle-deployment.js";
import type { CanvasState } from "../../shared.js";

const request = {
  targetRepo: "owner/repo",
  environment: "dev",
  branch: "feature",
  approvalRef: "trusted-approval"
};

it.each([
  "{",
  "null",
  "true",
  JSON.stringify({}),
  JSON.stringify({ ...request, repo: "other/repo" }),
  JSON.stringify({ ...request, appFile: 7 }),
  JSON.stringify({ ...request, approvalRef: 7 })
])(
  "rejects malformed HTTP admission before source or dispatch (case %#)",
  async (body) => {
    const f = createDeploymentFixture();
    const application = vi.fn(async () => "app");
    const service = createLifecycleDeploymentHttp({
      binding: f.binding,
      state: {},
      resolveApplication: application
    });
    try {
      expect(await service.start(body)).toMatchObject({ status: 400 });
      expect(application).not.toHaveBeenCalled();
      expect(f.state.dispatches).toHaveLength(0);
    } finally {
      await f.close();
    }
  }
);
it("preserves explicit repo and definition compatibility while refusing source drift", async () => {
  const f = createDeploymentFixture();
  const state: CanvasState = {};
  const service = createLifecycleDeploymentHttp({
    binding: f.binding,
    state,
    resolveApplication: async () => "app"
  });
  try {
    f.state.wrongCommit = true;
    expect(
      await service.start(
        JSON.stringify({
          repo: request.targetRepo,
          environment: "dev",
          branch: "feature",
          appFile: ".radius/app.bicep",
          approvalRef: request.approvalRef
        })
      )
    ).toMatchObject({ status: 400, body: { errorKind: "SOURCE_CHANGED" } });
    expect(state.lifecycleDeploymentId).toBeUndefined();
    expect(await service.status()).toMatchObject({
      status: "unconfirmed",
      repairing: false
    });
    await f.binding.close();
    expect(await service.start(JSON.stringify(request))).toMatchObject({
      status: 400,
      body: { error: "Published source unavailable." }
    });
  } finally {
    await f.close();
  }
});
it("rejects wrong response operation discriminants instead of projecting fabricated success", async () => {
  const f = createDeploymentFixture();
  const state: CanvasState = {};
  const service = createLifecycleDeploymentHttp({
    binding: f.binding,
    state,
    resolveApplication: async () => "app"
  });
  try {
    const other = await f.binding.execute({
      operation: "operation.list",
      target: { repo: "owner/repo" },
      input: {}
    });
    if ("error" in other) throw new Error("No capability response");
    vi.spyOn(f.binding, "execute").mockResolvedValue(other);
    await expect(service.start(JSON.stringify(request))).rejects.toThrow(
      "Unexpected lifecycle deployment response"
    );
    await expect(service.status()).rejects.toThrow(
      "Unexpected lifecycle observation response"
    );
    expect(state.lifecycleDeploymentId).toBeUndefined();
    expect(f.state.dispatches).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it("reports a confirmed running workflow without retaining dispatch uncertainty or manufacturing final phases", async () => {
  const f = createDeploymentFixture();
  const service = createLifecycleDeploymentHttp({
    binding: f.binding,
    state: {},
    resolveApplication: async () => "app"
  });
  try {
    expect(
      await service.start(
        JSON.stringify({
          targetRepo: "owner/repo",
          environment: "dev",
          branch: "feature"
        })
      )
    ).toMatchObject({ status: 400 });
    f.state.conclusion = "in_progress";
    expect(await service.start(JSON.stringify(request))).toMatchObject({
      status: 200
    });
    expect(await service.status()).toMatchObject({
      status: "in_progress",
      errorKind: null,
      phases: [],
      repairing: false
    });
  } finally {
    await f.close();
  }
});
