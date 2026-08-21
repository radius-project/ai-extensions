import { describe, expect, it, vi } from "vitest";
import {
  createDeploymentAbandonmentService,
  type DeploymentAbandonmentDependencies,
  type DeploymentAbandonmentReservation
} from "./deployment-abandonment.js";
import type { DeploymentRow } from "./deployment-resolver.js";

const PAYLOAD = {
  repo: "octo/todolist",
  environment: "dev",
  application: "todolist"
};
const ABANDON_LEASE: DeploymentAbandonmentReservation = {
  repo: PAYLOAD.repo,
  environment: PAYLOAD.environment,
  kind: "abandon",
  expiresAt: 10
};

function row(status: string): DeploymentRow {
  return {
    app: PAYLOAD.application,
    environment: PAYLOAD.environment,
    provider: "azure",
    status,
    deploymentId: "dep-dev",
    runUrl: "https://example.test/dev"
  };
}

function dependencies(
  overrides: Partial<DeploymentAbandonmentDependencies> = {}
): DeploymentAbandonmentDependencies {
  return {
    isValidRepoSlug: (value) => value === PAYLOAD.repo,
    readInstanceState: () => ({}),
    activeDeploymentMutation: () => undefined,
    localDeploymentBlocksMutation: () => false,
    reserveDeploymentMutation: () => ABANDON_LEASE,
    releaseDeploymentMutation: () => {},
    deploymentStatusBlocksMutation: (status) =>
      status === "pending" || status === "in_progress" || status === "deleting",
    resolveEnvDeployment: () => Promise.resolve(row("failed")),
    ghOrThrow: () => Promise.resolve(""),
    invalidateDeployListCache: () => {},
    ...overrides
  };
}

function abandon(
  overrides: Partial<DeploymentAbandonmentDependencies> = {},
  payload: unknown = PAYLOAD
) {
  return createDeploymentAbandonmentService(dependencies(overrides)).abandon({
    instanceId: "panel-a",
    payload
  });
}

