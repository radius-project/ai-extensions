import { expect, it } from "vitest";
import { portSuccess, portUnavailable } from "@radius-project/core/lifecycle";
import { createEnvironmentReadAdapter } from "./environment-read.js";

const scope = {
  operation: "environment.inspect" as const,
  principalRef: "reader",
  authorizationRef: "auth",
  target: { repo: "owner/repo", environment: "dev" }
};
const control = {
  requestId: "read",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
it("reports unavailable actual registrations separately from GitHub configuration", async () => {
  const calls: string[] = [];
  const read = createEnvironmentReadAdapter({
    classifyProvider: () => "azure",
    clock: { now: () => "2026-09-15T00:00:00Z" },
    get: async (path) => {
      calls.push(path);
      return portSuccess(
        path.includes("variables") ?
          { variables: [{ name: "AZURE_CLIENT_ID", value: "client-id" }] }
        : { name: "dev", protection_rules: [] }
      );
    },
    registrations: async () =>
      portUnavailable("RESULT_UNAVAILABLE", {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "radius",
        limitation: "No read-only registration evidence channel."
      })
  });
  expect(await read.inspect(scope, control)).toMatchObject({
    status: "ok",
    value: {
      configuration: { provider: "azure" },
      recipeObservation: { completeness: "unavailable" },
      observation: { completeness: "partial" }
    }
  });
  expect(calls).toHaveLength(2);
});

function fixture(
  options: {
    get?: import("./environment-read.js").GitHubDiscoveryRead["get"];
    registrations?: import("@radius-project/core/lifecycle").EnvironmentAccessPort["registrations"];
    provider?: "azure" | "aws" | "";
  } = {}
) {
  return createEnvironmentReadAdapter({
    clock: { now: () => "2026-09-15T00:00:00Z" },
    classifyProvider: () => options.provider ?? "azure",
    get:
      options.get ??
      (async (path) =>
        portSuccess(
          path.includes("variables") ? { variables: [] }
          : path.includes("?per_page") ? { environments: [] }
          : { name: "dev", protection_rules: [] }
        )),
    registrations:
      options.registrations ??
      (async () =>
        portSuccess({
          target: scope.target,
          provider: "azure",
          recipes: [],
          observation: {
            quality: "current",
            completeness: "complete",
            evidence: "radius",
            observedAt: "2026-09-15T00:00:00Z"
          }
        }))
  });
}
it("guards construction and distinguishes an observed empty recipe list from unavailable evidence", async () => {
  expect(() =>
    Reflect.apply(createEnvironmentReadAdapter, undefined, [{}])
  ).toThrow("require");
  expect(await fixture().inspect(scope, control)).toMatchObject({
    status: "ok",
    value: {
      configuration: { provider: "azure", recipes: [] },
      recipeObservation: { completeness: "complete" }
    }
  });
  expect(await fixture({ provider: "" }).inspect(scope, control)).toMatchObject(
    {
      status: "ok",
      value: {
        configuration: { provider: "azure", recipes: [] }
      }
    }
  );
});
it.each([
  null,
  {},
  { environments: null },
  { environments: [null] },
  { environments: [{ name: "" }] },
  { environments: [{ name: "has spaces" }] },
  { environments: [{ name: "a".repeat(129) }] },
  { environments: [{ name: "a".repeat(256) }] }
])(
  "rejects malformed environment listings without empty-success fallbacks",
  async (value) => {
    expect(
      await fixture({ get: async () => portSuccess(value) }).list(
        {
          ...scope,
          operation: "environment.list",
          target: { repo: scope.target.repo }
        },
        control
      )
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  }
);
it("returns complete empty and bounded partial environment observations", async () => {
  const selected = {
    ...scope,
    operation: "environment.list" as const,
    target: { repo: scope.target.repo }
  };
  expect(await fixture().list(selected, control)).toMatchObject({
    status: "ok",
    value: { items: [], observation: { completeness: "complete" } }
  });
  let calls = 0;
  const page = await fixture({
    get: async () => {
      calls++;
      return portSuccess({
        environments: Array.from({ length: 100 }, (_, index) => ({
          name: `env-${calls}-${index}`
        }))
      });
    }
  }).list(selected, control);
  expect(page).toMatchObject({
    status: "ok",
    value: { observation: { completeness: "partial" } }
  });
  if (page.status !== "ok") throw new Error("Expected page");
  expect(page.value.items).toHaveLength(1000);
  expect(calls).toBe(10);
});
it.each([
  null,
  { name: "other", protection_rules: [] },
  { name: "dev", protection_rules: null },
  { name: "dev", protection_rules: [null] },
  { name: "dev", protection_rules: [{}] }
])("rejects malformed or mismatched selected environments", async (value) => {
  expect(
    await fixture({ get: async () => portSuccess(value) }).inspect(
      scope,
      control
    )
  ).toMatchObject({ status: "failed" });
});
it.each([
  null,
  {},
  { variables: [null] },
  { variables: [{ name: "provider", value: 1 }] }
])(
  "rejects malformed configuration instead of guessing a provider",
  async (value) => {
    expect(
      await fixture({
        get: async (path) =>
          portSuccess(
            path.includes("variables") ? value : (
              { name: "dev", protection_rules: [] }
            )
          )
      }).inspect(scope, control)
    ).toMatchObject({ status: "failed" });
  }
);
it("preserves forbidden, unavailable, cancelled, absent and mismatched recipe observations", async () => {
  const { portForbidden, portCancelled, portAbsent } =
    await import("@radius-project/core/lifecycle");
  const selected = {
    ...scope,
    operation: "environment.list" as const,
    target: { repo: scope.target.repo }
  };
  for (const result of [portForbidden(), portCancelled("request_cancelled")]) {
    expect(
      await fixture({ get: async () => result }).list(selected, control)
    ).toEqual(result);
    expect(
      await fixture({ get: async () => result }).inspect(scope, control)
    ).toEqual(result);
    expect(
      await fixture({ registrations: async () => result }).inspect(
        scope,
        control
      )
    ).toEqual(result);
    expect(
      await fixture({
        get: async (path) =>
          path.includes("variables") ? result : (
            portSuccess({ name: "dev", protection_rules: [] })
          )
      }).inspect(scope, control)
    ).toEqual(result);
  }
  const absent = portAbsent({
    quality: "current",
    completeness: "complete",
    evidence: "radius",
    observedAt: "2026-09-15T00:00:00Z"
  });
  expect(
    await fixture({ registrations: async () => absent }).inspect(scope, control)
  ).toMatchObject({
    status: "ok",
    value: { recipeObservation: { completeness: "complete" } }
  });
  expect(
    await fixture({ provider: "aws" }).inspect(scope, control)
  ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  expect(
    await fixture({
      registrations: async () =>
        portSuccess({
          target: { ...scope.target, environment: "other" },
          provider: "azure",
          recipes: [],
          observation: {
            quality: "current",
            completeness: "complete",
            evidence: "radius"
          }
        })
    }).inspect(scope, control)
  ).toMatchObject({ status: "failed" });
  const cancelled = {
    ...control,
    cancellation: { ...control.cancellation, aborted: true }
  };
  expect(await fixture().list(selected, cancelled)).toMatchObject({
    status: "cancelled"
  });
  expect(await fixture().inspect(scope, cancelled)).toMatchObject({
    status: "cancelled"
  });
});

it("retains actual recipe registrations and reviewer protections instead of substituting a provider pack", async () => {
  const recipes = [
    {
      resourceType: "Radius.Compute/containers",
      kind: "terraform",
      source: "git::https://github.com/owner/recipes//container?ref=v1"
    }
  ];
  const read = fixture({
    get: async (path) =>
      portSuccess(
        path.includes("variables") ?
          { variables: [] }
        : { name: "dev", protection_rules: [{ type: "required_reviewers" }] }
      ),
    registrations: async () =>
      portSuccess({
        target: scope.target,
        provider: "azure",
        recipes,
        observation: {
          quality: "stale",
          completeness: "partial",
          evidence: "artifact",
          observedAt: "2026-09-14T00:00:00Z"
        }
      })
  });
  expect(await read.inspect(scope, control)).toMatchObject({
    status: "ok",
    value: {
      configuration: { recipes },
      protections: { requiredReviewers: true },
      recipeObservation: {
        quality: "stale",
        completeness: "partial",
        evidence: "artifact"
      }
    }
  });
  expect(
    await fixture({
      provider: "",
      registrations: async () =>
        portUnavailable("RESULT_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "radius"
        })
    }).inspect(scope, control)
  ).toMatchObject({
    status: "ok",
    value: {
      limitations: [
        "Actual recipe registrations are unavailable from this read context."
      ]
    }
  });
});
