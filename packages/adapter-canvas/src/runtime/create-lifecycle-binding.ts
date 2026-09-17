import {
  LIFECYCLE_API_VERSION,
  createActionService,
  createLifecycleService,
  createSessionOperationRegistry,
  lifecycleError,
  portSuccess,
  registerLifecycleOperation,
  type HostCallerBinding,
  type IdPort,
  type LifecycleRequest,
  type LifecycleError,
  type LifecycleResponse,
  type PortResult,
  type RequestControl,
  type Source,
  type Target
} from "@radius-project/core/lifecycle";
import {
  portFailure,
  portUnavailable,
  repositorySchema,
  gitRefSchema,
  type LifecycleGraphDependencies,
  type AuthorizedScope
} from "@radius-project/core/lifecycle";
import {
  createLifecycleGraphRegistrations,
  graphCapabilities
} from "./lifecycle-graphs.js";
import { createLifecycleValidators } from "@radius-project/adapter-shared";
import {
  createLifecycleDefinitionRegistrations,
  type LifecycleDefinitionDependencies
} from "./lifecycle-definitions.js";
import {
  createLifecycleDiscoveryRegistrations,
  type LifecycleDiscoveryDependencies
} from "./lifecycle-discovery.js";
import {
  createLifecycleAuthorization,
  type LifecycleAuthority
} from "./lifecycle-authorization.js";
import {
  createLifecycleRouting,
  type KnownLifecycleOperation,
  type LifecycleRoutingFamily
} from "./lifecycle-routing.js";
import {
  createLifecycleDeploymentRegistrations,
  type LifecycleDeploymentDependencies
} from "./lifecycle-deployment.js";
import {
  createLifecycleEnvironmentRegistrations,
  type LifecycleEnvironmentDependencies
} from "./lifecycle-environments.js";
import type { LifecycleCredentialDependencies } from "./lifecycle-credentials.js";
import { createLifecycleControlRegistrations } from "./lifecycle-controls.js";

