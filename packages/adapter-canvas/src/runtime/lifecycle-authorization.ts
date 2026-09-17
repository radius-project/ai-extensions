import {
  portCancelled,
  portForbidden,
  portSuccess,
  portUnavailable,
  verifySourceExpectation,
  sameLifecycleData,
  type AuthorizationRequest,
  type AuthorizedScope,
  type CallerContext,
  type HostCallerBinding,
  type IdentityPort,
  type LifecycleRequest,
  type PortResult,
  type ReadonlyData,
  type RequestControl,
  type SourceSnapshot,
  type LifecycleOperation,
  type Target
} from "@radius-project/core/lifecycle";
import { readObject } from "@radius-project/adapter-shared";
import { createDiscoveryGitHubRead } from "./discovery-github-read.js";
import type { CanvasDiscoveryDependencies } from "./create-discovery-context.js";

export type LifecycleAuthority = Pick<
  IdentityPort,
  "resolveCaller" | "authorize" | "authorizeResponse"
>;

export function unavailableCanvasLifecyclePrerequisite() {
  const limitation =
    "The host does not provide verified user approval or external agent assignment authority.";
  return portUnavailable(
    "CAPABILITY_UNAVAILABLE",
    {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "session",
      limitation
    },
    { diagnostics: [{ message: limitation, truncated: false }] }
  );
}

function unavailable() {
  return portUnavailable("CAPABILITY_UNAVAILABLE", {
    quality: "unknown",
    completeness: "unavailable",
    evidence: "session"
  });
}

export function createCanvasLifecycleAuthority(deps: {
  binding(): HostCallerBinding;
  identity(): Promise<{ actingLogin: string }>;
  workspace(): Promise<{ repo: string }>;
  responseAuthority: LifecycleAuthority["authorizeResponse"];
  executor?: CanvasDiscoveryDependencies["executor"];
}): LifecycleAuthority {
  if (
    typeof deps?.binding !== "function" ||
    typeof deps.identity !== "function" ||
    typeof deps.workspace !== "function" ||
    typeof deps.responseAuthority !== "function"
  )
    throw new Error(
      "Canvas authority requires identity, host binding, workspace and response verification."
    );
  async function resolveCaller(
    binding: HostCallerBinding,
    control: RequestControl
  ): Promise<PortResult<CallerContext>> {
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const trusted = deps.binding();
    if (
      binding.bindingRef !== trusted.bindingRef ||
      binding.sessionRef !== trusted.sessionRef
    )
      return portForbidden();
    const identity = await deps.identity();
    if (!identity.actingLogin) return unavailable();
    return portSuccess({
      principalRef: `github:${identity.actingLogin}`,
      identityRef: `github:${identity.actingLogin}`,
      sessionRef: trusted.sessionRef,
      responder: "agent",
      agentBindingRef: trusted.bindingRef
    });
  }
  return {
    resolveCaller,
    async authorize<O extends LifecycleOperation>(
      input: AuthorizationRequest<O>,
      control: RequestControl
    ) {
      const current = await resolveCaller(deps.binding(), control);
      if (current.status !== "ok") return current;
      if (
        current.value.principalRef !== input.caller.principalRef ||
        current.value.sessionRef !== input.caller.sessionRef ||
        current.value.identityRef !== input.caller.identityRef ||
        current.value.agentBindingRef !== input.caller.agentBindingRef ||
        input.caller.responder !== "agent"
      )
        return portForbidden();
      if (
        ![
          "operation.respond",
          "capabilities.get",
          "application.list",
          "application.inspect",
          "environment.list",
          "environment.inspect",
          "graph.get",
          "graph.diff",
          "definition.validate"
        ].includes(input.operation)
      )
        return unavailable();
      const workspace = await deps.workspace();
      const graphRead =
        input.operation === "graph.get" ||
        input.operation === "graph.diff" ||
        input.operation === "definition.validate";
      if (!graphRead || !deps.executor) {
        if (
          !workspace.repo ||
          workspace.repo.toLowerCase() !== input.target.repo.toLowerCase()
        )
          return portForbidden();
      }
      const scope: AuthorizedScope = {
        ...input,
        authorizationRef: deps.binding().bindingRef,
        principalRef: current.value.principalRef
      };
      if (graphRead && deps.executor) {
        const get = createDiscoveryGitHubRead({
          executor: deps.executor,
          verify: async () => {
            const latest = await resolveCaller(deps.binding(), control);
            return (
                latest.status === "ok" &&
                  sameLifecycleData(latest.value, current.value)
              ) ?
                portSuccess(undefined)
              : portForbidden();
          }
        });
        const repository = await get(
          `/repos/${input.target.repo}`,
          control,
          scope
        );
        if (repository.status !== "ok") return repository;
        if (
          !readObject(repository.value) ||
          typeof repository.value.full_name !== "string" ||
          repository.value.full_name.toLowerCase() !==
            input.target.repo.toLowerCase()
        )
          return portForbidden();
      }
      return portSuccess(scope as AuthorizedScope<O>);
    },
    authorizeResponse: deps.responseAuthority
  };
}

