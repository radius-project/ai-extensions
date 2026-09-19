import { describe, expect, it, vi } from "vitest";
import {
  createDeploymentAbandonmentService,
  type DeploymentAbandonmentDependencies
} from "./deployment-abandonment.js";
import type { DeploymentState } from "./types.js";
import {
  activeDeploymentMutation,
  reserveDeploymentMutation,
  releaseDeploymentMutation,
  deploymentStatusBlocksMutation,
  localDeploymentBlocksMutation
} from "./mutation.js";

describe("standalone deployment abandonment", () => {
  it.each([
    null,
    {},
    { repo: "acme/app" },
    { repo: "invalid", environment: "dev", application: "app" }
  ])(
    "rejects an incomplete identity %j without external work",
    async (invalid) => {
      const service = createDeploymentAbandonmentService(
        dependencies({
          resolveEnvDeployment: async () => {
            throw new Error("Must validate before reading");
          }
        })
      );
      expect(
        (await service.abandon({ state: {}, payload: invalid })).status
      ).toBe(400);
    }
  );
  function dependencies(
    overrides: Partial<DeploymentAbandonmentDependencies> = {}
  ): DeploymentAbandonmentDependencies {
    return {
      isValidRepoSlug: (repo) => repo === "acme/app",
      activeDeploymentMutation: (state) => activeDeploymentMutation(state, 0),
      reserveDeploymentMutation: (state, request) =>
        reserveDeploymentMutation(state, request, 0),
      releaseDeploymentMutation,
      deploymentStatusBlocksMutation,
      localDeploymentBlocksMutation: (state) =>
        localDeploymentBlocksMutation(state, 0),
      resolveEnvDeployment: async () => ({
        app: "app",
        environment: "dev",
        provider: "aws",
        status: "delete-failed",
        deploymentId: "8",
        runUrl: "https://github.com/acme/app/actions/runs/7"
      }),
      ghOrThrow: async () => {
        throw new Error("Unexpected GitHub write");
      },
      invalidateDeployListCache: () => {},
      ...overrides
    };
  }
  const payload = { repo: "acme/app", environment: "dev", application: "app" };

  it("only marks failed tracking inactive, keeps cloud resources and retires matching attempt identity", async () => {
    const state: DeploymentState = {
      deployAttempt: { id: "1", targetRepo: "acme/app", environment: "dev" },
      deployStatus: "failed"
    };
    const ghOrThrow = vi.fn(async () => "");
    const service = createDeploymentAbandonmentService(
      dependencies({ ghOrThrow })
    );
    expect(await service.abandon({ state, payload })).toEqual({
      status: 200,
      body: { outcome: "abandoned" }
    });
    expect(ghOrThrow).toHaveBeenCalledWith(
      expect.arrayContaining([
        "POST",
        "/repos/acme/app/deployments/8/statuses",
        "state=inactive"
      ])
    );
    expect(state).toEqual({});
  });

  it("refuses unreadable deployment state before writing and releases the reservation", async () => {
    const state: DeploymentState = {};
    const service = createDeploymentAbandonmentService(
      dependencies({
        resolveEnvDeployment: async () => {
          throw new Error("unavailable");
        }
      })
    );
    expect((await service.abandon({ state, payload })).status).toBe(503);
    expect(state.deploymentMutation).toBeUndefined();
  });

  it("does not clear tracking when GitHub refuses the inactive status mutation", async () => {
    const state: DeploymentState = {
      deployStatus: "failed",
      deployAttempt: { id: "1", targetRepo: "acme/app", environment: "dev" }
    };
    const service = createDeploymentAbandonmentService(dependencies());
    expect((await service.abandon({ state, payload })).status).toBe(502);
    expect(state.deployAttempt?.id).toBe("1");
    expect(state.deploymentMutation).toBeUndefined();
  });
});
