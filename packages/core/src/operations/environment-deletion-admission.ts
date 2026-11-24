import type { DeploymentApplicationIdentity } from "../deployment-lookup-policy.js";

export interface EnvironmentDeletionTarget {
  repo: string;
  environment: string;
}

export interface EnvironmentDeletionConfiguration {
  provider: string;
  clientId: string;
  tenantId: string;
  repoId: number;
  environmentId?: number;
  roleArn?: string;
  trustSubjects?: string[] | null;
  region?: string;
  cluster?: string;
}

export interface EnvironmentDeletionAdmissionPorts {
  resolveEnvDeployment(
    repo: string,
    environment: string,
    appName: string
  ): Promise<{
    app: string;
    status: string;
    identity?: DeploymentApplicationIdentity;
  } | null>;
  discoverEnvironmentTarget(
    repo: string,
    environment: string
  ): Promise<EnvironmentDeletionConfiguration>;
}

export type EnvironmentDeletionAdmission =
  | {
      kind: "ready";
      configuration: EnvironmentDeletionConfiguration & {
        provider: "azure" | "aws";
      };
    }
  | { kind: "deployment-unreadable"; error: unknown }
  | { kind: "identity-unavailable"; readFailed: boolean; reason?: string }
  | { kind: "app-deployed"; app: string; status: string }
  | { kind: "configuration-unreadable"; error: unknown }
  | { kind: "provider-unsupported"; provider: string };

export async function admitEnvironmentDeletion(
  { repo, environment }: EnvironmentDeletionTarget,
  ports: EnvironmentDeletionAdmissionPorts,
  allowAws: boolean
): Promise<EnvironmentDeletionAdmission> {
  let active: Awaited<
    ReturnType<EnvironmentDeletionAdmissionPorts["resolveEnvDeployment"]>
  >;
  try {
    active = await ports.resolveEnvDeployment(repo, environment, "");
  } catch (error) {
    return { kind: "deployment-unreadable", error };
  }
  if (active) {
    if (active.identity?.state !== "known") {
      return {
        kind: "identity-unavailable",
        readFailed: active.identity?.readFailed === true,
        reason: active.identity?.reason
      };
    }
    return { kind: "app-deployed", app: active.app, status: active.status };
  }

  let configuration: EnvironmentDeletionConfiguration;
  try {
    configuration = await ports.discoverEnvironmentTarget(repo, environment);
  } catch (error) {
    return { kind: "configuration-unreadable", error };
  }
  const { provider } = configuration;
  if (provider !== "azure" && !(provider === "aws" && allowAws)) {
    return { kind: "provider-unsupported", provider };
  }
  return { kind: "ready", configuration: { ...configuration, provider } };
}
