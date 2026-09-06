import { describe, expect, it } from "vitest";
import {
  appModelAuthoringFailure,
  appModelTargetKey,
  clearAppModelAuthoringFailure
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
});
