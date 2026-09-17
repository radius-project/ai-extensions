import { expect, it } from "vitest";
import { planEnvironmentConfiguration } from "./environment-configuration.js";
import type { EnvironmentChange } from "./ports.js";
import type { LifecycleResponseFor } from "./contracts/catalog.js";
type EnvironmentInspection =
  LifecycleResponseFor<"environment.inspect">["result"];

const observation = {
  quality: "current",
  completeness: "complete",
  evidence: "radius"
} as const;
const current: EnvironmentInspection = {
  target: { repo: "owner/repo", environment: "dev" },
  configuration: {
    provider: "azure",
    identityRef: "azure:profile",
    settings: {
      subscriptionId: "subscription",
      resourceGroup: "existing-group",
      location: "westus"
    },
    recipes: [
      {
        resourceType: "Radius.Data/redisCaches",
        kind: "bicep",
        source: "br:example.test/recipes/redis:1"
      }
    ]
  },
  protections: {
    requiredReviewers: true,
    waitTimerMinutes: 5,
    branchPolicy: "protected"
  },
  limitations: [],
  observation,
  recipeObservation: observation
};

it.each([
  "stale-recipes",
  "malformed-recipe",
  "missing-identity",
  "missing-account",
  "missing-region",
  "missing-role"
])("refuses incomplete or invalid configuration: %s", (scenario) => {
  const baseline = structuredClone(current);
  if (scenario === "stale-recipes")
    baseline.recipeObservation = { ...observation, quality: "stale" };
  else if (scenario === "malformed-recipe") {
    if (!baseline.configuration) throw new Error("Missing fixture");
    baseline.configuration.recipes = [
      { resourceType: "invalid", kind: "bicep", source: "invalid" }
    ];
  } else if (scenario === "missing-identity") {
    if (!baseline.configuration) throw new Error("Missing fixture");
    delete baseline.configuration.identityRef;
  } else {
    baseline.configuration = {
      provider: "aws",
      identityRef: "profile",
      recipes: [],
      settings: {
        accountId: scenario === "missing-account" ? undefined : "000011112222",
        region: scenario === "missing-region" ? undefined : "us-east-1",
        roleName: scenario === "missing-role" ? undefined : "fixture-role"
      }
    };
  }
  expect(
    planEnvironmentConfiguration(
      current.target,
      {
        operation: "environment.configure",
        patch: {
          provider: baseline.configuration?.provider ?? "azure",
          recipes: scenario.startsWith("missing-") ? [] : undefined
        }
      },
      baseline
    )
  ).toMatchObject({ status: "failed" });
});
it("rejects an Azure patch against an AWS environment", () => {
  expect(
    planEnvironmentConfiguration(
      current.target,
      {
        operation: "environment.configure",
        patch: { provider: "azure", recipes: [] }
      },
      {
        ...current,
        configuration: {
          provider: "aws",
          identityRef: "identity",
          settings: {},
          recipes: []
        }
      }
    )
  ).toMatchObject({ status: "failed", error: { code: "PRECONDITION_FAILED" } });
});

it("preserves AWS role and account when changing only its region", () => {
  const baseline: EnvironmentInspection = {
    ...current,
    configuration: {
      provider: "aws",
      identityRef: "profile",
      recipes: [],
      settings: {
        accountId: "000011112222",
        roleName: "fixture-role",
        region: "us-east-1"
      }
    }
  };
  expect(
    planEnvironmentConfiguration(
      current.target,
      {
        operation: "environment.configure",
        patch: { provider: "aws", settings: { region: "us-west-2" } }
      },
      baseline
    )
  ).toMatchObject({
    status: "ok",
    value: {
      configuration: {
        settings: {
          accountId: "000011112222",
          roleName: "fixture-role",
          region: "us-west-2"
        }
      }
    }
  });
});

it("preserves omitted settings, identity, recipes and protections when planning an explicit patch", () => {
  const before = structuredClone(current);
  const result = planEnvironmentConfiguration(
    current.target,
    {
      operation: "environment.configure",
      patch: { provider: "azure", settings: { location: "eastus" } }
    },
    current
  );
  expect(result).toMatchObject({
    status: "ok",
    value: {
      expected: current,
      configuration: {
        ...current.configuration,
        settings: { ...current.configuration?.settings, location: "eastus" }
      }
    }
  });
  expect(current).toEqual(before);
});
it("refuses provider substitution rather than replacing an environment", () => {
  expect(
    planEnvironmentConfiguration(
      current.target,
      {
        operation: "environment.configure",
        patch: { provider: "aws", settings: { region: "us-east-1" } }
      },
      current
    )
  ).toMatchObject({ status: "failed", error: { code: "PRECONDITION_FAILED" } });
});
it.each(["missing", "partial", "stale", "foreign"] as const)(
  "refuses an unsafe %s environment baseline",
  (scenario) => {
    const baseline = structuredClone(current);
    if (scenario === "partial") delete baseline.configuration?.settings;
    if (scenario === "stale") baseline.observation.quality = "stale";
    if (scenario === "foreign") baseline.target.environment = "other";
    expect(
      planEnvironmentConfiguration(
        current.target,
        {
          operation: "environment.configure",
          patch: { provider: "azure", settings: { location: "eastus" } }
        },
        scenario === "missing" ? null : baseline
      )
    ).not.toMatchObject({ status: "ok" });
  }
);
it("does not interpret unavailable recipe evidence as an empty registration list", () => {
  const baseline = structuredClone(current);
  delete baseline.configuration?.recipes;
  baseline.recipeObservation = {
    quality: "unknown",
    completeness: "unavailable",
    evidence: "radius"
  };
  expect(
    planEnvironmentConfiguration(
      current.target,
      {
        operation: "environment.configure",
        patch: { provider: "azure", settings: { location: "eastus" } }
      },
      baseline
    )
  ).not.toMatchObject({ status: "ok" });
});
it("allows an explicit patch to complete previously partial configuration", () => {
  const baseline = structuredClone(current);
  baseline.configuration = {
    provider: "azure",
    identityRef: "azure:profile",
    recipes: []
  };
  expect(
    planEnvironmentConfiguration(
      current.target,
      {
        operation: "environment.configure",
        patch: {
          provider: "azure",
          settings: {
            subscriptionId: "subscription",
            resourceGroup: "group",
            location: "eastus"
          }
        }
      },
      baseline
    )
  ).toMatchObject({
    status: "ok",
    value: { configuration: { settings: { location: "eastus" } } }
  });
});
it.each(["azure", "aws"] as const)(
  "creates an explicit %s configuration without any application or deployment intent",
  (provider) => {
    const change: EnvironmentChange = {
      operation: "environment.create",
      configuration:
        provider === "azure" ?
          {
            provider,
            identityRef: "azure:profile",
            recipes: [],
            settings: {
              subscriptionId: "subscription",
              resourceGroup: "group",
              location: "westus"
            }
          }
        : {
            provider,
            identityRef: "aws:profile",
            recipes: [],
            settings: {
              accountId: "000011112222",
              region: "us-east-1",
              roleName: "fixture-role"
            }
          }
    };
    const result = planEnvironmentConfiguration(current.target, change, null);
    expect(result).toMatchObject({
      status: "ok",
      value: { configuration: change.configuration, change, expected: null }
    });
    expect(
      planEnvironmentConfiguration(current.target, change, current)
    ).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
  }
);
