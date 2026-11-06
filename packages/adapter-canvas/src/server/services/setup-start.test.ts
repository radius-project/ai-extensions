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
  finish,
  STAGE_AUTHORIZE_IDENTITY
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
const aws = {
  provider: "aws",
  repo: "fixture/app",
  environment: "dev",
  branch: "feature/setup",
  roleName: "fixture-role",
  accountId: "123456789012",
  region: "us-west-2",
  cluster: "fixture-eks",
  vpcId: "vpc-0f1e",
  subnetIds: "subnet-a,subnet-b"
};
function harness(awsEnabled = true) {
  const registry = createRegistry();
  const deps: SetupStartDependencies = {
    awsEnabled,
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
  it.each([
    [{}, "provider-unsupported"],
    [{ namespace: "INVALID NAMESPACE" }, "provider-unsupported"],
    [{ repo: "invalid" }, "invalid-repo"],
    [{ environment: " " }, "environment-required"]
  ])(
    "preserves disabled AWS admission ordering for %j",
    async (patch, code) => {
      const h = harness(false);
      const conflict = vi.spyOn(h.deps, "startConflict");
      const create = vi.spyOn(h.deps, "createOperation");
      expect(
        await h.start({
          data: { ...aws, ...patch },
          claimAccount: h.claimAccount
        })
      ).toMatchObject({ status: 400, body: { code } });
      expect(conflict).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(h.claimAccount).not.toHaveBeenCalled();
      expect(h.deps.persistOperations).not.toHaveBeenCalled();
      expect(h.deps.scheduleEnvironmentOperation).not.toHaveBeenCalled();
    }
  );
  it("keeps Azure available with AWS disabled", async () => {
    const h = harness(false);
    expect(
      (await h.start({ data: azure, claimAccount: h.claimAccount })).status
    ).toBe(202);
  });
  it.each([
    { roleName: "fixture-role", existingRoleArn: "" },
    {
      roleName: "",
      existingRoleArn: "arn:aws:iam::123456789012:role/existing"
    },
    {
      roleName: "fixture-role",
      existingRoleArn: "arn:aws:iam::123456789012:role/existing"
    }
  ])(
    "retains both role selector fields and the AWS identity stage: %j",
    async (selectors) => {
      const h = harness();
      expect(
        (
          await h.start({
            data: { ...aws, ...selectors },
            claimAccount: h.claimAccount
          })
        ).status
      ).toBe(202);
      const saved = h.registry.latest(aws.repo);
      expect(saved.request.environment).toMatchObject({ ...aws, ...selectors });
      expect(saved.request.environment).not.toHaveProperty("roleArn");
      expect(saved.stages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: STAGE_AUTHORIZE_IDENTITY })
        ])
      );
    }
  );
  it.each([
    { accountId: "" },
    { accountId: "123" },
    { region: "" },
    { region: "not-a-region" },
    { cluster: "" },
    { vpcId: "" },
    { subnetIds: "" },
    { roleName: "" },
    { roleName: "invalid role" },
    { roleName: "", existingRoleArn: "invalid" },
    { roleName: "", roleArn: "arn:aws:iam::123456789012:role/legacy" }
  ])(
    "rejects invalid AWS domain input before account selection: %j",
    async (patch) => {
      const h = harness();
      expect(
        await h.start({
          data: { ...aws, ...patch },
          claimAccount: h.claimAccount
        })
      ).toMatchObject({
        status: 400,
        body: { code: "invalid-aws-operation-input" }
      });
      expect(h.claimAccount).not.toHaveBeenCalled();
      expect(h.deps.persistOperations).not.toHaveBeenCalled();
    }
  );
  it("saves the AWS request a continuation reads after a restart", async () => {
    const h = harness();
    const data = {
      ...aws,
      existingRoleArn: "arn:aws:iam::123456789012:role/existing",
      namespace: "shop",
      profileName: "fixture-profile",
      origin: "deploy"
    };
    expect((await h.start({ data, claimAccount: h.claimAccount })).status).toBe(
      202
    );
    const saved = h.registry.latest(aws.repo);
    expect(saved.resumeRequest).toEqual({
      needsAzureCredentials: false,
      github: { login: "octocat", credentialSource: "keyring" },
      environment: saved.request.environment
    });
    expect(saved.resumeRequest.environment).toMatchObject({
      accountId: aws.accountId,
      region: aws.region,
      cluster: aws.cluster,
      roleName: aws.roleName,
      existingRoleArn: data.existingRoleArn,
      vpcId: aws.vpcId,
      subnetIds: aws.subnetIds,
      namespace: "shop",
      profileName: "fixture-profile",
      origin: "deploy"
    });
    expect(saved.resumeRequest.environment).not.toBe(saved.request.environment);
  });
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
  it.each([
    { subscriptionId: "invalid" },
    { subscriptionId: "" },
    { tenantId: "" },
    { cluster: "" }
  ])("rejects invalid required Azure identity fields: %j", async (patch) => {
    const h = harness();
    expect(
      await h.start({
        data: { ...azure, ...patch },
        claimAccount: h.claimAccount
      })
    ).toMatchObject({
      status: 400,
      body: { code: "invalid-azure-operation-input" }
    });
    expect(h.claimAccount).not.toHaveBeenCalled();
  });
  it.each([azure, aws])(
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
