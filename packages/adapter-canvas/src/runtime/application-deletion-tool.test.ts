import { describe, expect, it, vi } from "vitest";
import {
  createApplicationDeletionTool,
  type ApplicationDeletionToolPorts
} from "./application-deletion-tool.js";
import type { ApplicationDeletionResult } from "@radius-project/core";

const args = {
  repo: "octo/app",
  environment: "dev",
  application: "demo",
  deploymentId: "42",
  runUrl: "https://github.com/octo/app/actions/runs/17",
  mode: "normal"
};

function fixture(confirm: ApplicationDeletionToolPorts["confirm"]) {
  const deleteApplication = vi.fn<
    (force: boolean) => Promise<ApplicationDeletionResult>
  >(async (force) => ({
    status: 200,
    body: { success: true, runUrl: args.runUrl, forced: force }
  }));
  const prepare = vi.fn<ApplicationDeletionToolPorts["prepare"]>(
    async ({ force }) => ({
      login: "fixture-owner",
      execute: () => deleteApplication(force)
    })
  );
  const prompt = vi.fn(confirm);
  const tool = createApplicationDeletionTool({
    confirm: prompt,
    prepare,
    redact: (value) => value.replace("sensitive-detail", "[redacted]")
  });
  return { ...tool, prompt, prepare, deleteApplication };
}

describe("application deletion tool", () => {
  it.each([
    null,
    { ...args, runUrl: "https://github.com/other/app/actions/runs/17" },
    { ...args, runUrl: `${args.runUrl}?prompt=untrusted` },
    { ...args, deploymentId: "" },
    { ...args, force: true },
    { ...args, confirmed: true }
  ])(
    "does not accept incomplete targets or agent-supplied approval",
    async (payload) => {
      const tool = fixture(async () => true);
      await expect(tool.handler(payload)).resolves.toMatchObject({
        kind: "interaction_required",
        code: "application-deletion-input-required"
      });
      expect(tool.prompt).not.toHaveBeenCalled();
      expect(tool.prepare).not.toHaveBeenCalled();
      expect(tool.deleteApplication).not.toHaveBeenCalled();
    }
  );

  it.each(["normal", "force_retry"])(
    "requests trusted %s confirmation",
    async (mode) => {
      const tool = fixture(async () => true);
      const force = mode === "force_retry";
      const { mode: _mode, ...target } = args;
      await expect(tool.handler({ ...args, mode })).resolves.toEqual({
        kind: "dispatched",
        forced: force,
        runUrl: args.runUrl
      });
      expect(tool.prompt).toHaveBeenCalledWith(
        expect.stringContaining(force ? "orphaned" : "not the environment")
      );
      expect(tool.prompt).toHaveBeenCalledWith(
        expect.stringContaining("@fixture-owner")
      );
      expect(tool.prepare).toHaveBeenCalledWith({ ...target, force });
      expect(tool.deleteApplication).toHaveBeenCalledWith(force);
    }
  );

  it.each([
    [false, "refused", "application-deletion-declined"],
    [undefined, "interaction_required", "force-delete-confirmation-required"]
  ] as const)(
    "does not dispatch when confirmation returns %s",
    async (answer, kind, code) => {
      const tool = fixture(async () => answer);
      await expect(
        tool.handler({ ...args, mode: "force_retry" })
      ).resolves.toMatchObject({ kind, code });
      expect(tool.deleteApplication).not.toHaveBeenCalled();
    }
  );

  it("does not interpret a failed confirmation channel as approval", async () => {
    const tool = fixture(async () => {
      throw new Error("channel unavailable");
    });

    await expect(tool.handler(args)).resolves.toMatchObject({
      kind: "interaction_required",
      code: "delete-confirmation-required"
    });
    expect(tool.deleteApplication).not.toHaveBeenCalled();
  });

  it("does not prompt for destructive approval before an account is verified", async () => {
    const tool = fixture(async () => true);
    tool.prepare.mockResolvedValue(undefined);
    await expect(tool.handler(args)).resolves.toMatchObject({
      kind: "interaction_required",
      code: "application-deletion-account-required"
    });
    expect(tool.prompt).not.toHaveBeenCalled();
    expect(tool.deleteApplication).not.toHaveBeenCalled();
  });

  it("reports ambiguity without suggesting that the request be dispatched again", async () => {
    const tool = fixture(async () => true);
    tool.deleteApplication.mockResolvedValue({
      status: 400,
      body: { error: "timeout" },
      dispatchUnconfirmed: true
    });
    await expect(tool.handler(args)).resolves.toMatchObject({
      kind: "unconfirmed"
    });
  });

  it("redacts service failures and propagates their outcomes", async () => {
    const tool = fixture(async () => true);
    tool.deleteApplication
      .mockResolvedValueOnce({
        status: 409,
        body: { error: "changed: sensitive-detail" }
      })
      .mockRejectedValueOnce(new Error("unavailable: sensitive-detail"))
      .mockRejectedValueOnce("unavailable: sensitive-detail");
    await expect(tool.handler(args)).resolves.toMatchObject({
      kind: "refused",
      message: "changed: [redacted]"
    });
    await expect(tool.handler(args)).resolves.toMatchObject({
      kind: "unavailable",
      message: "unavailable: [redacted]"
    });
    await expect(tool.handler(args)).resolves.toMatchObject({
      kind: "unavailable",
      message: "unavailable: [redacted]"
    });
  });
});
