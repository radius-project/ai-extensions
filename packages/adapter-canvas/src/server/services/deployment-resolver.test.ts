import { describe, expect, it, vi } from "vitest";
import {
  ABANDONED_DEPLOYMENT_DESCRIPTION,
  RESOURCE_DELETING_STATUS,
  resolveDeployStatus,
  resolveEnvironmentDeployment
} from "./deployment-resolver.js";
import { deploymentStatusBlocksMutation } from "../../browser/repositories.js";
import type { StateSaveFailure } from "../../state-save-diagnostics.js";

const REPO = "octo/app";
const ENVIRONMENT = "dev";
const DEPLOY_WORKFLOW = "run-rad-commands.yml";
const DELETE_WORKFLOW = "delete-application.yml";
const DELETE_RESOURCE_WORKFLOW = "delete-resource.yml";

interface RecordFixture {
  state: string;
  description?: string;
  logUrl?: string;
  previousLogUrl?: string;
  runPath?: string;
  runStatus?: string;
  runConclusion?: string;
  runAttempt?: string;
}

function resolver(
  ids: string[],
  records: Record<string, RecordFixture>,
  options: {
    variables?: string | Error;
    maxParallelRecords?: number;
    // Keyed by `<runId>#<runAttempt>`, mirroring the attempt-scoped diagnostic
    // the teardown action publishes.
    stateSaveFailures?: Record<string, StateSaveFailure>;
  } = {}
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
          record.runConclusion ?? "",
          record.runAttempt ?? "1"
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
        deleteResourceWorkflowFile: DELETE_RESOURCE_WORKFLOW,
        maxParallelRecords: options.maxParallelRecords ?? 10,
        readStateSaveFailure: (_repo, runId, runAttempt) =>
          Promise.resolve(
            options.stateSaveFailures?.[`${runId}#${runAttempt}`] ?? null
          )
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
      runUrl: "https://github.com/octo/app/actions/runs/200",
      runId: "200"
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

  it("keeps a failed redeploy current when an older successful deployment exists", async () => {
    const harness = resolver(["20", "10"], {
      "20": {
        state: "failure",
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

    await expect(harness.resolve()).resolves.toMatchObject({
      deploymentId: "20",
      status: "failed"
    });
  });

  it("does not treat a generic inactive deploy status as a Canvas tombstone", async () => {
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

    await expect(harness.resolve()).resolves.toMatchObject({
      deploymentId: "20",
      status: "failed"
    });
    expect(harness.ghOrThrow).not.toHaveBeenCalledWith([
      "api",
      `/repos/${REPO}/deployments/20/statuses?per_page=100`,
      "--jq",
      expect.any(String)
    ]);
  });

  it("surfaces a generic inactive failed delete as a recovery state", async () => {
    const harness = resolver(["30", "20"], {
      "30": {
        state: "inactive",
        logUrl: "https://github.com/octo/app/actions/runs/300",
        runPath: `.github/workflows/${DELETE_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "failure"
      },
      "20": {
        state: "failure",
        logUrl: "https://github.com/octo/app/actions/runs/200",
        runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "failure"
      }
    });

    await expect(harness.resolve()).resolves.toMatchObject({
      deploymentId: "30",
      status: "delete-failed"
    });
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

  it("recognizes a Canvas abandonment marker without resolving its retained workflow run", async () => {
    const harness = resolver(["20", "10"], {
      "20": {
        state: "inactive",
        description: ABANDONED_DEPLOYMENT_DESCRIPTION,
        logUrl: "https://github.com/octo/app/actions/runs/200"
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
      `/repos/${REPO}/actions/runs/200`,
      "--jq",
      expect.any(String)
    ]);
  });

  it("lets a newest Canvas tombstone remain decisive when an older record cannot be resolved", async () => {
    const harness = resolver(["20", "10"], {
      "20": {
        state: "inactive",
        description: ABANDONED_DEPLOYMENT_DESCRIPTION
      },
      "10": {
        state: "success",
        logUrl: "https://github.com/octo/app/actions/runs/100"
      }
    });
    const original = harness.ghOrThrow.getMockImplementation()!;
    harness.ghOrThrow.mockImplementation((args) => {
      if ((args[1] ?? "").includes("/actions/runs/100")) {
        return Promise.reject(new Error("expired"));
      }
      return original(args);
    });

    await expect(harness.resolve()).resolves.toBeNull();
  });

  it("fails closed when a record before any decisive result cannot be resolved", async () => {
    const harness = resolver(["20", "10"], {
      "20": {
        state: "failure",
        logUrl: "https://github.com/octo/app/actions/runs/200"
      },
      "10": {
        state: "success",
        logUrl: "https://github.com/octo/app/actions/runs/100",
        runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "success"
      }
    });
    const original = harness.ghOrThrow.getMockImplementation()!;
    harness.ghOrThrow.mockImplementation((args) => {
      if ((args[1] ?? "").includes("/actions/runs/200")) {
        return Promise.reject(new Error("offline"));
      }
      return original(args);
    });

    await expect(harness.resolve()).rejects.toThrow("offline");
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

  it("surfaces a failed delete but treats a successful delete as decisive", async () => {
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
      deploymentId: "30",
      status: "delete-failed"
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
      runUrl: "https://github.com/octo/app/actions/runs/200",
      runId: "200"
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
        deleteResourceWorkflowFile: DELETE_RESOURCE_WORKFLOW,
        maxParallelRecords: 10,
        readStateSaveFailure: () => Promise.resolve(null)
      })
    ).rejects.toBe(failure);
  });
});

describe("failed delete outcome parity (Part 8)", () => {
  const failedDelete = (conclusion: string) => ({
    "30": {
      state: "inactive",
      logUrl: "https://github.com/octo/app/actions/runs/300",
      runPath: `.github/workflows/${DELETE_WORKFLOW}`,
      runStatus: "completed",
      runConclusion: conclusion
    }
  });

  it.each([
    ["failure", "Deletion failed"],
    ["cancelled", "Deletion cancelled"],
    ["timed_out", "Deletion timed out"],
    ["startup_failure", "Deletion failed"]
  ])(
    "reports the exact outcome of a %s delete run",
    async (conclusion, expected) => {
      const harness = resolver(["30"], failedDelete(conclusion));

      await expect(harness.resolve()).resolves.toMatchObject({
        status: "delete-failed",
        statusDetail: expected
      });
    }
  );

  it("adds orphan-recovery guidance when the delete run could not save state", async () => {
    const harness = resolver(["30"], failedDelete("failure"), {
      stateSaveFailures: {
        "300#1": {
          attempts: 3,
          runAttempt: 1,
          error: "rad shutdown: connection refused"
        }
      }
    });

    const row = await harness.resolve();

    expect(row?.statusDetail).toContain("Deletion failed");
    expect(row?.statusDetail).toContain(
      "The deletion ran, but Radius could not save its state."
    );
    expect(row?.statusDetail).toContain("Orphaned cloud resources may exist.");
    expect(row?.statusDetail).toContain(
      "rad shutdown failed after 3 attempts."
    );
  });

  it("keeps the outcome when the state-save diagnostic cannot be read", async () => {
    const harness = resolver(["30"], failedDelete("cancelled"));
    const row = await resolveEnvironmentDeployment(REPO, ENVIRONMENT, "app", {
      ghOrThrow: harness.ghOrThrow,
      deployWorkflowFile: DEPLOY_WORKFLOW,
      deleteWorkflowFile: DELETE_WORKFLOW,
      deleteResourceWorkflowFile: DELETE_RESOURCE_WORKFLOW,
      maxParallelRecords: 10,
      readStateSaveFailure: () => Promise.reject(new Error("gh down"))
    });

    expect(row?.statusDetail).toBe("Deletion cancelled");
  });

  it("reads no diagnostic for a delete that is still running", async () => {
    const reads: string[] = [];
    const harness = resolver(["30"], {
      "30": {
        state: "in_progress",
        logUrl: "https://github.com/octo/app/actions/runs/300",
        runPath: `.github/workflows/${DELETE_WORKFLOW}`,
        runStatus: "in_progress"
      }
    });
    const row = await resolveEnvironmentDeployment(REPO, ENVIRONMENT, "app", {
      ghOrThrow: harness.ghOrThrow,
      deployWorkflowFile: DEPLOY_WORKFLOW,
      deleteWorkflowFile: DELETE_WORKFLOW,
      deleteResourceWorkflowFile: DELETE_RESOURCE_WORKFLOW,
      maxParallelRecords: 10,
      readStateSaveFailure: (_repo, runId) => {
        reads.push(runId);
        return Promise.resolve(null);
      }
    });

    expect(row?.status).toBe("deleting");
    expect(row?.statusDetail).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("reads no diagnostic for a successful deployment row", async () => {
    const reads: string[] = [];
    const harness = resolver(["20"], {
      "20": {
        state: "success",
        logUrl: "https://github.com/octo/app/actions/runs/200",
        runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "success"
      }
    });
    const row = await resolveEnvironmentDeployment(REPO, ENVIRONMENT, "app", {
      ghOrThrow: harness.ghOrThrow,
      deployWorkflowFile: DEPLOY_WORKFLOW,
      deleteWorkflowFile: DELETE_WORKFLOW,
      deleteResourceWorkflowFile: DELETE_RESOURCE_WORKFLOW,
      maxParallelRecords: 10,
      readStateSaveFailure: (_repo, runId) => {
        reads.push(runId);
        return Promise.resolve(null);
      }
    });

    expect(row?.status).toBe("success");
    expect(reads).toEqual([]);
  });

  it("scopes the state-save read to the run attempt that concluded", async () => {
    const reads: Array<[string, string]> = [];
    const harness = resolver(["30"], {
      "30": {
        state: "inactive",
        logUrl: "https://github.com/octo/app/actions/runs/300",
        runPath: `.github/workflows/${DELETE_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "failure",
        runAttempt: "2"
      }
    });

    await resolveEnvironmentDeployment(REPO, ENVIRONMENT, "app", {
      ghOrThrow: harness.ghOrThrow,
      deployWorkflowFile: DEPLOY_WORKFLOW,
      deleteWorkflowFile: DELETE_WORKFLOW,
      deleteResourceWorkflowFile: DELETE_RESOURCE_WORKFLOW,
      maxParallelRecords: 10,
      readStateSaveFailure: (_repo, runId, runAttempt) => {
        reads.push([runId, runAttempt]);
        return Promise.resolve(null);
      }
    });

    expect(reads).toEqual([["300", "2"]]);
  });
});

// Exception 7.1: a single-resource cleanup runs its own dispatcher, so its
// GitHub deployment record must never be read as a whole-application teardown —
// and while it is running it must still block another mutation of the same
// deployment, including one started from a different canvas instance.
describe("single-resource cleanup records", () => {
  const resourceDelete = (runConclusion?: string) => ({
    "31": {
      state: runConclusion ? "inactive" : "in_progress",
      logUrl: "https://github.com/octo/app/actions/runs/310",
      runPath: `.github/workflows/${DELETE_RESOURCE_WORKFLOW}`,
      runStatus: runConclusion ? "completed" : "in_progress",
      runConclusion
    }
  });
  const deployedApp = {
    "20": {
      state: "success",
      logUrl: "https://github.com/octo/app/actions/runs/200",
      runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
      runStatus: "completed",
      runConclusion: "success"
    }
  };

  it.each([
    ["succeeded", "success"],
    ["was cancelled", "cancelled"],
    ["failed", "failure"]
  ])(
    "keeps the application deployed when the resource cleanup %s",
    async (_label, conclusion) => {
      const harness = resolver(["31", "20"], {
        ...resourceDelete(conclusion),
        ...deployedApp
      });

      await expect(harness.resolve()).resolves.toMatchObject({
        status: "success",
        deploymentId: "20"
      });
    }
  );

  // The blocking case: a cleanup in flight is a destructive operation against
  // this deployment, so the row reports it instead of the application's older
  // (non-blocking) deploy status.
  it("reports a running resource cleanup as a blocking state", async () => {
    const harness = resolver(["31", "20"], {
      ...resourceDelete(),
      ...deployedApp
    });

    const row = await harness.resolve();

    expect(row).toEqual({
      app: "radius-app",
      environment: ENVIRONMENT,
      provider: "azure",
      status: RESOURCE_DELETING_STATUS,
      deploymentId: "31",
      runUrl: "https://github.com/octo/app/actions/runs/310",
      runId: "310",
      statusDetail:
        "Removing a resource from this application. The application itself stays deployed."
    });
    // The listing's own reader treats it as blocking, which is what stops a
    // second destructive operation on the same deployment.
    expect(deploymentStatusBlocksMutation(row?.status ?? "")).toBe(true);
  });

  it("reports a queued resource cleanup as blocking too", async () => {
    const harness = resolver(["31"], {
      "31": {
        state: "queued",
        logUrl: "https://github.com/octo/app/actions/runs/310",
        runPath: `.github/workflows/${DELETE_RESOURCE_WORKFLOW}`,
        runStatus: "queued"
      }
    });

    await expect(harness.resolve()).resolves.toMatchObject({
      status: RESOURCE_DELETING_STATUS,
      deploymentId: "31"
    });
  });

  // Terminal, so it no longer blocks — but a cleanup that did not succeed is
  // still reported on the application's own row rather than disappearing.
  it.each([
    ["failure", "failed"],
    ["cancelled", "was cancelled"],
    ["timed_out", "timed out"]
  ])(
    "annotates the application row when a %s cleanup fell through",
    async (conclusion, label) => {
      const harness = resolver(["31", "20"], {
        ...resourceDelete(conclusion),
        ...deployedApp
      });

      const row = await harness.resolve();

      expect(row).toMatchObject({ status: "success", deploymentId: "20" });
      expect(row?.statusDetail).toBe(
        `Removing a resource from this application ${label}. The application is still deployed; see the workflow run for details.\nCleanup run: https://github.com/octo/app/actions/runs/310`
      );
      expect(deploymentStatusBlocksMutation(row?.status ?? "")).toBe(false);
    }
  );

  it("adds no note when the cleanup succeeded and saved its state", async () => {
    const harness = resolver(["31", "20"], {
      ...resourceDelete("success"),
      ...deployedApp
    });

    await expect(harness.resolve()).resolves.not.toHaveProperty("statusDetail");
  });

  // Exception 5.4 on the cleanup path: the resource was deleted, but the run
  // could not persist Radius state, so the resource's cloud infrastructure may
  // still exist. The application row is the only place left to say so — the
  // cleanup's own record is skipped, and the application must stay listed.
  it("warns on the application row when a successful cleanup could not save state", async () => {
    const harness = resolver(
      ["31", "20"],
      { ...resourceDelete("success"), ...deployedApp },
      {
        stateSaveFailures: {
          "310#1": {
            attempts: 3,
            runAttempt: 1,
            error: "rad shutdown: connection refused"
          }
        }
      }
    );

    const row = await harness.resolve();

    // The application is untouched: still deployed, still its own run.
    expect(row).toMatchObject({
      app: "radius-app",
      status: "success",
      deploymentId: "20",
      runUrl: "https://github.com/octo/app/actions/runs/200"
    });
    expect(row?.statusDetail).toContain(
      "Removing a resource from this application succeeded. The application is still deployed."
    );
    expect(row?.statusDetail).toContain("Orphaned cloud resources may exist.");
    expect(row?.statusDetail).toContain(
      "rad shutdown failed after 3 attempts."
    );
    // The cleanup's own run, not the application's, so the warning is
    // actionable from the listing.
    expect(row?.statusDetail).toContain(
      "Cleanup run: https://github.com/octo/app/actions/runs/310"
    );
    expect(deploymentStatusBlocksMutation(row?.status ?? "")).toBe(false);
  });

  // Both diagnostics at once: the cleanup failed AND its run could not persist
  // state, which is the case with the most orphan risk.
  it("reports the outcome and the orphan warning of a failed cleanup together", async () => {
    const harness = resolver(
      ["31", "20"],
      { ...resourceDelete("failure"), ...deployedApp },
      {
        stateSaveFailures: {
          "310#1": {
            attempts: 3,
            runAttempt: 1,
            error: "rad shutdown: connection refused"
          }
        }
      }
    );

    const row = await harness.resolve();

    expect(row).toMatchObject({ status: "success", deploymentId: "20" });
    expect(row?.statusDetail).toBe(
      "Removing a resource from this application failed. The application is still deployed; see the workflow run for details.\n\n" +
        "The deletion ran, but Radius could not save its state. Orphaned cloud resources may exist. " +
        "To recover, redeploy the application so Radius reconciles the state; if it still cannot be reconciled, delete the deployment and redeploy it.\n\n" +
        "rad shutdown failed after 3 attempts.\nrad shutdown: connection refused\n" +
        "Cleanup run: https://github.com/octo/app/actions/runs/310"
    );
  });

  it("reads the diagnostic for the cleanup's own run attempt", async () => {
    const harness = resolver(
      ["31", "20"],
      {
        ...resourceDelete("success"),
        "31": {
          state: "inactive",
          logUrl: "https://github.com/octo/app/actions/runs/310",
          runPath: `.github/workflows/${DELETE_RESOURCE_WORKFLOW}`,
          runStatus: "completed",
          runConclusion: "success",
          runAttempt: "2"
        },
        ...deployedApp
      },
      {
        stateSaveFailures: {
          // The FIRST attempt's diagnostic must not be reported for a rerun
          // that saved its state.
          "310#1": {
            attempts: 3,
            runAttempt: 1,
            error: "rad shutdown: connection refused"
          }
        }
      }
    );

    await expect(harness.resolve()).resolves.not.toHaveProperty("statusDetail");
  });

  it("reports the cleanup failure alone when its diagnostic cannot be read", async () => {
    const harness = resolver(["31", "20"], {
      ...resourceDelete("failure"),
      ...deployedApp
    });

    const row = await resolveEnvironmentDeployment(
      REPO,
      ENVIRONMENT,
      "radius-app",
      {
        ghOrThrow: harness.ghOrThrow,
        deployWorkflowFile: DEPLOY_WORKFLOW,
        deleteWorkflowFile: DELETE_WORKFLOW,
        deleteResourceWorkflowFile: DELETE_RESOURCE_WORKFLOW,
        maxParallelRecords: 10,
        readStateSaveFailure: () => Promise.reject(new Error("artifact gone"))
      }
    );

    expect(row?.statusDetail).toBe(
      "Removing a resource from this application failed. The application is still deployed; see the workflow run for details.\nCleanup run: https://github.com/octo/app/actions/runs/310"
    );
  });

  it("keeps the delete diagnostic first when both are present", async () => {
    const harness = resolver(
      ["31", "30"],
      {
        ...resourceDelete("failure"),
        "30": {
          state: "inactive",
          logUrl: "https://github.com/octo/app/actions/runs/300",
          runPath: `.github/workflows/${DELETE_WORKFLOW}`,
          runStatus: "completed",
          runConclusion: "cancelled",
          runAttempt: "1"
        }
      },
      {}
    );

    const row = await harness.resolve();

    expect(row?.status).toBe("delete-failed");
    expect(row?.statusDetail).toBe(
      "Deletion cancelled\n\nRemoving a resource from this application failed. The application is still deployed; see the workflow run for details.\nCleanup run: https://github.com/octo/app/actions/runs/310"
    );
  });

  it("annotates a row resolved on the sequential path too", async () => {
    const harness = resolver(
      ["31", "20"],
      { ...resourceDelete("failure"), ...deployedApp },
      { maxParallelRecords: 1 }
    );

    await expect(harness.resolve()).resolves.toMatchObject({
      deploymentId: "20",
      statusDetail:
        "Removing a resource from this application failed. The application is still deployed; see the workflow run for details.\nCleanup run: https://github.com/octo/app/actions/runs/310"
    });
  });

  // Newest first: two failed cleanups report the most recent one rather than
  // stacking notes onto the row until the useful one is buried.
  it("reports only the newest failed cleanup", async () => {
    const harness = resolver(["32", "31", "20"], {
      "32": {
        state: "inactive",
        logUrl: "https://github.com/octo/app/actions/runs/320",
        runPath: `.github/workflows/${DELETE_RESOURCE_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "timed_out"
      },
      ...resourceDelete("failure"),
      ...deployedApp
    });

    await expect(harness.resolve()).resolves.toMatchObject({
      deploymentId: "20",
      statusDetail:
        "Removing a resource from this application timed out. The application is still deployed; see the workflow run for details.\nCleanup run: https://github.com/octo/app/actions/runs/320"
    });
  });

  it("does not report a deployment when only a resource cleanup exists", async () => {
    const harness = resolver(["31"], resourceDelete("success"));

    await expect(harness.resolve()).resolves.toBeNull();
  });
});

// Exception 5.4: a successful application delete normally retires the row. It
// must not do so silently when the run could not persist Radius state.
describe("successful delete with an exhausted state save", () => {
  const succeededDelete = {
    "30": {
      state: "inactive",
      logUrl: "https://github.com/octo/app/actions/runs/300",
      runPath: `.github/workflows/${DELETE_WORKFLOW}`,
      runStatus: "completed",
      runConclusion: "success",
      runAttempt: "1"
    }
  };

  it("retires the row when the delete saved its state", async () => {
    const harness = resolver(["30"], succeededDelete);

    await expect(harness.resolve()).resolves.toBeNull();
  });

  it("retains a warning row when the delete could not save its state", async () => {
    const harness = resolver(["30"], succeededDelete, {
      stateSaveFailures: {
        "300#1": {
          attempts: 3,
          runAttempt: 1,
          error: "rad shutdown: connection refused"
        }
      }
    });

    const row = await harness.resolve();

    expect(row).toMatchObject({
      app: "radius-app",
      environment: ENVIRONMENT,
      status: "deleted-state-warning",
      deploymentId: "30",
      runUrl: "https://github.com/octo/app/actions/runs/300"
    });
    expect(row?.statusDetail).toContain("Deletion succeeded");
    expect(row?.statusDetail).toContain("Orphaned cloud resources may exist.");
    expect(row?.statusDetail).toContain(
      "rad shutdown failed after 3 attempts."
    );
  });

  it("still retires the row when the diagnostic cannot be read", async () => {
    const harness = resolver(["30"], succeededDelete);

    await expect(
      resolveEnvironmentDeployment(REPO, ENVIRONMENT, "app", {
        ghOrThrow: harness.ghOrThrow,
        deployWorkflowFile: DEPLOY_WORKFLOW,
        deleteWorkflowFile: DELETE_WORKFLOW,
        deleteResourceWorkflowFile: DELETE_RESOURCE_WORKFLOW,
        maxParallelRecords: 10,
        readStateSaveFailure: () => Promise.reject(new Error("gh down"))
      })
    ).resolves.toBeNull();
  });

  it("retains the warning row when the record is resolved sequentially", async () => {
    // Beyond `maxParallelRecords` the resolver walks records one at a time; the
    // same decision has to be reached on that path.
    const harness = resolver(
      ["99", "30"],
      {
        "99": {
          state: "success",
          logUrl: "https://github.com/octo/app/actions/runs/990",
          runPath: ".github/workflows/unrelated.yml",
          runStatus: "completed",
          runConclusion: "success"
        },
        ...succeededDelete
      },
      {
        maxParallelRecords: 1,
        stateSaveFailures: {
          "300#1": { attempts: 2, runAttempt: 1, error: "push rejected" }
        }
      }
    );

    await expect(harness.resolve()).resolves.toMatchObject({
      status: "deleted-state-warning"
    });
  });
});
