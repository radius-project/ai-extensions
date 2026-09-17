import { expect, it } from "vitest";
import { createEnvironmentDiscovery } from "./environments-read.js";
import { portSuccess } from "./errors.js";

it("retains partial environment evidence without manufacturing recipes", async () => {
  const scope = {
    operation: "environment.inspect" as const,
    principalRef: "reader",
    authorizationRef: "auth",
    target: { repo: "owner/repo", environment: "dev" }
  };
  const observation = {
    quality: "unknown" as const,
    completeness: "unavailable" as const,
    evidence: "radius" as const
  };
  const value = {
    target: scope.target,
    protections: { requiredReviewers: false },
    limitations: ["Recipe evidence unavailable."],
    observation,
    recipeObservation: observation
  };
  const service = createEnvironmentDiscovery({
    ids: { next: () => "cursor" },
    clock: { now: () => "2026-09-15T00:00:00Z" },
    read: {
      list: async () => {
        throw new Error("Unmodeled list");
      },
      inspect: async () => portSuccess(value)
    }
  });
  expect(
    await service.inspect(scope, {
      requestId: "read",
      cancellation: { aborted: false, onAbort: () => () => {} }
    })
  ).toEqual(portSuccess(value));
});