export interface LifecycleBindingDependencies {
  readonly credentials?: LifecycleCredentialDependencies;
  readonly environmentConfiguration?: LifecycleEnvironmentDependencies;
  readonly deployment?: LifecycleDeploymentDependencies;
  readonly definitions?: LifecycleDefinitionDependencies;
  readonly discovery?: LifecycleDiscoveryDependencies;
  readonly graphs?: Omit<LifecycleGraphDependencies, "identity" | "clock">;
  resolveGitSource?(
    scope: AuthorizedScope,
    ref: string,
    control: RequestControl
  ): Promise<PortResult<Source>>;
  readonly authority: LifecycleAuthority;
  readonly ids: IdPort;
  readonly clock: { now(): string };
  hostBinding(): HostCallerBinding;
  resolveWorkspaceSource(
    target: Pick<Target, "repo" | "definition">,
    control: RequestControl
  ): Promise<PortResult<Source>>;
  knownLegacyOperations(): readonly KnownLifecycleOperation[];
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createLifecycleBinding(deps: LifecycleBindingDependencies) {
  if (
    typeof deps?.hostBinding !== "function" ||
    typeof deps.resolveWorkspaceSource !== "function" ||
    typeof deps.knownLegacyOperations !== "function"
  )
    throw new Error(
      "Lifecycle binding requires trusted host, source and legacy routing context."
    );
  const authorization = createLifecycleAuthorization(deps.authority);
  const registry = createSessionOperationRegistry(deps);
  const actions = createActionService({
    ...deps,
    registry,
    identity: deps.authority
  });
  let validators: ReturnType<typeof createLifecycleValidators> | undefined;
  const getValidators = () => (validators ??= createLifecycleValidators());
  let closed = false;
  let cleanup: Promise<void> | undefined;
  let definitionsClosed = false;
  let discoveryClosed = false;
  let registryClosed = false;
  let activeRequests = 0;
  const listeners = new Set<() => void>();
  const signal = {
    get aborted() {
      return closed;
    },
    onAbort(listener: () => void) {
      if (closed) listener();
      else listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
  const routing = createLifecycleRouting({
    knownOperations: () => [
      ...deps.knownLegacyOperations(),
      ...registry.knownOperations().map((operation) => {
        const prefix = operation.operation.split(".")[0];
        const family: LifecycleRoutingFamily =
          operation.operation === "operation.repair" ? "definition"
          : (
            prefix === "definition" ||
            prefix === "application" ||
            prefix === "deployment"
          ) ?
            prefix
          : "environment";
        return {
          operationId: operation.operationId,
          family,
          owner: "lifecycle" as const,
          needsControl: !["succeeded", "failed", "cancelled"].includes(
            operation.state
          )
        };
      })
    ]
  });
  const graphs =
    deps.graphs ?
      createLifecycleGraphRegistrations({
        ...deps.graphs,
        identity: deps.authority,
        clock: deps.clock
      })
    : undefined;
  const definitions =
    deps.definitions ?
      createLifecycleDefinitionRegistrations({
        ...deps.definitions,
        identity: deps.authority,
        registry,
        actions,
        clock: deps.clock,
        ids: deps.ids,
        routing
      })
    : undefined;
  if (deps.definitions?.authoring)
    routing.transition("definition", {
      writer: "lifecycle",
      readers: ["legacy", "lifecycle"],
      controllers: ["legacy", "lifecycle"]
    });
  const deployment = createLifecycleDeploymentRegistrations({
    ...deps,
    identity: deps.authority,
    registry,
    routing
  });
  const hasLegacySetupInProgress = () =>
    deps
      .knownLegacyOperations()
      .some(
        (operation) =>
          operation.family === "environment" &&
          operation.owner === "legacy" &&
          operation.needsControl
      );
  const environments = createLifecycleEnvironmentRegistrations({
    ...deps,
    identity: deps.authority,
    registry,
    actions,
    routing,
    hasLegacySetupInProgress
  });
  if (deps.environmentConfiguration)
    routing.transition("environment", {
      writer: "lifecycle",
      readers: ["legacy", "lifecycle"],
      controllers: ["legacy", "lifecycle"]
    });
  if (deps.deployment)
    routing.transition("deployment", {
      writer: "lifecycle",
      readers: ["legacy", "lifecycle"],
      controllers: ["legacy", "lifecycle"]
    });
  const controls = createLifecycleControlRegistrations({
    registry,
    clock: deps.clock,
    identity: deps.authority,
    routing,
    ...(definitions?.authoring ? { authoring: definitions.authoring } : {}),
    ...(deps.definitions?.authoring?.repairProvider ?
      { repairProvider: deps.definitions.authoring.repairProvider }
    : {}),
    ...(deps.deployment ? { workflow: deps.deployment.workflow } : {})
  });
  const discovery = createLifecycleDiscoveryRegistrations({
    ...deps,
    capabilities: [
      ...(graphs ? graphCapabilities : []),
      ...(definitions?.capabilities ?? []),
      ...deployment.capabilities,
      ...environments.capabilities,
      ...controls.capabilities
    ]
  });
  const service = createLifecycleService({
    validators: {
      validateRequest: (value) => getValidators().validateRequest(value),
      validateResponse: (value) => getValidators().validateResponse(value)
    },
    registrations: [
      ...discovery.registrations,
      ...(graphs?.registrations ?? []),
      ...(definitions?.registrations ?? []),
      ...deployment.registrations,
      ...environments.registrations,
      ...controls.registrations,
      registerLifecycleOperation(
        "operation.respond",
        { actions },
        ["actions"],
        async (request, context, ports) => {
          const result = await ports.actions.respond(
            context.scope,
            context.caller,
            request.input,
            context.control
          );
          if (result.status === "ok")
            await controls.afterResponse(
              result.value.operationId,
              context.control
            );
          return result.status === "ok" ?
              {
                apiVersion: LIFECYCLE_API_VERSION,
                requestId: request.requestId,
                operation: "operation.respond",
                result: result.value
              }
            : {
                apiVersion: LIFECYCLE_API_VERSION,
                requestId: request.requestId,
                error:
                  "error" in result ?
                    result.error
                  : lifecycleError("PRECONDITION_FAILED")
              };
        }
      )
    ]
  });
  async function resolveTarget(
    value: unknown,
    control: RequestControl
  ): Promise<PortResult<unknown>> {
    if (
      !record(value) ||
      typeof value.repo !== "string" ||
      typeof value.definition !== "string" ||
      value.source !== undefined
    )
      return portSuccess(value);
    const source = await deps.resolveWorkspaceSource(
      { repo: value.repo, definition: value.definition },
      control
    );
    return source.status === "ok" ?
        portSuccess({ ...value, source: source.value })
      : source;
  }
  async function executeRequest(intent: unknown): Promise<LifecycleResponse> {
    const requestId = deps.ids.next("request");
    const control: RequestControl = { requestId, cancellation: signal };
    const failure = (
      error: Parameters<typeof lifecycleError>[0] | LifecycleError
    ): LifecycleResponse => ({
      apiVersion: LIFECYCLE_API_VERSION,
      requestId,
      error:
        typeof error === "string" ?
          lifecycleError(error)
        : lifecycleError(error.code, { diagnostics: error.details })
    });
    if (closed) return failure("PRECONDITION_FAILED");
    if (
      !record(intent) ||
      Object.keys(intent).some(
        (key) => !["operation", "target", "input"].includes(key)
      )
    )
      return failure("INVALID_REQUEST");
    try {
      const caller = await authorization.resolveCaller(
        deps.hostBinding(),
        control
      );
      if (caller.status !== "ok")
        return {
          apiVersion: LIFECYCLE_API_VERSION,
          requestId,
          error:
            "error" in caller ?
              caller.error
            : lifecycleError("PRECONDITION_FAILED")
        };
      const target = await resolveTarget(intent.target, control);
      if (target.status !== "ok")
        return failure(
          "error" in target ? target.error : "PRECONDITION_FAILED"
        );
      let input = intent.input;
      if (intent.operation === "graph.diff" && record(input)) {
        const base = await resolveTarget(input.base, control);
        if (base.status !== "ok")
          return failure("error" in base ? base.error : "PRECONDITION_FAILED");
        const head = await resolveTarget(input.head, control);
        if (head.status !== "ok")
          return failure("error" in head ? head.error : "PRECONDITION_FAILED");
        input = { ...input, base: base.value, head: head.value };
      }
      return await service.execute(
        {
          ...intent,
          target: target.value,
          input,
          apiVersion: LIFECYCLE_API_VERSION,
          requestId
        },
        {
          caller: caller.value,
          control,
          authorize: (request: LifecycleRequest) =>
            authorization.authorize(caller.value, request, control)
        }
      );
    } catch {
      return failure("CAPABILITY_UNAVAILABLE");
    }
  }
  async function execute(intent: unknown): Promise<LifecycleResponse> {
    activeRequests++;
    try {
      return await executeRequest(intent);
    } finally {
      activeRequests--;
    }
  }
  return {
    execute,
    async resolveWorkspaceSource(
      target: Pick<Target, "repo" | "definition">
    ): Promise<PortResult<Source>> {
      if (closed) return portFailure("PRECONDITION_FAILED");
      activeRequests++;
      try {
        const result = await deps.resolveWorkspaceSource(target, {
          requestId: deps.ids.next("request"),
          cancellation: signal
        });
        return closed ? portFailure("PRECONDITION_FAILED") : result;
      } finally {
        activeRequests--;
      }
    },
    async resolveCommittedSource(
      repo: string,
      ref: string
    ): Promise<PortResult<Source>> {
      if (
        typeof repo !== "string" ||
        repo.length > repositorySchema.maxLength ||
        !new RegExp(repositorySchema.pattern).test(repo) ||
        typeof ref !== "string" ||
        ref.length > gitRefSchema.maxLength ||
        !new RegExp(gitRefSchema.pattern).test(ref)
      )
        return portFailure("INVALID_REQUEST");
      const control: RequestControl = {
        requestId: deps.ids.next("request"),
        cancellation: signal
      };
      if (closed) return portFailure("PRECONDITION_FAILED");
      if (!deps.resolveGitSource)
        return portUnavailable("CAPABILITY_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "source"
        });
      try {
        const caller = await authorization.resolveCaller(
          deps.hostBinding(),
          control
        );
        if (caller.status !== "ok") return caller;
        const scope = await deps.authority.authorize(
          {
            caller: caller.value,
            operation: "graph.diff",
            target: { repo }
          },
          control
        );
        if (scope.status !== "ok") return scope;
        if (
          scope.value.operation !== "graph.diff" ||
          scope.value.principalRef !== caller.value.principalRef ||
          scope.value.target.repo !== repo
        )
          return portFailure("PRECONDITION_FAILED");
        const result = await deps.resolveGitSource(scope.value, ref, control);
        return closed ? portFailure("PRECONDITION_FAILED") : result;
      } catch {
        return portUnavailable("SOURCE_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "source"
        });
      }
    },
    registry,
    actions,
    routing,
    capabilities: service.capabilities,
    hasLegacySetupInProgress,
    hasActiveOperations: () =>
      !closed && (activeRequests > 0 || registry.hasActiveOperations()),
    async close() {
      if (cleanup) return cleanup;
      if (!closed) {
        closed = true;
        controls.close();
        actions.close();
        graphs?.close();
      }
      cleanup = Promise.resolve()
        .then(async () => {
          for (const listener of listeners) {
            try {
              listener();
            } catch {
              /* A failed observer cannot prevent fencing the remaining work. */
            }
          }
          listeners.clear();
          // Authoring drains while its registry still exists. A failed owner
          // cannot prevent the remaining independent resources from closing.
          const results: PromiseSettledResult<unknown>[] =
            await Promise.allSettled([
              definitionsClosed ? undefined : (
                Promise.resolve(definitions?.close()).then(() => {
                  definitionsClosed = true;
                })
              )
            ]);
          results.push(
            ...(await Promise.allSettled([
              registryClosed ? undefined : (
                registry.close().then(() => {
                  registryClosed = true;
                })
              ),
              discoveryClosed ? undefined : (
                discovery.close().then(() => {
                  discoveryClosed = true;
                })
              )
            ]))
          );
          const failures = results.filter(
            (result) => result.status === "rejected"
          );
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              "Lifecycle cleanup failed."
            );
        })
        .catch((error) => {
          // Retry only incomplete local cleanup; never reopen or redispatch work.
          cleanup = undefined;
          throw error;
        });
      await cleanup;
    }
  };
}
export type LifecycleBinding = ReturnType<typeof createLifecycleBinding>;
