import { describe, expect, it } from "vitest";
import {
  appModelAuthoringFailure,
  appModelTargetKey,
  clearAppModelAuthoringFailure,
  reconcileAppModelAuthoringFailure
} from "./app-model-authoring-failure.js";

describe("app model authoring failures", () => {
  it("keys and reads failures by exact repository and branch", () => {
    const state = {
      appModelFailures: {
        "acme/widgets::main": {
          attemptToken: "attempt-1",
          error: "Recipe conflict"
        }
      },
      appModelAttemptTokens: {
        "acme/widgets::main": "attempt-1"
      }
    };

    expect(appModelTargetKey("acme/widgets", "main")).toBe(
      "acme/widgets::main"
    );
    expect(appModelAuthoringFailure(state, "acme/widgets", "main")).toEqual({
      attemptToken: "attempt-1",
      error: "Recipe conflict"
    });
    expect(
      appModelAuthoringFailure(state, "acme/widgets", "release")
    ).toBeNull();
    state.appModelAttemptTokens["acme/widgets::main"] = "attempt-2";
    expect(appModelAuthoringFailure(state, "acme/widgets", "main")).toBeNull();
  });

  it("clears both the failure and attempt token without requiring either map", () => {
    const state = {
      appModelFailures: {
        "acme/widgets::main": {
          attemptToken: "attempt-1",
          error: "Recipe conflict"
        }
      },
      appModelAttemptTokens: {
        "acme/widgets::main": "attempt-1"
      }
    };

    clearAppModelAuthoringFailure(state, "acme/widgets", "main");
    clearAppModelAuthoringFailure({}, "acme/widgets", "main");

    expect(state.appModelFailures).toEqual({});
    expect(state.appModelAttemptTokens).toEqual({});
  });

  describe("reconcileAppModelAuthoringFailure", () => {
    function failed(commit?: string) {
      return {
        appModelFailures: {
          "acme/widgets::main": {
            attemptToken: "attempt-1",
            error: "Recipe conflict",
            ...(commit === undefined ? {} : { commit })
          }
        } as Record<
          string,
          { attemptToken: string; error: string; commit?: string }
        >,
        appModelAttemptTokens: {
          "acme/widgets::main": "attempt-1"
        } as Record<string, string>
      };
    }
    const reconcile = (
      state: ReturnType<typeof failed>,
      read: () => Promise<string>
    ) => reconcileAppModelAuthoringFailure(state, "acme/widgets", "main", read);

    it("clears the failure when the branch is at a different commit", async () => {
      const state = failed("sha-0");
      await reconcile(state, async () => "sha-1");
      expect(state.appModelFailures).toEqual({});
      expect(state.appModelAttemptTokens).toEqual({});
    });

    it.each([
      ["the commit is unchanged", "sha-0", async () => "sha-0"],
      ["the commit is empty", "sha-0", async () => ""],
      [
        "the commit read throws",
        "sha-0",
        () => Promise.reject(new Error("offline"))
      ]
    ])("keeps the failure when %s", async (_name, recorded, read) => {
      const state = failed(recorded);
      await reconcile(state, read);
      expect(state.appModelFailures["acme/widgets::main"]).toBeDefined();
    });

    it("keeps a failure recorded without a commit and never reads one", async () => {
      const state = failed();
      let reads = 0;
      await reconcile(state, async () => {
        reads += 1;
        return "sha-1";
      });
      expect(reads).toBe(0);
      expect(state.appModelFailures["acme/widgets::main"]).toBeDefined();
    });

    it("keeps a failure that was replaced while the commit was read", async () => {
      const state = failed("sha-0");
      await reconcile(state, async () => {
        state.appModelFailures["acme/widgets::main"] = {
          attemptToken: "attempt-1",
          error: "Newer",
          commit: "sha-0"
        };
        return "sha-1";
      });
      expect(state.appModelFailures["acme/widgets::main"]?.error).toBe(
        "Newer"
      );
    });
  });
});
