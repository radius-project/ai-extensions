import { describe, expect, it, vi } from "vitest";
import type { GitHubAccountReadiness } from "../server/services/github-account-readiness.js";
import { createSetupAccountEligibility } from "./setup-account-eligibility.js";

describe("strict setup readiness adapter", () => {
  it.each([
    [true, "ready", "eligible"],
    [false, "missing", "ineligible"],
    [false, "error", "unavailable"],
    [false, "ready", "ineligible"]
  ] as const)(
    "maps readiness=%s and check=%s without changing setup policy",
    async (ready, state, expected) => {
      const passed = { state: "ready" as const, detail: "Ready" };
      const result: GitHubAccountReadiness = {
        ready,
        login: "writer",
        credentialSource: "keyring",
        summary:
          ready ?
            "Ready to configure deployments"
          : "Additional GitHub access is required",
        checks: {
          repository: passed,
          workflow: passed,
          environment: passed,
          identity: passed,
          packages: { state, detail: "Packages access" }
        },
        repair: null,
        repairRemediation: null,
        restoration: null
      };
      const check = vi.fn(async () => result);
      expect(
        await createSetupAccountEligibility({ check })("writer", {
          repo: "fixture/app",
          environment: "dev"
        })
      ).toEqual(
        ready ?
          { state: expected }
        : {
            state: expected,
            message: state === "ready" ? result.summary : "Packages access"
          }
      );
      expect(check).toHaveBeenCalledExactlyOnceWith({
        repo: "fixture/app",
        environment: "dev",
        login: "writer"
      });
    }
  );
});
