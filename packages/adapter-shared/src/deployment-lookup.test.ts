import { describe, expect, it, vi } from "vitest";
import {
  ABANDONED_DEPLOYMENT_DESCRIPTION,
  type DeploymentApplicationIdentity
} from "@radius-project/core";
import { createDeploymentLookup } from "./deployment-lookup.js";
import { cleanupMarker } from "./deployment-cleanup-marker.js";
import { createDeploymentDeferred } from "../test/support/deployment.js";

const REPO = "octo/app";
const ENVIRONMENT = "dev";
const DEPLOY_WORKFLOW = "run-rad-commands.yml";
const DELETE_WORKFLOW = "delete-application.yml";

it("keeps a healthy latest deployment readable without resolving thousands of older runs", async () => {
  const h = resolver(
    Array.from({ length: 100 }, (_, i) => String(3000 - i)),
    {
      "3000": {
        state: "success",
        logUrl: `https://github.com/${REPO}/actions/runs/42`,
        runPath: `.github/workflows/${DEPLOY_WORKFLOW}`,
        runStatus: "completed",
        runConclusion: "success"
      }
    }
  );
  expect(await h.resolve()).toMatchObject({
    app: "radius-app",
    status: "success"
  });
  expect(h.ghOrThrow.mock.calls).toHaveLength(4);
});

it.each([false, true])(
  "keeps expired identity recoverable but read failure fail-closed: %s",
  async (readFailed) => {
    const h = resolver(
      ["7"],
      {
        "7": {
          state: "failure",
          logUrl: `https://github.com/${REPO}/actions/runs/42`,
          runPath: DEPLOY_WORKFLOW,
          runStatus: "completed",
          runConclusion: "cancelled",
          runAttempt: 1,
          headSha: "a".repeat(40)
        }
      },
      {
        identity: {
          state: "unavailable",
          reason: "Artifact missing",
          readFailed
        }
      }
    );
    expect(await h.resolve()).toMatchObject({
      app: "",
      recovery: {
        runId: 42,
        runAttempt: 1,
        canMarkCleanupComplete: !readFailed,
        confirmation: "octo/app/run-42@1/dev"
      }
    });
  }
);

it.each([0, -1, 1.5, Number.NaN])(
  "refuses invalid lookup concurrency %s before I/O",
  async (maxParallelRecords) => {
    const h = resolver([], {}, { maxParallelRecords });
    await expect(h.resolve()).rejects.toThrow("positive concurrency");
    expect(h.ghOrThrow).not.toHaveBeenCalled();
  }
);

it("fails closed at the full history budget without an unbounded recovery scan", async () => {
  const h = resolver(["1"], {
    "1": {
      state: "failure",
      logUrl: `https://github.com/${REPO}/actions/runs/1`,
      runPath: DEPLOY_WORKFLOW,
      runStatus: "completed",
      runConclusion: "failure"
    }
  });
  let pages = 0;
  const lookup = createDeploymentLookup({
    ghOrThrow: async (args) => {
      if (!args[1].includes("/deployments?")) return h.ghOrThrow(args);
      const page = Number(/&page=(\d+)/.exec(args[1])?.[1] ?? 1);
      pages++;
      return Array.from({ length: 100 }, (_, i) =>
        String((page - 1) * 100 + i + 1)
      ).join("\n");
    },
    readApplicationIdentity: async () => ({
      state: "unavailable",
      reason: "Missing"
    }),
    deployWorkflowFile: DEPLOY_WORKFLOW,
    deleteWorkflowFile: DELETE_WORKFLOW
  });
  await expect(
    lookup.resolveEnvDeployment(REPO, ENVIRONMENT, "")
  ).rejects.toThrow("read budget");
  expect(pages).toBe(20);
});

