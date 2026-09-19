import { describe, expect, it, vi } from "vitest";
import {
  listApplications,
  listDeployments,
  type DeploymentInspectionPorts
} from "./inspection.js";
import { observeDeployment } from "./observation.js";

describe("standalone deployment inspection", () => {
  it("resolves the explicit source once and enumerates each environment independently", async () => {
    const resolveRepoAppName = vi.fn(async () => "application");
    const resolveEnvDeployment = vi.fn<
      DeploymentInspectionPorts["resolveEnvDeployment"]
    >(async (_repo, environment, app) =>
      environment === "empty" ? null : (
        {
          app,
          environment,
          provider: "aws",
          status: "success",
          deploymentId: "1",
          runUrl: ""
        }
      )
    );
    const ghOrThrow = vi.fn<DeploymentInspectionPorts["ghOrThrow"]>(
      async () => "dev\nempty\ndev\nprod\n"
    );
    const ports = { resolveRepoAppName, resolveEnvDeployment, ghOrThrow };
    expect(
      await listDeployments({ repo: "acme/app", branch: "working" }, ports)
    ).toEqual([
      {
        app: "application",
        environment: "dev",
        provider: "aws",
        status: "success",
        deploymentId: "1",
        runUrl: ""
      },
      {
        app: "application",
        environment: "prod",
        provider: "aws",
        status: "success",
        deploymentId: "1",
        runUrl: ""
      }
    ]);
    expect(resolveRepoAppName).toHaveBeenCalledExactlyOnceWith(
      "acme/app",
      "working"
    );
    expect(resolveEnvDeployment).toHaveBeenCalledTimes(3);
    expect(ghOrThrow).toHaveBeenCalledExactlyOnceWith([
      "api",
      "--paginate",
      "/repos/acme/app/environments?per_page=100",
      "--jq",
      ".environments[].name"
    ]);
    expect(
      await listApplications({ repo: "acme/app", branch: "feature" }, ports)
    ).toEqual([{ name: "application" }]);
  });

  it("propagates unreadable inventories and application definitions instead of manufacturing absence", async () => {
    const ports: DeploymentInspectionPorts = {
      ghOrThrow: async () => {
        throw new Error("permission denied");
      },
      resolveRepoAppName: async () => {
        throw new Error("unreadable source");
      },
      resolveEnvDeployment: async () => {
        throw new Error("must not resolve");
      }
    };
    await expect(
      listDeployments({ repo: "acme/app", branch: "main" }, ports)
    ).rejects.toThrow("permission denied");
    await expect(
      listApplications({ repo: "acme/app", branch: "main" }, ports)
    ).rejects.toThrow("unreadable source");
  });

  it("observes failure without opening repair or changing attempt state", () => {
    const state = {
      deployStatus: "failed",
      deployError: "failure",
      deployLogs: ["old", "new"],
      deployLogBase: 10,
      deployHandoffState: "idle"
    };
    const before = structuredClone(state);
    expect(observeDeployment(state, 11)).toMatchObject({
      status: "failed",
      logsNew: ["new"],
      logBase: 10,
      logTotal: 12,
      repairing: false
    });
    expect(observeDeployment(state, 2)).toMatchObject({
      logsNew: ["old", "new"]
    });
    expect(observeDeployment(state, NaN)).toMatchObject({
      logs: ["old", "new"]
    });
    expect(observeDeployment()).toMatchObject({
      status: "pending",
      logs: [],
      active: false
    });
    expect(state).toEqual(before);
  });
});
