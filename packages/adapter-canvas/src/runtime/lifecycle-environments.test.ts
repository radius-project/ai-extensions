import { afterEach, expect, it } from "vitest";
import {
  portSuccess,
  type RequestControl
} from "@radius-project/core/lifecycle";
import { createLifecycleFixture } from "../../test/support/lifecycle.js";
import { createLifecycleEnvironmentRegistrations } from "./lifecycle-environments.js";
import { unavailableCanvasLifecyclePrerequisite } from "./lifecycle-authorization.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
function fixture() {
  const foundation = createLifecycleFixture();
  disposals.push(() => foundation.binding.close());
  const deps = {
    registry: foundation.binding.registry,
    actions: foundation.binding.actions,
    routing: foundation.binding.routing,
    ids: foundation.ports.ids,
    clock: foundation.ports.clock,
    identity: foundation.ports.identity,
    hasLegacySetupInProgress: () => false
  };
  const credentials = {
    providers: ["azure" as const],
    inspect: async () =>
      portSuccess({
        prerequisites: [
          {
            provider: "azure" as const,
            status: "missing" as const,
            reason: "Authentication is required."
          }
        ],
        observation: {
          quality: "current" as const,
          completeness: "complete" as const,
          evidence: "configuration" as const
        }
      })
  };
  return { ...foundation, deps, credentials };
}
it.each(["environment.create", "environment.configure"] as const)(
  "keeps %s unavailable on legacy routing or while legacy setup requires control",
  async (operation) => {
    const f = fixture();
    const environmentConfiguration = {
      providers: ["azure" as const],
      environment: {
        inspect: async (): Promise<never> => {
          throw new Error("Blocked setup must not inspect or mutate");
        },
        configure: async (): Promise<never> => {
          throw new Error("Blocked setup must not configure");
        }
      }
    };
    for (const legacyInProgress of [false, true]) {
      f.binding.routing.transition("environment", {
        writer: legacyInProgress ? "lifecycle" : "legacy",
        readers: ["legacy", "lifecycle"],
        controllers: ["legacy", "lifecycle"]
      });
      const entries = createLifecycleEnvironmentRegistrations({
        ...f.deps,
        credentials: f.credentials,
        environmentConfiguration,
        hasLegacySetupInProgress: () => legacyInProgress
      });
      const entry = entries.registrations.find(
        (item) => item.operation === operation
      );
      if (!entry) throw new Error("Missing environment registration");
      const target = { repo: "owner/repo", environment: "dev" };
      const configuration = {
        provider: "azure" as const,
        identityRef: "profile",
        settings: {
          subscriptionId: "subscription",
          resourceGroup: "group",
          location: "westus"
        },
        recipes: []
      };
      const request =
        operation === "environment.create" ?
          {
            apiVersion: "github-radius/v1" as const,
            requestId: "request",
            operation,
            target,
            input: { configuration }
          }
        : {
            apiVersion: "github-radius/v1" as const,
            requestId: "request",
            operation,
            target,
            input: {
              patch: {
                provider: "azure" as const,
                settings: { location: "eastus" }
              }
            }
          };
      expect(
        await entry.execute(request, {
          caller: f.caller,
          control: {
            requestId: "request",
            cancellation: { aborted: false, onAbort: () => () => {} }
          },
          scope: {
            authorizationRef: "authority",
            principalRef: f.caller.principalRef,
            operation,
            target
          }
        })
      ).toMatchObject({
        error: {
          code:
            legacyInProgress ? "PRECONDITION_FAILED" : "CAPABILITY_UNAVAILABLE"
        }
      });
    }
  }
);

it("does not advertise absent environment or credential mutation bindings", () => {
  const f = fixture();
  expect(createLifecycleEnvironmentRegistrations(f.deps)).toEqual({
    capabilities: [],
    registrations: []
  });
  const result = createLifecycleEnvironmentRegistrations({
    ...f.deps,
    credentials: f.credentials
  });
  expect(result.registrations.map((entry) => entry.operation)).toEqual([
    "credentials.inspect"
  ]);
  expect(result.capabilities).toMatchObject([
    {
      operation: "credentials.inspect",
      providers: ["azure"],
      requiresAgent: false
    }
  ]);
});
it("rejects an environment binding without qualified identity inspection at construction", () => {
  const f = fixture();
  expect(() =>
    createLifecycleEnvironmentRegistrations({
      ...f.deps,
      environmentConfiguration: {
        providers: ["azure"],
        environment: {
          inspect: async () => unavailableCanvasLifecyclePrerequisite(),
          configure: async () => unavailableCanvasLifecyclePrerequisite()
        }
      }
    })
  ).toThrow("requires qualified credential inspection");
});
it.each([false, true])(
  "registers concrete credential configuration only when present: %s",
  (configured) => {
    const f = fixture();
    const result = createLifecycleEnvironmentRegistrations({
      ...f.deps,
      credentials: {
        ...f.credentials,
        ...(configured ?
          { configure: async () => unavailableCanvasLifecyclePrerequisite() }
        : {})
      }
    });
    expect(result.registrations.map((entry) => entry.operation)).toEqual(
      configured ?
        ["credentials.inspect", "credentials.configure"]
      : ["credentials.inspect"]
    );
  }
);
it.each([false, true])(
  "observes inspection or cancellation through the actual registration: %s",
  async (aborted) => {
    const f = fixture();
    const result = createLifecycleEnvironmentRegistrations({
      ...f.deps,
      credentials: f.credentials
    });
    const control: RequestControl = {
      requestId: "request",
      cancellation: { aborted, onAbort: () => () => {} }
    };
    const response = await result.registrations[0].execute(
      {
        apiVersion: "github-radius/v1",
        requestId: "request",
        operation: "credentials.inspect",
        target: { repo: "owner/repo" },
        input: { provider: "azure" }
      },
      {
        caller: f.caller,
        control,
        scope: {
          authorizationRef: "authority",
          principalRef: f.caller.principalRef,
          operation: "credentials.inspect",
          target: { repo: "owner/repo" }
        }
      }
    );
    expect(response).toMatchObject(
      aborted ?
        { error: { code: "PRECONDITION_FAILED" } }
      : {
          operation: "credentials.inspect",
          result: { prerequisites: [{ status: "missing" }] }
        }
    );
    expect(f.binding.registry.knownOperations()).toEqual([]);
  }
);
