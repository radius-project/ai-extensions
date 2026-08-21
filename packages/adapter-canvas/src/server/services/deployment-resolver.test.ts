import { describe, expect, it, vi } from "vitest";
import {
  ABANDONED_DEPLOYMENT_DESCRIPTION,
  resolveDeployStatus,
  resolveEnvironmentDeployment
} from "./deployment-resolver.js";

const REPO = "octo/app";
const ENVIRONMENT = "dev";
const DEPLOY_WORKFLOW = "run-rad-commands.yml";
const DELETE_WORKFLOW = "delete-application.yml";

interface RecordFixture {
  state: string;
  description?: string;
  logUrl?: string;
  previousLogUrl?: string;
  runPath?: string;
  runStatus?: string;
  runConclusion?: string;
}

function resolver(
  ids: string[],
  records: Record<string, RecordFixture>,
  options: { variables?: string | Error; maxParallelRecords?: number } = {}
) {
  const ghOrThrow = vi.fn((args: string[]) => {
    const path = args[1] ?? "";
    if (path.includes("/variables?")) {
      return options.variables instanceof Error ?
          Promise.reject(options.variables)
        : Promise.resolve(options.variables ?? "AZURE_CLIENT_ID");
    }
    if (path.includes("/deployments?")) return Promise.resolve(ids.join("\n"));
    const statusMatch = /\/deployments\/([^/]+)\/statuses/.exec(path);
    if (statusMatch) {
      const record = records[statusMatch[1]];
      if (!record) throw new Error(`missing record ${statusMatch[1]}`);
      if (path.includes("per_page=100")) {
        return Promise.resolve(record.previousLogUrl ?? record.logUrl ?? "");
      }
      return Promise.resolve(
        [record.state, record.logUrl ?? "", record.description ?? ""].join("\t")
      );
    }
    const runMatch = /\/actions\/runs\/(\d+)/.exec(path);
    if (runMatch) {
      const record = Object.values(records).find((candidate) =>
        (candidate.logUrl ?? candidate.previousLogUrl)?.endsWith(
          `/runs/${runMatch[1]}`
        )
      );
      if (!record) throw new Error(`missing run ${runMatch[1]}`);
      return Promise.resolve(
        [
          record.runPath ?? "",
          record.runStatus ?? "",
          record.runConclusion ?? ""
        ].join("\t")
      );
    }
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  });

  return {
    ghOrThrow,
    resolve: (appName = "radius-app") =>
      resolveEnvironmentDeployment(REPO, ENVIRONMENT, appName, {
        ghOrThrow,
        deployWorkflowFile: DEPLOY_WORKFLOW,
        deleteWorkflowFile: DELETE_WORKFLOW,
        maxParallelRecords: options.maxParallelRecords ?? 10
      })
  };
}

describe("resolveDeployStatus", () => {
  it.each([
    [{ runConclusion: "success" }, "success"],
    [{ runConclusion: "failure" }, "failed"],
    [{ runStatus: "in_progress" }, "pending"],
    [{ state: "success" }, "success"],
    [{ state: "failure" }, "failed"],
    [{ state: "error" }, "failed"],
    [{}, "pending"]
  ])("maps %# to %s", (record, expected) => {
    expect(resolveDeployStatus(record)).toBe(expected);
  });
});

