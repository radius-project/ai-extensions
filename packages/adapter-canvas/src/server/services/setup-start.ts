import { KUBERNETES_NAMESPACE_ERROR } from "@radius-project/core";
import type {
  CreateOperationDependencies,
  OperationRecord
} from "../routes/operations-status.js";
import type { SelectionHandleClaim } from "./github-account-readiness.js";
import type { OperationControlResult } from "./operation-control.js";
import { finishSchedulingFailure } from "./operation-resume.js";
import { setupStartConflictResponse } from "../routes/operation-start-conflict.js";

export type SetupStartDependencies = Omit<
  CreateOperationDependencies,
  "claimSelectionHandle" | "scheduleEnvironmentOperation"
> & {
  scheduleEnvironmentOperation(
    instanceId: string | undefined,
    operation: OperationRecord
  ): boolean;
};

export interface SetupStartInput {
  data: Record<string, unknown>;
  instanceId?: string;
  claimAccount(target: {
    repo: string;
    environment: string;
  }): SelectionHandleClaim | Promise<SelectionHandleClaim>;
  isCurrent?(): boolean;
  publish?(result: OperationControlResult): void;
}

export function createSetupStartService(dependencies: SetupStartDependencies) {
  return async (input: SetupStartInput): Promise<OperationControlResult> => {
    const { data } = input;
    const result = (
      status: number,
      body: Record<string, unknown>
    ): OperationControlResult => ({ status, body });
    const repo = String(data.repo || "");
    const environment = String(data.environment || data.name || "dev").trim();
    const provider = data.provider === "aws" ? "aws" : "azure";
    if (!dependencies.isValidRepoSlug(repo)) {
      return result(400, {
        error: `Invalid repository "${repo}". Expected "owner/repo".`,
        code: "invalid-repo"
      });
    }
    if (!environment.trim()) {
      return result(400, {
        error: "Environment name is required.",
        code: "environment-required"
      });
    }
    const namespace =
      (
        data.namespace === undefined ||
        data.namespace === null ||
        data.namespace === ""
      ) ?
        "default"
      : data.namespace;
    if (
      typeof namespace !== "string" ||
      !dependencies.isKubernetesNamespace(namespace)
    ) {
      return result(400, {
        error: KUBERNETES_NAMESPACE_ERROR,
        code: "invalid-kubernetes-namespace"
      });
    }
    if (provider === "azure") {
      if (
        !dependencies.isResourceGroupName(String(data.resourceGroup || "")) ||
        !dependencies.isAksClusterName(String(data.cluster || "")) ||
        !dependencies.isUuid(String(data.tenantId || "")) ||
        !dependencies.isUuid(String(data.subscriptionId || ""))
      ) {
        return result(400, {
          error:
            "Azure setup requires valid tenantId, subscriptionId, resourceGroup, and cluster values.",
          code: "invalid-azure-operation-input"
        });
      }
      // The cluster's resource group is optional, because the wizard cannot
      // always resolve which resource group a cluster lives in, and an
      // unrecorded one is already handled by the namespace check failing closed.
      // A value that is present must still be a resource group name, since it is
      // written to a GitHub environment variable. Reported on its own rather than
      // folded into the message above, which names four other fields and would
      // misdiagnose this one. Same rule and code as azure-auto-setup.
      const clusterResourceGroup = String(data.clusterResourceGroup || "");
      if (
        clusterResourceGroup !== "" &&
        !dependencies.isResourceGroupName(clusterResourceGroup)
      ) {
        return result(400, {
          error: `Invalid cluster resource group name "${clusterResourceGroup}".`,
          code: "invalid-cluster-resource-group"
        });
      }
    } else if (
      !String(data.roleArn || "").trim() ||
      !String(data.accountId || "").trim() ||
      !String(data.region || "").trim() ||
      !String(data.cluster || "").trim()
    ) {
      return result(400, {
        error: "AWS setup requires roleArn, accountId, region, and cluster.",
        code: "invalid-aws-operation-input"
      });
    }
    const startConflict = dependencies.startConflict(repo);
    if (startConflict) {
      return result(409, setupStartConflictResponse(repo, startConflict));
    }
    const selection = await input.claimAccount({ repo, environment });
    if (!selection.ok) {
      return result(409, {
        error:
          "The selected GitHub account is no longer ready. Re-check the account and try again.",
        code: `github-selection-${selection.error}`
      });
    }
    if (input.isCurrent && !input.isCurrent()) {
      selection.release();
      return result(409, {
        code: "operation-context-changed",
        error:
          "The setup context changed before admission. No setup work started."
      });
    }
    let selectionCommitted = false;
    try {
      const needsAzureCredentials =
        provider === "azure" && !String(data.clientId || "").trim();
      const op = dependencies.createOperation({
        provider,
        repo,
        environment,
        stages: dependencies.buildStages({
          includeIdentity: needsAzureCredentials
        }),
        journey: {
          origin: data.origin || null,
          resumeTarget: data.resumeTarget || null,
          resumeBranch: data.resumeBranch || data.branch || null,
          resumeReason: data.resumeReason || null
        }
      });
      op.context = {
        githubLogin: selection.login,
        githubCredentialSource: selection.credentialSource
      };
      const environmentRequest = {
        repo,
        environment,
        provider,
        cluster: data.cluster || "",
        namespace,
        profileName: data.profileName || "",
        branch: data.branch || "",
        clientId: data.clientId || "",
        tenantId: data.tenantId || "",
        subscriptionId: data.subscriptionId || "",
        resourceGroup: data.resourceGroup || "",
        clusterResourceGroup: data.clusterResourceGroup || "",
        appName: data.appName,
        appId: data.appId || "",
        createNew: data.createNew === true,
        serviceManagementReference: data.serviceManagementReference || "",
        roleArn: data.roleArn || "",
        accountId: data.accountId || "",
        region: data.region || "",
        vpcId: data.vpcId || "",
        subnetIds: data.subnetIds || "",
        origin: data.origin || null,
        resumeTarget: data.resumeTarget || null,
        resumeBranch: data.resumeBranch || null,
        resumeReason: data.resumeReason || null,
        githubLogin: selection.login
      };
      op.request = {
        needsAzureCredentials,
        github: {
          login: selection.login,
          credentialSource: selection.credentialSource
        },
        azure: {
          resourceGroup: data.resourceGroup || "",
          cluster: data.cluster || "",
          clusterResourceGroup: data.clusterResourceGroup || "",
          subscriptionId: data.subscriptionId || "",
          tenantId: data.tenantId || "",
          appName: data.appName,
          appId: data.appId || "",
          createNew: data.createNew === true,
          serviceManagementReference: data.serviceManagementReference || ""
        },
        environment: environmentRequest
      };
      if (provider === "azure") {
        op.resumeRequest = {
          needsAzureCredentials,
          github: {
            login: selection.login,
            credentialSource: selection.credentialSource
          },
          azure: structuredClone((op.request as { azure: unknown }).azure),
          environment: {
            repo,
            environment,
            provider,
            cluster: data.cluster || "",
            namespace,
            profileName: data.profileName || "",
            branch: data.branch || "",
            tenantId: data.tenantId || "",
            subscriptionId: data.subscriptionId || "",
            resourceGroup: data.resourceGroup || "",
            // Carried like every other identifying value, so a resumed setup
            // writes the same cluster resource group the original request did
            // rather than leaving the environment unable to say which cluster
            // it holds.
            clusterResourceGroup: data.clusterResourceGroup || "",
            githubLogin: selection.login,
            origin: data.origin || null,
            resumeTarget: data.resumeTarget || null,
            resumeBranch: data.resumeBranch || null,
            resumeReason: data.resumeReason || null
          }
        };
      }
      const started = dependencies.startOperation(op);
      if (!started.ok) {
        return result(409, setupStartConflictResponse(repo, started));
      }
      try {
        await dependencies.persistOperations();
      } catch (error) {
        dependencies.finish(op, "failed", {
          failure: {
            code: "operation-registration-persist-failed",
            stage: op.currentStage,
            stepSeq: null,
            message:
              "Radius could not durably register the environment operation.",
            classification: "unknown",
            evidence: dependencies.errorMessage(error)
          }
        });
        return result(500, {
          error:
            "Radius could not durably register the environment operation. No setup work was started.",
          code: "operation-registration-persist-failed"
        });
      }
      selection.commit();
      selectionCommitted = true;
      const statusUrl = `/api/operations/${encodeURIComponent(op.operationId)}`;
      const accepted = result(202, { operationId: op.operationId, statusUrl });
      input.publish?.(accepted);
      const scheduled =
        (!input.isCurrent || input.isCurrent()) &&
        dependencies.scheduleEnvironmentOperation(input.instanceId, op);
      if (!scheduled) {
        // No runner accepted the operation, so nothing will ever advance or finish
        // it. Leaving it `running` would keep polling clients spinning and block a
        // fresh start for the same repo with a 409 until the record went stale.
        // The 202 is already on the wire and cannot be recalled, but the record can
        // be moved to a terminal state and persisted so the failure is observable
        // through the same status endpoint the client is already polling.
        await finishSchedulingFailure(
          op,
          input.instanceId,
          (failure) => dependencies.finish(op, "failed", { failure }),
          dependencies.persistOperations,
          dependencies.errorMessage
        );
      }
      return accepted;
    } finally {
      if (!selectionCommitted) selection.release();
    }
  };
}
