import { describe, expect, it } from "vitest";
import {
  DELETE_RESULT_ARTIFACT,
  DELETE_RESULT_FILE,
  probeDeleteConflict,
  readNonTerminalState
} from "./delete-conflict.js";
import type {
  DeleteConflictDependencies,
  DeleteConflictProbe
} from "./delete-conflict.js";
import type {
  ArtifactFiles,
  WorkflowArtifact
} from "../../deploy-artifacts.js";
import type { DeploymentRow } from "./deployment-resolver.js";

const REQUEST = {
  repo: "octo/app",
  environment: "dev",
  application: "demo"
} as const;

const RUN_URL = "https://github.com/octo/app/actions/runs/4242";

const CONFLICT_OUTPUT = [
  "Deleting application 'demo'...",
  "RESPONSE 409: 409 Conflict",
  "ERROR CODE: Conflict",
  '{"error":{"code":"Conflict","message":"The target resource is in progress state: Updating."}}'
].join("\n");

function failedDeployment(overrides: Partial<DeploymentRow> = {}) {
  return {
    app: "demo",
    environment: "dev",
    provider: "azure",
    status: "delete-failed",
    deploymentId: "17",
    runUrl: RUN_URL,
    ...overrides
  } satisfies DeploymentRow;
}

function resultArtifact(
  overrides: Partial<WorkflowArtifact> = {}
): WorkflowArtifact {
  return {
    id: 9,
    name: DELETE_RESULT_ARTIFACT,
    workflow_run: { id: 4242 },
    ...overrides
  };
}

function resultFiles(payload: unknown): ArtifactFiles {
  return { [DELETE_RESULT_FILE]: JSON.stringify(payload) };
}

const FAILED_CONFLICT_RESULT = {
  schemaVersion: "1.0",
  outcome: "failed",
  exitCode: 1,
  resourceType: "application",
  name: "demo",
  forced: false,
  output: CONFLICT_OUTPUT
};

interface ProbeCalls {
  listed: Array<{ repo: string; runId: unknown }>;
  downloaded: Array<{ repo: string; artifact: WorkflowArtifact }>;
}

function probe(overrides: Partial<DeleteConflictDependencies> = {}): {
  calls: ProbeCalls;
  run: () => Promise<DeleteConflictProbe>;
} {
  const calls: ProbeCalls = { listed: [], downloaded: [] };
  const dependencies: DeleteConflictDependencies = {
    resolveEnvDeployment: async () => failedDeployment(),
    listArtifacts: async (repo, runId) => {
      calls.listed.push({ repo, runId });
      return [resultArtifact()];
    },
    downloadArtifact: async (repo, artifact) => {
      calls.downloaded.push({ repo, artifact });
      return resultFiles(FAILED_CONFLICT_RESULT);
    },
    ...overrides
  };
  return { calls, run: () => probeDeleteConflict(REQUEST, dependencies) };
}

describe("readNonTerminalState", () => {
  it.each([
    ["the control plane's conflict message", CONFLICT_OUTPUT, "Updating"],
    [
      "a quoted state name",
      'The target resource is in progress state: "Deleting".',
      "Deleting"
    ],
    [
      "a lowercased message",
      "the target resource is in progress state: accepted",
      "accepted"
    ]
  ])("reads the stranded state from %s", (_case, output, expected) => {
    expect(readNonTerminalState(output)).toBe(expected);
  });

  it.each([
    ["empty output", ""],
    ["an unrelated failure", "Error: recipe execution failed for 'db'."],
    [
      "a conflict phrase with no state named",
      "The target resource is in progress state:"
    ]
  ])("reports no stranded state for %s", (_case, output) => {
    expect(readNonTerminalState(output)).toBe("");
  });
});