describe("resolveEnvironmentDeployment", () => {
  it("returns the failed deploy with its provider, identity and run URL", async () => {
    const harness = resolver(["20"], {
      "20": {
        state: "in_progress",
        logUrl: "https://github.com/octo/app/actions/runs/200",
        runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "failure"
      }
    });

    await expect(harness.resolve()).resolves.toEqual({
      app: "radius-app",
      environment: ENVIRONMENT,
      provider: "azure",
      status: "failed",
      deploymentId: "20",
      runUrl: "https://github.com/octo/app/actions/runs/200"
    });
    expect(harness.ghOrThrow).toHaveBeenCalledWith([
      "api",
      `/repos/${REPO}/deployments/20/statuses?per_page=1`,
      "--jq",
      expect.any(String)
    ]);
    expect(harness.ghOrThrow).not.toHaveBeenCalledWith([
      "api",
      `/repos/${REPO}/deployments/20/statuses?per_page=100`,
      "--jq",
      expect.any(String)
    ]);
  });

  it("treats a relevant inactive status as a tombstone instead of revealing an older deploy", async () => {
    const harness = resolver(["20", "10"], {
      "20": {
        state: "inactive",
        logUrl: "https://github.com/octo/app/actions/runs/200",
        runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "failure"
      },
      "10": {
        state: "success",
        logUrl: "https://github.com/octo/app/actions/runs/100",
        runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "success"
      }
    });

    await expect(harness.resolve()).resolves.toBeNull();
    expect(harness.ghOrThrow).not.toHaveBeenCalledWith([
      "api",
      `/repos/${REPO}/deployments/20/statuses?per_page=100`,
      "--jq",
      expect.any(String)
    ]);
  });

  it("recognizes a Canvas abandonment marker even when the inactive status has no run URL", async () => {
    const harness = resolver(["20", "10"], {
      "20": {
        state: "inactive",
        description: ABANDONED_DEPLOYMENT_DESCRIPTION
      },
      "10": {
        state: "success",
        logUrl: "https://github.com/octo/app/actions/runs/100",
        runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "success"
      }
    });

    await expect(harness.resolve()).resolves.toBeNull();
    expect(harness.ghOrThrow).not.toHaveBeenCalledWith([
      "api",
      `/repos/${REPO}/deployments/20/statuses?per_page=100`,
      "--jq",
      expect.any(String)
    ]);
  });

  it("does not let an unrelated inactive workflow hide an older Radius deployment", async () => {
    const harness = resolver(["30", "20"], {
      "30": {
        state: "inactive",
        logUrl: "https://github.com/octo/app/actions/runs/300",
        runPath: ".github/workflows/verify-credentials.yml",
        runStatus: "completed",
        runConclusion: "success"
      },
      "20": {
        state: "success",
        logUrl: "https://github.com/octo/app/actions/runs/200",
        runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "success"
      }
    });

    await expect(harness.resolve()).resolves.toMatchObject({
      deploymentId: "20",
      status: "success"
    });
  });

  it("skips a failed delete but treats a successful delete as decisive", async () => {
    const failedDelete = resolver(["30", "20"], {
      "30": {
        state: "failure",
        logUrl: "https://github.com/octo/app/actions/runs/300",
        runPath: `.github/workflows/${DELETE_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "failure"
      },
      "20": {
        state: "success",
        logUrl: "https://github.com/octo/app/actions/runs/200",
        runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "success"
      }
    });
    await expect(failedDelete.resolve()).resolves.toMatchObject({
      deploymentId: "20"
    });

    const successfulDelete = resolver(["40", "20"], {
      "40": {
        state: "success",
        logUrl: "https://github.com/octo/app/actions/runs/400",
        runPath: `.github/workflows/${DELETE_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "success"
      },
      "20": {
        state: "success",
        logUrl: "https://github.com/octo/app/actions/runs/200",
        runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "success"
      }
    });
    await expect(successfulDelete.resolve()).resolves.toBeNull();
  });

  it("returns deleting while the latest delete workflow is still running", async () => {
    const harness = resolver(["30"], {
      "30": {
        state: "in_progress",
        logUrl: "https://github.com/octo/app/actions/runs/300",
        runPath: `.github/workflows/${DELETE_WORKFLOW}`,
        runStatus: "in_progress"
      }
    });

    await expect(harness.resolve()).resolves.toMatchObject({
      deploymentId: "30",
      status: "deleting"
    });
  });

  it("recovers a workflow run URL from older statuses only when the latest status has none", async () => {
    const harness = resolver(["20"], {
      "20": {
        state: "failure",
        previousLogUrl: "https://github.com/octo/app/actions/runs/200",
        runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "failure"
      }
    });

    await expect(harness.resolve()).resolves.toMatchObject({
      deploymentId: "20",
      status: "failed",
      runUrl: "https://github.com/octo/app/actions/runs/200"
    });
    expect(harness.ghOrThrow).toHaveBeenCalledWith([
      "api",
      `/repos/${REPO}/deployments/20/statuses?per_page=100`,
      "--jq",
      expect.any(String)
    ]);
  });

  it.each([
    ["no status or run URL", { state: "" }],
    [
      "a non-Actions target URL",
      { state: "pending", logUrl: "https://example.test/deployment" }
    ]
  ] as const)(
    "fails closed when the newest deployment has %s",
    async (_description, newest) => {
      const harness = resolver(["30", "20"], {
        "30": newest,
        "20": {
          state: "failure",
          logUrl: "https://github.com/octo/app/actions/runs/200",
          runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
          runStatus: "completed",
          runConclusion: "failure"
        }
      });

      await expect(harness.resolve()).rejects.toThrow(
        "Could not identify GitHub deployment 30 for environment dev."
      );
    }
  );

  it("returns a deployment beyond the parallel batch and soft-fails provider discovery", async () => {
    const harness = resolver(
      ["30", "25", "20"],
      {
        "30": {
          state: "success",
          logUrl: "https://github.com/octo/app/actions/runs/300",
          runPath: ".github/workflows/verify-credentials.yml",
          runStatus: "completed",
          runConclusion: "success"
        },
        "25": {
          state: "success",
          logUrl: "https://github.com/octo/app/actions/runs/250",
          runPath: ".github/workflows/cleanup.yml",
          runStatus: "completed",
          runConclusion: "success"
        },
        "20": {
          state: "success",
          logUrl: "https://github.com/octo/app/actions/runs/200",
          runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
          runStatus: "completed",
          runConclusion: "success"
        }
      },
      { variables: new Error("unavailable"), maxParallelRecords: 2 }
    );

    await expect(harness.resolve("")).resolves.toEqual({
      app: "app",
      environment: ENVIRONMENT,
      provider: "",
      status: "success",
      deploymentId: "20",
      runUrl: "https://github.com/octo/app/actions/runs/200"
    });
    expect(harness.ghOrThrow).toHaveBeenCalledWith([
      "api",
      `/repos/${REPO}/deployments/20/statuses?per_page=1`,
      "--jq",
      expect.any(String)
    ]);
  });

  it("skips unrelated workflows after the parallel batch", async () => {
    const harness = resolver(
      ["40", "30", "20"],
      {
        "40": {
          state: "success",
          logUrl: "https://github.com/octo/app/actions/runs/400",
          runPath: ".github/workflows/verify-credentials.yml",
          runStatus: "completed",
          runConclusion: "success"
        },
        "30": {
          state: "success",
          logUrl: "https://github.com/octo/app/actions/runs/300",
          runPath: ".github/workflows/cleanup.yml",
          runStatus: "completed",
          runConclusion: "success"
        },
        "20": {
          state: "success",
          logUrl: "https://github.com/octo/app/actions/runs/200",
          runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
          runStatus: "completed",
          runConclusion: "success"
        }
      },
      { maxParallelRecords: 1 }
    );

    await expect(harness.resolve()).resolves.toMatchObject({
      deploymentId: "20",
      status: "success"
    });
  });

  it("returns null for an environment with no deployment records", async () => {
    const harness = resolver([], {}, { variables: "AWS_ROLE_ARN" });

    await expect(harness.resolve()).resolves.toBeNull();
  });

  it("propagates deployment history lookup failures", async () => {
    const failure = new Error("GitHub unavailable");
    const ghOrThrow = vi.fn((args: string[]) =>
      args[1]?.includes("/variables?") ?
        Promise.resolve("")
      : Promise.reject(failure)
    );

    await expect(
      resolveEnvironmentDeployment(REPO, ENVIRONMENT, "app", {
        ghOrThrow,
        deployWorkflowFile: DEPLOY_WORKFLOW,
        deleteWorkflowFile: DELETE_WORKFLOW,
        maxParallelRecords: 10
      })
    ).rejects.toBe(failure);
  });
});
