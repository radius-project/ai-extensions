import { expect, it, vi } from "vitest";
import type {
  AuthorizedScope,
  CallerContext,
  GraphCompilation,
  RequestControl,
  SourceSelection,
  SourceSnapshot
} from "./ports.js";
import {
  portAbsent,
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable
} from "./errors.js";
import {
  createLifecycleGraphs,
  type LifecycleGraphDependencies
} from "./graphs.js";

const time = "2026-09-15T22:00:00Z";
const fingerprint = `sha256:${"a".repeat(64)}`;
const caller: CallerContext = {
  principalRef: "reader",
  sessionRef: "session",
  identityRef: "identity",
  responder: "agent"
};
const control: RequestControl = {
  requestId: "request",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
const base: SourceSelection = {
  repo: "owner/repo",
  source: { kind: "git", ref: "main", expectedCommit: "a".repeat(40) },
  definition: ".radius/app.bicep"
};
const head: SourceSelection = {
  repo: "fork/repo",
  source: { kind: "git", ref: "feature", expectedCommit: "b".repeat(40) },
  definition: "app.bicep"
};
const authoredScope: AuthorizedScope<"graph.get"> = {
  authorizationRef: "authorization",
  principalRef: caller.principalRef,
  operation: "graph.get",
  target: base
};
const diffScope: AuthorizedScope<"graph.diff"> = {
  ...authoredScope,
  operation: "graph.diff",
  target: { repo: head.repo }
};
function snapshot(selection: SourceSelection): SourceSnapshot {
  if (selection.source.kind !== "git")
    throw new Error("Only committed fixture sources are modeled");
  return {
    snapshotRef: `snapshot-${selection.repo}`,
    selection,
    provenance: {
      kind: "git",
      repo: selection.repo,
      ref: selection.source.ref,
      commit: selection.source.expectedCommit ?? "c".repeat(40),
      fingerprint,
      resolvedAt: time
    },
    manifest: {
      completeness: "complete",
      definition: selection.definition,
      fingerprint,
      inputs: [
        {
          path: selection.definition,
          kind: "definition",
          existed: true,
          contentHash: fingerprint
        }
      ]
    }
  };
}
function fixture() {
  const capture = vi.fn<LifecycleGraphDependencies["source"]["capture"]>(
    async (_scope, selection) =>
      portSuccess({ status: "captured", snapshot: snapshot(selection) })
  );
  const releaseSnapshot = vi.fn<
    LifecycleGraphDependencies["source"]["releaseSnapshot"]
  >(async () => portSuccess({ status: "released" }));
  const compile = vi.fn<LifecycleGraphDependencies["graph"]["compile"]>(
    async () => portSuccess({ graph: { resources: [] }, diagnostics: [] })
  );
  const observeDeployed = vi.fn<
    LifecycleGraphDependencies["graph"]["observeDeployed"]
  >(async () => {
    throw new Error("Unmodeled deployed observation");
  });
  const registrations = vi.fn<
    LifecycleGraphDependencies["environment"]["registrations"]
  >(async () => {
    throw new Error("Authored reads must not request recipes");
  });
  const authorize = vi.fn<LifecycleGraphDependencies["identity"]["authorize"]>(
    async (request) =>
      portSuccess({
        operation: request.operation,
        target: request.target,
        principalRef: request.caller.principalRef,
        authorizationRef: `scope-${request.target.repo}`
      })
  );
  const dependencies = {
    source: { capture, releaseSnapshot },
    graph: { compile, observeDeployed },
    environment: { registrations },
    identity: { authorize },
    clock: { now: () => time }
  } satisfies LifecycleGraphDependencies;
  return {
    ...dependencies,
    service: createLifecycleGraphs(dependencies)
  };
}

it("reads an authored graph without environment evidence and releases its owned snapshot", async () => {
  const f = fixture();
  const result = await f.service.get(
    authoredScope,
    { kind: "authored" },
    control
  );
  expect(result).toMatchObject({
    status: "ok",
    value: {
      kind: "authored",
      target: base,
      provenance: snapshot(base).provenance,
      graph: { resources: [] },
      observation: { quality: "current", completeness: "complete" }
    }
  });
  expect(f.graph.compile).toHaveBeenCalledWith(
    { kind: "authored", snapshot: snapshot(base) },
    control
  );
  expect(f.environment.registrations).not.toHaveBeenCalled();
  expect(f.graph.observeDeployed).not.toHaveBeenCalled();
  expect(f.source.releaseSnapshot).toHaveBeenCalledExactlyOnceWith(
    snapshot(base)
  );
});

it("authorizes and captures diff sides independently, retaining exact repository/ref/commit provenance", async () => {
  const f = fixture();
  const result = await f.service.diff(
    diffScope,
    { kind: "authored", base, head },
    caller,
    control
  );
  expect(result).toMatchObject({
    status: "ok",
    value: {
      status: "available",
      kind: "authored",
      base: snapshot(base).provenance,
      head: snapshot(head).provenance,
      baseTarget: base,
      headTarget: head,
      graph: { resources: [] }
    }
  });
  expect(f.identity.authorize.mock.calls.map(([request]) => request)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        operation: "graph.diff",
        caller,
        target: base
      }),
      expect.objectContaining({ operation: "graph.diff", caller, target: head })
    ])
  );
  expect(f.source.capture.mock.calls.map(([, selection]) => selection)).toEqual(
    expect.arrayContaining([base, head])
  );
  expect(f.source.releaseSnapshot).toHaveBeenCalledTimes(2);
});