describe("probeDeleteConflict", () => {
  it("reports the stranded state from the failed run's result artifact", async () => {
    const { calls, run } = probe();

    await expect(run()).resolves.toEqual({
      state: "conflict",
      resourceState: "Updating",
      forced: false
    });
    expect(calls.listed).toEqual([{ repo: "octo/app", runId: "4242" }]);
    expect(calls.downloaded).toEqual([
      { repo: "octo/app", artifact: resultArtifact() }
    ]);
  });

  it("reports that the failing attempt had already been forced", async () => {
    const { run } = probe({
      downloadArtifact: async () =>
        resultFiles({ ...FAILED_CONFLICT_RESULT, forced: true })
    });

    await expect(run()).resolves.toEqual({
      state: "conflict",
      resourceState: "Updating",
      forced: true
    });
  });

  it("is clear when nothing is deployed", async () => {
    const { calls, run } = probe({ resolveEnvDeployment: async () => null });

    await expect(run()).resolves.toEqual({ state: "clear" });
    expect(calls.listed).toEqual([]);
  });

  it.each(["success", "pending", "deleting", "failed"])(
    "is clear when the deployment status is %s rather than a failed delete",
    async (status) => {
      const { calls, run } = probe({
        resolveEnvDeployment: async () => failedDeployment({ status })
      });

      await expect(run()).resolves.toEqual({ state: "clear" });
      expect(calls.listed).toEqual([]);
    }
  );

  it("is clear when the recorded delete did not fail", async () => {
    const { run } = probe({
      downloadArtifact: async () =>
        resultFiles({ ...FAILED_CONFLICT_RESULT, outcome: "succeeded" })
    });

    await expect(run()).resolves.toEqual({ state: "clear" });
  });

  it("is clear when the delete failed for an unrelated reason", async () => {
    const { run } = probe({
      downloadArtifact: async () =>
        resultFiles({
          ...FAILED_CONFLICT_RESULT,
          output: "Error: recipe deletion failed for 'db'."
        })
    });

    await expect(run()).resolves.toEqual({ state: "clear" });
  });

  it("is clear when the failed run recorded no output at all", async () => {
    const { run } = probe({
      downloadArtifact: async () =>
        resultFiles({ ...FAILED_CONFLICT_RESULT, output: 42 })
    });

    await expect(run()).resolves.toEqual({ state: "clear" });
  });

  it("does not conclude when the deployment state cannot be read", async () => {
    const { run } = probe({
      resolveEnvDeployment: async () => {
        throw new Error("gh: HTTP 503");
      }
    });

    await expect(run()).resolves.toEqual({
      state: "unknown",
      detail: "The current deployment state could not be read: gh: HTTP 503."
    });
  });

  it("does not conclude when the deployment state failure carries no message", async () => {
    const { run } = probe({
      resolveEnvDeployment: async () => {
        throw new Error("   ");
      }
    });

    await expect(run()).resolves.toEqual({
      state: "unknown",
      detail:
        "The current deployment state could not be read: the request was refused."
    });
  });

  // `gh` failures reach this through several layers, and not every layer
  // rejects with an Error, so the reason must survive either shape.
  it.each([
    ["a non-Error rejection", "gh exploded", "gh exploded."],
    ["a rejection with no value", undefined, "the request was refused."]
  ])(
    "reports why it could not conclude from %s",
    async (_case, thrown, expected) => {
      const { run } = probe({
        resolveEnvDeployment: () => Promise.reject(thrown)
      });

      await expect(run()).resolves.toEqual({
        state: "unknown",
        detail: `The current deployment state could not be read: ${expected}`
      });
    }
  );

  it.each([
    ["an empty run URL", ""],
    ["a URL that names no run", "https://github.com/octo/app/actions"]
  ])("does not conclude when the failed delete has %s", async (_case, url) => {
    const { calls, run } = probe({
      resolveEnvDeployment: async () => failedDeployment({ runUrl: url })
    });

    await expect(run()).resolves.toEqual({
      state: "unknown",
      detail:
        "The failed delete has no workflow run Radius can read its result from."
    });
    expect(calls.listed).toEqual([]);
  });

  it("does not conclude when the run's artifacts cannot be listed", async () => {
    const { run } = probe({
      listArtifacts: async () => {
        throw new Error("HTTP 403: Forbidden");
      }
    });

    await expect(run()).resolves.toEqual({
      state: "unknown",
      detail:
        "The failed delete run's artifacts could not be listed: HTTP 403: Forbidden."
    });
  });

  it.each([
    ["the artifact is absent", [] as WorkflowArtifact[]],
    [
      "only unrelated artifacts were uploaded",
      [resultArtifact({ name: "radius-logs" })]
    ],
    ["the artifact expired", [resultArtifact({ expired: true })]]
  ])("does not conclude when %s", async (_case, artifacts) => {
    const { calls, run } = probe({ listArtifacts: async () => artifacts });

    await expect(run()).resolves.toEqual({
      state: "unknown",
      detail: `The failed delete run no longer has a ${DELETE_RESULT_ARTIFACT} artifact, so why it failed cannot be established.`
    });
    expect(calls.downloaded).toEqual([]);
  });

  it("does not conclude when the artifact download is refused", async () => {
    const { run } = probe({
      downloadArtifact: async () => {
        throw new Error("HTTP 403: Forbidden");
      }
    });

    await expect(run()).resolves.toEqual({
      state: "unknown",
      detail:
        "The failed delete run's result could not be downloaded: HTTP 403: Forbidden."
    });
  });

  it("does not conclude when the artifact download yields nothing", async () => {
    const { run } = probe({ downloadArtifact: async () => null });

    await expect(run()).resolves.toEqual({
      state: "unknown",
      detail: `The ${DELETE_RESULT_ARTIFACT} artifact could not be downloaded from the failed delete run.`
    });
  });

  it.each([
    ["the result file is missing", { "radius-logs.txt": "…" }],
    ["the result file is empty", { [DELETE_RESULT_FILE]: "   " }],
    ["the result file is not JSON", { [DELETE_RESULT_FILE]: "{oops" }],
    ["the result file is not an object", { [DELETE_RESULT_FILE]: "[1,2]" }],
    ["the result file is null", { [DELETE_RESULT_FILE]: "null" }]
  ])("does not conclude when %s", async (_case, files) => {
    const { run } = probe({ downloadArtifact: async () => files });

    await expect(run()).resolves.toEqual({
      state: "unknown",
      detail: `The ${DELETE_RESULT_FILE} written by the failed delete run could not be read.`
    });
  });
});
