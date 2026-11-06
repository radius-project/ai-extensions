import { describe, expect, it, vi } from "vitest";
import type { DeploymentState } from "@radius-project/core";
import {
  createDeploymentFileReader,
  createDeploymentStatusReader
} from "./deployment-bindings.js";
import { createWorkflowObservationScope } from "./workflow-observation-scope.js";
import { createWorkflowArtifactReader } from "./workflow-artifacts.js";

describe("deployment file binding", () => {
  const workspace = {
    repo: "acme/app",
    branch: "feature",
    workspacePath: "workspace"
  };
  it.each(["local content", ""])(
    "prefers saved workspace content, including %j",
    async (content) => {
      const readWorkspaceFile = vi.fn(async () => content);
      const readRepositoryFile = vi.fn(async () => "remote");
      const read = createDeploymentFileReader(workspace, {
        readWorkspaceFile,
        readRepositoryFile
      });
      expect(await read("acme/app", "feature", ".radius/app.bicep")).toBe(
        content
      );
      expect(readWorkspaceFile).toHaveBeenCalledWith(
        "workspace",
        ".radius/app.bicep"
      );
      expect(readRepositoryFile).not.toHaveBeenCalled();
    }
  );

  it.each([
    undefined,
    { ...workspace, workspacePath: "" },
    { ...workspace, repo: "ACME/app" },
    { ...workspace, branch: "other" }
  ])("does not use a nonmatching workspace %j", async (workspace) => {
    const readWorkspaceFile = vi.fn(async () => "local");
    const readRepositoryFile = vi.fn(async () => "remote");
    const read = createDeploymentFileReader(workspace, {
      readWorkspaceFile,
      readRepositoryFile
    });
    expect(await read("acme/app", "feature", "app.bicep")).toBe("remote");
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    expect(readRepositoryFile).toHaveBeenCalledWith(
      "acme/app",
      "app.bicep",
      "feature"
    );
  });

  it("falls back only on an absent file and captures the trusted workspace", async () => {
    const original = { ...workspace };
    const readWorkspaceFile = vi.fn(async () => null);
    const readRepositoryFile = vi.fn(async () => null);
    const read = createDeploymentFileReader(original, {
      readWorkspaceFile,
      readRepositoryFile
    });
    original.workspacePath = "changed";
    expect(await read("acme/app", "feature", "app.bicep")).toBeNull();
    expect(readWorkspaceFile).toHaveBeenCalledWith("workspace", "app.bicep");
    expect(readRepositoryFile).toHaveBeenCalledOnce();
  });

  it.each(["local", "remote"])(
    "propagates %s read failures",
    async (source) => {
      const failure = new Error("File unavailable");
      const read = createDeploymentFileReader(
        source === "local" ? workspace : undefined,
        {
          readWorkspaceFile: async () => {
            throw failure;
          },
          readRepositoryFile: async () => {
            throw failure;
          }
        }
      );
      await expect(read("acme/app", "feature", "app.bicep")).rejects.toBe(
        failure
      );
    }
  );
});

describe("invocation artifact reader binding", () => {
  function harness() {
    const factory = vi.fn(
      (options: Parameters<typeof createWorkflowArtifactReader>[0]) =>
        createWorkflowArtifactReader(options, async () => {
          throw new Error("No artifact reads expected");
        })
    );
    const observation = createWorkflowObservationScope(factory);
    return {
      factory,
      observation,
      reader: createDeploymentStatusReader(observation)
    };
  }

  it("scopes the reader to exact application, environment and acknowledged run", async () => {
    const h = harness();
    const state = {
      deployAppName: "app",
      deployEnvName: "production",
      envName: "ignored",
      deployRunId: 2
    };
    const reader = await h.reader(state, "acme/app", "feature", 7);
    expect(h.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "acme/app",
        application: "app",
        environment: "production",
        runId: 7
      })
    );
    expect(await h.reader(state, "acme/app", "feature", 7)).toBe(reader);
    h.observation.stop();
    await expect(h.reader(state, "acme/app", "feature", 7)).rejects.toThrow(
      "stopped"
    );
  });

  it("preserves unknown application identity while retaining the environment and run", async () => {
    const h = harness();
    const state: DeploymentState = {
      deployingBranch: "feature",
      envName: "test",
      deployRunId: 8
    };
    await h.reader(state, "acme/app", "");
    expect(state.deployAppName).toBeUndefined();
    expect(h.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        application: "",
        environment: "test",
        runId: 8
      })
    );
    h.observation.stop();
  });

  it("does not invent an application, environment, branch or run", async () => {
    const h = harness();
    const state: DeploymentState = {};
    await h.reader(state, "acme/app", "");
    expect(state.deployAppName).toBeUndefined();
    expect(h.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        application: "",
        environment: "",
        runId: null
      })
    );
    await h.reader({}, "", "");
    h.observation.stop();
  });
});
