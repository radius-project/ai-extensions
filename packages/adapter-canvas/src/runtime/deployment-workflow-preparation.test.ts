import { describe, expect, it, vi } from "vitest";
import {
  DEPLOY_AZURE_FILE,
  DEPLOY_DISPATCHER_FILE,
  type WorkflowSyncPorts,
  type syncRepoWorkflows
} from "../infra.js";
import { createDeploymentWorkflowPreparation } from "./deployment-workflow-preparation.js";

function fixture() {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected workflow operation");
  };
  const fetchFileFromRepo = vi.fn<WorkflowSyncPorts["fetchFileFromRepo"]>(
    async () => "existing"
  );
  const commitFileToRepo = vi.fn<WorkflowSyncPorts["commitFileToRepo"]>(
    async () => true
  );
  const generateDeployWorkflow = vi.fn<
    WorkflowSyncPorts["generateDeployWorkflow"]
  >(async () => ({
    [DEPLOY_DISPATCHER_FILE]: "dispatcher",
    [DEPLOY_AZURE_FILE]: "provider"
  }));
  const workflows: WorkflowSyncPorts = {
    getDefaultBranch: unexpected,
    getBranchHeadSha: unexpected,
    generateDeleteWorkflow: unexpected,
    generateVerifyWorkflow: unexpected,
    fetchFileFromRepo,
    commitFileToRepo,
    generateDeployWorkflow
  };
  const sync = vi.fn<typeof syncRepoWorkflows>(
    async (_repo, _environments, options) => {
      options?.log?.("synchronizing");
      return { created: [], updated: [], failed: [], skipped: false };
    }
  );
  const log = vi.fn();
  const written = vi.fn();
  const service = createDeploymentWorkflowPreparation(workflows, { sync, log });
  return {
    service,
    workflows,
    sync,
    log,
    written,
    fetchFileFromRepo,
    commitFileToRepo,
    generateDeployWorkflow
  };
}

