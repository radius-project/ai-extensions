import { describe, expect, it } from "vitest";
import type { CanvasState } from "../../shared.js";
import { discardDeployedApplicationState } from "./deployed-view-state.js";

function deployedState(over: Partial<CanvasState> = {}): CanvasState {
  return {
    deployEnvName: "prod",
    deployAppName: "billing",
    deployStatus: "complete",
    deployRunId: 42,
    deployedGraph: [{ name: "frontend" }],
    deployedGraphRepo: "octo/shop",
    deployingResources: [{ name: "frontend", deployStatus: "success" }],
    ...over
  } as CanvasState;
}

describe("discardDeployedApplicationState", () => {
  it("forgets the deployed graph of the application being deleted", () => {
    const state = deployedState();

    expect(
      discardDeployedApplicationState(state, {
        environment: "prod",
        application: "billing"
      })
    ).toBe(true);

    expect(state.deployedGraph).toBeNull();
    expect(state.deployedGraphRepo).toBeUndefined();
    expect(state.deployingResources).toBeNull();
    expect(state.deployStatus).toBe("");
    expect(state.deployRunId).toBeNull();
  });

  it("matches the environment and application case-insensitively", () => {
    const state = deployedState({
      deployEnvName: "Prod",
      deployAppName: "Billing"
    });

    expect(
      discardDeployedApplicationState(state, {
        environment: " prod ",
        application: "billing"
      })
    ).toBe(true);
    expect(state.deployedGraph).toBeNull();
  });

  it("falls back to the session environment when no deploy environment is recorded", () => {
    const state = deployedState({
      deployEnvName: undefined,
      envName: "prod"
    });

    expect(
      discardDeployedApplicationState(state, {
        environment: "prod",
        application: "billing"
      })
    ).toBe(true);
    expect(state.deployedGraph).toBeNull();
  });

  it("keeps another application's graph in the same environment", () => {
    const state = deployedState();

    expect(
      discardDeployedApplicationState(state, {
        environment: "prod",
        application: "checkout"
      })
    ).toBe(false);

    expect(state.deployedGraph).toEqual([{ name: "frontend" }]);
    expect(state.deployStatus).toBe("complete");
    expect(state.deployRunId).toBe(42);
  });

  it("keeps the same application's graph in another environment", () => {
    const state = deployedState();

    expect(
      discardDeployedApplicationState(state, {
        environment: "staging",
        application: "billing"
      })
    ).toBe(false);

    expect(state.deployedGraph).toEqual([{ name: "frontend" }]);
    expect(state.deployStatus).toBe("complete");
  });

  it.each([
    ["environment", { environment: "", application: "billing" }],
    ["blank environment", { environment: "   ", application: "billing" }],
    ["application", { environment: "prod", application: "" }],
    ["blank application", { environment: "prod", application: "\t" }]
  ])("discards nothing when the target has no %s", (_label, target) => {
    const state = deployedState();

    expect(discardDeployedApplicationState(state, target)).toBe(false);
    expect(state.deployedGraph).toEqual([{ name: "frontend" }]);
  });

  it.each([
    ["environment", { deployEnvName: undefined, envName: undefined }],
    ["application", { deployAppName: undefined }],
    ["named environment", { deployEnvName: "  ", envName: "" }],
    ["named application", { deployAppName: "  " }]
  ])(
    "discards nothing when the session deployment has no %s",
    (_label, over) => {
      const state = deployedState(over);

      expect(
        discardDeployedApplicationState(state, {
          environment: "prod",
          application: "billing"
        })
      ).toBe(false);
      expect(state.deployedGraph).toEqual([{ name: "frontend" }]);
    }
  );

  it("is idempotent across repeated deletes of the same application", () => {
    const state = deployedState();
    const target = { environment: "prod", application: "billing" };

    expect(discardDeployedApplicationState(state, target)).toBe(true);
    // The identity fields are not cleared, so the second call still recognizes
    // this state as describing the deleted deployment and still returns true --
    // the return value reports a matching identity, not a state transition.
    expect(discardDeployedApplicationState(state, target)).toBe(true);
    expect(state.deployedGraph).toBeNull();
  });
});