function sameTarget(left: ReadonlyData<Target>, right: ReadonlyData<Target>) {
  return (
    left.repo.toLowerCase() === right.repo.toLowerCase() &&
    left.environment === right.environment &&
    left.application === right.application &&
    left.definition === right.definition &&
    sameLifecycleData(left.source, right.source)
  );
}

export function createLifecycleAuthorization(authority: LifecycleAuthority) {
  if (
    typeof authority?.resolveCaller !== "function" ||
    typeof authority.authorize !== "function" ||
    typeof authority.authorizeResponse !== "function"
  ) {
    throw new Error(
      "Lifecycle requires trusted caller and approval authority."
    );
  }

  async function resolveCaller(
    binding: HostCallerBinding,
    control: RequestControl
  ): Promise<PortResult<CallerContext>> {
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    try {
      const result = await authority.resolveCaller(binding, control);
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      if (result.status !== "ok") return result;
      if (
        result.value.sessionRef !== binding.sessionRef ||
        !result.value.principalRef ||
        !result.value.identityRef
      ) {
        return portForbidden();
      }
      return result;
    } catch {
      return unavailable();
    }
  }

  async function authorize(
    caller: CallerContext,
    request: LifecycleRequest,
    control: RequestControl,
    snapshot?: SourceSnapshot
  ): Promise<PortResult<AuthorizedScope>> {
    const source = snapshot?.provenance;
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    if ("source" in request.target && source && snapshot) {
      const match = verifySourceExpectation(
        request.target,
        source,
        snapshot.manifest,
        control.cancellation
      );
      if (match.status !== "ok") return match;
    }
    // The validated request already correlates operation and target. Authority
    // is always the separately resolved caller, never an input-envelope field.
    const input = {
      caller,
      operation: request.operation,
      target: request.target,
      ...("operationId" in request.input ?
        { operationId: request.input.operationId }
      : {}),
      ...(source ? { source } : {})
    } as AuthorizationRequest;
    try {
      const result = await authority.authorize(input, control);
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      if (result.status !== "ok") return result;
      const scope = result.value;
      if (
        !scope.authorizationRef ||
        scope.principalRef !== caller.principalRef ||
        scope.operation !== request.operation ||
        !sameTarget(scope.target, request.target) ||
        scope.operationId !== input.operationId ||
        !sameLifecycleData(scope.source, source)
      ) {
        return portForbidden();
      }
      return portSuccess(scope);
    } catch {
      return unavailable();
    }
  }

  async function authorizeDiff(
    caller: CallerContext,
    request: Extract<LifecycleRequest, { operation: "graph.diff" }>,
    control: RequestControl
  ) {
    const scopes: AuthorizedScope[] = [];
    for (const target of [request.input.base, request.input.head]) {
      const result = await authorize(caller, { ...request, target }, control);
      if (result.status !== "ok") return result;
      scopes.push(result.value);
    }
    return portSuccess(scopes);
  }

  return { resolveCaller, authorize, authorizeDiff, authority };
}
