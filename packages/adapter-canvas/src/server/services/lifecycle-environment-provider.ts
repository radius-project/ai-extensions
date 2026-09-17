import {
  portCancelled,
  portFailure,
  type Observation,
  type PortResult
} from "@radius-project/core/lifecycle";
import type { EnvironmentConfigurationDependencies } from "@radius-project/adapter-shared";
import { applyProviderConfiguration } from "../routes/create-environment-workflow-publisher.js";

type Writer = EnvironmentConfigurationDependencies["write"];
type Scope = Parameters<Writer>[0];
type Control = Parameters<Writer>[2];
export type ScopedProviderConfiguration = {
  readonly identityRef: string;
  readonly observation: Observation;
} & (
  | {
      readonly provider: "azure";
      readonly clientId: string;
      readonly tenantId: string;
      readonly subscriptionId: string;
    }
  | {
      readonly provider: "aws";
      readonly roleArn: string;
      readonly accountId: string;
    }
);
class VariableWriteRefusal extends Error {
  constructor(readonly result: Exclude<PortResult<void>, { status: "ok" }>) {
    super("A scoped environment variable write was refused.");
  }
}
export function createEnvironmentProviderWriter(deps: {
  authorize(scope: Scope, control: Control): Promise<PortResult<void>>;
  resolve(
    scope: Scope,
    identityRef: string,
    control: Control
  ): Promise<PortResult<ScopedProviderConfiguration>>;
  ensure: Writer;
  setVariable(
    scope: Scope,
    name: string,
    value: string,
    control: Control
  ): Promise<PortResult<void>>;
}): Writer {
  if (
    typeof deps.authorize !== "function" ||
    typeof deps.resolve !== "function" ||
    typeof deps.ensure !== "function" ||
    typeof deps.setVariable !== "function"
  )
    throw new Error(
      "Environment providers require authority, identity resolution, environment creation and variable writing."
    );
  return async (scope, plan, control) => {
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const authorized = await deps.authorize(scope, control);
    if (authorized.status !== "ok") return authorized;
    const resolved = await deps.resolve(
      scope,
      plan.configuration.identityRef,
      control
    );
    if (resolved.status !== "ok") return resolved;
    const identity = resolved.value;
    const configuration = plan.configuration;
    if (
      identity.identityRef !== configuration.identityRef ||
      identity.provider !== configuration.provider ||
      identity.observation.quality !== "current" ||
      identity.observation.completeness !== "complete"
    )
      return portFailure("PRECONDITION_FAILED");
    let data;
    if (identity.provider === "azure" && configuration.provider === "azure") {
      if (
        identity.subscriptionId !== configuration.settings.subscriptionId ||
        !identity.clientId ||
        !identity.tenantId
      )
        return portFailure("PRECONDITION_FAILED");
      data = {
        ...configuration.settings,
        clientId: identity.clientId,
        tenantId: identity.tenantId
      };
    } else if (
      identity.provider === "aws" &&
      configuration.provider === "aws"
    ) {
      if (
        identity.accountId !== configuration.settings.accountId ||
        !identity.roleArn.endsWith(
          `:role/${configuration.settings.roleName}`
        ) ||
        identity.roleArn.split(":")[4] !== identity.accountId
      )
        return portFailure("PRECONDITION_FAILED");
      data = { ...configuration.settings, roleArn: identity.roleArn };
    } else return portFailure("PRECONDITION_FAILED");
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const ensured = await deps.ensure(scope, plan, control);
    if (ensured.status !== "ok") return ensured;
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const current = await deps.authorize(scope, control);
    if (current.status !== "ok") return current;
    const reference = await deps.setVariable(
      scope,
      "RADIUS_IDENTITY_REF",
      configuration.identityRef,
      control
    );
    if (reference.status !== "ok") return reference;
    try {
      const receipt = await applyProviderConfiguration(
        configuration.provider,
        data,
        {
          azureCredential: () => ({}),
          awsCredential: () => ({}),
          optionalString: () => "",
          pushStep: () => {},
          setEnvironmentVariable: async (name, value) => {
            // Omitted legacy-only cluster, network and namespace fields are preserved.
            if (value === "" || value === undefined) return false;
            if (typeof value !== "string")
              throw new VariableWriteRefusal(
                portFailure("PRECONDITION_FAILED")
              );
            if (control.cancellation.aborted)
              throw new VariableWriteRefusal(
                portCancelled("request_cancelled")
              );
            const authority = await deps.authorize(scope, control);
            if (authority.status !== "ok")
              throw new VariableWriteRefusal(authority);
            const written = await deps.setVariable(scope, name, value, control);
            if (written.status !== "ok")
              throw new VariableWriteRefusal(written);
            return true;
          }
        }
      );
      return receipt.credentialsComplete ? ensured : (
          portFailure("PRECONDITION_FAILED")
        );
    } catch (error) {
      if (error instanceof VariableWriteRefusal) return error.result;
      throw error;
    }
  };
}
