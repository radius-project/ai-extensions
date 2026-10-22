import { describe, expect, it, vi } from "vitest";
import { isKubernetesNamespace } from "@radius-project/core";
import {
  isValidRepoSlug,
  isResourceGroupName,
  isAksClusterName,
  isUuid
} from "../../azure-oidc.js";
import {
  createOperation,
  buildStages,
  createRegistry,
  finish
} from "../../operations.js";
import {
  createSetupStartService,
  type SetupStartDependencies
} from "./setup-start.js";

const azure = {
  provider: "azure",
  repo: "fixture/app",
  environment: "dev",
  branch: "feature/setup",
  tenantId: "11111111-1111-4111-8111-111111111111",
  subscriptionId: "22222222-2222-4222-8222-222222222222",
  resourceGroup: "fixture-rg",
  cluster: "fixture-aks"
};
function harness() {
  const registry = createRegistry();
  const deps: SetupStartDependencies = {
    isValidRepoSlug,
    isResourceGroupName,
    isAksClusterName,
    isUuid,
    isKubernetesNamespace,
    createOperation,
    buildStages,
    finish,
    startConflict: (repo) => registry.startConflict(repo),
    startOperation: (operation) => registry.start(operation),
    persistOperations: vi.fn(async () => {}),
    scheduleEnvironmentOperation: vi.fn(() => true),
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  };
  const commit = vi.fn();
  const release = vi.fn();
  const claimAccount = vi.fn(async () => ({
    ok: true as const,
    login: "octocat",
    credentialSource: "keyring" as const,
    commit,
    release
  }));
  return {
    deps,
    registry,
    commit,
    release,
    claimAccount,
    start: createSetupStartService(deps)
  };
}
describe("shared setup admission", () => {
  it("preserves optional environment configuration and journey provenance for continuation", async () => {
    const h = harness();
    const extra = {
      profileName: "fixture-profile",
      appName: "fixture-identity",
      appId: "33333333-3333-4333-8333-333333333333",
      serviceManagementReference: "fixture-reference",
      origin: "deploy",
      resumeTarget: "fixture-app",
      resumeBranch: "feature/deploy",
      resumeReason: "environment-required"
    };
    expect(
      (
        await h.start({
          data: { ...azure, ...extra },
          claimAccount: h.claimAccount
        })
      ).status
    ).toBe(202);
    expect(h.registry.latest(azure.repo)).toMatchObject({
      request: { environment: extra },
      resumeRequest: {
        environment: {
          profileName: extra.profileName,
          origin: extra.origin,
          resumeTarget: extra.resumeTarget,
          resumeBranch: extra.resumeBranch,
          resumeReason: extra.resumeReason
        }
      }
    });
  });
  it.each(["invalid", ""])(
    "rejects subscription %j after other Azure identity fields pass",
    async (subscriptionId) => {
      const h = harness();
      expect(
        await h.start({
          data: { ...azure, subscriptionId },
          claimAccount: h.claimAccount
        })
      ).toMatchObject({
        status: 400,
        body: { code: "invalid-azure-operation-input" }
      });
      expect(h.claimAccount).not.toHaveBeenCalled();
    }
  );
  it.each([
    azure,
    {
      provider: "aws",
      repo: "fixture/app",
      environment: "dev",
      branch: "feature/setup",
      roleArn: "arn:aws:iam::123456789012:role/fixture",
      accountId: "123456789012",
      region: "us-west-2",
      cluster: "fixture-eks"
    }
  ])(
    "durably admits panel-free $provider work with its saved account",
    async (data) => {
      const h = harness();
      const order: string[] = [];
      vi.mocked(h.deps.persistOperations).mockImplementation(async () => {
        order.push("persist");
      });
      vi.mocked(h.deps.scheduleEnvironmentOperation).mockImplementation(
        (instance, op) => {
          expect(instance).toBeUndefined();
          expect(op.request).toMatchObject({
            github: { login: "octocat", credentialSource: "keyring" },
            environment: { namespace: "default", branch: "feature/setup" }
          });
          order.push("schedule");
          return true;
        }
      );
      const result = await h.start({
        data,
        claimAccount: h.claimAccount,
        publish: () => {
          order.push("publish");
        }
      });
      expect(result.status).toBe(202);
      expect(order).toEqual(["persist", "publish", "schedule"]);
      expect(h.commit).toHaveBeenCalledOnce();
      expect(h.release).not.toHaveBeenCalled();
    }
  );
  it("validates before consulting host account selection", async () => {
    const h = harness();
    expect(
      await h.start({
        data: { ...azure, namespace: "invalid namespace" },
        claimAccount: h.claimAccount
      })
    ).toMatchObject({
      status: 400,
      body: { code: "invalid-kubernetes-namespace" }
    });
    expect(h.claimAccount).not.toHaveBeenCalled();
  });
  it("releases an account claim superseded before registration", async () => {
    const h = harness();
    expect(
      await h.start({
        data: azure,
        claimAccount: h.claimAccount,
        isCurrent: () => false
      })
    ).toMatchObject({
      status: 409,
      body: { code: "operation-context-changed" }
    });
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.deps.persistOperations).not.toHaveBeenCalled();
  });
  it("does not execute after shutdown during the admission write", async () => {
    const h = harness();
    let current = true;
    vi.mocked(h.deps.persistOperations).mockImplementation(async () => {
      current = false;
    });
    expect(
      (
        await h.start({
          data: azure,
          claimAccount: h.claimAccount,
          isCurrent: () => current
        })
      ).status
    ).toBe(202);
    expect(h.deps.scheduleEnvironmentOperation).not.toHaveBeenCalled();
    expect(h.registry.latest("fixture/app")?.state).toBe("failed");
  });
});