it.each([
  [
    portAbsent({
      quality: "current",
      completeness: "complete",
      evidence: "source",
      observedAt: time
    }),
    "DEFINITION_NOT_FOUND"
  ],
  [
    portUnavailable("SOURCE_UNAVAILABLE", {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "source"
    }),
    "SOURCE_UNAVAILABLE"
  ],
  [portFailure("SOURCE_CHANGED"), "SOURCE_CHANGED"],
  [portForbidden(), "FORBIDDEN"]
])(
  "does not turn a missing or unreadable base into an empty diff",
  async (failure, reason) => {
    const f = fixture();
    f.source.capture.mockImplementation(async (_scope, selection) =>
      selection.repo === base.repo ?
        failure
      : portSuccess({ status: "captured", snapshot: snapshot(selection) })
    );
    expect(
      await f.service.diff(
        diffScope,
        { kind: "authored", base, head },
        caller,
        control
      )
    ).toMatchObject({
      status: "ok",
      value: { status: "unavailable", source: "base", reason }
    });
  }
);

it("does not compile incomplete captures or pretend unavailable recipes are empty registrations", async () => {
  const f = fixture();
  f.source.capture.mockResolvedValueOnce(
    portSuccess({
      status: "incomplete",
      manifest: {
        completeness: "incomplete",
        definition: base.definition,
        inputs: [],
        diagnostics: [{ message: "Dynamic input path.", truncated: false }]
      }
    })
  );
  expect(
    await f.service.get(authoredScope, { kind: "authored" }, control)
  ).toMatchObject({ status: "unavailable" });
  expect(f.graph.compile).not.toHaveBeenCalled();
  expect(f.source.releaseSnapshot).not.toHaveBeenCalled();
  f.environment.registrations.mockResolvedValueOnce(
    portUnavailable("RESULT_UNAVAILABLE", {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "radius",
      limitation: "Actual registrations are unavailable."
    })
  );
  expect(
    await f.service.get(
      { ...authoredScope, target: { ...base, environment: "test" } },
      { kind: "planned" },
      control
    )
  ).toMatchObject({
    status: "unavailable",
    error: { code: "RESULT_UNAVAILABLE" }
  });
  expect(f.graph.compile).not.toHaveBeenCalled();
});

it("keeps deployed observation separate from authored compilation", async () => {
  const f = fixture();
  const target = {
    repo: "owner/repo",
    environment: "test",
    application: "app"
  };
  f.graph.observeDeployed.mockResolvedValueOnce(
    portSuccess({
      kind: "deployed",
      target,
      graph: { resources: [] },
      observation: {
        quality: "stale",
        completeness: "partial",
        evidence: "radius",
        observedAt: time,
        limitation: "Last observed deployment."
      }
    })
  );
  expect(
    await f.service.get(
      { ...authoredScope, target },
      { kind: "deployed" },
      control
    )
  ).toMatchObject({
    status: "ok",
    value: { kind: "deployed", observation: { quality: "stale" } }
  });
  expect(f.source.capture).not.toHaveBeenCalled();
  expect(f.graph.compile).not.toHaveBeenCalled();
});

