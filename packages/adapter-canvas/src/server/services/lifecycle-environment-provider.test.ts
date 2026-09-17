import { expect, it, vi } from "vitest";
import {
  portForbidden,
  portFailure,
  portSuccess,
  type AuthorizedScope,
  type EnvironmentConfigurationPlan,
  type RequestControl
} from "@radius-project/core/lifecycle";
import {
  createEnvironmentProviderWriter,
  type ScopedProviderConfiguration
} from "./lifecycle-environment-provider.js";

function fixture(provider: "azure" | "aws" = "azure") {
  const observation = {
    quality: "current",
    completeness: "complete",
    evidence: "configuration"
  } as const;
  const configuration =
    provider === "azure" ?
      {
        provider,
        identityRef: "azure:profile",
        settings: {
          subscriptionId: "subscription",
          resourceGroup: "group",
          location: "westus"
        },
        recipes: []
      }
    : {
        provider,
        identityRef: "aws:profile",
        settings: {
          accountId: "000011112222",
          region: "us-east-1",
          roleName: "fixture-role"
        },
        recipes: []
      };
  const target = { repo: "owner/repo", environment: "dev" };
  const scope: AuthorizedScope<"environment.create"> = {
    authorizationRef: "authority",
    principalRef: "principal",
    operation: "environment.create",
    operationId: "operation",
    target
  };
  const plan: EnvironmentConfigurationPlan = {
    target,
    change: { operation: "environment.create", configuration },
    configuration,
    expected: null
  };
  const control: RequestControl = {
    requestId: "request",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  const identity: ScopedProviderConfiguration =
    provider === "azure" ?
      {
        provider,
        identityRef: "azure:profile",
        clientId: "client",
        tenantId: "tenant",
        subscriptionId: "subscription",
        observation
      }
    : {
        provider,
        identityRef: "aws:profile",
        roleArn: "arn:aws:iam::000011112222:role/fixture-role",
        accountId: "000011112222",
        observation
      };
  const writes: string[] = [];
  const ensure = vi.fn(async () => portSuccess(undefined));
  const deps = {
    authorize: async () => portSuccess(undefined),
    resolve: async () => portSuccess(identity),
    ensure,
    setVariable: async (_scope: unknown, name: string) => {
      writes.push(name);
      return portSuccess(undefined);
    }
  };
  return { scope, plan, control, identity, writes, ensure, deps };
}
it.each(["before", "after-resolve", "after-ensure", "during-write"])(
  "fences cancellation %s and preserves completed writes",
  async (phase) => {
    const f = fixture();
    const cancellation = {
      aborted: phase === "before",
      onAbort: () => () => {}
    };
    const writer = createEnvironmentProviderWriter({
      ...f.deps,
      resolve: async () => {
        cancellation.aborted = phase === "after-resolve";
        return portSuccess(f.identity);
      },
      ensure: async () => {
        cancellation.aborted = phase === "after-ensure";
        return portSuccess(undefined);
      },
      setVariable: async (_scope, name) => {
        f.writes.push(name);
        cancellation.aborted = phase === "during-write";
        return portSuccess(undefined);
      }
    });
    expect(
      await writer(f.scope, f.plan, { ...f.control, cancellation })
    ).toMatchObject({ status: "cancelled" });
    expect(f.writes.length).toBe(phase === "during-write" ? 1 : 0);
  }
);
it.each(["authorization", "resolution", "ensure", "recheck", "variable"])(
  "preserves refusal from %s",
  async (phase) => {
    const f = fixture();
    let grants = 0;
    const writer = createEnvironmentProviderWriter({
      ...f.deps,
      authorize: async () => {
        grants += 1;
        return (
            phase === "authorization" || (phase === "recheck" && grants === 2)
          ) ?
            portForbidden()
          : portSuccess(undefined);
      },
      resolve: async () =>
        phase === "resolution" ? portForbidden() : portSuccess(f.identity),
      ensure: async () =>
        phase === "ensure" ? portForbidden() : portSuccess(undefined),
      setVariable: async (_scope, name) => {
        f.writes.push(name);
        return phase === "variable" && f.writes.length === 2 ?
            portForbidden()
          : portSuccess(undefined);
      }
    });
    expect(await writer(f.scope, f.plan, f.control)).toMatchObject({
      status: "forbidden"
    });
  }
);
it.each([
  "azure-subscription",
  "azure-client",
  "azure-tenant",
  "aws-account",
  "aws-role",
  "aws-arn-account",
  "stale",
  "partial"
])("rejects unverified provider binding %s", async (scenario) => {
  const f = fixture(scenario.startsWith("aws") ? "aws" : "azure");
  if (scenario === "stale")
    Reflect.set(f.identity, "observation", {
      quality: "stale",
      completeness: "complete",
      evidence: "configuration"
    });
  if (scenario === "partial")
    Reflect.set(f.identity, "observation", {
      quality: "current",
      completeness: "partial",
      evidence: "configuration"
    });
  if (scenario === "azure-subscription")
    Reflect.set(f.identity, "subscriptionId", "other");
  if (scenario === "azure-client") Reflect.set(f.identity, "clientId", "");
  if (scenario === "azure-tenant") Reflect.set(f.identity, "tenantId", "");
  if (scenario === "aws-account")
    Reflect.set(f.identity, "accountId", "999900001111");
  if (scenario === "aws-role")
    Reflect.set(f.identity, "roleArn", "arn:aws:iam::000011112222:role/other");
  if (scenario === "aws-arn-account")
    Reflect.set(
      f.identity,
      "roleArn",
      "arn:aws:iam::999900001111:role/fixture-role"
    );
  expect(
    await createEnvironmentProviderWriter(f.deps)(f.scope, f.plan, f.control)
  ).toMatchObject({ status: "failed" });
  expect(f.ensure).not.toHaveBeenCalled();
});
it.each(["authorize", "resolve", "ensure", "setVariable"])(
  "rejects a missing %s provider dependency before any mutation",
  (dependency) => {
    const f = fixture();
    Reflect.deleteProperty(f.deps, dependency);
    expect(() => createEnvironmentProviderWriter(f.deps)).toThrow(
      "Environment providers require"
    );
    expect(f.writes).toEqual([]);
  }
);

it("propagates unknown write failures instead of reporting a completed environment", async () => {
  const f = fixture();
  const writer = createEnvironmentProviderWriter({
    ...f.deps,
    setVariable: async (_scope, name) => {
      if (name === "RADIUS_IDENTITY_REF") return portSuccess(undefined);
      throw new Error("Controlled lost response");
    }
  });
  await expect(writer(f.scope, f.plan, f.control)).rejects.toThrow(
    "Controlled lost response"
  );
});

it.each(["azure", "aws"] as const)(
  "reuses scoped %s configuration without clearing omitted legacy fields",
  async (provider) => {
    const f = fixture(provider);
    expect(
      await createEnvironmentProviderWriter(f.deps)(f.scope, f.plan, f.control)
    ).toMatchObject({ status: "ok" });
    expect(f.ensure).toHaveBeenCalledTimes(1);
    expect(f.writes).not.toContain("KUBERNETES_NAMESPACE");
    expect(f.writes).not.toContain("AWS_EKS_CLUSTER_NAME");
    expect(f.writes).not.toContain("AZURE_AKS_CLUSTER_NAME");
    expect(f.writes).toContain(
      provider === "azure" ? "AZURE_SUBSCRIPTION_ID" : "AWS_ROLE_ARN"
    );
  }
);
it("refuses a foreign identity before creating an environment", async () => {
  const f = fixture();
  Reflect.set(f.identity, "identityRef", "foreign-profile");
  expect(
    await createEnvironmentProviderWriter(f.deps)(f.scope, f.plan, f.control)
  ).toMatchObject({ status: "failed" });
  expect(f.ensure).not.toHaveBeenCalled();
});
it("does not mask a rejected variable write as complete configuration", async () => {
  const f = fixture();
  const write = vi.fn(async () => portFailure("PRECONDITION_FAILED"));
  expect(
    await createEnvironmentProviderWriter({ ...f.deps, setVariable: write })(
      f.scope,
      f.plan,
      f.control
    )
  ).toMatchObject({ status: "failed", error: { code: "PRECONDITION_FAILED" } });
  expect(write).toHaveBeenCalledTimes(1);
});
it("stops before later variables when current authorization changes", async () => {
  const f = fixture();
  const authorize = async () =>
    f.writes.length ?
      portFailure("PRECONDITION_FAILED")
    : portSuccess(undefined);
  expect(
    await createEnvironmentProviderWriter({ ...f.deps, authorize })(
      f.scope,
      f.plan,
      f.control
    )
  ).toMatchObject({ status: "failed" });
  expect(f.writes).toHaveLength(1);
});
