import { describe, expect, it } from "vitest";
import { successfulSelectedGhExecutor } from "../../test/support/server/selected-gh.js";
import { createGitHubAccountCoordinator } from "../server/services/github-account-coordinator.js";
import { createEnvironmentAccountContext } from "./environment-account-context.js";

function coordinator() {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected credential access");
  };
  return createGitHubAccountCoordinator({
    createExecutor: unexpected,
    getActiveKeyringLogin: unexpected,
    switchKeyringAccount: unexpected,
    resetIdentityCache: () => {
      throw new Error("Unexpected identity cache reset");
    }
  });
}

describe("runtime environment account bindings", () => {
  it("constructs without a panel and isolates executor maps even with one shared coordinator", () => {
    const shared = coordinator();
    const first = createEnvironmentAccountContext("first", shared);
    const second = createEnvironmentAccountContext("second", shared);
    const executor = successfulSelectedGhExecutor();
    expect(first.coordinator).toBe(second.coordinator);
    expect(first.getExecutor("operation")).toBeUndefined();
    first.registerExecutor("operation", executor);
    expect(first.getExecutor("operation")).toBe(executor);
    expect(second.getExecutor("operation")).toBeUndefined();
    second.unregisterExecutor("operation");
    expect(first.getExecutor("operation")).toBe(executor);
    first.unregisterExecutor("operation");
    first.unregisterExecutor("operation");
    expect(first.getExecutor("operation")).toBeUndefined();
  });

  it("retains replacement and operation-ID cleanup without changing another operation", () => {
    const context = createEnvironmentAccountContext("runtime", coordinator());
    const initial = successfulSelectedGhExecutor({ login: "initial" });
    const replacement = successfulSelectedGhExecutor({ login: "replacement" });
    context.registerExecutor("operation", initial);
    context.registerExecutor("other", initial);
    context.registerExecutor("operation", replacement);
    expect(context.getExecutor("operation")).toBe(replacement);
    context.unregisterExecutor("operation");
    expect(context.getExecutor("operation")).toBeUndefined();
    expect(context.getExecutor("other")).toBe(initial);
  });

  it("propagates acquisition failure without inventing an executor binding", async () => {
    const context = createEnvironmentAccountContext("runtime", coordinator());
    await expect(
      context.coordinator.createReadOnlyExecutor("selected")
    ).rejects.toThrow("Unexpected credential access");
    expect(context.getExecutor("operation")).toBeUndefined();
  });
});
