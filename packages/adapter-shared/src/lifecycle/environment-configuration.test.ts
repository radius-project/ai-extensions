import { expect, it, vi } from "vitest";
import {
  portAbsent,
  portFailure,
  portForbidden,
  portSuccess,
  type AuthorizedScope,
  type EnvironmentConfigurationPlan,
  type EnvironmentInspection,
  type RequestControl
} from "@radius-project/core/lifecycle";
import {
  createEnvironmentConfigurationAdapter,
  type EnvironmentConfigurationDependencies,
  type EnvironmentWorkflowPreview
} from "./environment-configuration.js";

function fixture() {
  const observation = {
    quality: "current",
    completeness: "complete",
    evidence: "radius",
    observedAt: "2026-09-17T15:00:00Z"
  } as const;
  const target = { repo: "owner/repo", environment: "dev" };
  const scope: AuthorizedScope<"environment.create"> = {
    authorizationRef: "authority",
    principalRef: "principal",
    operation: "environment.create",
    operationId: "operation",
    target
  };
  const configuration = {
    provider: "azure",
    identityRef: "azure:profile",
    settings: {
      subscriptionId: "subscription",
      resourceGroup: "group",
      location: "westus"
    },
    recipes: [
      {
        resourceType: "Radius.Data/redisCaches",
        kind: "bicep",
        source: "br:example.test/redis:1"
      }
    ]
  } as const;
  const change = { operation: "environment.create", configuration } as const;
  const plan: EnvironmentConfigurationPlan = {
    target,
    configuration,
    change,
    expected: null
  };
  Object.assign(scope, { configuration: change });
  const control: RequestControl = {
    requestId: "request",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  const producerRef = "a".repeat(40);
  const providerWorkflow = `actions/lifecycle-evidence@${producerRef}\nactions/publish-lifecycle-result@${producerRef}`;
  const files = {
    "run-rad-commands.yml": "reviewed dispatcher",
    "run-rad-commands-azure.yml": providerWorkflow,
    "run-rad-commands-aws.yml": providerWorkflow
  };
  const producerFiles = Object.fromEntries(
    [
      "lifecycle-evidence/action.yml",
      "lifecycle-evidence/evidence.sh",
      "run-rad-commands/action.yml",
      "restore-state/action.yml",
      "teardown/action.yml",
      "publish-lifecycle-result/action.yml",
      "deploy-progress/progress.sh"
    ].map((file) => [file, `reviewed ${file}`])
  );
  const preview: EnvironmentWorkflowPreview = {
    intent: { operation: "environment.create", target, change },
    assets: {
      workflow: ".github/workflows/run-rad-commands.yml",
      executionVersion: 1,
      producerRef,
      selectedFiles: files,
      reviewedFiles: files,
      producerFiles,
      reviewedProducerFiles: producerFiles
    }
  };
  const state = {
    current: null as EnvironmentInspection | null,
    fail: "",
    uncertain: "",
    foreignRecipes: false,
    lostProtection: false
  };
  const calls: string[] = [];
  const phase = async (name: string) => {
    calls.push(name);
    if (state.uncertain === name)
      throw new Error("Provider output must not become a public diagnostic.");
    return state.fail === name ?
        portFailure("PRECONDITION_FAILED")
      : portSuccess(undefined);
  };
  const deps: EnvironmentConfigurationDependencies = {
    clock: { now: () => observation.observedAt },
    authorize: async () => portSuccess(undefined),
    inspect: async () =>
      state.current ? portSuccess(state.current) : portAbsent(observation),
    prepare: async () => portSuccess(preview),
    write: async (_scope, currentPlan) => {
      const result = await phase("environment");
      if (result.status === "ok")
        state.current = {
          target,
          configuration: currentPlan.configuration,
          protections: {
            requiredReviewers: !state.lostProtection,
            waitTimerMinutes: 5
          },
          limitations: [],
          observation,
          recipeObservation: observation
        };
      return result;
    },
    publish: async () => {
      const result = await phase("workflows");
      return result.status === "ok" ?
          portSuccess({ ...preview, commit: "b".repeat(40), observation })
        : result;
    },
    registerRecipes: async () => {
      const result = await phase("recipes");
      return result.status === "ok" ?
          portSuccess({
            target:
              state.foreignRecipes ?
                { ...target, environment: "other" }
              : target,
            provider: "azure",
            recipes: configuration.recipes,
            observation
          })
        : result;
    }
  };
  const service = createEnvironmentConfigurationAdapter(deps);
  return {
    service,
    deps,
    state,
    calls,
    scope,
    plan,
    preview,
    control,
    observation
  };
}
it.each([
  "authority",
  "inspection",
  "preparation",
  "cancelled",
  "cancelled-preparation",
  "foreign-scope",
  "changed-plan",
  "occupied"
])("refuses %s before any external writes", async (scenario) => {
  const f = fixture();
  const cancellation = {
    aborted: scenario === "cancelled",
    onAbort: () => () => {}
  };
  if (scenario === "authority") f.deps.authorize = async () => portForbidden();
  if (scenario === "inspection")
    f.deps.inspect = async () => portFailure("EVIDENCE_MISMATCH");
  if (scenario === "preparation")
    f.deps.prepare = async () => portFailure("PRECONDITION_FAILED");
  if (scenario === "cancelled-preparation")
    f.deps.prepare = async () => {
      cancellation.aborted = true;
      return portSuccess(f.preview);
    };
  const plan =
    scenario === "changed-plan" ?
      {
        ...f.plan,
        configuration: { ...f.plan.configuration, identityRef: "other" }
      }
    : f.plan;
  if (scenario === "occupied")
    f.state.current = {
      target: f.plan.target,
      configuration: f.plan.configuration,
      protections: { requiredReviewers: false },
      observation: f.observation,
      limitations: []
    };
  const scope =
    scenario === "foreign-scope" ? { ...f.scope, operationId: "" } : f.scope;
  expect(
    await f.service.configure(scope, plan, { ...f.control, cancellation })
  ).not.toMatchObject({ status: "ok" });
  expect(f.calls).toEqual([]);
});
it.each(["environment", "workflows", "recipes"])(
  "rechecks authority immediately before %s effects",
  async (phase) => {
    const f = fixture();
    const at = ["environment", "workflows", "recipes"].indexOf(phase);
    let grants = 0;
    f.deps.authorize = async () =>
      ++grants === at + 2 ? portForbidden() : portSuccess(undefined);
    expect(await f.service.configure(f.scope, f.plan, f.control)).toMatchObject(
      { status: "ok", value: { state: "failed" } }
    );
    expect(f.calls).toEqual(
      ["environment", "workflows", "recipes"].slice(0, at)
    );
  }
);
it.each(["after-write", "after-recipes", "changed-final"])(
  "records %s observation loss without repeating effects",
  async (scenario) => {
    const f = fixture();
    let reads = 0;
    const inspect = f.deps.inspect;
    f.deps.inspect = async (scope, control) => {
      reads += 1;
      if (
        (scenario === "after-write" && reads === 2) ||
        (scenario === "after-recipes" && reads === 3)
      )
        return portFailure("EVIDENCE_MISMATCH");
      if (scenario === "changed-final" && reads === 3 && f.state.current)
        return portSuccess({
          ...f.state.current,
          target: { ...f.plan.target, environment: "other" }
        });
      return inspect(scope, control);
    };
    expect(await f.service.configure(f.scope, f.plan, f.control)).toMatchObject(
      { status: "ok", value: { state: "failed" } }
    );
    expect(f.calls.filter((phase) => phase === "environment")).toHaveLength(1);
  }
);
it("does not start a dependent phase after cancellation", async () => {
  const f = fixture();
  const cancellation = { aborted: false, onAbort: () => () => {} };
  const write = f.deps.write;
  f.deps.write = async (scope, plan, control) => {
    const result = await write(scope, plan, control);
    cancellation.aborted = true;
    return result;
  };
  expect(
    await f.service.configure(f.scope, f.plan, { ...f.control, cancellation })
  ).toMatchObject({
    status: "ok",
    value: {
      state: "running",
      phases: [
        { phase: "environment", status: "succeeded" },
        { phase: "workflows", status: "unknown" },
        { phase: "recipes", status: "skipped" }
      ]
    }
  });
  expect(f.calls).toEqual(["environment"]);
});
it.each(["intent", "commit", "observation"])(
  "rejects publication with mismatched %s evidence",
  async (scenario) => {
    const f = fixture();
    f.deps.publish = async () =>
      portSuccess({
        ...f.preview,
        ...(scenario === "intent" ?
          {
            intent: {
              ...f.preview.intent,
              target: { ...f.plan.target, environment: "other" }
            }
          }
        : {}),
        commit: scenario === "commit" ? "" : "b".repeat(40),
        observation: {
          ...f.observation,
          quality: scenario === "observation" ? "stale" : "current"
        }
      });
    expect(await f.service.configure(f.scope, f.plan, f.control)).toMatchObject(
      {
        status: "ok",
        value: { state: "failed", error: { code: "EVIDENCE_MISMATCH" } }
      }
    );
    expect(f.calls).not.toContain("recipes");
  }
);
it("requires all external evidence bindings at construction", () => {
  const f = fixture();
  Reflect.deleteProperty(f.deps, "registerRecipes");
  expect(() => createEnvironmentConfigurationAdapter(f.deps)).toThrow(
    "requires qualified publishers"
  );
});

it("publishes only the declared environment intent and verifies actual recipe registrations", async () => {
  const f = fixture();
  expect(await f.service.configure(f.scope, f.plan, f.control)).toMatchObject({
    status: "ok",
    value: {
      state: "succeeded",
      phases: [
        { phase: "environment", status: "succeeded" },
        { phase: "workflows", status: "succeeded" },
        { phase: "recipes", status: "succeeded" }
      ]
    }
  });
  expect(f.calls).toEqual(["environment", "workflows", "recipes"]);
});
it.each(["environment", "workflows", "recipes"])(
  "retains prior effects and skips dependents after a conclusive %s failure",
  async (phase) => {
    const f = fixture();
    f.state.fail = phase;
    const result = await f.service.configure(f.scope, f.plan, f.control);
    expect(result).toMatchObject({
      status: "ok",
      value: {
        state: "failed",
        error: { code: "PRECONDITION_FAILED" },
        phases: expect.arrayContaining([
          expect.objectContaining({ phase, status: "failed" })
        ])
      }
    });
    expect(f.calls).toEqual(
      ["environment", "workflows", "recipes"].slice(
        0,
        ["environment", "workflows", "recipes"].indexOf(phase) + 1
      )
    );
  }
);
it.each(["environment", "workflows", "recipes"])(
  "retains uncertain %s completion without retrying or exposing provider output",
  async (phase) => {
    const f = fixture();
    f.state.uncertain = phase;
    const result = await f.service.configure(f.scope, f.plan, f.control);
    expect(result).toMatchObject({
      status: "ok",
      value: {
        state: "running",
        observation: { quality: "unknown", completeness: "partial" }
      }
    });
    expect(JSON.stringify(result)).not.toContain("Provider output");
    expect(f.calls.filter((item) => item === phase)).toHaveLength(1);
  }
);
it("refuses unqualified workflow assets before writing an environment", async () => {
  const f = fixture();
  Reflect.set(f.preview.assets, "executionVersion", 2);
  expect(await f.service.configure(f.scope, f.plan, f.control)).toMatchObject({
    status: "failed",
    error: { code: "PRECONDITION_FAILED" }
  });
  expect(f.calls).toEqual([]);
});
it("refuses deployment intent even when the published assets themselves are qualified", async () => {
  const f = fixture();
  Reflect.set(f.preview.intent, "operation", "deployment.start");
  expect(await f.service.configure(f.scope, f.plan, f.control)).toMatchObject({
    status: "failed",
    error: { code: "PRECONDITION_FAILED" }
  });
  expect(f.calls).toEqual([]);
});
it("does not register recipes from a foreign environment as success", async () => {
  const f = fixture();
  f.state.foreignRecipes = true;
  expect(await f.service.configure(f.scope, f.plan, f.control)).toMatchObject({
    status: "ok",
    value: { state: "failed", error: { code: "EVIDENCE_MISMATCH" } }
  });
});
it("preserves existing protected environment settings during an explicit patch", async () => {
  const f = fixture();
  const existing: EnvironmentInspection = {
    target: f.plan.target,
    configuration: f.plan.configuration,
    protections: { requiredReviewers: true, waitTimerMinutes: 5 },
    limitations: [],
    observation: f.observation,
    recipeObservation: f.observation
  };
  f.state.current = existing;
  const plan: EnvironmentConfigurationPlan = {
    ...f.plan,
    expected: existing,
    change: {
      operation: "environment.configure",
      patch: { provider: "azure", settings: { location: "eastus" } }
    },
    configuration: {
      ...f.plan.configuration,
      provider: "azure",
      settings: {
        subscriptionId: "subscription",
        resourceGroup: "group",
        location: "eastus"
      }
    }
  };
  Reflect.set(f.preview, "intent", {
    operation: "environment.configure",
    target: plan.target,
    change: plan.change
  });
  f.state.lostProtection = true;
  expect(
    await f.service.configure(
      {
        ...f.scope,
        operation: "environment.configure",
        configuration: plan.change
      },
      plan,
      f.control
    )
  ).toMatchObject({
    status: "ok",
    value: { state: "failed", error: { code: "EVIDENCE_MISMATCH" } }
  });
  expect(f.calls).toEqual(["environment"]);
});
it("rechecks authorization before each external phase", async () => {
  const f = fixture();
  const authorize = vi.fn(async () =>
    f.calls.length ? portFailure("PRECONDITION_FAILED") : portSuccess(undefined)
  );
  const result = await createEnvironmentConfigurationAdapter({
    ...f.deps,
    authorize
  }).configure(f.scope, f.plan, f.control);
  expect(result).toMatchObject({ status: "ok", value: { state: "failed" } });
  expect(f.calls).toEqual(["environment"]);
});
