import {
  createOperationRecord,
  portSuccess,
  type ActionContinuation,
  type AuthorizationRequest,
  type AuthorizedScope,
  type CallerContext,
  type LifecycleOperation,
  type LifecyclePorts,
  type RequestControl,
  type Source
} from "@radius-project/core/lifecycle";
import { createLifecycleBinding } from "../../src/runtime/create-lifecycle-binding.js";
import type { KnownLifecycleOperation } from "../../src/runtime/lifecycle-routing.js";

type PortOverrides = {
  [Key in keyof LifecyclePorts]?: Partial<LifecyclePorts[Key]>;
};
export function createStrictLifecyclePorts(
  overrides: PortOverrides = {}
): LifecyclePorts {
  const unexpected = (name: string) => async (): Promise<never> => {
    throw new Error(`Unmodeled lifecycle port call: ${name}`);
  };
  return {
    source: {
      capture: unexpected("source.capture"),
      discoverDefinitions: unexpected("source.discoverDefinitions"),
      readText: unexpected("source.readText"),
      readBytes: unexpected("source.readBytes"),
      prepareStaging: unexpected("source.prepareStaging"),
      inspectStagedOutputs: unexpected("source.inspectStagedOutputs"),
      promote: unexpected("source.promote"),
      releaseSnapshot: unexpected("source.releaseSnapshot"),
      releaseStaging: unexpected("source.releaseStaging"),
      ...overrides.source
    },
    graph: {
      compile: unexpected("graph.compile"),
      observeDeployed: unexpected("graph.observeDeployed"),
      ...overrides.graph
    },
    environment: {
      list: unexpected("environment.list"),
      inspect: unexpected("environment.inspect"),
      listApplications: unexpected("environment.listApplications"),
      registrations: unexpected("environment.registrations"),
      configure: unexpected("environment.configure"),
      planDeletion: unexpected("environment.planDeletion"),
      executeDeletionPhase: unexpected("environment.executeDeletionPhase"),
      ...overrides.environment
    },
    identity: {
      resolveCaller: unexpected("identity.resolveCaller"),
      authorize: unexpected("identity.authorize"),
      authorizeResponse: unexpected("identity.authorizeResponse"),
      inspect: unexpected("identity.inspect"),
      configure: unexpected("identity.configure"),
      ...overrides.identity
    },
    workflow: {
      prepare: unexpected("workflow.prepare"),
      dispatch: unexpected("workflow.dispatch"),
      reconcile: unexpected("workflow.reconcile"),
      observe: unexpected("workflow.observe"),
      cancel: unexpected("workflow.cancel"),
      ...overrides.workflow
    },
    agent: {
      assign: unexpected("agent.assign"),
      authenticateOutcome: unexpected("agent.authenticateOutcome"),
      cancel: unexpected("agent.cancel"),
      ...overrides.agent
    },
    registry: {
      create: unexpected("registry.create"),
      get: unexpected("registry.get"),
      list: unexpected("registry.list"),
      compareAndSwap: unexpected("registry.compareAndSwap"),
      close: unexpected("registry.close"),
      ...overrides.registry
    },
    clock: {
      now: () => {
        throw new Error("Unmodeled lifecycle port call: clock.now");
      },
      wait: unexpected("clock.wait"),
      ...overrides.clock
    },
    ids: {
      next: () => {
        throw new Error("Unmodeled lifecycle port call: ids.next");
      },
      ...overrides.ids
    },
    diagnostics: {
      collect: unexpected("diagnostics.collect"),
      record: unexpected("diagnostics.record"),
      ...overrides.diagnostics
    }
  };
}

export function authorizeFixture<O extends LifecycleOperation>(
  request: AuthorizationRequest<O>
): AuthorizedScope<O> {
  const scope: AuthorizedScope = {
    ...request,
    authorizationRef: "fixture-authorization",
    principalRef: request.caller.principalRef
  };
  return scope as AuthorizedScope<O>;
}

export function createLifecycleFixture(
  options: {
    caller?: CallerContext;
    knownLegacyOperations?: () => readonly KnownLifecycleOperation[];
    overrides?: PortOverrides;
  } = {}
) {
  let sequence = 0;
  let sourceResolutions = 0;
  const caller: CallerContext = options.caller ?? {
    principalRef: "fixture-principal",
    sessionRef: "fixture-session",
    identityRef: "fixture-identity",
    responder: "user"
  };
  const source: Source = {
    kind: "workspace",
    workspaceRef: "fixture-workspace",
    branch: "feature",
    expectedFingerprint: `sha256:${"a".repeat(64)}`
  };
  const ports = createStrictLifecyclePorts({
    ...options.overrides,
    identity: {
      resolveCaller: async (binding) => {
        if (binding.sessionRef !== caller.sessionRef)
          throw new Error("Unexpected session binding");
        return portSuccess(caller);
      },
      authorize: async (request) => portSuccess(authorizeFixture(request)),
      authorizeResponse: async (responder, action) =>
        portSuccess({
          authorizationRef: "fixture-response",
          principalRef: responder.principalRef,
          operation: "operation.respond",
          operationId: action.operationId,
          target: action.target,
          ...(action.source ? { source: action.source } : {})
        }),
      ...options.overrides?.identity
    },
    ids: { next: (kind) => `${kind}-${++sequence}`, ...options.overrides?.ids },
    clock: { now: () => "2026-09-15T00:00:00Z", ...options.overrides?.clock }
  });
  const binding = createLifecycleBinding({
    authority: ports.identity,
    ids: ports.ids,
    clock: ports.clock,
    hostBinding: () => ({
      bindingRef: "fixture-binding",
      sessionRef: caller.sessionRef
    }),
    resolveWorkspaceSource: async () => {
      sourceResolutions++;
      return portSuccess(source);
    },
    knownLegacyOperations: options.knownLegacyOperations ?? (() => [])
  });
  async function pendingAction(continuation?: ActionContinuation) {
    let continuations = 0;
    const target = { repo: "owner/repo", environment: "dev" };
    const control: RequestControl = {
      requestId: ports.ids.next("request"),
      cancellation: { aborted: false, onAbort: () => () => {} }
    };
    const owner = authorizeFixture({
      caller,
      operation: "environment.create",
      target
    });
    const operation = createOperationRecord(ports, {
      operation: "environment.create",
      target
    });
    const created = await binding.registry.create(owner, operation, control);
    if (created.status !== "ok")
      throw new Error("Fixture operation creation failed");
    const pending = await binding.actions.create(
      owner,
      created.value,
      {
        kind: "user.decision",
        responder: "user",
        message: "Approve the environment",
        response: {
          kind: "user.decision",
          choices: ["approve"],
          permittedInput: []
        }
      },
      caller,
      continuation ?? {
        revalidate: async () => portSuccess(undefined),
        continue: async () => {
          continuations++;
          return portSuccess({
            kind: "started",
            observation: operation.observation
          });
        }
      },
      control
    );
    if (pending.status !== "ok")
      throw new Error("Fixture action creation failed");
    return {
      operationId: operation.operationId,
      intent: {
        operation: "operation.respond",
        target,
        input: {
          operationId: operation.operationId,
          actionId: pending.value.operation.actions[0].actionId,
          response: { kind: "user.decision", choice: "approve" }
        }
      },
      continuations: () => continuations
    };
  }
  return {
    binding,
    ports,
    caller,
    source,
    pendingAction,
    sourceResolutions: () => sourceResolutions
  };
}