describe("createDeploymentAbandonmentService", () => {
  it("fails construction when a required dependency is missing", () => {
    const incomplete = dependencies();
    Reflect.deleteProperty(incomplete, "ghOrThrow");

    expect(() => createDeploymentAbandonmentService(incomplete)).toThrow(
      "createDeploymentAbandonmentService is missing required dependencies: ghOrThrow"
    );
  });

  it.each([
    null,
    [],
    {},
    { ...PAYLOAD, repo: [] },
    { ...PAYLOAD, environment: " " },
    { ...PAYLOAD, application: " " },
    { ...PAYLOAD, repo: "invalid" }
  ])("rejects invalid identity %# before reading state", async (payload) => {
    const readInstanceState = vi.fn(() => {
      throw new Error("must reject before reading state");
    });

    await expect(abandon({ readInstanceState }, payload)).resolves.toEqual({
      status: 400,
      body: {
        error:
          "A valid repo, environment, and application are required to abandon deployment tracking."
      }
    });
    expect(readInstanceState).not.toHaveBeenCalled();
  });

  it("fails closed when Canvas state is unavailable", async () => {
    await expect(
      abandon({ readInstanceState: () => undefined })
    ).resolves.toEqual({
      status: 503,
      body: { error: "Canvas server state is unavailable." }
    });
  });

  it.each([
    [
      "deploy",
      true,
      undefined,
      "A deploy operation for octo/todolist in environment dev"
    ],
    [
      "delete",
      false,
      {
        repo: "octo/other",
        environment: "prod",
        kind: "delete",
        expiresAt: 10
      },
      "A delete operation for octo/other in environment prod"
    ],
    [
      "abandon",
      false,
      {
        repo: "octo/other",
        environment: "prod",
        kind: "abandon",
        expiresAt: 10
      },
      "An abandonment operation for octo/other in environment prod"
    ]
  ] as const)(
    "refuses while a %s operation is active",
    async (_kind, localOnly, active, description) => {
      const reserveDeploymentMutation = vi.fn(() => {
        throw new Error("must not reserve while another operation is active");
      });

      const result = await abandon({
        localDeploymentBlocksMutation: () => localOnly,
        activeDeploymentMutation: () => active,
        reserveDeploymentMutation
      });

      expect(result).toEqual({
        status: 409,
        body: {
          error: `${description} is already in progress. Wait for it to finish before abandoning deployment tracking.`
        }
      });
      expect(reserveDeploymentMutation).not.toHaveBeenCalled();
    }
  );

  it("reports an abandonment winner when reservation is lost in a race", async () => {
    let reads = 0;

    const result = await abandon({
      reserveDeploymentMutation: () => null,
      activeDeploymentMutation: () => {
        reads++;
        return reads === 1 ? undefined : (
            {
              repo: "octo/winner",
              environment: "prod",
              kind: "abandon",
              expiresAt: 10
            }
          );
      }
    });

    expect(result).toEqual({
      status: 409,
      body: {
        error:
          "An abandonment operation for octo/winner in environment prod is already starting."
      }
    });
  });

  it("uses a generic race message when no winner can be read", async () => {
    await expect(
      abandon({ reserveDeploymentMutation: () => null })
    ).resolves.toEqual({
      status: 409,
      body: { error: "Another deployment operation is already starting." }
    });
  });

  it("releases the lease when current GitHub state is unavailable", async () => {
    const releaseDeploymentMutation = vi.fn();

    await expect(
      abandon({
        resolveEnvDeployment: () => Promise.reject(new Error("offline")),
        releaseDeploymentMutation
      })
    ).resolves.toEqual({
      status: 503,
      body: {
        error:
          "Could not verify the current deployment state. Check your GitHub connection and try again."
      }
    });
    expect(releaseDeploymentMutation).toHaveBeenCalledWith(
      expect.any(Object),
      ABANDON_LEASE
    );
  });

  it.each([
    [null, "No failed deployment is available to abandon."],
    [row("success"), "Only a failed deployment can be abandoned."],
    [
      row("pending"),
      "This application is still being deployed. Wait for it to finish before abandoning deployment tracking."
    ],
    [
      row("deleting"),
      "This deployment is being deleted and cannot be abandoned."
    ],
    [
      { ...row("failed"), deploymentId: "" },
      "No failed deployment is available to abandon."
    ]
  ] as const)(
    "refuses an ineligible resolved state and releases its lease",
    async (current, error) => {
      const releaseDeploymentMutation = vi.fn();

      await expect(
        abandon({
          resolveEnvDeployment: () => Promise.resolve(current),
          releaseDeploymentMutation
        })
      ).resolves.toEqual({ status: 409, body: { error } });
      expect(releaseDeploymentMutation).toHaveBeenCalledWith(
        expect.any(Object),
        ABANDON_LEASE
      );
    }
  );

  it("marks the failed deployment inactive, evicts cache, and releases the lease", async () => {
    const ghOrThrow = vi.fn<(args: string[]) => Promise<string>>(() =>
      Promise.resolve("")
    );
    const invalidateDeployListCache = vi.fn();
    const releaseDeploymentMutation = vi.fn();

    await expect(
      abandon({
        ghOrThrow,
        invalidateDeployListCache,
        releaseDeploymentMutation
      })
    ).resolves.toEqual({
      status: 200,
      body: { outcome: "abandoned" }
    });
    expect(ghOrThrow).toHaveBeenCalledWith([
      "api",
      "--method",
      "POST",
      "/repos/octo/todolist/deployments/dep-dev/statuses",
      "-f",
      "state=inactive",
      "-f",
      "description=Tracking abandoned in Radius Canvas; cloud resources were not deleted.",
      "-f",
      "log_url=https://example.test/dev"
    ]);
    expect(invalidateDeployListCache).toHaveBeenCalledWith(PAYLOAD.repo);
    expect(releaseDeploymentMutation).toHaveBeenCalledWith(
      expect.any(Object),
      ABANDON_LEASE
    );
  });

  it("omits a blank run URL from the inactive status request", async () => {
    const ghOrThrow = vi.fn<(args: string[]) => Promise<string>>(() =>
      Promise.resolve("")
    );

    await expect(
      abandon({
        resolveEnvDeployment: () =>
          Promise.resolve({ ...row("failed"), runUrl: "" }),
        ghOrThrow
      })
    ).resolves.toMatchObject({ status: 200 });
    expect(ghOrThrow.mock.calls[0]?.[0]).not.toContain(
      expect.stringContaining("log_url=")
    );
  });

  it("reports a GitHub mutation failure without evicting cache and releases the lease", async () => {
    const invalidateDeployListCache = vi.fn();
    const releaseDeploymentMutation = vi.fn();

    await expect(
      abandon({
        ghOrThrow: () => Promise.reject(new Error("denied")),
        invalidateDeployListCache,
        releaseDeploymentMutation
      })
    ).resolves.toEqual({
      status: 502,
      body: {
        error:
          "Could not abandon deployment tracking on GitHub. Cloud resources were not changed."
      }
    });
    expect(invalidateDeployListCache).not.toHaveBeenCalled();
    expect(releaseDeploymentMutation).toHaveBeenCalledWith(
      expect.any(Object),
      ABANDON_LEASE
    );
  });
});
