import { expect, it } from "vitest";
import type { CanvasState } from "../../shared.js";
import { retainedMonitoring } from "./retained-monitoring.js";

const target = { repo: "owner/repo", application: "app", environment: "dev" };
function state(): CanvasState {
  return {
    deployingRepo: target.repo,
    deployAppName: target.application,
    deployEnvName: target.environment,
    deployRunId: 7,
    deployStatus: "failed",
    deployErrorKind: "run-unconfirmed",
    deployingResources: [
      {
        id: "web",
        name: "web",
        type: "Radius.Compute/containers",
        deployStatus: "failed",
        deployMessage: "Monitoring timed out."
      }
    ]
  };
}

it("copies only recorded settled monitoring resources for the exact selection", () => {
  const source = state();
  source.deployingResources?.push(
    { id: "db", deployStatus: "success" },
    { id: "unknown", deployStatus: "pending" },
    { deployStatus: "failed" },
    { id: "", deployStatus: "success" }
  );
  const value = retainedMonitoring(
    source,
    { repo: "OWNER/REPO", application: "APP", environment: "DEV" },
    "RESULT_UNAVAILABLE"
  );
  expect(value?.resources.map((resource) => resource.id)).toEqual([
    "web",
    "db"
  ]);
  expect(value?.runId).toBe(7);
  if (!value) throw new Error("Missing monitoring evidence");
  value.resources[0].deployMessage = "changed";
  expect(source.deployingResources?.[0].deployMessage).toBe(
    "Monitoring timed out."
  );
  expect(
    retainedMonitoring(undefined, target, "RESULT_UNAVAILABLE")
  ).toBeUndefined();
});

it.each([
  { deployStatus: "deploying" },
  { deployErrorKind: "branch-not-pushed" },
  { deployRunId: undefined },
  { deployRunId: 0 },
  { deployRunId: -1 },
  { deployRunId: 1.5 },
  { deployRunId: Number.NaN },
  { deployingRepo: undefined },
  { deployingRepo: "other/repo" },
  { deployAppName: undefined },
  { deployAppName: "other" },
  { deployEnvName: undefined },
  { deployEnvName: "other" },
  { deployingResources: undefined },
  { deployingResources: [] }
] satisfies Partial<CanvasState>[])(
  "does not project unproven or mismatched monitoring state %j",
  (patch) => {
    expect(
      retainedMonitoring({ ...state(), ...patch }, target, "RESULT_UNAVAILABLE")
    ).toBeUndefined();
  }
);

it.each(["repo", "application", "environment"] as const)(
  "requires a named %s",
  (key) => {
    expect(
      retainedMonitoring(
        state(),
        { ...target, [key]: "" },
        "RESULT_UNAVAILABLE"
      )
    ).toBeUndefined();
  }
);
it.each(["FORBIDDEN", "CAPABILITY_UNAVAILABLE", "INVALID_REQUEST"])(
  "does not expose cached monitoring after %s",
  (reason) => {
    expect(retainedMonitoring(state(), target, reason)).toBeUndefined();
  }
);
