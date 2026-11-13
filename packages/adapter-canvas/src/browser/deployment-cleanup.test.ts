import { describe, expect, it } from "vitest";
import { loadCleanupDetails } from "./deployment-cleanup.js";
import {
  createFakeBrowser,
  jsonResponse
} from "../../test/support/browser/fakes.js";

const selection = {
  runId: 42,
  runAttempt: 1,
  deploymentId: "7",
  runUrl: "https://github.com/octo/app/actions/runs/42"
};
const row = {
  app: "",
  environment: "dev",
  status: "failed",
  deploymentId: selection.deploymentId,
  runUrl: selection.runUrl,
  cleanupSelection: selection
};
const recovery = {
  runId: 42,
  runAttempt: 1,
  revision: "a".repeat(64),
  confirmation: "octo/app/run-42@1/dev",
  canMarkCleanupComplete: true
};

describe("browser cleanup preparation", () => {
  it("requests fresh evidence for the selected run before enabling confirmation", async () => {
    const h = createFakeBrowser();
    h.net.handle("/api/deployment-cleanup-details", () =>
      jsonResponse({
        deployment: { ...row, recovery },
        selection,
        prepared: true
      })
    );
    const result = await loadCleanupDetails(
      h.context,
      "octo/app",
      "dev",
      "fixture",
      row
    );
    expect(result.prepared).toBe(true);
    expect(result.deployment?.recovery).toEqual(recovery);
    expect(h.net.calls[0].init).toMatchObject({
      headers: { "X-Radius-Mutation-Nonce": "fixture" },
      body: JSON.stringify({
        repo: "octo/app",
        environment: "dev",
        ...selection
      })
    });
  });

  it("supports discovery without a selected run or confirmation", async () => {
    const h = createFakeBrowser();
    h.net.handle("/api/deployment-cleanup-details", () =>
      jsonResponse({
        deployment: row,
        selection,
        prepared: false
      })
    );
    expect(
      await loadCleanupDetails(h.context, "octo/app", "dev", "fixture")
    ).toMatchObject({
      prepared: false,
      deployment: { cleanupSelection: selection }
    });
  });

  it("accepts verified absence only as discovery", async () => {
    const h = createFakeBrowser();
    h.net.handle("/api/deployment-cleanup-details", () =>
      jsonResponse({
        deployment: null,
        prepared: false
      })
    );
    expect(
      await loadCleanupDetails(h.context, "octo/app", "dev", "fixture")
    ).toEqual({
      prepared: false,
      deployment: undefined
    });
  });

  it.each([
    { environment: "other" },
    { runUrl: "https://github.com/octo/app/actions/runs/43" },
    { deploymentId: "other" },
    { recovery: undefined }
  ])("rejects malformed or changed prepared evidence %j", async (changed) => {
    const h = createFakeBrowser();
    h.net.handle("/api/deployment-cleanup-details", () =>
      jsonResponse({
        deployment: { ...row, recovery, ...changed },
        selection,
        prepared: true
      })
    );
    await expect(
      loadCleanupDetails(h.context, "octo/app", "dev", "fixture", row)
    ).rejects.toThrow("target changed");
  });

  it.each([
    null,
    {},
    { deployment: null },
    { deployment: [], prepared: false },
    { deployment: { ...row, environment: "other" }, prepared: false }
  ])(
    "does not mistake malformed discovery for verified absence: %j",
    async (payload) => {
      const h = createFakeBrowser();
      h.net.handle("/api/deployment-cleanup-details", () =>
        jsonResponse(payload)
      );
      await expect(
        loadCleanupDetails(h.context, "octo/app", "dev", "fixture")
      ).rejects.toThrow();
    }
  );

  it.each([
    { recovery: { ...recovery, runId: 43 } },
    { recovery: { ...recovery, runAttempt: 2 } },
    { selection: undefined },
    { selection: { ...selection, runId: 43 } },
    { selection: { ...selection, runAttempt: 2 } },
    { selection: { ...selection, deploymentId: "8" } },
    { selection: { ...selection, runUrl: `${selection.runUrl}0` } }
  ])("refuses inconsistent confirmation identity %j", async (changed) => {
    const h = createFakeBrowser();
    const { recovery: changedRecovery, ...response } = changed;
    h.net.handle("/api/deployment-cleanup-details", () =>
      jsonResponse({
        deployment: { ...row, recovery: changedRecovery ?? recovery },
        selection,
        prepared: true,
        ...response
      })
    );
    await expect(
      loadCleanupDetails(h.context, "octo/app", "dev", "fixture", row)
    ).rejects.toThrow("target changed");
  });

  it("never enables confirmation from an unselected discovery request", async () => {
    const h = createFakeBrowser();
    h.net.handle("/api/deployment-cleanup-details", () =>
      jsonResponse({
        deployment: { ...row, recovery },
        selection,
        prepared: true
      })
    );
    await expect(
      loadCleanupDetails(h.context, "octo/app", "dev", "fixture")
    ).rejects.toThrow("target changed");
  });

  it.each(["error", "empty", "network"] as const)(
    "surfaces %s failures instead of enabling confirmation",
    async (kind) => {
      const h = createFakeBrowser();
      h.net.handle("/api/deployment-cleanup-details", () => {
        if (kind === "network") throw new Error("offline");
        return jsonResponse(
          kind === "error" ? { error: "Run changed" } : {},
          false,
          409
        );
      });
      await expect(
        loadCleanupDetails(h.context, "octo/app", "dev", "fixture", row)
      ).rejects.toThrow(
        kind === "network" ? "offline"
        : kind === "error" ? "Run changed"
        : "could not be verified"
      );
    }
  );
});
