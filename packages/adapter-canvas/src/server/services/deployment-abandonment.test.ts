import { describe, expect, it, vi } from "vitest";
import {
  createDeploymentAbandonmentService,
  type DeploymentAbandonmentDependencies,
  type DeploymentAbandonmentReservation
} from "./deployment-abandonment.js";
import type { DeploymentRow } from "./deployment-resolver.js";
import type { CanvasState } from "../../shared.js";
import { cleanupMarker } from "@radius-project/adapter-shared";

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
    identity: { state: "known", application: PAYLOAD.application },
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
    resolveEnvDeployment: () => Promise.resolve(row("delete-failed")),
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
  it.each(["unknown", "known"] as const)(
    "attests external cleanup of the exact %s run without hiding older deployments",
    async (identity) => {
      const current: DeploymentRow = {
        ...row("failed"),
        app: identity === "known" ? PAYLOAD.application : "",
        identity:
          identity === "known" ?
            { state: "known", application: PAYLOAD.application }
          : { state: "unavailable", reason: "Identity artifacts expired." },
        deploymentId: "3",
        runUrl: `https://github.com/${PAYLOAD.repo}/actions/runs/42`,
        recovery: {
          runId: 42,
          runAttempt: 1,
          revision: "a".repeat(64),
          deploymentIds: ["3", "2"],
          confirmation:
            identity === "known" ?
              `${PAYLOAD.application}/dev`
            : `${PAYLOAD.repo}/run-42@1/dev`,
          canMarkCleanupComplete: true
        }
      };
      const recovery = current.recovery;
      if (!recovery) throw new Error("Missing fixture recovery");
      const markers = new Map<string, string>();
      const marker = cleanupMarker(recovery);
      const ghOrThrow = vi.fn(async (args: string[]) => {
        const endpoint = args.find((arg) => arg.includes("/deployments/"));
        const id = /deployments\/(\d+)/.exec(endpoint || "")?.[1];
        if (!id) throw new Error("Unexpected external operation");
        if (args.includes("POST")) {
          expect(args).toContain("auto_inactive=false");
          expect(args).toContain(`log_url=${current.runUrl}`);
          markers.set(id, marker);
          return "";
        }
        return markers.get(id) || "";
      });
      const payload = {
        ...PAYLOAD,
        application: current.app,
        ...recovery,
        deploymentId: current.deploymentId,
        runUrl: current.runUrl
      };
      expect(
        await abandon(
          {
            ghOrThrow,
            resolveEnvDeployment: async () =>
              markers.size === 2 ? row("success") : current
          },
          payload
        )
      ).toEqual({ status: 200, body: { outcome: "abandoned" } });
      expect(markers).toEqual(
        new Map([
          ["3", marker],
          ["2", marker]
        ])
      );
      expect(ghOrThrow.mock.calls.every(([args]) => args[0] === "api")).toBe(
        true
      );
    }
  );

  it.each([
    "active",
    "revision",
    "run",
    "attempt",
    "confirmation",
    "unknown-to-known"
  ] as const)("refuses %s recovery before any marker write", async (reason) => {
    const recovery = {
      runId: 42,
      runAttempt: 1,
      revision: "a".repeat(64),
      deploymentIds: ["3"],
      confirmation: "todolist/dev",
      canMarkCleanupComplete: true
    };
    const current: DeploymentRow = { ...row("failed"), recovery };
    const ghOrThrow = vi.fn(async () => "");
    const payload = {
      ...PAYLOAD,
      ...recovery,
      deploymentId: current.deploymentId,
      runUrl: current.runUrl
    };
    if (reason === "active") recovery.canMarkCleanupComplete = false;
    if (reason === "revision") payload.revision = "b".repeat(64);
    if (reason === "run") payload.runId = 43;
    if (reason === "attempt") payload.runAttempt = 2;
    if (reason === "confirmation") payload.confirmation = "incorrect";
    if (reason === "unknown-to-known") payload.application = "";
    const result = await abandon(
      { ghOrThrow, resolveEnvDeployment: async () => current },
      payload
    );
    expect(result.status).toBe(
      reason === "confirmation" || reason === "unknown-to-known" ? 400 : 409
    );
    expect(ghOrThrow).not.toHaveBeenCalled();
  });

  it("keeps partial-marker failure effective and retries only missing writes", async () => {
    const recovery = {
      runId: 42,
      runAttempt: 1,
      revision: "a".repeat(64),
      deploymentIds: ["3", "2"],
      confirmation: "todolist/dev",
      canMarkCleanupComplete: true
    };
    const current: DeploymentRow = { ...row("delete-failed"), recovery };
    const markers = new Set<string>();
    let fail = true;
    const writes: string[] = [];
    const ghOrThrow = vi.fn(async (args: string[]) => {
      const id =
        args.find((arg) => arg.includes("/deployments/"))?.includes("/3/") ?
          "3"
        : "2";
      if (args.includes("POST")) {
        writes.push(id);
        if (id === "2" && fail) throw new Error("write refused");
        markers.add(id);
        return "";
      }
      return markers.has(id) ? cleanupMarker(recovery) : "";
    });
    const options = {
      ghOrThrow,
      resolveEnvDeployment: async () => (markers.size === 2 ? null : current)
    };
    const payload = {
      ...PAYLOAD,
      ...recovery,
      deploymentId: current.deploymentId,
      runUrl: current.runUrl
    };
    expect((await abandon(options, payload)).status).toBe(502);
    expect(markers.size).toBe(1);
    fail = false;
    expect((await abandon(options, payload)).status).toBe(200);
    expect(writes).toEqual(["3", "2", "2"]);
  });

  it.each(["still tracked", "read failure", "string rejection"] as const)(
    "does not retire local tracking when marker verification reports %s",
    async (failure) => {
      const recovery = {
        runId: 42,
        runAttempt: 1,
        revision: "a".repeat(64),
        deploymentIds: ["3"],
        confirmation: "todolist/dev",
        canMarkCleanupComplete: true
      };
      const current: DeploymentRow = { ...row("failed"), recovery };
      const state: CanvasState = {
        deployAttempt: {
          id: "original",
          targetRepo: PAYLOAD.repo,
          environment: PAYLOAD.environment
        },
        deployAppName: PAYLOAD.application,
        deployRunId: "42",
        deployStatus: "failed"
      };
      const before = structuredClone(state);
      const invalidateDeployListCache = vi.fn();
      const releaseDeploymentMutation = vi.fn();
      let reads = 0;
      const result = await abandon(
        {
          readInstanceState: () => state,
          invalidateDeployListCache,
          releaseDeploymentMutation,
          resolveEnvDeployment: async () => {
            if (++reads === 1 || failure === "still tracked") return current;
            if (failure === "read failure")
              throw new Error("GitHub history unavailable");
            throw "GitHub history unavailable";
          },
          ghOrThrow: async (args) => {
            if (args.some((arg) => arg.includes("/deployments/3/statuses")))
              return "";
            throw new Error("Unexpected external operation");
          }
        },
        {
          ...PAYLOAD,
          ...recovery,
          deploymentId: current.deploymentId,
          runUrl: current.runUrl
        }
      );
      expect(result.status).toBe(502);
      expect(result.body).toMatchObject({
        error: expect.stringMatching(/Tracking (remains|may remain) effective/)
      });
      expect(state).toEqual(before);
      expect(invalidateDeployListCache).toHaveBeenCalledWith(PAYLOAD.repo);
      expect(releaseDeploymentMutation).toHaveBeenCalledWith(
        expect.any(Object),
        ABANDON_LEASE
      );
    }
  );

  it("requires exact-run confirmation when the listing acquires recovery evidence", async () => {
    const ghOrThrow = vi.fn(async () => "");
    const current: DeploymentRow = {
      ...row("delete-failed"),
      recovery: {
        runId: 42,
        runAttempt: 1,
        revision: "a".repeat(64),
        deploymentIds: ["3"],
        confirmation: "todolist/dev",
        canMarkCleanupComplete: true
      }
    };
    expect(
      await abandon({
        ghOrThrow,
        resolveEnvDeployment: async () => current
      })
    ).toMatchObject({
      status: 409,
      body: { error: expect.stringContaining("exact recorded run") }
    });
    expect(ghOrThrow).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { state: "unavailable" as const, reason: "expired" },
    { state: "unavailable" as const, reason: "denied", readFailed: true },
    { state: "known" as const, application: "another-app" }
  ])(
    "never abandons a deployment without matching identity evidence %j",
    async (identity) => {
      const ghOrThrow = vi.fn(async () => "");
      const releaseDeploymentMutation = vi.fn();
      const result = await abandon({
        resolveEnvDeployment: async () => ({
          ...row("delete-failed"),
          identity
        }),
        ghOrThrow,
        releaseDeploymentMutation
      });
      expect(result.status).toBe(
        identity?.state === "unavailable" && identity.readFailed ? 503 : 409
      );
      expect(ghOrThrow).not.toHaveBeenCalled();
      expect(releaseDeploymentMutation).toHaveBeenCalledOnce();
    }
  );

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
          "A valid repo, environment, and application are required to stop tracking a deployment."
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
          error: `${description} is already in progress. Wait for it to finish before stopping deployment tracking.`
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
    [null, "No failed teardown is available to stop tracking."],
    [row("success"), "Only a failed teardown can be removed from tracking."],
    [row("failed"), "Only a failed teardown can be removed from tracking."],
    [
      row("pending"),
      "This application is still being deployed. Wait for it to finish before stopping deployment tracking."
    ],
    [
      row("deleting"),
      "This deployment is being deleted and cannot be removed from tracking."
    ],
    [
      { ...row("failed"), deploymentId: "" },
      "No failed teardown is available to stop tracking."
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

  it("marks the failed teardown inactive, evicts cache, and releases the lease", async () => {
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

  it("retires the matching failed deploy attempt after GitHub records abandonment", async () => {
    const state = {
      deployAppName: " TODOLIST ",
      deployAttempt: {
        id: "attempt-dev",
        targetRepo: PAYLOAD.repo.toUpperCase(),
        environment: PAYLOAD.environment.toUpperCase()
      },
      deployResult: { error: "failed" },
      deployStatus: "failed",
      deployError: "failed",
      deployErrorKind: "run-unconfirmed" as const,
      deployErrorBranch: "main",
      deployStartedAt: 1,
      deployFinishedAt: 2,
      deployLogs: ["failed"],
      deployLogBase: 1,
      deployRunId: "run-1",
      deployRunUrl: "https://example.test/run-1",
      deployRepairing: false,
      deployHandoffState: "reported",
      deployHandoffAttempts: 1,
      deployNoticeState: "reported",
      deployNoticeAttempts: 1,
      deployRepairAttempts: 1
    };

    await expect(
      abandon({ readInstanceState: () => state })
    ).resolves.toMatchObject({ status: 200 });

    expect(state).toEqual({ deployAppName: " TODOLIST " });
  });

  it.each(["other-app", "", " ", undefined])(
    "preserves a legacy attempt with a different or unknown application %j",
    async (deployAppName) => {
      const state: CanvasState = {
        deployAttempt: {
          id: "original",
          targetRepo: PAYLOAD.repo,
          environment: PAYLOAD.environment
        },
        deployAppName,
        deployStatus: "failed"
      };
      const before = { ...state };
      expect((await abandon({ readInstanceState: () => state })).status).toBe(
        200
      );
      expect(state).toEqual(before);
    }
  );

  it.each([
    "attempt",
    "generation",
    "application",
    "run",
    "id",
    "repo",
    "environment"
  ] as const)(
    "preserves legacy evidence when its %s changes during remote work",
    async (changed) => {
      const state: CanvasState = {
        deployAttempt: {
          id: "original",
          targetRepo: PAYLOAD.repo,
          environment: PAYLOAD.environment
        },
        deployAppName: PAYLOAD.application,
        deployStatus: "failed",
        deployRunId: "original-run"
      };
      let replacement: CanvasState = {};
      const result = await abandon({
        readInstanceState: () => state,
        ghOrThrow: async () => {
          if (changed === "attempt")
            state.deployAttempt = { ...state.deployAttempt, id: "replacement" };
          if (changed === "generation") state.deployGeneration = 2;
          if (changed === "application") state.deployAppName = "another-app";
          if (changed === "run") state.deployRunId = "replacement-run";
          if (state.deployAttempt) {
            if (changed === "id") state.deployAttempt.id = "replacement";
            if (changed === "repo")
              state.deployAttempt.targetRepo = "another/repo";
            if (changed === "environment")
              state.deployAttempt.environment = "another";
          }
          replacement = { ...state };
          return "";
        }
      });
      expect(result.status).toBe(200);
      expect(state).toEqual(replacement);
    }
  );

  it("does not retire a different deploy attempt", async () => {
    const deployAttempt = {
      id: "attempt-prod",
      targetRepo: PAYLOAD.repo,
      environment: "prod"
    };
    const state = { deployAttempt, deployStatus: "failed" };

    await expect(
      abandon({ readInstanceState: () => state })
    ).resolves.toMatchObject({ status: 200 });

    expect(state).toEqual({ deployAttempt, deployStatus: "failed" });
  });

  it("omits a blank run URL from the inactive status request", async () => {
    const ghOrThrow = vi.fn<(args: string[]) => Promise<string>>(() =>
      Promise.resolve("")
    );

    await expect(
      abandon({
        resolveEnvDeployment: () =>
          Promise.resolve({ ...row("delete-failed"), runUrl: "" }),
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
        ghOrThrow: () => Promise.reject("denied"),
        invalidateDeployListCache,
        releaseDeploymentMutation
      })
    ).resolves.toEqual({
      status: 502,
      body: {
        error:
          "Could not stop tracking the deployment on GitHub. Cloud resources were not changed."
      }
    });
    expect(invalidateDeployListCache).not.toHaveBeenCalled();
    expect(releaseDeploymentMutation).toHaveBeenCalledWith(
      expect.any(Object),
      ABANDON_LEASE
    );
  });

  it.each([
    "HTTP 403: Forbidden",
    "Resource not accessible by personal access token",
    "token is missing a required scope"
  ])("gives an actionable permission hint for %s", async (message) => {
    await expect(
      abandon({
        ghOrThrow: () => Promise.reject(new Error(message))
      })
    ).resolves.toEqual({
      status: 502,
      body: {
        error:
          "Could not stop tracking the deployment on GitHub because the active GitHub token lacks permission to update deployments. Run `gh auth refresh -h github.com -s repo` in a terminal, then retry. Cloud resources were not changed."
      }
    });
  });

  it("uses the bundled GitHub CLI path in permission guidance", async () => {
    await expect(
      abandon({
        ghCommandPresentation: {
          kind: "absolute",
          shell: "posix",
          executablePath: "/opt/Copilot Tools/gh",
          installationNote: "Install GitHub CLI system-wide."
        },
        ghOrThrow: () => Promise.reject(new Error("HTTP 403: Forbidden"))
      })
    ).resolves.toMatchObject({
      body: {
        error: expect.stringContaining(
          "'/opt/Copilot Tools/gh' auth refresh -h github.com -s repo"
        )
      }
    });
  });
});