it("propagates an older grouped-record read failure instead of offering incomplete recovery", async () => {
  const h = resolver(["1", "2"], {
    "1": {
      state: "failure",
      logUrl: `https://github.com/${REPO}/actions/runs/1`,
      runPath: DEPLOY_WORKFLOW,
      runStatus: "completed",
      runConclusion: "failure"
    }
  });
  const lookup = createDeploymentLookup({
    ghOrThrow: (args) =>
      args[1].includes("/deployments/2/statuses") ?
        Promise.reject(new Error("Older record unavailable"))
      : h.ghOrThrow(args),
    readApplicationIdentity: async () => ({
      state: "unavailable",
      reason: "Missing"
    }),
    deployWorkflowFile: DEPLOY_WORKFLOW,
    deleteWorkflowFile: DELETE_WORKFLOW
  });
  await expect(
    lookup.resolveEnvDeployment(REPO, ENVIRONMENT, "")
  ).rejects.toThrow("Older record unavailable");
});
interface RecordFixture {
  state: string;
  description?: string;
  logUrl?: string;
  previousLogUrl?: string;
  runPath?: string;
  runStatus?: string;
  runConclusion?: string;
  runAttempt?: number;
  headSha?: string;
  runId?: number;
  runRepository?: string;
}

function resolver(
  ids: string[],
  records: Record<string, RecordFixture>,
  options: {
    variables?: string | Error;
    maxParallelRecords?: number;
    application?: string;
    identity?: DeploymentApplicationIdentity;
    identities?: Readonly<Record<number, DeploymentApplicationIdentity>>;
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
          record.runAttempt ?? "",
          record.headSha ?? "",
          "",
          record.runId ?? runMatch[1],
          record.runRepository ?? REPO,
          "workflow_dispatch"
        ].join("\t")
      );
    }
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  });

  return {
    ghOrThrow,
    resolve: (appName = "radius-app") =>
      createDeploymentLookup({
        readApplicationIdentity: async (_repo, _environment, runId) =>
          options.identities?.[runId] ??
          options.identity ?? {
            state: "known",
            application: options.application ?? "radius-app"
          },
        ghOrThrow,
        deployWorkflowFile: DEPLOY_WORKFLOW,
        deleteWorkflowFile: DELETE_WORKFLOW,
        maxParallelRecords: options.maxParallelRecords ?? 10
      }).resolveEnvDeployment(REPO, ENVIRONMENT, appName)
  };
}

