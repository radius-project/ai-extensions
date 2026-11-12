import { describe, expect, it } from "vitest";
import {
  MAX_DEPLOY_MESSAGE_LENGTH,
  settleDeployStatuses,
  unfinishedDeployMessage,
  type SettleableResource
} from "./deployment-resource-status.js";

describe("terminal deployment resource evidence", () => {
  it("lets successful workflow evidence replace stale failures and messages", () => {
    const resources: SettleableResource[] = [
      { deployStatus: "failed", deployMessage: "old failure" },
      { deployStatus: "in_progress" },
      {}
    ];
    settleDeployStatuses(resources, "success", "ignored");
    expect(resources).toEqual([
      { deployStatus: "success" },
      { deployStatus: "success" },
      { deployStatus: "success" }
    ]);
  });

  it("settles unfinished nodes while preserving successful and producer-failed evidence", () => {
    const resources: SettleableResource[] = [
      {},
      { deployStatus: "pending" },
      { deployStatus: "in_progress", deployMessage: "starting" },
      { deployStatus: "failed", deployMessage: "specific failure" },
      { deployStatus: "failed", deployMessage: " " },
      { deployStatus: "failed" },
      { deployStatus: "success", deployMessage: "done" }
    ];
    settleDeployStatuses(resources, "failure", "run failure");
    expect(resources.map((resource) => resource.deployMessage)).toEqual([
      "run failure",
      "run failure",
      "run failure",
      "specific failure",
      "run failure",
      "run failure",
      "done"
    ]);
    expect(resources.map((resource) => resource.deployStatus)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
      "success"
    ]);
  });

  it("matches resource-specific errors case-insensitively and keeps the first matching error", () => {
    const resources: SettleableResource[] = [
      {
        id: "/planes/radius/local/resourcegroups/dev/providers/Applications.Datastores/redisCaches/cache"
      },
      { name: "cache", type: "Applications.Datastores/redisCaches" },
      { id: "simple" },
      { id: "unmatched" }
    ];
    settleDeployStatuses(resources, "failure", "run failure", [
      { target: "ignored", message: " " },
      {
        target:
          "/planes/radius/local/resourceGroups/dev/providers/Applications.Datastores/redisCaches/cache",
        message: " inner cause "
      },
      {
        target:
          "/planes/radius/local/resourceGroups/dev/providers/Applications.Datastores/redisCaches/cache",
        message: "later duplicate"
      },
      { target: "simple", message: "z".repeat(501) }
    ]);
    expect(resources.map((resource) => resource.deployMessage)).toEqual([
      "inner cause",
      "inner cause",
      "z".repeat(497) + "...",
      "run failure"
    ]);
  });

  it.each([
    ["cancelled", "Deployment cancelled"],
    ["timed_out", "Deployment timed out"],
    [
      "monitor_timed_out",
      "Deployment monitoring timed out; the workflow may still be running."
    ],
    [null, "Deployment failed"],
    [undefined, "Deployment failed"]
  ])(
    "distinguishes %s from confirmed resource failure",
    (conclusion, expected) => {
      expect(unfinishedDeployMessage(conclusion)).toBe(expected);
    }
  );

  it.each([0, 499, 500, 501])(
    "bounds copied diagnostics at %i characters",
    (length) => {
      const detail = "x".repeat(length);
      expect(unfinishedDeployMessage("failure", detail)).toBe(
        length === 0 ? "Deployment failed"
        : length > MAX_DEPLOY_MESSAGE_LENGTH ? "x".repeat(497) + "..."
        : detail
      );
    }
  );

  it("accepts empty and rejects malformed resource collections without fabricating evidence", () => {
    const resources: SettleableResource[] = [];
    settleDeployStatuses(resources);
    expect(resources).toEqual([]);
    expect(() =>
      Reflect.apply(settleDeployStatuses, undefined, [null])
    ).not.toThrow();
  });
});
