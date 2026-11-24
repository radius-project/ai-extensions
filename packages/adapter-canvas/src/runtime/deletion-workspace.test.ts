import { describe, expect, it, vi } from "vitest";
import type { GitHubAccountSelection } from "@radius-project/core";
import {
  createDeletionWorkspace,
  createWorkspaceApplicationDeletion
} from "./deletion-workspace.js";
import { createSessionHolder } from "./session.js";

const target = { repo: "octo/project", environment: "test" };
const original = { repo: "Octo/Project", workspacePath: "/workspace" };

function fixture() {
  const session = createSessionHolder();
  const joined = () => ({
    send: () => undefined,
    rpc: { canvas: { open: async () => undefined } }
  });
  session.set(joined());
  const ports = {
    session,
    isActive: vi.fn(() => true),
    workspace: vi.fn(async () => original),
    account: vi.fn(async (): Promise<GitHubAccountSelection> => ({
      state: "selected",
      login: "octocat"
    }))
  };
  return { resolve: createDeletionWorkspace(ports), ports, joined };
}

describe("deletion workspace", () => {
  it("checks the canonical repository against the requested target before choosing an account", async () => {
    const { resolve, ports } = fixture();
    await expect(
      resolve({ ...target, repo: "octo/other" })
    ).resolves.toBeUndefined();
    expect(ports.account).not.toHaveBeenCalled();
    const scope = await resolve(target);
    expect(scope).toMatchObject({ repo: original.repo, login: "octocat" });
    expect(ports.account).toHaveBeenCalledWith({
      target: { repo: original.repo, environment: target.environment },
      isCurrent: expect.any(Function)
    });
    await expect(scope?.validate()).resolves.toBe(true);
  });
});

describe("workspace application deletion", () => {
  const request = {
    ...target,
    application: "demo",
    deploymentId: "42",
    runUrl: "https://github.com/octo/project/actions/runs/17",
    mode: "normal"
  };

  function toolFixture() {
    const { ports } = fixture();
    const execute = vi.fn(async () => ({
      status: 200 as const,
      body: { success: true as const, runUrl: "", forced: false }
    }));
    const confirm = vi.fn(async () => true);
    const verifyIdentity = vi.fn(async () => {});
    const createExecutor = vi.fn(async () => ({
      login: "Octocat",
      verifyIdentity
    }));
    const prepare = vi.fn(
      async (): Promise<
        { login: string; execute: typeof execute } | undefined
      > => ({ login: "octocat", execute })
    );
    const handle = createWorkspaceApplicationDeletion({
      ...ports,
      listLogins: async () => ["octocat"],
      createExecutor,
      chooseAccount: () => undefined,
      prepare,
      confirm,
      redact: (message) => message
    });
    return {
      handle,
      ports,
      execute,
      prepare,
      confirm,
      createExecutor,
      verifyIdentity
    };
  }

  it("binds the canonical workspace repository and verified account before prompting", async () => {
    const f = toolFixture();
    f.confirm.mockImplementationOnce(async () => {
      expect(f.prepare).toHaveBeenCalledWith({
        login: "octocat",
        request: {
          ...target,
          repo: original.repo,
          application: request.application,
          deploymentId: request.deploymentId,
          runUrl: request.runUrl,
          force: false
        },
        isCurrent: expect.any(Function)
      });
      expect(f.execute).not.toHaveBeenCalled();
      return true;
    });
    await f.handle(request);
    expect(f.verifyIdentity).toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it.each(["wrong login", "verification failed", "workspace switched"])(
    "does not prompt or dispatch when admission fails: %s",
    async (failure) => {
      const f = toolFixture();
      if (failure === "wrong login")
        f.createExecutor.mockResolvedValueOnce({
          login: "other",
          verifyIdentity: f.verifyIdentity
        });
      else if (failure === "verification failed")
        f.verifyIdentity.mockRejectedValueOnce(new Error("Wrong credential"));
      else
        f.ports.workspace
          .mockResolvedValueOnce(original)
          .mockResolvedValueOnce({ ...original, workspacePath: "/other" });
      await expect(f.handle(request)).resolves.toMatchObject({
        code: "application-deletion-account-required"
      });
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.confirm).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    }
  );

  it("rejects confirmation after the workspace switches", async () => {
    const f = toolFixture();
    f.confirm.mockImplementationOnce(async () => {
      f.ports.workspace.mockResolvedValue({
        ...original,
        workspacePath: "/other"
      });

      return true;
    });
    await expect(f.handle(request)).resolves.toMatchObject({
      message: "The workspace changed before deletion."
    });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("does not offer confirmation if preparation finishes in a different workspace", async () => {
    const f = toolFixture();
    f.prepare.mockImplementationOnce(async () => {
      f.ports.workspace.mockResolvedValue({
        ...original,
        workspacePath: "/other"
      });
      return { login: "octocat", execute: f.execute };
    });
    await expect(f.handle(request)).resolves.toMatchObject({
      message: "The workspace changed before deletion."
    });
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("does not prompt when the selected deletion service cannot prepare the target", async () => {
    const f = toolFixture();
    f.prepare.mockResolvedValueOnce(undefined);
    await expect(f.handle(request)).resolves.toMatchObject({
      code: "application-deletion-account-required"
    });
    expect(f.confirm).not.toHaveBeenCalled();
  });
});
describe("deletion workspace lifetime", () => {
  it.each([
    { ...original, repo: "octo/replacement" },
    { ...original, workspacePath: "/replacement" }
  ])(
    "invalidates the scope when the workspace changes to %j",
    async (workspace) => {
      const { resolve, ports } = fixture();
      const scope = await resolve(target);
      ports.workspace.mockResolvedValue(workspace);
      await expect(scope?.validate()).resolves.toBe(false);
    }
  );

  it("does not use an account selection that outlives its SDK session", async () => {
    const { resolve, ports, joined } = fixture();
    ports.account.mockImplementationOnce(async () => {
      ports.session.set(joined());
      return { state: "selected", login: "octocat" };
    });
    await expect(resolve(target)).resolves.toBeUndefined();
  });

  it("stops before resolving the workspace during shutdown", async () => {
    const { resolve, ports } = fixture();
    ports.isActive.mockReturnValue(false);
    await expect(resolve(target)).resolves.toBeUndefined();
    expect(ports.workspace).not.toHaveBeenCalled();
  });

  it("refuses an unattached session or an unavailable account", async () => {
    const { resolve, ports } = fixture();
    ports.account.mockResolvedValue({ state: "stopped" });
    await expect(resolve(target)).resolves.toBeUndefined();
    const unattached = createDeletionWorkspace({
      ...ports,
      session: createSessionHolder()
    });
    await expect(unattached(target)).resolves.toBeUndefined();
    expect(ports.workspace).toHaveBeenCalledTimes(1);
  });

  it("invalidates an established scope at shutdown without a workspace lookup", async () => {
    const { resolve, ports } = fixture();
    const scope = await resolve(target);
    ports.isActive.mockReturnValue(false);
    await expect(scope?.validate()).resolves.toBe(false);
    expect(ports.workspace).toHaveBeenCalledTimes(1);
  });
});
