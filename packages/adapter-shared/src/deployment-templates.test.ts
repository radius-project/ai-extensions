import { describe, expect, it, vi } from "vitest";
import {
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AWS_FILE,
  RADIUS_REF,
  RADIUS_WORKFLOW_REPO,
  RADIUS_WORKFLOW_DIR,
  deployWorkflowFiles
} from "@radius-project/core";
import {
  createDeploymentTemplates,
  type DeploymentTemplatePorts
} from "./deployment-templates.js";
import { deploymentTemplates } from "../test/fixtures/deployment-workflows.js";

function fixture() {
  let now = 0;
  const readRepositoryFile = vi.fn<
    DeploymentTemplatePorts["readRepositoryFile"]
  >(async (repo, path, ref) => {
    expect(repo).toBe(RADIUS_WORKFLOW_REPO);
    expect(ref).toBe(RADIUS_REF);
    const file = path.slice(RADIUS_WORKFLOW_DIR.length + 1);
    const content = deploymentTemplates[file];
    if (!content) throw new Error(`Unexpected template: ${path}`);
    return { content };
  });
  const ports = { readRepositoryFile, now: () => now };
  return {
    generate: createDeploymentTemplates(ports),
    ports,
    readRepositoryFile,
    setTime: (value: number) => {
      now = value;
    }
  };
}

describe("deployment template bindings", () => {
  it.each([false, true])(
    "generates only the enabled provider workflows (AWS %s)",
    async (includeAws) => {
      const { generate, readRepositoryFile } = fixture();
      const generated = await generate("dev", ".radius/custom.bicep", {
        includeAws
      });
      expect(Object.keys(generated)).toEqual(deployWorkflowFiles(includeAws));
      expect(generated[DEPLOY_DISPATCHER_FILE]).toContain(
        "dev/.radius/custom.bicep"
      );
      expect(generated[DEPLOY_DISPATCHER_FILE]).not.toContain("workflow_run");
      expect(generated[DEPLOY_DISPATCHER_FILE].includes("  aws:")).toBe(
        includeAws
      );
      expect(
        readRepositoryFile.mock.calls.some((call) =>
          call[1].endsWith(DEPLOY_AWS_FILE)
        )
      ).toBe(includeAws);
    }
  );

  it("uses Azure-only defaults and caches within, but not at, the expiration boundary", async () => {
    const { generate, readRepositoryFile, setTime, ports } = fixture();
    await generate("dev", ".radius/app.bicep");
    setTime(59_999);
    await generate("prod", ".radius/app.bicep");
    expect(readRepositoryFile).toHaveBeenCalledTimes(2);
    setTime(60_000);
    await generate("prod", ".radius/app.bicep");
    expect(readRepositoryFile).toHaveBeenCalledTimes(4);
    await createDeploymentTemplates(ports)("dev", ".radius/app.bicep");
    expect(readRepositoryFile).toHaveBeenCalledTimes(6);
  });

  it.each([null, "", "  "])(
    "refuses empty fetched templates: %s",
    async (content) => {
      const { generate, readRepositoryFile } = fixture();
      readRepositoryFile.mockResolvedValue({ content });
      await expect(generate("dev", ".radius/app.bicep")).rejects.toThrow(
        "is empty."
      );
    }
  );

  it("retains fetch errors and permits a later successful retry", async () => {
    const { generate, readRepositoryFile } = fixture();
    readRepositoryFile.mockResolvedValueOnce({
      content: null,
      error: "HTTP 403"
    });
    await expect(generate("dev", ".radius/app.bicep")).rejects.toThrow(
      "HTTP 403"
    );
    await expect(generate("dev", ".radius/app.bicep")).resolves.toHaveProperty(
      DEPLOY_DISPATCHER_FILE
    );
  });

  it("propagates a rejected template read rather than falling back to local assets", async () => {
    const { generate, readRepositoryFile } = fixture();
    readRepositoryFile.mockRejectedValue(new Error("offline"));
    await expect(generate("dev", ".radius/app.bicep")).rejects.toThrow(
      "offline"
    );
  });

  it("validates fetched YAML after generation", async () => {
    const { generate, readRepositoryFile } = fixture();
    readRepositoryFile.mockResolvedValue({
      content: "on:\n  push: {}\njobs:\n  run: {}"
    });
    await expect(generate("dev", ".radius/app.bicep")).rejects.toThrow(
      "trust validation"
    );
  });
});
