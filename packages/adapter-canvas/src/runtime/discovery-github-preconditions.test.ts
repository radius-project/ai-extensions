import { expect, it } from "vitest";
import { portSuccess } from "@radius-project/core/lifecycle";
import { createDiscoveryGitHubRead } from "./discovery-github-read.js";

it.each([
  "authority-error",
  "cancel-during-authority",
  "cancel-during-executor"
] as const)("fences selected-account commands after %s", async (scenario) => {
  let aborted = false;
  const listeners = new Set<() => void>();
  const get = createDiscoveryGitHubRead({
    verify: async () => {
      if (scenario === "authority-error")
        throw new Error("private upstream detail");
      if (scenario === "cancel-during-authority") aborted = true;
      return portSuccess(undefined);
    },
    executor: async (login) => {
      expect(scenario).toBe("cancel-during-executor");
      aborted = true;
      return {
        login,
        run: async () => {
          throw new Error("Unmodeled command");
        }
      };
    }
  });
  const result = await get(
    "/repos/owner/repo",
    {
      requestId: "read",
      cancellation: {
        get aborted() {
          return aborted;
        },
        onAbort(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }
      }
    },
    {
      operation: "environment.list",
      principalRef: "github:reader",
      authorizationRef: "auth",
      target: { repo: "owner/repo" }
    }
  );
  expect(result.status).toBe(
    scenario === "authority-error" ? "unavailable" : "cancelled"
  );
  expect(JSON.stringify(result)).not.toContain("private upstream detail");
  expect(listeners.size).toBe(0);
});
