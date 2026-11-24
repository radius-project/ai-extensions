import { describe, expect, it, vi } from "vitest";
import {
  deleteApplication,
  type ApplicationDeletionPorts
} from "./application-deletion.js";
import type { DeploymentRow } from "./deployment-lookup-policy.js";

const target = { repo: "octo/app", environment: "dev", application: "demo" };
const request = { ...target, force: false };
const row: DeploymentRow = {
  ...target,
  app: target.application,
  identity: { state: "known", application: target.application },
  provider: "azure",
  status: "delete-failed",
  deploymentId: "42",
  runUrl: "https://github.com/octo/app/actions/runs/17"
};

function fixture(overrides: Partial<ApplicationDeletionPorts> = {}) {
  const effects: string[] = [];
  const ports: ApplicationDeletionPorts = {
    reserve: () => ({
      retain: () => effects.push("retain"),
      release: () => effects.push("release")
    }),
    captureAcceptedDeletion: () => {
      effects.push("capture");
      return () => effects.push("invalidate");
    },
    resolveDeployment: async () => row,
    statusBlocksMutation: (status) => ["deleting", "pending"].includes(status),
    probeConflict: async () => ({
      state: "conflict",
      resourceState: "Updating",
      forced: false
    }),
    dispatch: async () => ({
      kind: "accepted",
      discoverRunUrl: async () => {
        effects.push("discover");
        return row.runUrl;
      }
    }),
    invalidateListing: () => effects.push("evict"),
    reportDiscoveryError: () => effects.push("report"),
    ...overrides
  };
  return { ports, effects };
}

describe("application deletion", () => {
  it("revalidates force against the exact admitted row and invalidates before discovery", async () => {
    const probe = vi.fn<ApplicationDeletionPorts["probeConflict"]>(
      async () => ({
        state: "conflict",
        resourceState: "Updating",
        forced: false
      })
    );
    const { ports, effects } = fixture({ probeConflict: probe });
    const result = await deleteApplication({ ...request, force: true }, ports);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining(target), {
      deploymentId: row.deploymentId,
      runUrl: row.runUrl
    });
    expect(result).toEqual({
      status: 200,
      body: { success: true, runUrl: row.runUrl, forced: true }
    });
    expect(effects).toEqual([
      "capture",
      "retain",
      "evict",
      "invalidate",
      "discover"
    ]);
  });

  it.each([
    ["stale approved row", { ...request, deploymentId: "43" }, row, 409],
    ["delete still running", request, { ...row, status: "deleting" }, 409],
    ["deploy still running", request, { ...row, status: "pending" }, 409],
    ["force without a failed delete", { ...request, force: true }, null, 409],
    ["unknown application", request, { ...row, identity: undefined }, 409]
  ] as const)(
    "releases without dispatch for %s",
    async (_name, input, current, status) => {
      const dispatch = vi.fn<ApplicationDeletionPorts["dispatch"]>();
      const { ports, effects } = fixture({
        dispatch,
        resolveDeployment: async () => current
      });
      const result = await deleteApplication(input, ports);
      expect(result.status).toBe(status);
      expect(dispatch).not.toHaveBeenCalled();
      expect(effects).toEqual(["capture", "release"]);
    }
  );

  it("does not read GitHub without the shared reservation", async () => {
    const resolveDeployment =
      vi.fn<ApplicationDeletionPorts["resolveDeployment"]>();
    const { ports, effects } = fixture({
      reserve: () => ({ error: "already in progress" }),
      resolveDeployment
    });
    expect(await deleteApplication(request, ports)).toEqual({
      status: 409,
      body: { error: "already in progress" }
    });
    expect(resolveDeployment).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
  });

  it("does not force deletion when the conflict reader rejects without an Error object", async () => {
    const dispatch = vi.fn<ApplicationDeletionPorts["dispatch"]>();
    const { ports, effects } = fixture({
      probeConflict: async () => Promise.reject("artifact read failed"),
      dispatch
    });
    expect(await deleteApplication({ ...request, force: true }, ports)).toEqual(
      {
        status: 503,
        body: {
          error:
            "The previous delete failure could not be verified, so this delete was not forced: artifact read failed"
        }
      }
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(effects).toEqual(["capture", "release"]);
  });

  it("does not invalidate evidence or report a definitive refusal after ambiguous dispatch", async () => {
    const { ports, effects } = fixture({
      dispatch: async () => ({ kind: "ambiguous", error: "timeout" })
    });
    expect(await deleteApplication(request, ports)).toEqual({
      status: 400,
      body: { error: "timeout" },
      dispatchUnconfirmed: true
    });
    expect(effects).toEqual(["capture", "retain"]);
  });

  it("reports a non-Error dispatch rejection and releases the reservation", async () => {
    const { ports, effects } = fixture({
      dispatch: () => Promise.reject("workflow unavailable")
    });
    expect(await deleteApplication(request, ports)).toEqual({
      status: 400,
      body: { error: "workflow unavailable" }
    });
    expect(effects).toEqual(["capture", "release"]);
  });
});