describe("deployment workflow preparation", () => {
  it("does not generate or rewrite existing workflow files", async () => {
    const f = fixture();
    await f.service.publish(
      "fixture/app",
      "feature/model",
      "dev",
      f.log,
      f.written
    );
    expect(f.fetchFileFromRepo.mock.calls).toEqual([
      [
        "fixture/app",
        ".github/workflows/" + DEPLOY_DISPATCHER_FILE,
        "feature/model"
      ],
      ["fixture/app", ".github/workflows/" + DEPLOY_AZURE_FILE, "feature/model"]
    ]);
    expect(f.generateDeployWorkflow).not.toHaveBeenCalled();
    expect(f.commitFileToRepo).not.toHaveBeenCalled();
  });

  it.each([null, ""])(
    "publishes only missing files (%s) on the selected branch",
    async (content) => {
      const f = fixture();
      f.fetchFileFromRepo.mockResolvedValueOnce(content);
      await f.service.publish(
        "fixture/app",
        "feature/model",
        "dev",
        f.log,
        f.written
      );
      expect(f.generateDeployWorkflow).toHaveBeenCalledWith(
        "dev",
        ".radius/app.bicep"
      );
      expect(f.commitFileToRepo).toHaveBeenCalledExactlyOnceWith(
        "fixture/app",
        ".github/workflows/" + DEPLOY_DISPATCHER_FILE,
        "dispatcher",
        "feature/model",
        expect.stringContaining("worktree-consistent")
      );
      expect(f.written).toHaveBeenCalledExactlyOnceWith(DEPLOY_DISPATCHER_FILE);
    }
  );

  it("does not report an unchanged concurrent publication as a new write", async () => {
    const f = fixture();
    f.fetchFileFromRepo.mockResolvedValue(null);
    f.commitFileToRepo.mockResolvedValue(false);
    await f.service.publish(
      "fixture/app",
      "feature/model",
      "dev",
      f.log,
      f.written
    );
    expect(f.commitFileToRepo).toHaveBeenCalledTimes(2);
    expect(f.written).not.toHaveBeenCalled();
  });

  it("refuses incomplete generated templates before dispatch", async () => {
    const f = fixture();
    f.fetchFileFromRepo.mockResolvedValue(null);
    f.generateDeployWorkflow.mockResolvedValue({});
    await expect(
      f.service.publish("fixture/app", "feature/model", "dev", f.log, f.written)
    ).rejects.toThrow(DEPLOY_DISPATCHER_FILE);
    expect(f.commitFileToRepo).not.toHaveBeenCalled();
  });

  it.each(["read", "template", "write"] as const)(
    "propagates a %s failure without pretending preparation succeeded",
    async (phase) => {
      const f = fixture();
      f.fetchFileFromRepo.mockResolvedValue(null);
      const error = new Error(`${phase} unavailable`);
      if (phase === "read") f.fetchFileFromRepo.mockRejectedValue(error);
      if (phase === "template")
        f.generateDeployWorkflow.mockRejectedValue(error);
      if (phase === "write") f.commitFileToRepo.mockRejectedValue(error);
      await expect(
        f.service.publish(
          "fixture/app",
          "feature/model",
          "dev",
          f.log,
          f.written
        )
      ).rejects.toBe(error);
      expect(f.written).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["", "feature/model", "dev"],
    ["fixture/app", "", "dev"],
    ["fixture/app", "feature/model", ""]
  ])(
    "refuses incomplete publication identity %j",
    async (repo, branch, environment) => {
      const f = fixture();
      await expect(
        f.service.publish(repo, branch, environment, f.log, f.written)
      ).rejects.toThrow("requires");
      expect(f.fetchFileFromRepo).not.toHaveBeenCalled();
    }
  );

  it("preloads deploy templates and synchronizes the exact target with explicit creation", async () => {
    const f = fixture();
    const only = [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE];
    expect(
      await f.service.synchronize(
        "fixture/app",
        "dev",
        "azure",
        only,
        "feature/model"
      )
    ).toEqual({ created: [], updated: [] });
    expect(f.sync).toHaveBeenCalledWith(
      "fixture/app",
      [{ name: "dev", provider: "azure" }],
      {
        workingBranch: "feature/model",
        only,
        create: true,
        log: expect.any(Function)
      },
      f.workflows
    );
    expect(f.generateDeployWorkflow.mock.invocationCallOrder[0]).toBeLessThan(
      f.sync.mock.invocationCallOrder[0]
    );
    expect(f.log).toHaveBeenCalledWith(
      "[radius workflow-presync] fixture/app: synchronizing"
    );
  });

  it("keeps registration evidence distinct from writes while deduplicating retry hints", async () => {
    const f = fixture();
    f.sync.mockResolvedValue({
      created: ["new"],
      updated: ["changed"],
      registrationPending: ["new", "concurrent"],
      failed: [],
      skipped: false
    });
    expect(
      await f.service.synchronize(
        "fixture/app",
        "dev",
        "",
        ["deploy.yml"],
        "feature/model"
      )
    ).toEqual({ created: ["new", "concurrent"], updated: ["changed"] });
    expect(f.log).toHaveBeenCalledWith(
      "[radius workflow-presync] fixture/app: changed, new before dispatch"
    );
  });

  it("surfaces protected-branch failures with the failing path and branch", async () => {
    const f = fixture();
    f.sync.mockResolvedValue({
      created: [],
      updated: [],
      failed: [{ path: "deploy.yml", branch: "protected" }],
      skipped: false
    });
    await expect(
      f.service.synchronize(
        "fixture/app",
        "dev",
        "azure",
        ["deploy.yml"],
        "feature/model"
      )
    ).rejects.toThrow("deploy.yml on protected");
  });

  it.each(["template", "sync"] as const)(
    "propagates a synchronization %s failure",
    async (phase) => {
      const f = fixture();
      const error = new Error("unavailable");
      if (phase === "template")
        f.generateDeployWorkflow.mockRejectedValue(error);
      else f.sync.mockRejectedValue(error);
      await expect(
        f.service.synchronize(
          "fixture/app",
          "dev",
          "azure",
          ["deploy.yml"],
          "feature/model"
        )
      ).rejects.toBe(error);
      if (phase === "template") expect(f.sync).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["", "dev", ["deploy.yml"], "feature/model"],
    ["fixture/app", "", ["deploy.yml"], "feature/model"],
    ["fixture/app", "dev", [], "feature/model"],
    ["fixture/app", "dev", ["deploy.yml"], ""]
  ] satisfies [string, string, string[], string][])(
    "refuses incomplete synchronization identity %j",
    async (repo, environment, only, branch) => {
      const f = fixture();
      await expect(
        f.service.synchronize(repo, environment, "azure", only, branch)
      ).rejects.toThrow("requires");
      expect(f.generateDeployWorkflow).not.toHaveBeenCalled();
      expect(f.sync).not.toHaveBeenCalled();
    }
  );
});
