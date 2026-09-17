import { expect, it } from "vitest";
import {
  portAbsent,
  portCancelled,
  portForbidden,
  portSuccess,
  portUnavailable,
  type ApplicationReadPort,
  type EnvironmentReadPort
} from "@radius-project/core/lifecycle";
import { createLifecycleBinding } from "./create-lifecycle-binding.js";
import { createLifecycleDiscoveryRegistrations } from "./lifecycle-discovery.js";
import { createLifecycleFixture } from "../../test/support/lifecycle.js";

const observation = {
  quality: "current" as const,
  completeness: "complete" as const,
  evidence: "workflow" as const
};
const application = {
  target: { repo: "owner/repo", application: "app" },
  observation
};
const environment = {
  target: { repo: "owner/repo", environment: "dev" },
  protections: { requiredReviewers: false },
  observation,
  recipeObservation: {
    ...observation,
    quality: "unknown" as const,
    completeness: "unavailable" as const
  },
  limitations: []
};
function fixture(
  overrides: {
    applications?: Partial<ApplicationReadPort>;
    environments?: Partial<EnvironmentReadPort>;
  } = {}
) {
  const foundation = createLifecycleFixture();
  let closes = 0;
  const discovery = {
    applications: {
      list: async () =>
        portSuccess({
          target: { repo: "owner/repo" },
          items: [application],
          observation
        }),
      inspect: async () => portSuccess(application),
      ...overrides.applications
    },
    environments: {
      list: async () =>
        portSuccess({
          target: { repo: "owner/repo" },
          items: [{ target: environment.target, observation }],
          observation
        }),
      inspect: async () => portSuccess(environment),
      ...overrides.environments
    },
    capabilities: [],
    close: async () => {
      closes++;
    }
  };
  const deps = {
    authority: foundation.ports.identity,
    clock: foundation.ports.clock,
    ids: foundation.ports.ids,
    hostBinding: () => ({
      sessionRef: foundation.caller.sessionRef,
      bindingRef: "binding"
    }),
    resolveWorkspaceSource: async () => portSuccess(foundation.source),
    knownLegacyOperations: () => [],
    discovery
  };
  return {
    binding: createLifecycleBinding(deps),
    deps,
    closes: () => closes,
    finish: () => foundation.binding.close()
  };
}
it.each([
  "application.list",
  "application.inspect",
  "environment.list",
  "environment.inspect"
] as const)(
  "dispatches and validates %s through the actual binding",
  async (operation) => {
    const f = fixture();
    try {
      expect(
        await f.binding.execute({
          operation,
          target:
            operation.endsWith(".list") ? { repo: "owner/repo" }
            : operation === "application.inspect" ?
              { ...environment.target, application: "app" }
            : environment.target,
          input: {}
        })
      ).toMatchObject({ operation, result: { observation } });
      await f.binding.close();
      await f.binding.close();
      expect(f.closes()).toBe(1);
    } finally {
      await f.binding.close();
      await f.finish();
    }
  }
);
it.each([
  portForbidden(),
  portCancelled("request_cancelled"),
  portAbsent({ ...observation, observedAt: "2026-09-15T00:00:00Z" }),
  portUnavailable("RESULT_UNAVAILABLE", {
    quality: "unknown",
    completeness: "unavailable",
    evidence: "workflow"
  })
])(
  "preserves explicit inspection failures through the result envelope",
  async (result) => {
    const f = fixture({
      applications: { inspect: async () => result },
      environments: { inspect: async () => result }
    });
    try {
      for (const operation of ["application.inspect", "environment.inspect"])
        expect(
          await f.binding.execute({
            operation,
            target:
              operation === "application.inspect" ?
                { ...environment.target, application: "app" }
              : environment.target,
            input: {}
          })
        ).toMatchObject({
          error: {
            code:
              "error" in result ? result.error.code
              : result.status === "absent" ? "DEFINITION_NOT_FOUND"
              : "PRECONDITION_FAILED"
          }
        });
    } finally {
      await f.binding.close();
      await f.finish();
    }
  }
);
it("rejects missing cleanup for an otherwise advertised discovery context", async () => {
  const f = fixture();
  try {
    expect(() =>
      Reflect.apply(createLifecycleDiscoveryRegistrations, undefined, [
        {
          ...f.deps,
          discovery: { ...f.deps.discovery, close: undefined }
        }
      ])
    ).toThrow("cleanup");
  } finally {
    await f.binding.close();
    await f.finish();
  }
});
it("preserves listing failures through the public envelope", async () => {
  const f = fixture({
    applications: { list: async () => portForbidden() },
    environments: { list: async () => portForbidden() }
  });
  try {
    for (const operation of ["application.list", "environment.list"])
      expect(
        await f.binding.execute({
          operation,
          target: { repo: "owner/repo" },
          input: {}
        })
      ).toMatchObject({ error: { code: "FORBIDDEN" } });
  } finally {
    await f.binding.close();
    await f.finish();
  }
});
