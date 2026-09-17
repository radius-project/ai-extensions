import {
  lifecycleError,
  type LifecycleError,
  type LifecycleResponse
} from "@radius-project/core/lifecycle";
import { readObject } from "@radius-project/adapter-shared";
import type { LifecycleBinding } from "../../runtime/create-lifecycle-binding.js";
import { lifecycleEnvironmentView } from "./lifecycle-environment-view.js";

export function isLifecycleSetupInput(value: unknown): boolean {
  return (
    readObject(value) &&
    ["configuration", "patch", "credentialIntent"].some((key) =>
      Object.hasOwn(value, key)
    )
  );
}
export function lifecycleSetupOperation(
  binding: LifecycleBinding,
  operationId?: string,
  repo?: string
) {
  return binding.registry
    .knownOperations()
    .filter(
      (operation) =>
        [
          "credentials.configure",
          "environment.create",
          "environment.configure"
        ].includes(operation.operation) &&
        (operationId === undefined || operation.operationId === operationId) &&
        (!repo || operation.target.repo === repo)
    )
    .at(-1);
}
function failure(error: LifecycleError) {
  return {
    status:
      error.code === "FORBIDDEN" ? 403
      : error.code === "CAPABILITY_UNAVAILABLE" ? 503
      : error.code === "INVALID_REQUEST" ? 400
      : 409,
    body: { error: error.message, code: error.code }
  };
}
function invalid() {
  return failure(lifecycleError("INVALID_REQUEST"));
}

export function createLifecycleEnvironmentHttp(binding: LifecycleBinding) {
  async function read(operationId: string): Promise<LifecycleResponse | null> {
    const known = lifecycleSetupOperation(binding, operationId);
    if (!known) return null;
    binding.routing.address(operationId);
    return binding.execute({
      operation: "operation.get",
      target: known.target,
      input: { operationId }
    });
  }
  return {
    async start(input: unknown) {
      if (
        !readObject(input) ||
        Object.keys(input).some(
          (key) =>
            ![
              "repo",
              "environment",
              "provider",
              "configuration",
              "patch",
              "credentialIntent",
              "identityRef",
              "approvalRef"
            ].includes(key)
        ) ||
        typeof input.repo !== "string" ||
        ["configuration", "patch", "credentialIntent"].filter((key) =>
          Object.hasOwn(input, key)
        ).length !== 1
      )
        return invalid();
      const credential = input.credentialIntent !== undefined;
      if (
        (credential &&
          (input.approvalRef !== undefined ||
            input.configuration !== undefined ||
            input.patch !== undefined)) ||
        (!credential && input.identityRef !== undefined)
      )
        return invalid();
      if (!credential && input.provider !== undefined) {
        const change = input.patch ?? input.configuration;
        if (!readObject(change) || change.provider !== input.provider)
          return invalid();
      }
      if (
        !credential &&
        binding.routing.selection("environment").writer !== "lifecycle"
      )
        return failure(lifecycleError("CAPABILITY_UNAVAILABLE"));
      const operation =
        credential ? "credentials.configure"
        : input.patch ? "environment.configure"
        : "environment.create";
      const target = {
        repo: input.repo,
        ...(input.environment !== undefined ?
          { environment: input.environment }
        : {})
      };
      const result = await binding.execute({
        operation,
        target,
        input:
          credential ?
            {
              provider: input.provider,
              intent: input.credentialIntent,
              ...(input.identityRef !== undefined ?
                { identityRef: input.identityRef }
              : {})
            }
          : {
              ...(input.patch ?
                { patch: input.patch }
              : { configuration: input.configuration }),
              ...(input.approvalRef !== undefined ?
                { approvalRef: input.approvalRef }
              : {})
            }
      });
      if ("error" in result) return failure(result.error);
      if (
        ![
          "credentials.configure",
          "environment.create",
          "environment.configure"
        ].includes(result.operation) ||
        !("operationId" in result.result)
      )
        throw new Error("Unexpected configuration acceptance.");
      const statusUrl = `/api/operations/${encodeURIComponent(result.result.operationId)}`;
      return {
        status: 202,
        body: { operationId: result.result.operationId, statusUrl }
      };
    },
    async status(operationId: string) {
      const result = await read(operationId);
      if (!result)
        return { status: 404, body: { error: "Unknown operation." } };
      if ("error" in result) return failure(result.error);
      if (result.operation !== "operation.get")
        throw new Error("Unexpected configuration observation.");
      return {
        status: 200,
        body: { operation: lifecycleEnvironmentView(result.result) }
      };
    },
    async respond(operationId: string, input: unknown) {
      if (
        !readObject(input) ||
        Object.keys(input).some(
          (key) => !["actionId", "choice", "approvalRef"].includes(key)
        ) ||
        typeof input.actionId !== "string" ||
        input.choice !== "continue"
      )
        return invalid();
      const known = lifecycleSetupOperation(binding, operationId);
      if (!known) return { status: 404, body: { error: "Unknown operation." } };
      binding.routing.address(operationId, true);
      const result = await binding.execute({
        operation: "operation.respond",
        target: known.target,
        input: {
          operationId,
          actionId: input.actionId,
          response: {
            kind: "user.decision",
            choice: input.choice,
            ...(input.approvalRef !== undefined ?
              { approvalRef: input.approvalRef }
            : {})
          }
        }
      });
      if ("error" in result) return failure(result.error);
      if (result.operation !== "operation.respond")
        throw new Error("Unexpected configuration response.");
      return {
        status: 202,
        body: {
          operationId,
          statusUrl: `/api/operations/${encodeURIComponent(operationId)}`,
          commandId: input.actionId,
          duplicate: false,
          operation: lifecycleEnvironmentView(result.result)
        }
      };
    }
  };
}
