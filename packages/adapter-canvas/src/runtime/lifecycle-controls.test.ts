import { expect, it, vi } from "vitest";
import {
  createOperationRecord,
  createSessionOperationRegistry,
  portSuccess,
  portUnavailable,
  portCancelled,
  type AuthorizedScope,
  type RequestControl
} from "@radius-project/core/lifecycle";
import { createLifecycleControlRegistrations } from "./lifecycle-controls.js";
import { createLifecycleRouting } from "./lifecycle-routing.js";
import { authorizeFixture } from "../../test/support/lifecycle.js";

async function fixture(
  mode:
    | "queued"
    | "running"
    | "failed"
    | "missing-source"
    | "provider-unavailable" = "queued"
) {
  let id = 0;
  const ids = { next: () => `id-${++id}` };
  const clock = { now: () => "2026-09-17T19:00:00Z" };
  const registry = createSessionOperationRegistry({ ids, clock });
  const routing = createLifecycleRouting({ knownOperations: () => [] });
  routing.transition("definition", {
    writer: "lifecycle",
    readers: ["legacy", "lifecycle"],
    controllers: ["legacy", "lifecycle"]
  });
  const source = {
    kind: "workspace" as const,
    workspaceRef: "workspace",
    branch: "feature",
    expectedFingerprint: `sha256:${"a".repeat(64)}`
  };
  const target = {
    repo: "owner/repo",
    definition: ".radius/app.bicep",
    source
  };
  const scope: AuthorizedScope<"operation.repair"> = {
    operation: "operation.repair",
    target: { repo: target.repo },
    principalRef: "principal",
    authorizationRef: "authority",
    approvalRef: "approval"
  };
  const caller = {
    principalRef: "principal",
    identityRef: "identity",
    sessionRef: "session",
    responder: "user" as const,
    agentBindingRef: "agent",
    approvedHostActionRef: "approval"
  };
  const control: RequestControl = {
    requestId: "request",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  const original = createOperationRecord(
    { ids, clock },
    { operation: "definition.author", target }
  );
  const created = await registry.create(
    { ...scope, operation: "definition.author", target },
    original,
    control
  );
  if (created.status !== "ok") throw new Error(JSON.stringify(created));
  expect(
    await registry.compareAndSwap(
      scope,
      {
        operationId: original.operationId,
        expectedRevision: created.value.revision,
        replacement: {
          ...original,
          state: "failed",
          error: {
            code: "VALIDATION_FAILED",
            message: "Invalid definition.",
            retryable: false
          }
        }
      },
      control
    )
  ).toMatchObject({ status: "ok" });
  type Deps = Parameters<typeof createLifecycleControlRegistrations>[0];
  const identity: Deps["identity"] = {
    authorize: async (request) => portSuccess(authorizeFixture(request))
  };
  const authoring: NonNullable<Deps["authoring"]> = {
    repair: vi.fn(async () =>
      portSuccess({
        ...createOperationRecord(
          { ids, clock },
          {
            operation: "operation.repair",
            target,
            ...(mode === "missing-source" ?
              {}
            : {
                source: {
                  kind: "workspace" as const,
                  repo: target.repo,
                  workspaceRef: "workspace",
                  branch: "feature",
                  fingerprint: source.expectedFingerprint,
                  resolvedAt: clock.now()
                }
              })
          }
        ),
        state:
          mode === "failed" ? ("failed" as const)
          : mode === "running" ? ("running" as const)
          : ("queued" as const)
      })
    ),
    cancel: vi.fn(async () => {
      throw new Error("Unmodeled local cancellation");
    })
  };
  const repairProvider: NonNullable<Deps["repairProvider"]> = async () =>
    mode === "provider-unavailable" ?
      portUnavailable("CAPABILITY_UNAVAILABLE", {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "session"
      })
    : portSuccess("azure");
  const deps = {
    registry,
    clock,
    identity,
    routing,
    authoring,
    repairProvider
  };
  const registrations = createLifecycleControlRegistrations(deps);
  const request = {
    apiVersion: "github-radius/v1" as const,
    requestId: "request",
    operation: "operation.repair" as const,
    target: { repo: target.repo },
    input: {
      operationId: original.operationId,
      source,
      repairPolicy: { mode: "manual" as const, maxAttempts: 5 }
    }
  };
  return { deps, registrations, request, scope, caller, control };
}

it.each([
  "queued",
  "running",
  "failed",
  "missing-source",
  "provider-unavailable"
] as const)(
  "maps %s executor evidence without claiming unsupported completion",
  async (mode) => {
    const f = await fixture(mode);
    const registration = f.registrations.registrations.find(
      (item) => item.operation === "operation.repair"
    );
    if (!registration) throw new Error("Missing repair registration");
    const result = await registration.execute(f.request, {
      scope: f.scope,
      caller: f.caller,
      control: f.control
    });
    expect(result).toMatchObject(
      mode === "queued" || mode === "running" ?
        { result: { state: mode } }
      : {
          error: {
            code:
              mode === "provider-unavailable" ?
                "CAPABILITY_UNAVAILABLE"
              : "EVIDENCE_MISMATCH"
          }
        }
    );
  }
);
it("does not advertise or emulate unavailable controllers", async () => {
  const f = await fixture();
  const { authoring: _authoring, repairProvider: _provider, ...deps } = f.deps;
  const registrations = createLifecycleControlRegistrations(deps);
  expect(registrations.capabilities).toEqual([]);
  expect(registrations.registrations).toEqual([]);
});
it("respects rollback to the legacy definition writer without a second mutation", async () => {
  const f = await fixture();
  f.deps.routing.transition("definition", {
    writer: "legacy",
    readers: ["legacy", "lifecycle"],
    controllers: ["legacy", "lifecycle"]
  });
  const repair = f.registrations.registrations.find(
    (item) => item.operation === "operation.repair"
  );
  if (!repair) throw new Error("Missing repair registration");
  expect(
    await repair.execute(f.request, {
      scope: f.scope,
      caller: f.caller,
      control: f.control
    })
  ).toMatchObject({ error: { code: "CAPABILITY_UNAVAILABLE" } });
  expect(f.deps.authoring.repair).not.toHaveBeenCalled();
});
it("keeps cancellation failures as explicit responses", async () => {
  const f = await fixture();
  const cancel = f.registrations.registrations.find(
    (item) => item.operation === "operation.cancel"
  );
  if (!cancel) throw new Error("Missing cancel registration");
  await f.deps.registry.close();
  expect(
    await cancel.execute(
      {
        ...f.request,
        operation: "operation.cancel",
        input: { operationId: f.request.input.operationId }
      },
      {
        scope: { ...f.scope, operation: "operation.cancel" },
        caller: f.caller,
        control: f.control
      }
    )
  ).toMatchObject({ error: { code: "PRECONDITION_FAILED" } });
});
it("propagates cancelled provider resolution without a fake repair", async () => {
  const f = await fixture();
  const registrations = createLifecycleControlRegistrations({
    ...f.deps,
    repairProvider: async () => portCancelled("request_cancelled")
  });
  const repair = registrations.registrations.find(
    (item) => item.operation === "operation.repair"
  );
  if (!repair) throw new Error("Missing repair registration");
  expect(
    await repair.execute(f.request, {
      scope: f.scope,
      caller: f.caller,
      control: f.control
    })
  ).toMatchObject({ error: { code: "PRECONDITION_FAILED" } });
  expect(f.deps.authoring.repair).not.toHaveBeenCalled();
});
