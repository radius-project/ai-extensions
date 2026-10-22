import { describe, expect, it, vi } from "vitest";
import {
  checkDeploymentBranch,
  type DeploymentBranchPorts
} from "./deployment-branch.js";

function ports(
  overrides: Partial<DeploymentBranchPorts> = {}
): DeploymentBranchPorts {
  return {
    isCurrent: () => true,
    head: async () => "sha",
    defaultBranch: async () => {
      throw new Error("Unexpected default-branch lookup");
    },
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    ...overrides
  };
}

describe("deployment branch preflight", () => {
  it("accepts the explicit remote branch without changing to the default", async () => {
    const head = vi.fn(async () => "sha");
    expect(
      await checkDeploymentBranch(
        "acme/widgets",
        "feature/model",
        ports({ head })
      )
    ).toEqual({ kind: "ready" });
    expect(head).toHaveBeenCalledExactlyOnceWith(
      "acme/widgets",
      "feature/model"
    );
  });

  it("reports an unpushed branch only after confirming repository access", async () => {
    const reads: string[] = [];
    expect(
      await checkDeploymentBranch(
        "acme/widgets",
        "feature/model",
        ports({
          head: async () => {
            reads.push("head");
            return null;
          },
          defaultBranch: async (repo) => {
            reads.push(repo);
            return "trunk";
          }
        })
      )
    ).toEqual({ kind: "missing" });
    expect(reads).toEqual(["head", "acme/widgets"]);
  });

  it.each([null, "", " "])(
    "refuses unknown repository identity instead of blaming a missing ref: %s",
    async (defaultBranch) => {
      expect(
        await checkDeploymentBranch(
          "acme/widgets",
          "feature/model",
          ports({
            head: async () => null,
            defaultBranch: async () => defaultBranch
          })
        )
      ).toMatchObject({
        kind: "refused",
        message: expect.stringContaining("Could not confirm repository access")
      });
    }
  );

  it.each([
    ["", "feature"],
    ["acme/widgets", " "]
  ])("refuses an unresolved target: %s@%s", async (repo, branch) => {
    const head = vi.fn(async () => "sha");
    expect(
      await checkDeploymentBranch(repo, branch, ports({ head }))
    ).toMatchObject({ kind: "refused" });
    expect(head).not.toHaveBeenCalled();
  });

  it.each(["head", "default"] as const)(
    "reports failed %s reads without inventing a branch diagnosis",
    async (step) => {
      const fail = async () => {
        throw new Error("HTTP 403");
      };
      expect(
        await checkDeploymentBranch(
          "acme/widgets",
          "feature/model",
          ports({
            head: step === "head" ? fail : async () => null,
            defaultBranch: fail
          })
        )
      ).toEqual({
        kind: "refused",
        message: "Could not confirm the deployment branch: HTTP 403"
      });
    }
  );

  it.each(["start", "head", "default", "error"] as const)(
    "stops reads after retirement at %s",
    async (step) => {
      let current = step !== "start";
      const head = vi.fn(async () => {
        if (step === "head" || step === "error") current = false;
        if (step === "error") throw new Error("late error");
        return null;
      });
      const defaultBranch = vi.fn(async () => {
        current = false;
        return "trunk";
      });
      expect(
        await checkDeploymentBranch(
          "acme/widgets",
          "feature/model",
          ports({
            isCurrent: () => current,
            head,
            defaultBranch
          })
        )
      ).toMatchObject({ kind: "cancelled" });
      expect(head).toHaveBeenCalledTimes(step === "start" ? 0 : 1);
      expect(defaultBranch).toHaveBeenCalledTimes(step === "default" ? 1 : 0);
    }
  );
});
