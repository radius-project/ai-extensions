import { describe, expect, it, vi } from "vitest";
import {
  prepareDeploymentWorkflows,
  type DeploymentPublicationPorts
} from "./deployment-publication.js";

const target = {
  repo: "acme/widgets",
  branch: "feat",
  environment: "production",
  workflowFile: "run-rad-commands.yml"
};
const unchanged = { created: [], updated: [] };
function ports(
  overrides: Partial<DeploymentPublicationPorts> = {}
): DeploymentPublicationPorts {
  return {
    isCurrent: () => true,
    publish: async () => {},
    synchronize: async () => unchanged,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    ...overrides
  };
}

describe("deployment publication", () => {
  it.each([
    "unchanged",
    "published-name",
    "published-path",
    "created",
    "updated",
    "other"
  ] as const)(
    "recognizes dispatcher registration requirements after %s",
    async (change) => {
      const selected = { ...target };
      const effects: string[] = [];
      const result = await prepareDeploymentWorkflows(
        selected,
        ports({
          publish: async (actual, written) => {
            effects.push("publish");
            expect(actual).toEqual(target);
            selected.branch = "other";
            if (change === "published-name") written(target.workflowFile);
            if (change === "published-path")
              written(".github/workflows/" + target.workflowFile);
            if (change === "other") written("other.yml");
          },
          synchronize: async (actual) => {
            effects.push("synchronize");
            expect(actual).toEqual(target);
            return {
              created:
                change === "created" ?
                  [".github/workflows/" + target.workflowFile]
                : ["other.yml"],
              updated: change === "updated" ? [target.workflowFile] : []
            };
          }
        })
      );
      expect(result).toEqual({
        kind: "prepared",
        recentlyPublished: change !== "unchanged" && change !== "other"
      });
      expect(effects).toEqual(["publish", "synchronize"]);
    }
  );

  it.each(["publish", "synchronize"] as const)(
    "refuses after %s fails, even with a partial dispatcher write",
    async (phase) => {
      const sync = vi.fn(async () => {
        throw new Error("protected branch");
      });
      const result = await prepareDeploymentWorkflows(
        target,
        ports({
          publish: async (_target, written) => {
            written(target.workflowFile);
            if (phase === "publish") throw new Error("protected branch");
          },
          synchronize: sync
        })
      );
      expect(result).toEqual({
        kind: "refused",
        message: `Could not ${phase} deploy workflows on branch "feat": protected branch. No workflow was dispatched.`
      });
      expect(sync).toHaveBeenCalledTimes(phase === "synchronize" ? 1 : 0);
    }
  );

  it.each(["start", "publish", "synchronize", "error"] as const)(
    "stops after retirement at %s",
    async (step) => {
      let current = step !== "start";
      const publish = vi.fn(async () => {
        if (step === "publish" || step === "error") current = false;
        if (step === "error") throw new Error("late failure");
      });
      const synchronize = vi.fn(async () => {
        if (step === "synchronize") current = false;
        return unchanged;
      });
      expect(
        await prepareDeploymentWorkflows(
          target,
          ports({
            isCurrent: () => current,
            publish,
            synchronize
          })
        )
      ).toMatchObject({ kind: "cancelled" });
      expect(publish).toHaveBeenCalledTimes(step === "start" ? 0 : 1);
      expect(synchronize).toHaveBeenCalledTimes(step === "synchronize" ? 1 : 0);
    }
  );
});
