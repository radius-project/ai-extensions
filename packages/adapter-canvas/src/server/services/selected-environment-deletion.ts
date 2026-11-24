import type { SelectedGhExecutor } from "../../gh.js";
import type { EnvironmentDeletionConfiguration } from "@radius-project/core";
import {
  runEnvironmentDeletion,
  type DeletionOperation,
  type EnvironmentDeletionPorts
} from "./environment-deletion.js";
import type { EnvironmentDeletionDispatch } from "./radius-environment-workflow-deletion.js";

export function hasSelectedEnvironmentDeletion(operation: {
  request?: unknown;
}): boolean {
  return (
    typeof operation.request === "object" &&
    operation.request !== null &&
    Object.hasOwn(operation.request, "selectedOwner")
  );
}

export async function runSelectedEnvironmentDeletion(
  operation: DeletionOperation,
  dependencies: {
    isCurrent(): boolean;
    withOwner(
      login: string,
      work: (executor: SelectedGhExecutor) => Promise<void>
    ): Promise<void>;
    readTarget(
      executor: SelectedGhExecutor,
      repo: string,
      environment: string,
      assertCurrent: () => void
    ): Promise<EnvironmentDeletionConfiguration>;
    isEnvironmentAbsent(
      executor: SelectedGhExecutor,
      repo: string,
      environment: string,
      assertCurrent: () => void
    ): Promise<boolean>;
    bind(
      executor: SelectedGhExecutor,
      assertCurrent: () => void,
      beforeDispatch: (dispatch: EnvironmentDeletionDispatch) => Promise<void>,
      recoverDispatch: () => EnvironmentDeletionDispatch | undefined
    ): EnvironmentDeletionPorts;
  }
): Promise<void> {
  const request = operation.request;
  const { repo, environment, provider } = operation;
  const login = request?.selectedOwner;
  if (
    typeof login !== "string" ||
    !login.trim() ||
    provider !== "azure" ||
    request?.provider !== provider ||
    !repo ||
    repo !== request.repo ||
    !environment ||
    environment !== request.environment ||
    !Number.isSafeInteger(request.repoId) ||
    Number(request.repoId) <= 0 ||
    !Number.isSafeInteger(request.environmentId) ||
    Number(request.environmentId) <= 0 ||
    !request.clientId ||
    !request.tenantId
  ) {
    throw new Error("The deletion has no valid saved GitHub owner and target.");
  }
  const assertCurrent = () => {
    if (
      !dependencies.isCurrent() ||
      operation.request !== request ||
      operation.repo !== repo ||
      operation.environment !== environment ||
      operation.provider !== provider ||
      request.selectedOwner !== login
    ) {
      throw new Error("The saved environment deletion is no longer current.");
    }
  };
  assertCurrent();
  await dependencies.withOwner(login, async (executor) => {
    assertCurrent();
    if (executor.login.toLowerCase() !== login.toLowerCase()) {
      throw new Error(
        "The selected GitHub account does not match the saved deletion owner."
      );
    }
    await executor.verifyIdentity();
    const assertTarget = async (allowAbsent = false) => {
      assertCurrent();
      let live: EnvironmentDeletionConfiguration;
      try {
        live = await dependencies.readTarget(
          executor,
          repo,
          environment,
          assertCurrent
        );
      } catch (error) {
        if (allowAbsent && (await isEnvironmentAbsent())) return "absent";
        throw error;
      }
      assertCurrent();
      if (
        live.provider !== provider ||
        live.repoId !== request.repoId ||
        live.environmentId !== request.environmentId ||
        live.clientId !== request.clientId ||
        live.tenantId !== request.tenantId
      ) {
        throw new Error(
          "The GitHub environment or its Azure identity changed after approval."
        );
      }
      return "present";
    };
    const isEnvironmentAbsent = async () => {
      assertCurrent();
      const absent = await dependencies.isEnvironmentAbsent(
        executor,
        repo,
        environment,
        assertCurrent
      );
      assertCurrent();
      return absent;
    };
    const ports = dependencies.bind(
      executor,
      assertCurrent,
      async (dispatch) => {
        assertCurrent();
        if (
          Object.hasOwn(request, "selectedDispatchStarted") &&
          request.selectedDispatchStarted !== false
        ) {
          throw new Error(
            "A previous delete workflow dispatch may have been accepted. Verify its outcome before starting another deletion."
          );
        }
        await assertTarget();
        request.selectedDispatchStarted = true;
        request.selectedDispatchTime = dispatch.dispatchedAt;
        request.selectedDispatchCorrelation = dispatch.correlationId;
        await ports.persist();
        assertCurrent();
      },
      () => {
        const dispatchedAt = request.selectedDispatchTime;
        const correlationId = request.selectedDispatchCorrelation;
        if (
          request.selectedDispatchStarted === true &&
          typeof dispatchedAt === "number" &&
          Number.isSafeInteger(dispatchedAt) &&
          dispatchedAt > 0 &&
          typeof correlationId === "string" &&
          /^del-[a-z0-9]+-[a-z0-9]{1,8}$/.test(correlationId)
        ) {
          return { dispatchedAt, correlationId };
        }
        return undefined;
      }
    );
    if ((await ports.readRepositoryId(repo)) !== request.repoId) {
      throw new Error(
        "GitHub no longer resolves the saved environment deletion to the same repository."
      );
    }
    assertCurrent();
    await runEnvironmentDeletion(operation, {
      ...ports,
      async validateCredentialCleanupTarget() {
        await assertTarget();
      },
      async deleteGitHubEnvironment(target) {
        if ((await assertTarget(true)) === "absent") {
          return { outcome: "not_found" };
        }
        return ports.deleteGitHubEnvironment(target);
      },
      async deleteStatePackage(target) {
        if (!(await isEnvironmentAbsent())) {
          throw new Error(
            "The GitHub environment still exists or could not be confirmed absent. Radius kept the state package."
          );
        }
        return ports.deleteStatePackage(target);
      }
    });
  });
}