describe("resolveEnvironmentDeployment", () => {
  it.each(["delete", "legacy abandonment"] as const)(
    "preserves an older %s history stop without adopting unrelated records",
    async (kind) => {
      const h = resolver(["3", "2", "1"], {
        "3": {
          state: "success",
          logUrl: `https://github.com/${REPO}/actions/runs/30`,
          runPath: "unrelated.yml",
          runStatus: "completed",
          runConclusion: "success"
        },
        "2": {
          state: kind === "delete" ? "success" : "inactive",
          description:
            kind === "delete" ? "" : ABANDONED_DEPLOYMENT_DESCRIPTION,
          logUrl: `https://github.com/${REPO}/actions/runs/20`,
          runPath: DELETE_WORKFLOW,
          runStatus: "completed",
          runConclusion: "success"
        }
      });
      expect(await h.resolve()).toBeNull();
    }
  );

  it("does not borrow identity from older history for a successful unknown deployment", async () => {
    const h = resolver(
      ["3", "2"],
      {
        "3": {
          state: "success",
          logUrl: `https://github.com/${REPO}/actions/runs/30`,
          runPath: DEPLOY_WORKFLOW,
          runStatus: "completed",
          runConclusion: "success",
          runAttempt: 1,
          headSha: "a".repeat(40)
        },
        "2": {
          state: "success",
          logUrl: `https://github.com/${REPO}/actions/runs/20`,
          runPath: DEPLOY_WORKFLOW,
          runStatus: "completed",
          runConclusion: "success"
        }
      },
      {
        identities: {
          30: { state: "unavailable", reason: "Artifact expired" },
          20: { state: "known", application: "older-only-app" }
        }
      }
    );
    expect(await h.resolve("current-model-app")).toMatchObject({
      app: "",
      status: "success",
      identity: { state: "unavailable" },
      recovery: {
        runId: 30,
        confirmation: `${REPO}/run-30@1/${ENVIRONMENT}`
      }
    });
  });

  it.each([
    { runAttempt: 0 },
    { runAttempt: Number.MAX_SAFE_INTEGER + 1 },
    { headSha: "truncated" },
    { runId: 43 },
    { runRepository: "another/repository" }
  ])("withholds recovery for unverified run evidence %j", async (evidence) => {
    const h = resolver(["3"], {
      "3": {
        state: "failure",
        logUrl: `https://github.com/${REPO}/actions/runs/42`,
        runPath: DEPLOY_WORKFLOW,
        runStatus: "completed",
        runConclusion: "failure",
        runAttempt: 1,
        headSha: "a".repeat(40),
        ...evidence
      }
    });
    expect(await h.resolve()).toMatchObject({ status: "failed" });
    expect((await h.resolve())?.recovery).toBeUndefined();
  });

  it.each([
    { index: 0, value: DELETE_WORKFLOW },
    { index: 1, value: "in_progress" },
    { index: 2, value: "cancelled" },
    { index: 3, value: "2" },
    { index: 4, value: "b".repeat(40) },
    { index: 6, value: "43" },
    { index: 7, value: "another/repository" }
  ])(
    "refuses conflicting evidence across duplicate run records %j",
    async ({ index, value }) => {
      const record: RecordFixture = {
        state: "failure",
        logUrl: `https://github.com/${REPO}/actions/runs/42`,
        runPath: DEPLOY_WORKFLOW,
        runStatus: "completed",
        runConclusion: "failure",
        runAttempt: 1,
        headSha: "a".repeat(40)
      };
      const h = resolver(["3", "2"], { "3": record, "2": record });
      const read = h.ghOrThrow.getMockImplementation();
      if (!read) throw new Error("Missing API fixture");
      let runReads = 0;
      h.ghOrThrow.mockImplementation(async (args) => {
        const response = await read(args);
        if (!args[1].includes("/actions/runs/")) return response;
        if (++runReads === 1) return response;
        const fields = response.split("\t");
        fields[index] = value;
        return fields.join("\t");
      });
      await expect(h.resolve()).rejects.toThrow("run changed");
    }
  );

  it("exposes queued runs without allowing external-cleanup attestation", async () => {
    const h = resolver(["3"], {
      "3": {
        state: "pending",
        logUrl: `https://github.com/${REPO}/actions/runs/42`,
        runPath: DEPLOY_WORKFLOW,
        runStatus: "queued",
        runAttempt: 1,
        headSha: "a".repeat(40),
        runRepository: REPO.toUpperCase()
      }
    });
    expect(await h.resolve()).toMatchObject({
      status: "pending",
      recovery: { runId: 42, canMarkCleanupComplete: false }
    });
  });

  it.each(["partial", "complete", "rerun"] as const)(
    "keeps cleanup run-scoped with %s markers across duplicate deployment records",
    async (mode) => {
      const records: Record<string, RecordFixture> = {
        "3": {
          state: "failure",
          logUrl: `https://github.com/${REPO}/actions/runs/30`,
          runPath: DEPLOY_WORKFLOW,
          runStatus: "completed",
          runConclusion: "failure",
          runAttempt: 1,
          headSha: "a".repeat(40)
        },
        "2": {
          state: "failure",
          logUrl: `https://github.com/${REPO}/actions/runs/30`,
          runPath: DEPLOY_WORKFLOW,
          runStatus: "completed",
          runConclusion: "failure",
          runAttempt: 1,
          headSha: "a".repeat(40)
        },
        "1": {
          state: "success",
          logUrl: `https://github.com/${REPO}/actions/runs/10`,
          runPath: DEPLOY_WORKFLOW,
          runStatus: "completed",
          runConclusion: "success",
          runAttempt: 1,
          headSha: "b".repeat(40)
        }
      };
      const h = resolver(["3", "2", "1"], records);
      const first = await h.resolve();
      if (!first?.recovery) throw new Error("Missing recovery projection");
      expect(first.recovery.deploymentIds).toEqual(["3", "2"]);
      const marker = cleanupMarker(first.recovery);
      expect(marker.length).toBeLessThanOrEqual(140);
      records["3"].state = "inactive";
      records["3"].description = marker;
      if (mode !== "partial") {
        records["2"].state = "inactive";
        records["2"].description = marker;
      }
      if (mode === "rerun") {
        records["3"].runAttempt = 2;
        records["2"].runAttempt = 2;
      }
      expect(await h.resolve()).toMatchObject({
        deploymentId: mode === "complete" ? "1" : "3",
        status: mode === "complete" ? "success" : "failed"
      });
    }
  );

  it("walks beyond the first 100 records without treating truncation as absence", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => String(200 - index));
    const records = Object.fromEntries(
      ids.map((id, index) => [
        id,
        {
          state: "success",
          logUrl: `https://github.com/${REPO}/actions/runs/${id}`,
          runPath: index === 100 ? DEPLOY_WORKFLOW : "unrelated.yml",
          runStatus: "completed",
          runConclusion: "success"
        }
      ])
    );
    const h = resolver(ids, records);
    const ghOrThrow = vi.fn(async (args: string[]) =>
      args[1].includes("/deployments?") ?
        (args[1].includes("&page=2") ? ids.slice(100) : ids.slice(0, 100)).join(
          "\n"
        )
      : h.ghOrThrow(args)
    );
    const lookup = createDeploymentLookup({
      ghOrThrow,
      deployWorkflowFile: DEPLOY_WORKFLOW,
      deleteWorkflowFile: DELETE_WORKFLOW,
      readApplicationIdentity: async () => ({
        state: "known",
        application: "older-app"
      })
    });
    expect(
      await lookup.resolveEnvDeployment(REPO, ENVIRONMENT, "")
    ).toMatchObject({ app: "older-app", deploymentId: "100" });
    expect(ghOrThrow).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("&page=2")])
    );
  });

  it("refuses duplicated pages instead of silently dropping unresolved history", async () => {
    const h = resolver(
      Array.from({ length: 100 }, (_, index) => String(index + 1)),
      {
        "1": {
          state: "failure",
          logUrl: `https://github.com/${REPO}/actions/runs/1`,
          runPath: "unrelated.yml",
          runStatus: "completed",
          runConclusion: "failure"
        }
      }
    );
    await expect(h.resolve()).rejects.toThrow("pagination");
  });
  it("bounds the default concurrent batch to ten before walking older records", async () => {
    const release = createDeploymentDeferred<void>();
    const batchStarted = createDeploymentDeferred<void>();
    const statusIds: number[] = [];
    const ghOrThrow = async (args: string[]) => {
      const path = args[1];
      if (path.includes("/variables?")) return "AZURE_CLIENT_ID";
      if (path.includes("/deployments?"))
        return Array.from({ length: 11 }, (_, index) => String(index + 1)).join(
          "\n"
        );
      const status = /deployments\/(\d+)\/statuses/.exec(path);
      if (status) {
        const id = Number(status[1]);
        statusIds.push(id);
        if (statusIds.length === 10) batchStarted.resolve();
        if (id !== 1) await release.promise;
        return `success\thttps://github.com/${REPO}/actions/runs/${id}\t`;
      }
      const run = /actions\/runs\/(\d+)/.exec(path);
      if (run)
        return `.github/workflows/${Number(run[1]) === 11 ? DEPLOY_WORKFLOW : "unrelated.yml"}\tcompleted\tsuccess`;
      throw new Error(`Unexpected request ${path}`);
    };
    const lookup = createDeploymentLookup({
      readApplicationIdentity: async () => ({
        state: "known",
        application: "modeled-app"
      }),
      ghOrThrow,
      deployWorkflowFile: DEPLOY_WORKFLOW,
      deleteWorkflowFile: DELETE_WORKFLOW
    });
    const result = lookup.resolveEnvDeployment(
      REPO,
      ENVIRONMENT,
      "modeled-app"
    );
    try {
      await batchStarted.promise;
      expect(statusIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      release.resolve();
      await result;
    }
    expect(await result).toMatchObject({
      deploymentId: "11",
      app: "modeled-app",
      status: "success"
    });
    expect(statusIds).toHaveLength(11);
  });

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
      identity: { state: "known", application: "radius-app" },
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
      app: "radius-app",
      identity: { state: "known", application: "radius-app" },
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
      createDeploymentLookup({
        readApplicationIdentity: async () => {
          throw new Error("Unexpected identity read");
        },
        ghOrThrow,
        deployWorkflowFile: DEPLOY_WORKFLOW,
        deleteWorkflowFile: DELETE_WORKFLOW,
        maxParallelRecords: 10
      }).resolveEnvDeployment(REPO, ENVIRONMENT, "app")
    ).rejects.toBe(failure);
  });
});

