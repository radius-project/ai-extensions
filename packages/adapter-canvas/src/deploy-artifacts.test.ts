import { describe, expect, it } from "vitest";
import {
  applyDeployStatusToResources,
  buildDeployStatusMap,
  parseDeployProgressArtifact,
  settleDeployStatuses,
  DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE
} from "./deploy-artifacts.js";
import { DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE as browserMessage } from "./deploy-messages.js";
import type { DeployStatus } from "@radius-project/core";

describe("Canvas progress compatibility forwarding", () => {
  it("uses the shared progress and settlement contracts without changing graph vocabulary", () => {
    const progress = parseDeployProgressArtifact(
      JSON.stringify({
        schemaVersion: 1,
        application: "app",
        environment: "production",
        runId: 42,
        sequence: 1,
        updatedAt: "2026-01-01T00:00:00Z",
        state: "running",
        resources: [
          { name: "web", type: "Radius.Compute/containers", status: "success" }
        ]
      })
    );
    const resources: Array<{
      name: string;
      type: string;
      deployStatus: DeployStatus;
    }> = [
      {
        name: "web",
        type: "Radius.Compute/containers",
        deployStatus: "pending"
      }
    ];
    applyDeployStatusToResources(resources, buildDeployStatusMap(progress));
    expect(resources[0].deployStatus).toBe("success");
    settleDeployStatuses(resources, "failure");
    expect(resources[0].deployStatus).toBe("success");
    expect(DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE).toBe(browserMessage);
  });
});
