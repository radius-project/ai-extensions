import { expect, it } from "vitest";
import { createEnvironmentDiscovery } from "./environments-read.js";
import { portSuccess } from "./errors.js";
it("fences environment inspection completion after context close", async () => {
  const target = { repo: "owner/repo", environment: "dev" };
  const observation = {
    quality: "current" as const,
    completeness: "complete" as const,
    evidence: "configuration" as const
  };
  const service = createEnvironmentDiscovery({
    ids: { next: () => "cursor" },
    clock: { now: () => "2026-09-15T00:00:00Z" },
    read: {
      list: async () => {
        throw new Error("No listing");
      },
      inspect: async () => {
        await Promise.resolve();
        return portSuccess({
          target,
          protections: { requiredReviewers: false },
          limitations: [],
          observation,
          recipeObservation: observation
        });
      }
    }
  });
  const pending = service.inspect(
    {
      operation: "environment.inspect",
      target,
      principalRef: "reader",
      authorizationRef: "auth"
    },
    {
      requestId: "read",
      cancellation: { aborted: false, onAbort: () => () => {} }
    }
  );
  service.close();
  expect(await pending).toMatchObject({ status: "cancelled" });
});
it.each([
  { repo: "other/repo", environment: "dev" },
  { repo: "owner/repo", environment: "other" }
])("rejects environment evidence from another selection", async (target) => {
  const observation = {
    quality: "current" as const,
    completeness: "complete" as const,
    evidence: "configuration" as const
  };
  const service = createEnvironmentDiscovery({
    ids: { next: () => "cursor" },
    clock: { now: () => "2026-09-15T00:00:00Z" },
    read: {
      list: async () => {
        throw new Error("Unexpected listing");
      },
      inspect: async () =>
        portSuccess({
          target,
          protections: { requiredReviewers: false },
          limitations: [],
          observation,
          recipeObservation: observation
        })
    }
  });
  expect(
    await service.inspect(
      {
        operation: "environment.inspect",
        principalRef: "reader",
        authorizationRef: "auth",
        target: { repo: "owner/repo", environment: "dev" }
      },
      {
        requestId: "read",
        cancellation: { aborted: false, onAbort: () => () => {} }
      }
    )
  ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
});