describe("repository application-name compatibility", () => {
  function lookup(responses: readonly (string | Error)[]) {
    let index = 0;
    const ghOrThrow = vi.fn(async () => {
      const response = responses[index++];
      if (response === undefined) throw new Error("Unexpected GitHub request");
      if (response instanceof Error) throw response;
      return response;
    });
    return {
      ghOrThrow,
      lookup: createDeploymentLookup({
        readApplicationIdentity: async () => {
          throw new Error("Unexpected identity read");
        },
        ghOrThrow,
        deployWorkflowFile: DEPLOY_WORKFLOW,
        deleteWorkflowFile: DELETE_WORKFLOW
      })
    };
  }
  const encode = (source: string) => Buffer.from(source).toString("base64");

  it("reads the committed model on the exact requested branch and stops after its application name", async () => {
    const h = lookup([
      encode(
        "resource app 'Radius.Core/applications@v1' = { name: 'modeled-app' }"
      )
    ]);
    expect(await h.lookup.resolveRepoAppName("acme/repo", "feature")).toBe(
      "modeled-app"
    );
    expect(h.ghOrThrow).toHaveBeenCalledExactlyOnceWith([
      "api",
      "/repos/acme/repo/contents/.radius/app.bicep?ref=feature",
      "--jq",
      ".content"
    ]);
  });

  it.each([
    new Error("not available"),
    "",
    "malformed base64",
    encode("param location string")
  ])(
    "falls back to root app.bicep after an unreadable or nameless preferred model: %s",
    async (first) => {
      const h = lookup([first, encode("name: 'legacy-app'")]);
      expect(await h.lookup.resolveRepoAppName("acme/repo", "feature")).toBe(
        "legacy-app"
      );
      expect(h.ghOrThrow).toHaveBeenLastCalledWith([
        "api",
        "/repos/acme/repo/contents/app.bicep?ref=feature",
        "--jq",
        ".content"
      ]);
    }
  );

  it("retains the empty-branch main fallback and basename fallback when both reads fail", async () => {
    const h = lookup([new Error("permission denied"), new Error("missing")]);
    expect(await h.lookup.resolveRepoAppName("acme/repo", "")).toBe("repo");
    expect(h.ghOrThrow).toHaveBeenNthCalledWith(1, [
      "api",
      "/repos/acme/repo/contents/.radius/app.bicep?ref=main",
      "--jq",
      ".content"
    ]);
  });

  it("retains the complete repository label when it has no basename", async () => {
    const h = lookup(["", ""]);
    expect(await h.lookup.resolveRepoAppName("acme/", "feature")).toBe("acme/");
  });
});
