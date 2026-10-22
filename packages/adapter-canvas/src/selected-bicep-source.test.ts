import { describe, expect, it, vi } from "vitest";
import { successfulSelectedGhExecutor } from "../test/support/server/selected-gh.js";
import { createSelectedRepositoryReader } from "./selected-repository-reader.js";
import { fetchSelectedBicep } from "./selected-bicep-source.js";
import { isWorkspaceSelection, resolveWorkspaceBicep } from "./workspace.js";

function fixture() {
  const run = vi.fn(async () => ({
    code: 0,
    stdout: JSON.stringify({
      type: "file",
      encoding: "base64",
      content: Buffer.from("remote model").toString("base64")
    }),
    stderr: ""
  }));
  const reader = createSelectedRepositoryReader(
    successfulSelectedGhExecutor({ run })
  );
  const resolve = vi.fn<typeof resolveWorkspaceBicep>(async () => null);
  const state = {
    workspaceRepo: "fixture/app",
    workspaceBranch: "feature/model",
    workspacePath: "/synthetic/workspace"
  };
  return {
    run,
    reader,
    resolve,
    state,
    workspace: { isSelection: isWorkspaceSelection, resolve }
  };
}

describe("selected planned Bicep source", () => {
  it("uses the checked-out model only for the matching repository and branch", async () => {
    const f = fixture();
    f.resolve.mockResolvedValue({
      content: "local model",
      repoPath: "models/app.bicep"
    });
    expect(
      await fetchSelectedBicep(
        f.state,
        "fixture/app",
        "feature/model",
        f.reader,
        f.workspace
      )
    ).toEqual({
      content: "local model",
      fromWorkspace: true,
      branch: "feature/model",
      bicepPath: "models/app.bicep"
    });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.resolve).toHaveBeenCalledWith(
      f.state,
      "fixture/app",
      "feature/model"
    );
  });

  it.each([
    ["fixture/other", "feature/model"],
    ["fixture/app", "release"]
  ])(
    "reads remote %s at %s without touching the unrelated workspace",
    async (repo, branch) => {
      const f = fixture();
      expect(
        await fetchSelectedBicep(f.state, repo, branch, f.reader, f.workspace)
      ).toEqual({
        content: "remote model",
        fromWorkspace: false,
        branch,
        bicepPath: ""
      });
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.run).toHaveBeenCalledWith(
        [
          "api",
          `/repos/${repo}/contents/.radius/app.bicep?ref=${encodeURIComponent(branch)}`
        ],
        { timeout: 15000 }
      );
    }
  );

  it("retains the graph view's selected-branch fallback and remote fallback for a missing local model", async () => {
    const f = fixture();
    expect(
      await fetchSelectedBicep(
        f.state,
        "fixture/app",
        "",
        f.reader,
        f.workspace
      )
    ).toMatchObject({
      content: "remote model",
      branch: "feature/model",
      fromWorkspace: false
    });
    expect(f.resolve).toHaveBeenCalledOnce();
  });

  it("constructs remote-only reads without a workspace binding", async () => {
    const f = fixture();
    expect(
      await fetchSelectedBicep({}, "fixture/app", "release", f.reader)
    ).toMatchObject({
      content: "remote model",
      branch: "release",
      fromWorkspace: false
    });
  });

  it("propagates workspace and selected-account failures without switching identity", async () => {
    const f = fixture();
    f.resolve.mockRejectedValue(new Error("workspace unavailable"));
    await expect(
      fetchSelectedBicep(
        f.state,
        "fixture/app",
        "feature/model",
        f.reader,
        f.workspace
      )
    ).rejects.toThrow("workspace unavailable");
    expect(f.run).not.toHaveBeenCalled();
    f.run.mockRejectedValue(new Error("selected account unavailable"));
    await expect(
      fetchSelectedBicep(
        f.state,
        "fixture/other",
        "release",
        f.reader,
        f.workspace
      )
    ).rejects.toThrow("selected account unavailable");
  });
});
