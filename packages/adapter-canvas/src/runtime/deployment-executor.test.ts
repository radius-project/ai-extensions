import { describe, expect, it, vi } from "vitest";
import { successfulSelectedGhExecutor } from "../../test/support/server/selected-gh.js";
import { bindDeploymentExecutor } from "./deployment-executor.js";
import { createDeferred } from "../../test/support/browser/fakes.js";
import type { SelectedGhCommandResult } from "../gh.js";

describe("deployment executor lifetime", () => {
  it.each(["run", "runOrThrow"] as const)(
    "passes exact argv and stdin through %s without changing account",
    async (method) => {
      const result = { code: 0, stdout: "accepted", stderr: "" };
      const run = vi.fn(async () => result);
      const source = successfulSelectedGhExecutor({ login: "fixture", run });
      const executor = bindDeploymentExecutor(source, () => true);
      const args = ["secret", "set", "PARAMS"];
      const options = { stdin: "synthetic-parameter-value", timeout: 30 };
      const actual =
        method === "run" ?
          await executor.run(args, options)
        : await executor.runOrThrow(args, "write failed", options);
      expect(actual).toBe(result);
      expect(run).toHaveBeenCalledExactlyOnceWith(args, options);
      expect(executor.login).toBe(source.login);
      expect(executor.scopes).toEqual(source.scopes);
      expect(executor.credentialSource).toBe(source.credentialSource);
      expect(executor.requiresKeyringSwitch).toBe(source.requiresKeyringSwitch);
    }
  );

  it.each(["run", "runOrThrow", "verifyIdentity"] as const)(
    "refuses %s before external work after shutdown or replacement",
    async (method) => {
      const run = vi.fn(async () => {
        throw new Error("Must not run");
      });
      const verifyIdentity = vi.fn(async () => {
        throw new Error("Must not verify");
      });
      const executor = bindDeploymentExecutor(
        {
          ...successfulSelectedGhExecutor({ run }),
          verifyIdentity
        },
        () => false
      );
      const pending =
        method === "run" ? executor.run(["api", "user"])
        : method === "runOrThrow" ?
          executor.runOrThrow(["api", "user"], "failed")
        : executor.verifyIdentity();
      await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
      expect(run).not.toHaveBeenCalled();
      expect(verifyIdentity).not.toHaveBeenCalled();
    }
  );

  it.each(["run", "runOrThrow", "verifyIdentity"] as const)(
    "does not publish a late %s result or retry an in-flight command",
    async (method) => {
      let current = true;
      const pending = createDeferred<SelectedGhCommandResult>();
      const run = vi.fn(() => pending.promise);
      const verifyIdentity = vi.fn(async () => {
        await pending.promise;
      });
      const executor = bindDeploymentExecutor(
        {
          ...successfulSelectedGhExecutor({ run }),
          verifyIdentity
        },
        () => current
      );
      const request =
        method === "run" ? executor.run(["workflow", "run"])
        : method === "runOrThrow" ?
          executor.runOrThrow(["workflow", "run"], "failed")
        : executor.verifyIdentity();
      current = false;
      pending.resolve({ code: 0, stdout: "accepted", stderr: "" });
      await expect(request).rejects.toMatchObject({ reason: "cancelled" });
      expect(
        method === "verifyIdentity" ? verifyIdentity : run
      ).toHaveBeenCalledTimes(1);
    }
  );

  it("preserves external failures and allows pure redaction after disposal", async () => {
    const failure = new Error("selected command failed");
    const source = successfulSelectedGhExecutor({
      run: async () => {
        throw failure;
      }
    });
    let current = true;
    const executor = bindDeploymentExecutor(source, () => current);
    await expect(executor.run([])).rejects.toBe(failure);
    await expect(executor.runOrThrow([], "failed")).rejects.toBe(failure);
    await expect(executor.verifyIdentity()).resolves.toBeUndefined();
    expect(executor.packageCredentials()).toEqual(source.packageCredentials());
    current = false;
    expect(() => executor.packageCredentials()).toThrow();
    expect(executor.errorMessage(failure)).toBe("selected command failed");
    expect(executor.redact("diagnostic")).toBe("diagnostic");
  });
});