it("fences a late compiler result after cancellation and still releases its snapshot", async () => {
  const f = fixture();
  let aborted = false;
  const cancelled: RequestControl = {
    ...control,
    cancellation: {
      get aborted() {
        return aborted;
      },
      onAbort: () => () => {}
    }
  };
  f.graph.compile.mockImplementationOnce(async () => {
    aborted = true;
    return portSuccess({ graph: { resources: [] }, diagnostics: [] });
  });
  expect(
    await f.service.get(authoredScope, { kind: "authored" }, cancelled)
  ).toEqual({ status: "cancelled", reason: "request_cancelled" });
  expect(f.source.releaseSnapshot).toHaveBeenCalledOnce();
});

it("fails construction instead of installing missing graph dependencies", () => {
  expect(() =>
    Reflect.apply(createLifecycleGraphs, undefined, [undefined])
  ).toThrow("complete source");
  const f = fixture();
  for (const dependency of [
    "source",
    "graph",
    "environment",
    "identity",
    "clock"
  ]) {
    expect(() =>
      Reflect.apply(createLifecycleGraphs, undefined, [
        { ...f, [dependency]: {} }
      ])
    ).toThrow("complete source");
  }
});

it("refuses malformed or non-source authored targets before capture", async () => {
  const f = fixture();
  for (const target of [
    { ...base, definition: "../app.bicep" },
    { repo: base.repo, environment: "test", application: "app" }
  ]) {
    expect(
      await f.service.get(
        { ...authoredScope, target },
        { kind: "authored" },
        control
      )
    ).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
  }
  expect(f.source.capture).not.toHaveBeenCalled();
});

it("refuses an authored selection used as a deployed request", async () => {
  const f = fixture();
  expect(
    await f.service.get(authoredScope, { kind: "deployed" }, control)
  ).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
  expect(f.graph.observeDeployed).not.toHaveBeenCalled();
});

