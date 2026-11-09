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
    const releaseFirst = first.registerExecutor("operation", executor);
    expect(first.getExecutor("operation")).toBe(executor);
    expect(second.getExecutor("operation")).toBeUndefined();
    const releaseSecond = second.registerExecutor("operation", executor);
    releaseSecond();
    expect(first.getExecutor("operation")).toBe(executor);
    releaseFirst();
    releaseFirst();
    expect(first.getExecutor("operation")).toBeUndefined();
  });

  it.each([false, true])(
    "ignores an old registration release when its executor is reused=%s",
    (reuseExecutor) => {
      const context = createEnvironmentAccountContext("runtime", coordinator());
      const initial = successfulSelectedGhExecutor({ login: "saved-account" });
      const replacement =
        reuseExecutor ? initial : (
          successfulSelectedGhExecutor({ login: "saved-account" })
        );
      const releaseInitial = context.registerExecutor("operation", initial);
      const releaseOther = context.registerExecutor("other", initial);
      const releaseReplacement = context.registerExecutor(
        "operation",
        replacement
      );
      releaseInitial();
      releaseInitial();
      expect(context.getExecutor("operation")).toBe(replacement);
      expect(context.getExecutor("other")).toBe(initial);
      releaseOther();
      expect(context.getExecutor("operation")).toBe(replacement);
      releaseReplacement();
      releaseReplacement();
      expect(context.getExecutor("operation")).toBeUndefined();
      expect(context.getExecutor("other")).toBeUndefined();
      const releaseAgain = context.registerExecutor("operation", initial);
      releaseReplacement();
      expect(context.getExecutor("operation")).toBe(initial);
      releaseAgain();
      expect(context.getExecutor("operation")).toBeUndefined();
    }
  );

  it("propagates acquisition failure without inventing an executor binding", async () => {
    const context = createEnvironmentAccountContext("runtime", coordinator());
    await expect(
      context.coordinator.createReadOnlyExecutor("selected")
    ).rejects.toThrow("Unexpected credential access");
    expect(context.getExecutor("operation")).toBeUndefined();
  });
});
