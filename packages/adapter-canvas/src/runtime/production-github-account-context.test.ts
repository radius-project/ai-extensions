import { describe, expect, it } from "vitest";
import { createProductionGitHubAccountContext } from "./production-github-account-context.js";

describe("production GitHub account construction", () => {
  it("creates distinct runtime provenance without opening a panel or acquiring credentials", () => {
    const first = createProductionGitHubAccountContext();
    const second = createProductionGitHubAccountContext();
    expect(first.ownerKey).not.toBe(second.ownerKey);
    expect(first.ownerKey).not.toBe("");
    expect(first.coordinator).not.toBe(second.coordinator);
    expect(first.getExecutor("operation")).toBeUndefined();
  });

  it("uses the production executor's missing-login refusal without an ambient fallback", async () => {
    const context = createProductionGitHubAccountContext();
    await expect(
      context.coordinator.createReadOnlyExecutor("")
    ).rejects.toThrow("A GitHub account login is required.");
    expect(context.getExecutor("operation")).toBeUndefined();
  });
});
