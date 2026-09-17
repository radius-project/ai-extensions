import { expect, it } from "vitest";
import type { CanonicalGraph } from "./contracts/common.js";
import type { RecipeRegistrationEvidence } from "./ports.js";
import { enrichGraphWithRegistrations } from "./recipe-registrations.js";

const graph: CanonicalGraph = {
  resources: [
    {
      id: "cache",
      name: "cache",
      type: "Radius.Data/redisCaches",
      diffHash: `sha256:${"a".repeat(64)}`,
      connections: [],
      outputResources: []
    }
  ]
};
const observation = {
  quality: "current",
  completeness: "complete",
  evidence: "radius",
  observedAt: "2026-09-15T22:00:00Z"
} as const;
const evidence: RecipeRegistrationEvidence = {
  target: { repo: "owner/repo", environment: "azure-test" },
  provider: "azure",
  recipes: [
    {
      resourceType: "Radius.Data/redisCaches",
      kind: "bicep",
      source: "br:mcr.microsoft.com/bicep/avm/res/cache/redis-enterprise:0.5.1"
    }
  ],
  observation
};

it("uses distinct actual selected-environment registrations rather than provider defaults", () => {
  const before = structuredClone({ graph, evidence });
  const azure = enrichGraphWithRegistrations(graph, evidence);
  const kubernetes = enrichGraphWithRegistrations(graph, {
    ...evidence,
    target: { repo: "owner/repo", environment: "aws-test" },
    provider: "aws",
    recipes: [
      {
        resourceType: "Radius.Data/redisCaches",
        kind: "bicep",
        source: "br:ghcr.io/radius-project/kube-recipes/rediscaches:1.0"
      }
    ]
  });
  expect(azure).toMatchObject({
    status: "ok",
    value: {
      resources: [
        {
          diffHash: graph.resources[0].diffHash,
          outputResources: [
            { type: "Microsoft.Cache/redisEnterprise", provider: "azure" }
          ]
        }
      ]
    }
  });
  expect(kubernetes).toMatchObject({
    status: "ok",
    value: {
      resources: [
        {
          outputResources: [{ type: "apps/Deployment", provider: "kubernetes" }]
        }
      ]
    }
  });
  expect({ graph, evidence }).toEqual(before);
});

it("distinguishes an observed missing recipe for a known type from unavailable registrations", () => {
  expect(
    enrichGraphWithRegistrations(graph, { ...evidence, recipes: [] })
  ).toMatchObject({
    status: "failed",
    error: { code: "RECIPE_PACK_REQUIRED" }
  });
  expect(
    enrichGraphWithRegistrations(graph, {
      ...evidence,
      recipes: [],
      observation: {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "radius",
        limitation: "Actual registrations are unavailable."
      }
    })
  ).toMatchObject({
    status: "unavailable",
    error: { code: "RESULT_UNAVAILABLE" }
  });
});

it("does not invent output resources for an unrecognized registered recipe", () => {
  expect(
    enrichGraphWithRegistrations(graph, {
      ...evidence,
      recipes: [
        {
          resourceType: "Radius.Data/redisCaches",
          kind: "bicep",
          source: "br:ghcr.io/example/custom-cache:1.0"
        }
      ]
    })
  ).toMatchObject({
    status: "unavailable",
    error: { code: "RESULT_UNAVAILABLE" }
  });
});

it("rejects contradictory duplicate registrations instead of selecting an arbitrary recipe", () => {
  expect(
    enrichGraphWithRegistrations(graph, {
      ...evidence,
      recipes: [
        ...evidence.recipes,
        {
          resourceType: "Radius.Data/redisCaches",
          kind: "bicep",
          source: "br:ghcr.io/radius-project/kube-recipes/rediscaches:1.0"
        }
      ]
    })
  ).toMatchObject({
    status: "failed",
    error: { code: "EVIDENCE_CONFLICT" }
  });
});

it("preserves connections and uses existing legacy type aliases for actual registrations", () => {
  const result = enrichGraphWithRegistrations(
    {
      resources: [
        {
          ...graph.resources[0],
          type: "Applications.Datastores/redisCaches@2025-08-01",
          connections: [{ id: "api", direction: "Inbound" }]
        }
      ]
    },
    evidence
  );
  expect(result).toMatchObject({
    status: "ok",
    value: {
      resources: [{ connections: [{ id: "api", direction: "Inbound" }] }]
    }
  });
});

it("does not infer outputs for unsupported recipe kinds or a different registry reusing a known path", () => {
  for (const recipe of [
    { ...evidence.recipes[0], kind: "terraform" },
    {
      ...evidence.recipes[0],
      source: "br:registry.example/bicep/avm/res/cache/redis-enterprise:0.5.1"
    },
    {
      ...evidence.recipes[0],
      source: "br:mcr.microsoft.com/bicep/avm/res/example/unknown:1.0"
    }
  ]) {
    expect(
      enrichGraphWithRegistrations(graph, {
        ...evidence,
        recipes: [recipe]
      })
    ).toMatchObject({
      status: "unavailable",
      error: { code: "RESULT_UNAVAILABLE" }
    });
  }
});

it("keeps an observed empty graph empty when actual registrations are known", () => {
  expect(enrichGraphWithRegistrations({ resources: [] }, evidence)).toEqual({
    status: "ok",
    value: { resources: [] }
  });
});

it("does not replace a registered Kubernetes recipe output with provider infrastructure", () => {
  const result = enrichGraphWithRegistrations(
    {
      resources: [
        {
          ...graph.resources[0],
          type: "Radius.Compute/containers"
        }
      ]
    },
    {
      ...evidence,
      provider: "azure",
      recipes: [
        {
          resourceType: "Radius.Compute/containers",
          kind: "bicep",
          source: "br:ghcr.io/radius-project/kube-recipes/containers:1.0"
        }
      ]
    }
  );
  expect(result).toMatchObject({
    status: "ok",
    value: {
      resources: [
        {
          outputResources: [{ type: "apps/Deployment", provider: "kubernetes" }]
        }
      ]
    }
  });
});