it("rechecks snapshot selection, provenance and any pre-authorized source binding", async () => {
  const f = fixture();
  f.source.capture.mockResolvedValueOnce(
    portSuccess({ status: "captured", snapshot: snapshot(head) })
  );
  expect(
    await f.service.get(authoredScope, { kind: "authored" }, control)
  ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  const changed = snapshot(base);
  f.source.capture.mockResolvedValueOnce(
    portSuccess({
      status: "captured",
      snapshot: {
        ...changed,
        provenance: {
          ...snapshot(head).provenance,
          repo: base.repo,
          ref: "main"
        }
      }
    })
  );
  expect(
    await f.service.get(authoredScope, { kind: "authored" }, control)
  ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
  expect(
    await f.service.get(
      { ...authoredScope, source: snapshot(head).provenance },
      { kind: "authored" },
      control
    )
  ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  expect(
    await f.service.get(
      { ...authoredScope, source: snapshot(base).provenance },
      { kind: "authored" },
      control
    )
  ).toMatchObject({ status: "ok" });
  expect(f.source.releaseSnapshot).toHaveBeenCalledTimes(4);
  expect(f.graph.compile).toHaveBeenCalledOnce();
});

it("releases failed compilations and reports cleanup failures instead of returning success", async () => {
  const f = fixture();
  f.graph.compile.mockResolvedValueOnce(portFailure("VALIDATION_FAILED"));
  expect(
    await f.service.get(authoredScope, { kind: "authored" }, control)
  ).toMatchObject({ status: "failed", error: { code: "VALIDATION_FAILED" } });
  f.graph.compile.mockRejectedValueOnce(
    new Error("Unexpected adapter exception.")
  );
  expect(
    await f.service.get(authoredScope, { kind: "authored" }, control)
  ).toMatchObject({
    status: "unavailable",
    error: {
      code: "RESULT_UNAVAILABLE",
      details: [
        {
          message: "The graph adapter failed while reading captured inputs.",
          truncated: false
        }
      ]
    }
  });
  f.source.releaseSnapshot.mockResolvedValueOnce(
    portFailure("PRECONDITION_FAILED")
  );
  expect(
    await f.service.get(authoredScope, { kind: "authored" }, control)
  ).toMatchObject({ status: "failed", error: { code: "PRECONDITION_FAILED" } });
  expect(f.source.releaseSnapshot).toHaveBeenCalledTimes(3);
});

it("fences close before reads, after capture, and after compiler completion without abandoning snapshots", async () => {
  const f = fixture();
  f.source.capture.mockImplementationOnce(async () => {
    f.service.close();
    return portSuccess({ status: "captured", snapshot: snapshot(base) });
  });
  expect(
    await f.service.get(authoredScope, { kind: "authored" }, control)
  ).toEqual({ status: "cancelled", reason: "request_cancelled" });
  expect(f.graph.compile).not.toHaveBeenCalled();
  expect(f.source.releaseSnapshot).toHaveBeenCalledOnce();
  expect(
    await f.service.get(authoredScope, { kind: "authored" }, control)
  ).toEqual({ status: "cancelled", reason: "request_cancelled" });
  expect(
    await f.service.diff(
      diffScope,
      { kind: "authored", base, head },
      caller,
      control
    )
  ).toEqual({ status: "cancelled", reason: "request_cancelled" });
  const active = fixture();
  active.graph.compile.mockImplementationOnce(async () => {
    active.service.close();
    return portSuccess({ graph: { resources: [] }, diagnostics: [] });
  });
  expect(
    await active.service.diff(
      diffScope,
      { kind: "authored", base, head },
      caller,
      control
    )
  ).toEqual({ status: "cancelled", reason: "request_cancelled" });
  expect(active.identity.authorize).toHaveBeenCalledOnce();
  expect(active.source.releaseSnapshot).toHaveBeenCalledOnce();
});

it("does not authorize diff work for another principal or unrelated outer repository", async () => {
  const f = fixture();
  for (const scope of [
    { ...diffScope, principalRef: "other" },
    { ...diffScope, target: { repo: "other/repository" } },
    { ...diffScope, target: { repo: base.repo } }
  ]) {
    expect(
      await f.service.diff(
        scope,
        { kind: "authored", base, head },
        caller,
        control
      )
    ).toMatchObject({ status: "forbidden" });
  }
  expect(f.identity.authorize).not.toHaveBeenCalled();
});

it("rejects mismatched per-side authority and identifies the head-only refusal", async () => {
  const f = fixture();
  f.identity.authorize.mockImplementation(async (request) =>
    portSuccess({
      operation: request.operation,
      authorizationRef: "authorization",
      principalRef:
        request.target.repo === head.repo ? "other" : caller.principalRef,
      target: request.target
    })
  );
  expect(
    await f.service.diff(
      diffScope,
      { kind: "authored", base, head },
      caller,
      control
    )
  ).toMatchObject({
    status: "ok",
    value: { status: "unavailable", source: "head", reason: "FORBIDDEN" }
  });
  expect(f.source.capture).toHaveBeenCalledOnce();
  f.identity.authorize.mockImplementation(async (request) =>
    portSuccess({
      operation: request.operation,
      authorizationRef: "authorization",
      principalRef: caller.principalRef,
      target: { repo: request.target.repo }
    })
  );
  expect(
    await f.service.diff(
      diffScope,
      { kind: "authored", base, head },
      caller,
      control
    )
  ).toMatchObject({
    status: "ok",
    value: { status: "unavailable", source: "both", reason: "FORBIDDEN" }
  });
});

it("retains capability limitations and prioritizes a forbidden side over missing evidence", async () => {
  const f = fixture();
  f.identity.authorize.mockResolvedValueOnce(
    portUnavailable("CAPABILITY_UNAVAILABLE", {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "session"
    })
  );
  expect(
    await f.service.diff(
      diffScope,
      { kind: "authored", base, head },
      caller,
      control
    )
  ).toMatchObject({
    value: {
      status: "unavailable",
      source: "base",
      reason: "CAPABILITY_UNAVAILABLE"
    }
  });
  f.identity.authorize
    .mockResolvedValueOnce(portFailure("DEFINITION_NOT_FOUND"))
    .mockResolvedValueOnce(portForbidden());
  expect(
    await f.service.diff(
      diffScope,
      { kind: "authored", base, head },
      caller,
      control
    )
  ).toMatchObject({
    value: { status: "unavailable", source: "both", reason: "FORBIDDEN" }
  });
  f.graph.compile.mockResolvedValueOnce(portFailure("VALIDATION_FAILED"));
  expect(
    await f.service.diff(
      diffScope,
      { kind: "authored", base, head },
      caller,
      control
    )
  ).toMatchObject({
    value: {
      status: "unavailable",
      source: "base",
      reason: "RESULT_UNAVAILABLE"
    }
  });
});

it("requires an environment for planning and refuses absent, stale or mismatched recipe evidence", async () => {
  const f = fixture();
  expect(
    await f.service.get(authoredScope, { kind: "planned" }, control)
  ).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
  const scope = { ...authoredScope, target: { ...base, environment: "test" } };
  f.environment.registrations.mockResolvedValueOnce(
    portAbsent({
      quality: "current",
      completeness: "complete",
      evidence: "configuration",
      observedAt: time
    })
  );
  expect(
    await f.service.get(scope, { kind: "planned" }, control)
  ).toMatchObject({ status: "failed", error: { code: "PRECONDITION_FAILED" } });
  f.environment.registrations.mockResolvedValueOnce(
    portSuccess({
      target: { repo: base.repo, environment: "other" },
      provider: "azure",
      recipes: [],
      observation: {
        quality: "current",
        completeness: "complete",
        evidence: "radius"
      }
    })
  );
  expect(
    await f.service.get(scope, { kind: "planned" }, control)
  ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  f.environment.registrations.mockResolvedValueOnce(
    portSuccess({
      target: { repo: base.repo, environment: "test" },
      provider: "azure",
      recipes: [],
      observation: {
        quality: "stale",
        completeness: "complete",
        evidence: "radius"
      }
    })
  );
  expect(
    await f.service.get(scope, { kind: "planned" }, control)
  ).toMatchObject({
    status: "unavailable",
    error: { code: "RESULT_UNAVAILABLE" }
  });
  f.environment.registrations.mockResolvedValueOnce(
    portSuccess({
      target: { repo: base.repo, environment: "test" },
      provider: "azure",
      recipes: [],
      observation: {
        quality: "current",
        completeness: "partial",
        evidence: "radius"
      }
    })
  );
  expect(
    await f.service.get(scope, { kind: "planned" }, control)
  ).toMatchObject({
    status: "unavailable",
    error: { code: "RESULT_UNAVAILABLE" }
  });
  expect(f.graph.compile).not.toHaveBeenCalled();
});

it("passes each actual environment registration set to planned compilation and discloses incomplete output enumeration", async () => {
  const f = fixture();
  f.environment.registrations.mockImplementation(async (_scope, target) =>
    portSuccess({
      target,
      provider: target.environment === "azure-test" ? "azure" : "aws",
      recipes: [
        {
          resourceType: "Radius.Data/redisCaches",
          kind: "bicep",
          source:
            target.environment === "azure-test" ?
              "br:mcr.microsoft.com/bicep/avm/res/cache/redis-enterprise:0.5.1"
            : "br:ghcr.io/radius-project/kube-recipes/rediscaches:1.0"
        }
      ],
      observation: {
        quality: "current",
        completeness: "complete",
        evidence: "radius",
        observedAt: time
      }
    })
  );
  const result = await f.service.diff(
    diffScope,
    {
      kind: "planned",
      base: { ...base, environment: "azure-test" },
      head: { ...head, environment: "aws-test" }
    },
    caller,
    control
  );
  expect(result).toMatchObject({
    status: "ok",
    value: {
      status: "available",
      kind: "planned",
      baseTarget: { environment: "azure-test" },
      headTarget: { environment: "aws-test" },
      observation: { completeness: "partial" }
    }
  });
  expect(
    f.graph.compile.mock.calls.map(([input]) =>
      input.kind === "planned" ?
        input.registrations.target.environment
      : input.kind
    )
  ).toEqual(["azure-test", "aws-test"]);
  const single = await f.service.get(
    { ...authoredScope, target: { ...base, environment: "azure-test" } },
    { kind: "planned" },
    control
  );
  expect(single).toMatchObject({
    status: "ok",
    value: {
      kind: "planned",
      enrichment: {
        recipes: [{ resourceType: "Radius.Data/redisCaches" }],
        observation: {
          completeness: "partial",
          limitation: expect.stringContaining(
            "supporting resources are not enumerated"
          )
        }
      }
    }
  });
});

it("honors cancellation arriving while actual registrations are read", async () => {
  const f = fixture();
  f.environment.registrations.mockImplementationOnce(async (_scope, target) => {
    f.service.close();
    return portSuccess({
      target,
      provider: "azure",
      recipes: [],
      observation: {
        quality: "current",
        completeness: "complete",
        evidence: "radius"
      }
    });
  });
  expect(
    await f.service.get(
      { ...authoredScope, target: { ...base, environment: "test" } },
      { kind: "planned" },
      control
    )
  ).toMatchObject({ status: "cancelled" });
  expect(f.graph.compile).not.toHaveBeenCalled();
  expect(f.source.releaseSnapshot).toHaveBeenCalledOnce();
});

it("never replaces missing, forbidden, mismatched or unavailable deployed observations with authored resources", async () => {
  const f = fixture();
  const target = { repo: base.repo, environment: "test", application: "app" };
  const scope = { ...authoredScope, target };
  f.graph.observeDeployed
    .mockResolvedValueOnce(
      portAbsent({
        quality: "current",
        completeness: "complete",
        evidence: "radius",
        observedAt: time
      })
    )
    .mockResolvedValueOnce(portForbidden())
    .mockResolvedValueOnce(
      portSuccess({
        kind: "deployed",
        target: { ...target, environment: "other" },
        graph: { resources: [] },
        observation: {
          quality: "current",
          completeness: "complete",
          evidence: "radius"
        }
      })
    )
    .mockResolvedValueOnce(
      portSuccess({
        kind: "deployed",
        target,
        graph: { resources: [] },
        observation: {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "radius"
        }
      })
    );
  for (const status of ["unavailable", "forbidden", "failed", "unavailable"]) {
    expect(
      await f.service.get(scope, { kind: "deployed" }, control)
    ).toMatchObject({ status });
  }
  expect(f.source.capture).not.toHaveBeenCalled();
  expect(f.graph.compile).not.toHaveBeenCalled();
});

it("compares deployed graphs only against recorded source provenance matching both captured sources", async () => {
  const f = fixture();
  f.graph.observeDeployed.mockImplementation(async (_scope, target) =>
    portSuccess({
      kind: "deployed",
      target,
      graph: { resources: [] },
      provenance: snapshot(target.repo === base.repo ? base : head).provenance,
      observation: {
        quality: "current",
        completeness: "complete",
        evidence: "radius",
        observedAt: time
      }
    })
  );
  const input = {
    kind: "deployed",
    base: { ...base, environment: "test", application: "app" },
    head: { ...head, environment: "test", application: "app" }
  } as const;
  expect(await f.service.diff(diffScope, input, caller, control)).toMatchObject(
    {
      status: "ok",
      value: {
        status: "available",
        kind: "deployed",
        base: snapshot(base).provenance,
        head: snapshot(head).provenance
      }
    }
  );
  expect(f.source.capture).toHaveBeenCalledTimes(2);
  expect(f.graph.compile).not.toHaveBeenCalled();
  f.graph.observeDeployed.mockImplementation(async (_scope, target) =>
    portSuccess({
      kind: "deployed",
      target,
      graph: { resources: [] },
      observation: {
        quality: "current",
        completeness: "complete",
        evidence: "radius"
      }
    })
  );
  expect(await f.service.diff(diffScope, input, caller, control)).toMatchObject(
    {
      value: {
        status: "unavailable",
        source: "both",
        reason: "RESULT_UNAVAILABLE"
      }
    }
  );
  f.graph.observeDeployed.mockImplementation(async (_scope, target) =>
    portSuccess({
      kind: "deployed",
      target,
      graph: { resources: [] },
      provenance: {
        ...snapshot(base).provenance,
        fingerprint: `sha256:${"b".repeat(64)}`
      },
      observation: {
        quality: "current",
        completeness: "complete",
        evidence: "radius"
      }
    })
  );
  expect(await f.service.diff(diffScope, input, caller, control)).toMatchObject(
    {
      value: {
        status: "unavailable",
        source: "both",
        reason: "RESULT_UNAVAILABLE"
      }
    }
  );
  expect(f.source.releaseSnapshot).toHaveBeenCalledTimes(6);
});

it("does not return a deployed success after its context closes during observation", async () => {
  const f = fixture();
  const target = { repo: base.repo, environment: "test", application: "app" };
  f.graph.observeDeployed.mockImplementationOnce(async () => {
    f.service.close();
    return portSuccess({
      kind: "deployed",
      target,
      graph: { resources: [] },
      observation: {
        quality: "current",
        completeness: "complete",
        evidence: "radius"
      }
    });
  });
  expect(
    await f.service.get(
      { ...authoredScope, target },
      { kind: "deployed" },
      control
    )
  ).toEqual({ status: "cancelled", reason: "request_cancelled" });
});

it("preserves stale and partial deployed evidence in comparison freshness", async () => {
  const f = fixture();
  f.graph.observeDeployed.mockImplementation(async (_scope, target) =>
    portSuccess({
      kind: "deployed",
      target,
      graph: { resources: [] },
      provenance: snapshot(target.repo === base.repo ? base : head).provenance,
      observation: {
        quality: target.repo === base.repo ? "stale" : "current",
        completeness: target.repo === base.repo ? "partial" : "complete",
        evidence: "radius",
        observedAt: time,
        limitation: "Last observed deployed graph."
      }
    })
  );
  expect(
    await f.service.diff(
      diffScope,
      {
        kind: "deployed",
        base: { ...base, environment: "test", application: "app" },
        head: { ...head, environment: "test", application: "app" }
      },
      caller,
      control
    )
  ).toMatchObject({
    status: "ok",
    value: {
      observation: {
        quality: "stale",
        completeness: "partial",
        evidence: "radius"
      }
    }
  });
});

it("returns independent graph records rather than exposing the compiler's mutable objects", async () => {
  const f = fixture();
  const compilation: GraphCompilation = {
    graph: {
      resources: [
        {
          id: "api",
          name: "api",
          type: "Radius.Compute/containers",
          diffHash: fingerprint,
          connections: [{ id: "store", direction: "Outbound" }],
          outputResources: [
            {
              name: "deployment",
              type: "apps/Deployment",
              displayType: "Deployment",
              provider: "kubernetes",
              apiVersion: "v1"
            }
          ]
        }
      ]
    },
    diagnostics: []
  };
  f.graph.compile.mockResolvedValueOnce(portSuccess(compilation));
  const result = await f.service.get(
    authoredScope,
    { kind: "authored" },
    control
  );
  if (result.status !== "ok") throw new Error("Expected authored graph");
  const resource = result.value.graph.resources[0];
  expect(resource).not.toBe(compilation.graph.resources[0]);
  resource.connections[0].id = "changed";
  resource.outputResources[0].name = "changed";
  expect(compilation.graph.resources[0].connections[0].id).toBe("store");
  expect(compilation.graph.resources[0].outputResources[0].name).toBe(
    "deployment"
  );
  f.graph.compile.mockResolvedValueOnce(
    portSuccess({
      ...compilation,
      graph: {
        resources: [
          {
            ...compilation.graph.resources[0],
            diffHash: "invalid compiler evidence"
          }
        ]
      }
    })
  );
  expect(
    await f.service.diff(
      diffScope,
      { kind: "authored", base, head },
      caller,
      control
    )
  ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
});

it.each([
  { quality: "unknown", observedAt: undefined },
  { quality: "current", observedAt: "2026-09-15T21:00:00Z" }
] as const)(
  "does not advance the age of deployed observations when comparing them",
  async (headObservation) => {
    const f = fixture();
    f.graph.observeDeployed.mockImplementation(async (_scope, target) => {
      const isHead = target.repo === head.repo;
      return portSuccess({
        kind: "deployed",
        target,
        graph: { resources: [] },
        provenance: snapshot(isHead ? head : base).provenance,
        observation: {
          quality: isHead ? headObservation.quality : "current",
          completeness: "complete",
          evidence: "radius",
          ...(isHead ?
            headObservation.observedAt ?
              { observedAt: headObservation.observedAt }
            : {}
          : { observedAt: time })
        }
      });
    });
    const result = await f.service.diff(
      diffScope,
      {
        kind: "deployed",
        base: { ...base, environment: "test", application: "app" },
        head: { ...head, environment: "test", application: "app" }
      },
      caller,
      control
    );
    expect(result).toMatchObject({
      status: "ok",
      value: {
        observation: {
          quality: headObservation.quality,
          completeness: "complete"
        }
      }
    });
    if (result.status !== "ok") throw new Error("Expected comparison");
    expect(result.value.observation.observedAt).toBe(
      headObservation.observedAt
    );
  }
);

it("stops before reading the other diff side when a port reports cancellation", async () => {
  const f = fixture();
  f.identity.authorize.mockResolvedValueOnce(portCancelled("session_shutdown"));
  expect(
    await f.service.diff(
      diffScope,
      { kind: "authored", base, head },
      caller,
      control
    )
  ).toEqual({ status: "cancelled", reason: "session_shutdown" });
  expect(f.identity.authorize).toHaveBeenCalledOnce();
  expect(f.source.capture).not.toHaveBeenCalled();
});

it("retains safe static prerequisite diagnostics in an unavailable comparison", async () => {
  const f = fixture();
  const message =
    "Registry restoration is unavailable in isolated compilation.";
  f.graph.compile.mockResolvedValueOnce(
    portUnavailable(
      "CAPABILITY_UNAVAILABLE",
      {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "source",
        limitation: message
      },
      { diagnostics: [{ message, truncated: false }] }
    )
  );
  expect(
    await f.service.diff(
      diffScope,
      { kind: "authored", base, head },
      caller,
      control
    )
  ).toMatchObject({
    status: "ok",
    value: { status: "unavailable", source: "base", message }
  });
});

it("captures original comparison expectations before awaiting either side", async () => {
  const f = fixture();
  const input = {
    kind: "authored" as const,
    base,
    head: {
      ...head,
      source: {
        kind: "git" as const,
        ref: "feature",
        expectedCommit: "b".repeat(40)
      }
    }
  };
  f.graph.compile.mockImplementationOnce(async () => {
    input.head.source.expectedCommit = "d".repeat(40);
    return portSuccess({ graph: { resources: [] }, diagnostics: [] });
  });
  expect(await f.service.diff(diffScope, input, caller, control)).toMatchObject(
    {
      status: "ok",
      value: { status: "available", head: { commit: "b".repeat(40) } }
    }
  );
});

it("fences a successful authorization that arrives after its graph context closes", async () => {
  const f = fixture();
  f.identity.authorize.mockImplementationOnce(async (request) => {
    f.service.close();
    return portSuccess({
      operation: request.operation,
      target: request.target,
      authorizationRef: "authorization",
      principalRef: caller.principalRef
    });
  });
  expect(
    await f.service.diff(
      diffScope,
      { kind: "authored", base, head },
      caller,
      control
    )
  ).toEqual({ status: "cancelled", reason: "request_cancelled" });
  expect(f.source.capture).not.toHaveBeenCalled();
});

it.each(["base", "head"] as const)(
  "stops a diff when a %s read failure coincides with context shutdown",
  async (side) => {
    const f = fixture();
    f.source.capture.mockImplementation(async (_scope, selection) => {
      if (selection.repo === (side === "base" ? base.repo : head.repo)) {
        f.service.close();
        return portFailure("SOURCE_CHANGED");
      }
      return portSuccess({
        status: "captured",
        snapshot: snapshot(selection)
      });
    });
    expect(
      await f.service.diff(
        diffScope,
        { kind: "authored", base, head },
        caller,
        control
      )
    ).toEqual({ status: "cancelled", reason: "request_cancelled" });
    expect(f.identity.authorize).toHaveBeenCalledTimes(side === "base" ? 1 : 2);
    expect(f.source.releaseSnapshot).toHaveBeenCalledTimes(
      side === "base" ? 0 : 1
    );
  }
);

it("propagates deployed-read permission failures within a source-bound comparison", async () => {
  const f = fixture();
  f.graph.observeDeployed.mockImplementation(async (_scope, target) =>
    target.repo === base.repo ?
      portForbidden()
    : portSuccess({
        kind: "deployed",
        target,
        graph: { resources: [] },
        provenance: snapshot(head).provenance,
        observation: {
          quality: "current",
          completeness: "complete",
          evidence: "radius"
        }
      })
  );
  expect(
    await f.service.diff(
      diffScope,
      {
        kind: "deployed",
        base: { ...base, environment: "test", application: "app" },
        head: { ...head, environment: "test", application: "app" }
      },
      caller,
      control
    )
  ).toMatchObject({
    status: "ok",
    value: { status: "unavailable", source: "base", reason: "FORBIDDEN" }
  });
  expect(f.source.releaseSnapshot).toHaveBeenCalledTimes(2);
});
