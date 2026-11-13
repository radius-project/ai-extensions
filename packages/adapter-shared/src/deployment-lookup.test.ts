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
  const h = resolver(
    ["1"],
    Object.fromEntries(
      Array.from({ length: 2000 }, (_, index) => [
        String(index + 1),
        {
          state: "failure",
          logUrl: `https://github.com/${REPO}/actions/runs/1`,
          runPath: DEPLOY_WORKFLOW,
          runStatus: "completed",
          runConclusion: "failure"
        }
      ])
    )
  );
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
  runError?: Error;
}

const activeRecord: RecordFixture = {
  state: "in_progress",
  logUrl: `https://github.com/${REPO}/actions/runs/42`,
  runPath: DEPLOY_WORKFLOW,
  runStatus: "in_progress",
  runAttempt: 1,
  headSha: "a".repeat(40),
  runRepository: REPO.toUpperCase()
};
const missingOlderRun: RecordFixture = {
  state: "failure",
  logUrl: `https://github.com/${REPO}/actions/runs/41`,
  runError: new Error("HTTP 404: older run missing")
};

function resolver(
  ids: string[],
  records: Record<string, RecordFixture>,
  options: {
    variables?: string | Error;
    maxParallelRecords?: number;
    application?: string;
    identity?: DeploymentApplicationIdentity;
    identities?: Readonly<Record<number, DeploymentApplicationIdentity>>;
    pages?: readonly string[][];
  } = {}
) {
  const ghOrThrow = vi.fn((args: string[]) => {
    const path = args[1] ?? "";
    if (path.includes("/variables?")) {
      return options.variables instanceof Error ?
          Promise.reject(options.variables)
        : Promise.resolve(options.variables ?? "AZURE_CLIENT_ID");
    }
    if (path.includes("/deployments?")) {
      const page = Number(/&page=(\d+)/.exec(path)?.[1] ?? 1);
      return Promise.resolve(
        (options.pages ? (options.pages[page - 1] ?? []) : ids).join("\n")
      );
    }
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
      if (record.runError) return Promise.reject(record.runError);
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
    list: () =>
      createDeploymentLookup({
        readApplicationIdentity: async () =>
          options.identity ?? {
            state: "known",
            application: "radius-app"
          },
        ghOrThrow,
        deployWorkflowFile: DEPLOY_WORKFLOW,
        deleteWorkflowFile: DELETE_WORKFLOW
      }).listEnvDeployment(REPO, ENVIRONMENT, ""),
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
  it("reports verified absence from an empty bounded listing", async () => {
    const h = resolver([], {});
    expect(await h.list()).toEqual({ deployment: null, incomplete: false });
  });

  it.each(["active", "successful delete", "legacy stop"] as const)(
    "keeps bounded %s history decisive without reading older records",
    async (kind) => {
      const h = resolver(["7", "6"], {
        "7": {
          state: kind === "legacy stop" ? "inactive" : "success",
          description:
            kind === "legacy stop" ? ABANDONED_DEPLOYMENT_DESCRIPTION : "",
          logUrl: `https://github.com/${REPO}/actions/runs/42`,
          runPath:
            kind === "successful delete" ? DELETE_WORKFLOW : DEPLOY_WORKFLOW,
          runStatus: kind === "active" ? "queued" : "completed",
          runConclusion: kind === "active" ? "" : "success",
          runAttempt: 1,
          headSha: "a".repeat(40)
        }
      });
      const result = await h.list();
      expect(result.incomplete).toBe(false);
      if (kind === "active") {
        expect(result).toMatchObject({
          deployment: { status: "pending" },
          selection: { runId: 42, runAttempt: 1 }
        });
        expect(result.deployment?.recovery).toBeUndefined();
      } else expect(result.deployment).toBeNull();
      expect(
        h.ghOrThrow.mock.calls.some(([args]) =>
          args[1].includes("/deployments/6/")
        )
      ).toBe(false);
    }
  );

  it.each([1999, 2000])(
    "keeps ordinary listing bounded for %i historical records without confirmation authority",
    async (length) => {
      const ids = Array.from({ length }, (_, i) => String(i + 1));
      const records = Object.fromEntries(
        ids.map((id) => [
          id,
          {
            state: "failure",
            logUrl: `https://github.com/${REPO}/actions/runs/${id}`,
            runPath: DEPLOY_WORKFLOW,
            runStatus: "completed",
            runConclusion: "failure",
            runAttempt: 1,
            headSha: "a".repeat(40)
          }
        ])
      );
      const h = resolver([], records, {
        pages: [ids.slice(0, 100), ids.slice(100, 200)]
      });
      expect(await h.list()).toMatchObject({
        deployment: { deploymentId: "1", status: "failed" },
        selection: { runId: 1, runAttempt: 1 },
        incomplete: false
      });
      expect((await h.list()).deployment?.recovery).toBeUndefined();
      expect(
        h.ghOrThrow.mock.calls.filter(([args]) =>
          args[1].includes("/deployments?")
        )
      ).toHaveLength(2);
      expect(h.ghOrThrow.mock.calls.length).toBeLessThanOrEqual(48);
    }
  );

  it.each(["delete", "legacy abandonment"] as const)(
    "honors a %s stop before requesting any older page",
    async (stop) => {
      const ids = Array.from({ length: 100 }, (_, i) => String(i + 1));
      const records = Object.fromEntries(
        ids.map((id) => [
          id,
          {
            state:
              id === "3" && stop === "legacy abandonment" ?
                "inactive"
              : "failure",
            description:
              id === "3" && stop === "legacy abandonment" ?
                ABANDONED_DEPLOYMENT_DESCRIPTION
              : "",
            logUrl: `https://github.com/${REPO}/actions/runs/${id}`,
            runPath:
              id === "3" ? DELETE_WORKFLOW
              : id === "2" ? DEPLOY_WORKFLOW
              : "unrelated.yml",
            runStatus: "completed",
            runConclusion: id === "3" ? "success" : "failure",
            runAttempt: 1,
            headSha: "a".repeat(40)
          }
        ])
      );
      const h = resolver([], records, { pages: [ids] });
      expect(await h.resolve()).toMatchObject({ deploymentId: "2" });
      expect(
        h.ghOrThrow.mock.calls.filter(([args]) =>
          args[1].includes("/deployments?")
        )
      ).toHaveLength(1);
    }
  );

  it.each(["partial", "complete", "rerun"] as const)(
    "does not trust %s cleanup groups cut off at record 100",
    async (mode) => {
      const ids = Array.from({ length: 101 }, (_, i) => String(i + 1));
      const records: Record<string, RecordFixture> = Object.fromEntries(
        ids.map((id) => [
          id,
          {
            state: "failure",
            logUrl: `https://github.com/${REPO}/actions/runs/${id === "101" ? "1" : id}`,
            runPath:
              id === "1" || id === "101" ? DEPLOY_WORKFLOW : "unrelated.yml",
            runStatus: "completed",
            runConclusion: "failure",
            runAttempt: 1,
            headSha: "a".repeat(40)
          }
        ])
      );
      const h = resolver([], records, {
        pages: [ids.slice(0, 100), ids.slice(100)]
      });
      const recovery = (await h.resolve())?.recovery;
      if (!recovery) throw new Error("Missing recovery");
      records["1"].state = "inactive";
      records["1"].description = cleanupMarker(recovery);
      if (mode !== "partial") {
        records["101"].state = "inactive";
        records["101"].description = cleanupMarker(recovery);
      }
      if (mode === "rerun") {
        records["1"].runAttempt = 2;
        records["101"].runAttempt = 2;
      }
      h.ghOrThrow.mockClear();
      expect(await h.list()).toEqual({ deployment: null, incomplete: true });
      expect(
        h.ghOrThrow.mock.calls.filter(([args]) =>
          args[1].includes("/deployments?")
        )
      ).toHaveLength(1);
      const resolved = await h.resolve();
      if (mode === "complete") expect(resolved).toBeNull();
      else expect(resolved?.deploymentId).toBe("1");
    }
  );
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

  it("exposes queued runs without recovery metadata", async () => {
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
    const row = await h.resolve();
    expect(row).toMatchObject({ status: "pending" });
    expect(row?.recovery).toBeUndefined();
  });

  it.each([DEPLOY_WORKFLOW, DELETE_WORKFLOW])(
    "keeps an active %s visible after unrelated history despite an older missing run",
    async (runPath) => {
      const h = resolver(["3", "2", "1"], {
        "3": {
          state: "success",
          logUrl: `https://github.com/${REPO}/actions/runs/43`,
          runPath: "unrelated.yml",
          runStatus: "completed",
          runConclusion: "success"
        },
        "2": {
          state: "in_progress",
          logUrl: `https://github.com/${REPO}/actions/runs/42`,
          runPath,
          runStatus: "in_progress"
        },
        "1": {
          state: "failure",
          logUrl: `https://github.com/${REPO}/actions/runs/41`
        }
      });
      const read = h.ghOrThrow.getMockImplementation();
      if (!read) throw new Error("Missing API fixture");
      h.ghOrThrow.mockImplementation((args) =>
        args[1].endsWith("/actions/runs/41") ?
          Promise.reject(new Error("HTTP 404: older run missing"))
        : read(args)
      );
      const row = await h.resolve();
      expect(row).toMatchObject({
        deploymentId: "2",
        app: "radius-app",
        status: runPath === DEPLOY_WORKFLOW ? "pending" : "deleting"
      });
      expect(row?.recovery).toBeUndefined();
    }
  );

  describe.each([DEPLOY_WORKFLOW, DELETE_WORKFLOW])(
    "verified active %s",
    (runPath) => {
      it.each(["queued", "in_progress", "waiting", "requested", "pending"])(
        "returns %s without reading older pages or exposing recovery",
        async (runStatus) => {
          const h = resolver(
            Array.from({ length: 100 }, (_, index) => String(100 - index)),
            { "100": { ...activeRecord, runPath, runStatus } }
          );
          const row = await h.resolve();
          expect(row).toMatchObject({
            app: "radius-app",
            status: runPath === DEPLOY_WORKFLOW ? "pending" : "deleting",
            deploymentId: "100"
          });
          expect(row?.recovery).toBeUndefined();
          expect(h.ghOrThrow.mock.calls).toHaveLength(4);
        }
      );

      it("does not fabricate identity when the active run's artifact is unavailable", async () => {
        const h = resolver(
          ["2", "1"],
          { "2": { ...activeRecord, runPath }, "1": missingOlderRun },
          { identity: { state: "unavailable", reason: "Artifact missing" } }
        );
        const row = await h.resolve("guessed-from-model");
        expect(row).toMatchObject({
          app: "",
          identity: { state: "unavailable", reason: "Artifact missing" }
        });
        expect(row?.recovery).toBeUndefined();
      });
    }
  );

  it.each([
    { runStatus: "" },
    { runStatus: "unsupported" },
    { runStatus: "completed" },
    { runConclusion: "failure" },
    { runId: 43 },
    { runRepository: "another/repository" },
    { description: "Radius cleanup v1 previous-revision", state: "inactive" },
    { description: ABANDONED_DEPLOYMENT_DESCRIPTION },
    { logUrl: "https://github.com/another/repository/actions/runs/42" }
  ])(
    "does not fast-path unverified or marked activity %j",
    async (evidence) => {
      const h = resolver(["2", "1"], {
        "2": { ...activeRecord, ...evidence },
        "1": missingOlderRun
      });
      await expect(h.resolve()).rejects.toThrow("HTTP 404: older run missing");
    }
  );

  it.each(["read failure", "unknown workflow"] as const)(
    "preserves a newer %s before an active row",
    async (failure) => {
      const h = resolver(["3", "2"], {
        "3": {
          state: "failure",
          logUrl: `https://github.com/${REPO}/actions/runs/43`,
          ...(failure === "read failure" ?
            { runError: new Error("HTTP 404: newer run missing") }
          : {})
        },
        "2": activeRecord
      });
      await expect(h.resolve()).rejects.toThrow(
        failure === "read failure" ? "newer run missing" : "Could not identify"
      );
    }
  );

  it("propagates the active run's application identity read error", async () => {
    const h = resolver(["2"], { "2": activeRecord });
    const lookup = createDeploymentLookup({
      ghOrThrow: h.ghOrThrow,
      readApplicationIdentity: async () => {
        throw new Error("Application identity read failed");
      },
      deployWorkflowFile: DEPLOY_WORKFLOW,
      deleteWorkflowFile: DELETE_WORKFLOW
    });
    await expect(
      lookup.resolveEnvDeployment(REPO, ENVIRONMENT, "")
    ).rejects.toThrow("Application identity read failed");
  });

  it("propagates a batched read failure before an otherwise verified active row", async () => {
    const h = resolver(["4", "3", "2"], {
      "4": {
        state: "success",
        logUrl: `https://github.com/${REPO}/actions/runs/44`,
        runPath: "unrelated.yml",
        runStatus: "completed",
        runConclusion: "success"
      },
      "3": {
        ...missingOlderRun,
        runError: new Error("Newer record unreadable")
      },
      "2": activeRecord
    });
    await expect(h.resolve()).rejects.toThrow("Newer record unreadable");
  });

  it.each([2, 20])(
    "finds active history on page %s without fetching beyond it",
    async (activePage) => {
      const pages = Array.from({ length: activePage }, (_, page) =>
        Array.from({ length: 100 }, (_, index) =>
          String(page * 100 + index + 1)
        )
      );
      const activeId = pages[activePage - 1][0];
      const olderId = pages[activePage - 1][1];
      const records: Record<string, RecordFixture> = Object.fromEntries(
        pages
          .slice(0, -1)
          .flat()
          .map((id) => [
            id,
            {
              state: "success",
              logUrl: `https://github.com/${REPO}/actions/runs/${Number(id) + 1000}`,
              runPath: "unrelated.yml",
              runStatus: "completed",
              runConclusion: "success"
            }
          ])
      );
      records[activeId] = activeRecord;
      records[olderId] = missingOlderRun;
      const h = resolver([], records, { pages });
      const row = await h.resolve();
      expect(row).toMatchObject({ deploymentId: activeId, status: "pending" });
      expect(row?.recovery).toBeUndefined();
      expect(
        h.ghOrThrow.mock.calls.filter(([args]) =>
          args[1].includes("/deployments?")
        )
      ).toHaveLength(activePage);
    }
  );

  it.each(["unrelated", "terminal"] as const)(
    "refuses excess %s history after scanning twenty full unrelated pages",
    async (last) => {
      const pages = Array.from({ length: 20 }, (_, page) =>
        Array.from({ length: 100 }, (_, index) =>
          String(page * 100 + index + 1)
        )
      );
      const records = Object.fromEntries(
        pages.flat().map((id) => [
          id,
          {
            state: "failure",
            logUrl: `https://github.com/${REPO}/actions/runs/${Number(id) + 1000}`,
            runPath:
              last === "terminal" && id === "1901" ?
                DEPLOY_WORKFLOW
              : "unrelated.yml",
            runStatus: "completed",
            runConclusion: "failure"
          }
        ])
      );
      const h = resolver([], records, { pages });
      await expect(h.resolve()).rejects.toThrow("read budget");
      expect(
        h.ghOrThrow.mock.calls.filter(([args]) =>
          args[1].includes("/deployments?")
        )
      ).toHaveLength(20);
    }
  );

  it.each([DEPLOY_WORKFLOW, "unrelated.yml"])(
    "does not bypass a newer %s cleanup marker to expose an older active row",
    async (runPath) => {
      const h = resolver(["3", "2", "1"], {
        "3": {
          ...activeRecord,
          runPath,
          state: "inactive",
          runStatus: "completed",
          runConclusion: "failure",
          description: "Radius cleanup v1 previous-revision"
        },
        "2": {
          ...activeRecord,
          logUrl: `https://github.com/${REPO}/actions/runs/40`
        },
        "1": missingOlderRun
      });
      await expect(h.resolve()).rejects.toThrow("older run missing");
      expect(
        h.ghOrThrow.mock.calls.filter(([args]) =>
          args[1].endsWith("/actions/runs/42")
        )
      ).toHaveLength(1);
    }
  );
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
    const ids = Array.from({ length: 100 }, (_, index) => String(index + 1));
    const h = resolver(
      ids,
      Object.fromEntries(
        ids.map((id) => [
          id,
          {
            state: "failure",
            logUrl: `https://github.com/${REPO}/actions/runs/${id}`,
            runPath: "unrelated.yml",
            runStatus: "completed",
            runConclusion: "failure"
          }
        ])
      )
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
