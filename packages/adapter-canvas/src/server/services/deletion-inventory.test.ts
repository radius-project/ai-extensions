import { describe, expect, it } from "vitest";
import type { DeployProgress } from "../../deploy-artifacts.js";
import { deletionInventoryFromSnapshot } from "./deletion-inventory.js";

function progress(overrides: Partial<DeployProgress> = {}): DeployProgress {
  return {
    schemaVersion: 1,
    application: "billing",
    environment: "prod",
    runId: 42,
    sequence: 1,
    state: "succeeded",
    resources: [
      {
        name: "database",
        type: "Radius.Resources/redis",
        id: "/applications/billing/redis/database",
        message: "Internal provisioning detail",
        outputResourceIds: ["/provider/internal-id"]
      }
    ],
    ...overrides
  };
}

describe("deletionInventoryFromSnapshot", () => {
  it.each(["succeeded", "failed"])(
    "projects only inventory names/types from a %s resource-list report",
    (state) => {
      expect(
        deletionInventoryFromSnapshot(
          { status: "ok", progress: progress({ state }) },
          "BILLING",
          "PROD",
          "42"
        )
      ).toEqual({
        application: "billing",
        environment: "prod",
        resources: [{ name: "database", type: "Radius.Resources/redis" }]
      });
    }
  );

  it("accepts a terminal report when no session run constrains the selection", () => {
    expect(
      deletionInventoryFromSnapshot(
        { status: "ok", progress: progress() },
        "billing",
        "prod",
        null
      )
    ).not.toBeNull();
  });

  it.each(["missing", "malformed", "auth", "error", "stale"])(
    "rejects %s reads even if they retain a last-good progress report",
    (status) => {
      expect(
        deletionInventoryFromSnapshot(
          { status, progress: progress() },
          "billing",
          "prod",
          42
        )
      ).toBeNull();
    }
  );

  it("rejects absent progress", () => {
    expect(
      deletionInventoryFromSnapshot(
        { status: "ok", progress: null },
        "billing",
        "prod",
        42
      )
    ).toBeNull();
  });

  it("accepts identical revalidated progress without accepting other stale reads", () => {
    for (const progressRevalidated of [true, false]) {
      const inventory = deletionInventoryFromSnapshot(
        { status: "stale", progressRevalidated, progress: progress() },
        "billing",
        "prod",
        42
      );
      if (progressRevalidated) {
        expect(inventory?.resources).toEqual([
          { name: "database", type: "Radius.Resources/redis" }
        ]);
      } else {
        expect(inventory).toBeNull();
      }
    }
  });

  it("never treats a failed read as revalidation", () => {
    expect(
      deletionInventoryFromSnapshot(
        { status: "error", progressRevalidated: true, progress: progress() },
        "billing",
        "prod",
        42
      )
    ).toBeNull();
  });

  it.each([
    ["", "prod"],
    ["billing", ""],
    ["other", "prod"],
    ["billing", "other"]
  ])(
    "rejects an unverified requested pair %s/%s",
    (application, environment) => {
      expect(
        deletionInventoryFromSnapshot(
          { status: "ok", progress: progress() },
          application,
          environment,
          42
        )
      ).toBeNull();
    }
  );

  it.each<Partial<DeployProgress>>([
    { application: "" },
    { environment: "" },
    { runId: undefined },
    { runId: 41 },
    { state: undefined },
    { state: "in_progress" },
    { resources: [] },
    { resources: [{ name: " ", type: "Radius.Resources/redis" }] },
    { resources: [{ name: "database", type: " " }] }
  ])("rejects unknown, partial or superseded progress: %j", (overrides) => {
    expect(
      deletionInventoryFromSnapshot(
        { status: "ok", progress: progress(overrides) },
        "billing",
        "prod",
        42
      )
    ).toBeNull();
  });
});
