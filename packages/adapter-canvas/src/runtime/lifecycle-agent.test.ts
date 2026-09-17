import { describe, expect, it, vi } from "vitest";
import {
  portFailure,
  portForbidden,
  portSuccess,
  portCancelled,
  portUnavailable,
  type AgentAssignment,
  type AgentOutcome,
  type AuthorizedScope,
  type CallerContext,
  type CancellationReceipt,
  type RequestControl,
  type SourceSnapshot
} from "@radius-project/core/lifecycle";
import {
  createLifecycleAgent,
  type LifecycleAgentReceipt,
  type LifecycleAgentDependencies,
  type TrustedLifecycleAgentHost
} from "./lifecycle-agent.js";

const fingerprint = `sha256:${"a".repeat(64)}`;
const target = {
  repo: "owner/repo",
  definition: ".radius/app.bicep",
  source: {
    kind: "workspace" as const,
    workspaceRef: "workspace",
    branch: "feature",
    expectedFingerprint: fingerprint
  }
};
const caller: CallerContext = {
  principalRef: "principal",
  sessionRef: "session",
  identityRef: "identity",
  responder: "agent",
  agentBindingRef: "agent"
};
const snapshot = {
  snapshotRef: "snapshot",
  selection: target,
  provenance: {
    repo: target.repo,
    kind: "workspace",
    workspaceRef: "workspace",
    branch: "feature",
    fingerprint,
    resolvedAt: "2026-09-16T00:00:00Z"
  },
  manifest: {
    completeness: "complete",
    definition: target.definition,
    fingerprint,
    inputs: [
      {
        path: target.definition,
        kind: "definition",
        existed: false,
        contentHash: null
      }
    ]
  }
} satisfies SourceSnapshot;
const assignment: Extract<AgentAssignment, { operation: "definition.author" }> =
  {
    operation: "definition.author",
    action: {
      kind: "agent.author_definition",
      responder: "agent",
      response: { kind: "agent.outcome" },
      message: "Author without publishing",
      status: "outstanding",
      actionId: "action",
      operationId: "operation",
      target,
      source: snapshot.provenance
    },
    staging: {
      stagingRef: "staging",
      operationId: "operation",
      actionId: "action",
      snapshot
    },
    intent: { intent: "create_or_update", provider: "azure" }
  };
const scope: AuthorizedScope<"definition.author"> = {
  authorizationRef: "authorization",
  principalRef: caller.principalRef,
  approvalRef: "approval",
  operation: "definition.author",
  operationId: "operation",
  target,
  source: snapshot.provenance
};
const receipt: LifecycleAgentReceipt = {
  deliveryRef: "delivery",
  operationId: "operation",
  actionId: "action",
  principalRef: "principal",
  sessionRef: "session",
  agentBindingRef: "agent"
};
const delivery = {
  deliveryRef: "delivery",
  operationId: "operation",
  actionId: "action"
};
const outcome: AgentOutcome = {
  kind: "agent.outcome",
  status: "completed",
  stagedOutputRefs: ["staging/app.bicep"]
};
const cancellation: CancellationReceipt = {
  status: "requested",
  requestedAt: "2026-09-16T00:00:00Z",
  observation: {
    quality: "unknown",
    completeness: "partial",
    evidence: "session"
  }
};
function fixture(supported = true) {
  const signal = { aborted: false, onAbort: () => () => {} };
  const control: RequestControl = {
    requestId: "request",
    cancellation: signal
  };
  // This fake is deliberately stronger than the current SDK; it is not host qualification.
  const host = {
    binding: vi.fn<TrustedLifecycleAgentHost["binding"]>(() => caller),
    issueAssignment: vi.fn<TrustedLifecycleAgentHost["issueAssignment"]>(
      async () => portSuccess(receipt)
    ),
    verifyAssignment: vi.fn<TrustedLifecycleAgentHost["verifyAssignment"]>(
      async () => portSuccess(undefined)
    ),
    dispatch: vi.fn<TrustedLifecycleAgentHost["dispatch"]>(async () =>
      portSuccess(undefined)
    ),
    verifyOutcome: vi.fn<TrustedLifecycleAgentHost["verifyOutcome"]>(async () =>
      portSuccess(undefined)
    ),
    cancel: vi.fn<TrustedLifecycleAgentHost["cancel"]>(async () =>
      portSuccess(cancellation)
    )
  };
  const discoverSkill = vi.fn<LifecycleAgentDependencies["discoverSkill"]>(
    async () => portSuccess({ skillRef: "authoring-skill" })
  );
  const stagingLocation = vi.fn<LifecycleAgentDependencies["stagingLocation"]>(
    async () => portSuccess("owned-workspace\\staging")
  );
  const agent = createLifecycleAgent({
    ...(supported ? { host } : {}),
    discoverSkill,
    stagingLocation
  });
  const assign = () => agent.assign(scope, assignment, control);
  const authenticate = () =>
    agent.authenticateOutcome(caller, assignment.action, outcome, control);
  const cancel = () =>
    agent.cancel(
      { ...scope, operation: "operation.cancel" },
      delivery,
      control
    );
  return {
    host,
    discoverSkill,
    stagingLocation,
    agent,
    assign,
    authenticate,
    cancel,
    control,
    signal
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred promise is not initialized.");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("lifecycle agent bridge", () => {
  it("checks source expectations against the exact snapshot before consulting the host", async () => {
    const f = fixture();
    const changedTarget = {
      ...target,
      source: { ...target.source, branch: "different" }
    };
    expect(
      await f.agent.assign(
        { ...scope, target: changedTarget },
        {
          ...assignment,
          action: { ...assignment.action, target: changedTarget },
          staging: {
            ...assignment.staging,
            snapshot: { ...snapshot, selection: changedTarget }
          }
        },
        f.control
      )
    ).toMatchObject({ error: { code: "SOURCE_CHANGED" } });
    expect(f.host.issueAssignment).not.toHaveBeenCalled();
  });

  it.each(["", "delivery\n", "x".repeat(257)])(
    "rejects malformed and out-of-bound delivery reference %j",
    async (deliveryRef) => {
      const f = fixture();
      f.host.issueAssignment.mockResolvedValue(
        portSuccess({ ...receipt, deliveryRef })
      );
      expect(await f.assign()).toEqual(portForbidden());
      expect(f.host.dispatch).not.toHaveBeenCalled();
    }
  );

  it.each(["d", "x".repeat(256)])(
    "accepts bounded opaque delivery reference of length %j",
    async (deliveryRef) => {
      const f = fixture();
      f.host.issueAssignment.mockResolvedValue(
        portSuccess({ ...receipt, deliveryRef })
      );
      expect(await f.assign()).toEqual(
        portSuccess({ ...delivery, deliveryRef })
      );
    }
  );
  it("fails closed without a trusted host and never discovers a skill or accesses a workspace", async () => {
    const f = fixture(false);
    for (const result of [
      await f.assign(),
      await f.authenticate(),
      await f.cancel()
    ]) {
      expect(result).toMatchObject({
        status: "unavailable",
        error: {
          code: "CAPABILITY_UNAVAILABLE",
          details: [{ truncated: false }]
        }
      });
    }
    expect(f.discoverSkill).not.toHaveBeenCalled();
    expect(f.stagingLocation).not.toHaveBeenCalled();
    expect(f.host.dispatch).not.toHaveBeenCalled();
  });

  it("delivers a private staging location only through authenticated injected authority", async () => {
    const f = fixture();
    expect(await f.assign()).toEqual(portSuccess(delivery));
    expect(f.host.dispatch).toHaveBeenCalledWith(
      receipt,
      {
        assignment,
        skill: { skillRef: "authoring-skill" },
        stagingLocation: "owned-workspace\\staging"
      },
      f.control
    );
    expect(f.host.verifyAssignment).toHaveBeenCalledTimes(2);
    expect(await f.authenticate()).toEqual(
      portSuccess({
        agentBindingRef: "agent",
        operationId: "operation",
        actionId: "action",
        outcome
      })
    );
    expect(
      await f.agent.authenticateOutcome(
        caller,
        {
          ...assignment.action,
          status: "accepted"
        },
        outcome,
        f.control
      )
    ).toMatchObject({ status: "ok" });
    expect(f.host.verifyOutcome).toHaveBeenCalledTimes(2);
    expect(await f.assign()).toMatchObject({
      status: "failed",
      error: { code: "ACTION_NOT_OUTSTANDING" }
    });
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "staging/../app.bicep",
    "staging/C:/app.bicep",
    "staging/dir/app.bicep",
    "staging/dir\\app.bicep",
    "foreign/app.bicep",
    "staging/",
    "/app.bicep",
    "staging/.%2e",
    "staging/\\\\server\\share"
  ])(
    "rejects unowned output reference %s before host verification",
    async (ref) => {
      const f = fixture();
      await f.assign();
      expect(
        await f.agent.authenticateOutcome(
          caller,
          assignment.action,
          {
            ...outcome,
            stagedOutputRefs: [ref]
          },
          f.control
        )
      ).toMatchObject({
        status: "failed",
        error: { code: "ACTION_RESPONSE_INVALID" }
      });
      expect(f.host.verifyOutcome).not.toHaveBeenCalled();
    }
  );

  it("does not let public user decisions authenticate an agent outcome", async () => {
    const f = fixture();
    await f.assign();
    expect(
      await f.agent.authenticateOutcome(
        { ...caller, responder: "user" },
        assignment.action,
        outcome,
        f.control
      )
    ).toMatchObject({ status: "forbidden" });
    expect(f.host.verifyOutcome).not.toHaveBeenCalled();
  });

  it("preserves uncertain dispatch and never sends the assignment again", async () => {
    const f = fixture();
    f.host.dispatch.mockResolvedValue(
      portFailure("PRECONDITION_FAILED", {
        diagnostics: [
          { message: "Host could not confirm delivery", truncated: false }
        ]
      })
    );
    expect(await f.assign()).toMatchObject({
      status: "failed",
      error: {
        code: "DISPATCH_UNCONFIRMED",
        details: [{ message: "Host could not confirm delivery" }]
      }
    });
    expect(await f.assign()).toMatchObject({ status: "failed" });
    expect(await f.authenticate()).toMatchObject({ status: "forbidden" });
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
  });

  it("rechecks authority before accepting outcomes", async () => {
    const f = fixture();
    await f.assign();
    f.host.verifyAssignment.mockResolvedValue(portForbidden());
    expect(await f.authenticate()).toEqual(portForbidden());
    expect(f.host.verifyOutcome).not.toHaveBeenCalled();
  });

  it("fences outcomes on cancellation and shutdown without reporting remote rollback", async () => {
    const f = fixture();
    await f.assign();
    expect(await f.cancel()).toEqual(portSuccess(cancellation));
    expect(await f.authenticate()).toMatchObject({ status: "forbidden" });
    expect(await f.cancel()).toMatchObject({ status: "failed" });
    f.agent.close();
    f.agent.close();
    expect(await f.assign()).toEqual({
      status: "cancelled",
      reason: "session_shutdown"
    });
    expect(await f.authenticate()).toEqual({
      status: "cancelled",
      reason: "session_shutdown"
    });
    expect(await f.cancel()).toEqual({
      status: "cancelled",
      reason: "session_shutdown"
    });
  });

  it.each([
    "binding",
    "issueAssignment",
    "verifyAssignment",
    "dispatch",
    "verifyOutcome",
    "cancel",
    "discoverSkill",
    "stagingLocation"
  ])(
    "rejects incomplete supported host dependency %s at construction",
    (method) => {
      const f = fixture();
      const deps = {
        host: f.host,
        discoverSkill: f.discoverSkill,
        stagingLocation: f.stagingLocation
      };
      Object.defineProperty(
        method === "discoverSkill" || method === "stagingLocation" ?
          deps
        : deps.host,
        method,
        { value: undefined }
      );
      expect(() => createLifecycleAgent(deps)).toThrow("complete trusted host");
    }
  );

  it.each([
    ["authorization", { ...scope, authorizationRef: "" }, assignment],
    ["approval", { ...scope, approvalRef: "" }, assignment],
    ["principal", { ...scope, principalRef: "" }, assignment],
    ["operation", { ...scope, operationId: "foreign" }, assignment],
    ["scope kind", { ...scope, operation: "operation.repair" }, assignment],
    [
      "action ID",
      scope,
      { ...assignment, action: { ...assignment.action, actionId: "" } }
    ],
    [
      "operation ID",
      scope,
      { ...assignment, action: { ...assignment.action, operationId: "" } }
    ],
    [
      "staging ID",
      scope,
      {
        ...assignment,
        staging: { ...assignment.staging, stagingRef: "C:\\private" }
      }
    ],
    [
      "staging operation",
      scope,
      {
        ...assignment,
        staging: { ...assignment.staging, operationId: "foreign" }
      }
    ],
    [
      "staging action",
      scope,
      { ...assignment, staging: { ...assignment.staging, actionId: "foreign" } }
    ],
    [
      "action kind",
      scope,
      {
        ...assignment,
        action: { ...assignment.action, kind: "agent.repair_definition" }
      }
    ],
    [
      "accepted action",
      scope,
      { ...assignment, action: { ...assignment.action, status: "accepted" } }
    ],
    [
      "action target",
      scope,
      {
        ...assignment,
        action: {
          ...assignment.action,
          target: { ...target, repo: "owner/foreign" }
        }
      }
    ],
    [
      "snapshot selection",
      scope,
      {
        ...assignment,
        staging: {
          ...assignment.staging,
          snapshot: {
            ...snapshot,
            selection: { ...target, definition: ".radius/other.bicep" }
          }
        }
      }
    ],
    ["missing source", { ...scope, source: undefined }, assignment],
    [
      "action source",
      scope,
      {
        ...assignment,
        action: {
          ...assignment.action,
          source: { ...snapshot.provenance, branch: "foreign" }
        }
      }
    ],
    [
      "snapshot source",
      scope,
      {
        ...assignment,
        staging: {
          ...assignment.staging,
          snapshot: {
            ...snapshot,
            provenance: { ...snapshot.provenance, branch: "foreign" }
          }
        }
      }
    ],
    [
      "manifest identity",
      scope,
      {
        ...assignment,
        staging: {
          ...assignment.staging,
          snapshot: {
            ...snapshot,
            manifest: { ...snapshot.manifest, fingerprint: "different" }
          }
        }
      }
    ]
  ] satisfies [
    string,
    AuthorizedScope<"definition.author" | "operation.repair">,
    AgentAssignment
  ][])(
    "rejects mismatched assignment %s before skill or staging access",
    async (_label, requestScope, work) => {
      const f = fixture();
      expect(await f.agent.assign(requestScope, work, f.control)).toMatchObject(
        {
          status: "failed",
          error: { code: "PRECONDITION_FAILED" }
        }
      );
      expect(f.host.issueAssignment).not.toHaveBeenCalled();
      expect(f.discoverSkill).not.toHaveBeenCalled();
      expect(f.stagingLocation).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["principalRef", ""],
    ["sessionRef", ""],
    ["agentBindingRef", ""],
    ["principalRef", "foreign"],
    ["sessionRef", "foreign"],
    ["agentBindingRef", "foreign"],
    ["operationId", "foreign"],
    ["actionId", "foreign"],
    ["deliveryRef", "C:\\private"]
  ])("rejects unbound receipt %s=%s", async (field, value) => {
    const f = fixture();
    f.host.issueAssignment.mockResolvedValue(
      portSuccess({ ...receipt, [field]: value })
    );
    expect(await f.assign()).toEqual(portForbidden());
    expect(f.host.verifyAssignment).not.toHaveBeenCalled();
    expect(f.discoverSkill).not.toHaveBeenCalled();
  });

  it("rejects a receipt for a different authorized principal even when the host binding matches it", async () => {
    const f = fixture();
    f.host.binding.mockReturnValue({ ...caller, principalRef: "foreign" });
    f.host.issueAssignment.mockResolvedValue(
      portSuccess({ ...receipt, principalRef: "foreign" })
    );
    expect(await f.assign()).toEqual(portForbidden());
  });

  it("does not transfer an in-flight assignment to a changed session", async () => {
    const f = fixture();
    f.host.issueAssignment.mockImplementationOnce(async () => {
      f.host.binding.mockReturnValue({ ...caller, sessionRef: "new-session" });
      return portSuccess({ ...receipt, sessionRef: "new-session" });
    });
    expect(await f.assign()).toEqual(portForbidden());
  });

  it.each(["principalRef", "sessionRef", "agentBindingRef"] as const)(
    "rejects foreign outcome caller %s",
    async (field) => {
      const f = fixture();
      await f.assign();
      expect(
        await f.agent.authenticateOutcome(
          { ...caller, [field]: "foreign" },
          assignment.action,
          outcome,
          f.control
        )
      ).toEqual(portForbidden());
      expect(f.host.verifyOutcome).not.toHaveBeenCalled();
    }
  );

  it.each(["expired", "rejected", "superseded"] as const)(
    "rejects %s action outcomes",
    async (status) => {
      const f = fixture();
      await f.assign();
      expect(
        await f.agent.authenticateOutcome(
          caller,
          { ...assignment.action, status },
          outcome,
          f.control
        )
      ).toMatchObject({
        error: { code: "ACTION_RESPONSE_INVALID" }
      });
      expect(f.host.verifyOutcome).not.toHaveBeenCalled();
    }
  );

  it.each([
    { ...assignment.action, actionId: "foreign" },
    { ...assignment.action, operationId: "foreign" },
    {
      ...assignment.action,
      source: { ...snapshot.provenance, branch: "foreign" }
    },
    { ...assignment.action, target: { ...target, repo: "owner/foreign" } }
  ])(
    "rejects foreign or stale outcome action $actionId $operationId",
    async (action) => {
      const f = fixture();
      await f.assign();
      expect(
        (await f.agent.authenticateOutcome(caller, action, outcome, f.control))
          .status
      ).not.toBe("ok");
      expect(f.host.verifyOutcome).not.toHaveBeenCalled();
    }
  );

  it.each([
    [],
    ["staging/app.bicep", "staging/app.bicep"],
    ["staging/app.bicep", "staging/APP.bicep"],
    Array.from({ length: 101 }, (_, index) => `staging/file-${index}.bicep`)
  ])("rejects invalid output reference bounds and aliases", async (...refs) => {
    const f = fixture();
    await f.assign();
    expect(
      await f.agent.authenticateOutcome(
        caller,
        assignment.action,
        { ...outcome, stagedOutputRefs: refs },
        f.control
      )
    ).toMatchObject({
      error: { code: "ACTION_RESPONSE_INVALID" }
    });
    expect(f.host.verifyOutcome).not.toHaveBeenCalled();
  });

  it("accepts the maximum owned outputs without exposing receipt identity in the delivery", async () => {
    const f = fixture();
    await f.assign();
    const many: AgentOutcome = {
      ...outcome,
      stagedOutputRefs: Array.from(
        { length: 100 },
        (_, i) => `staging/file-${i}.bicep`
      )
    };
    expect(
      await f.agent.authenticateOutcome(
        caller,
        assignment.action,
        many,
        f.control
      )
    ).toMatchObject({
      status: "ok",
      value: { outcome: many }
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "authenticates an evidenced %s outcome without declaring success",
    async (status) => {
      const f = fixture();
      await f.assign();
      const failed: AgentOutcome = {
        kind: "agent.outcome",
        status,
        diagnostics: [
          { message: "Authoring did not complete", truncated: false }
        ]
      };
      expect(
        await f.agent.authenticateOutcome(
          caller,
          assignment.action,
          failed,
          f.control
        )
      ).toMatchObject({
        status: "ok",
        value: { outcome: failed }
      });
      expect(await f.authenticate()).toMatchObject({
        error: { code: "ACTION_RESPONSE_INVALID" }
      });
      expect(f.host.verifyOutcome).toHaveBeenCalledTimes(1);
    }
  );

  it("does not cache positive authentication when the host revokes authority", async () => {
    const f = fixture();
    await f.assign();
    await f.authenticate();
    f.host.verifyOutcome.mockResolvedValue(portForbidden());
    expect(await f.authenticate()).toEqual(portForbidden());
    expect(f.host.verifyOutcome).toHaveBeenCalledTimes(2);
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not authenticate receipts from another bridge instance", async () => {
    const owner = fixture();
    const other = fixture();
    await owner.assign();
    expect(await other.authenticate()).toEqual(portForbidden());
    expect(await other.cancel()).toEqual(portForbidden());
  });

  it.each(["assign", "authenticate", "cancel"] as const)(
    "honors request cancellation before %s without host access",
    async (method) => {
      const f = fixture();
      f.signal.aborted = true;
      expect(await f[method]()).toEqual(portCancelled("request_cancelled"));
      expect(f.host.binding).not.toHaveBeenCalled();
      expect(f.host.issueAssignment).not.toHaveBeenCalled();
    }
  );

  it.each(["issue", "verify", "skill", "location", "ready"] as const)(
    "retains explicit %s failures and never attempts dispatch",
    async (stage) => {
      const f = fixture();
      const failure = portUnavailable("SOURCE_UNAVAILABLE", {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "source"
      });
      if (stage === "issue") f.host.issueAssignment.mockResolvedValue(failure);
      if (stage === "verify")
        f.host.verifyAssignment.mockResolvedValue(failure);
      if (stage === "skill") f.discoverSkill.mockResolvedValue(failure);
      if (stage === "location") f.stagingLocation.mockResolvedValue(failure);
      if (stage === "ready")
        f.host.verifyAssignment
          .mockResolvedValueOnce(portSuccess(undefined))
          .mockResolvedValue(failure);
      expect(await f.assign()).toEqual(failure);
      expect(await f.assign()).toMatchObject({
        error: { code: "ACTION_NOT_OUTSTANDING" }
      });
      expect(f.host.dispatch).not.toHaveBeenCalled();
    }
  );

  it.each(["skill", "location"] as const)(
    "refuses empty host %s evidence",
    async (stage) => {
      const f = fixture();
      if (stage === "skill")
        f.discoverSkill.mockResolvedValue(portSuccess({ skillRef: "" }));
      else f.stagingLocation.mockResolvedValue(portSuccess(""));
      expect(await f.assign()).toMatchObject({
        error: { code: "CAPABILITY_UNAVAILABLE" }
      });
      expect(f.host.dispatch).not.toHaveBeenCalled();
    }
  );

  it.each([
    "binding",
    "issue",
    "verify",
    "skill",
    "location",
    "outcome",
    "cancel"
  ] as const)(
    "redacts %s exceptions without authorizing a retry",
    async (stage) => {
      const f = fixture();
      const fail = () => {
        throw new Error("private exception text");
      };
      if (stage === "outcome" || stage === "cancel") await f.assign();
      if (stage === "binding") f.host.binding.mockImplementation(fail);
      if (stage === "issue") f.host.issueAssignment.mockImplementation(fail);
      if (stage === "verify") f.host.verifyAssignment.mockImplementation(fail);
      if (stage === "skill") f.discoverSkill.mockImplementation(fail);
      if (stage === "location") f.stagingLocation.mockImplementation(fail);
      if (stage === "outcome") f.host.verifyOutcome.mockImplementation(fail);
      if (stage === "cancel") f.host.cancel.mockImplementation(fail);
      const result = await (stage === "outcome" ? f.authenticate()
      : stage === "cancel" ? f.cancel()
      : f.assign());
      expect(result).toMatchObject({
        error: { code: "CAPABILITY_UNAVAILABLE" }
      });
      expect(JSON.stringify(result)).not.toContain("private exception text");
    }
  );

  it("bounds actual redacted dispatch diagnostics through lifecycle errors", async () => {
    const f = fixture();
    const result = portFailure("PRECONDITION_FAILED");
    result.error.details = Array.from({ length: 101 }, () => ({
      message: "diagnostic ".repeat(500),
      truncated: false
    }));
    f.host.dispatch.mockResolvedValue(result);
    const sent = await f.assign();
    expect(sent).toMatchObject({ error: { code: "DISPATCH_UNCONFIRMED" } });
    if (sent.status !== "failed")
      throw new Error("Expected unconfirmed delivery");
    expect(sent.error.details).toHaveLength(100);
    expect(
      sent.error.details?.every(
        (detail) => detail.message.length === 4096 && detail.truncated
      )
    ).toBe(true);
  });

  it("redacts thrown dispatch uncertainty and refuses an automatic repeat", async () => {
    const f = fixture();
    f.host.dispatch.mockRejectedValue(new Error("private dispatch exception"));
    const result = await f.assign();
    expect(result).toMatchObject({ error: { code: "DISPATCH_UNCONFIRMED" } });
    expect(JSON.stringify(result)).not.toContain("private dispatch exception");
    expect(await f.assign()).toMatchObject({
      error: { code: "ACTION_NOT_OUTSTANDING" }
    });
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
  });

  it("retains host cancellation during dispatch without retrying it", async () => {
    const f = fixture();
    f.host.dispatch.mockResolvedValue(portCancelled("request_cancelled"));
    expect(await f.assign()).toEqual(portCancelled("request_cancelled"));
    expect(await f.assign()).toMatchObject({
      error: { code: "ACTION_NOT_OUTSTANDING" }
    });
  });

  it("preserves the real staging object identity despite caller mutation while authorizing", async () => {
    const f = fixture();
    const mutable = { ...assignment };
    f.host.issueAssignment.mockImplementationOnce(async () => {
      mutable.staging = { ...assignment.staging, stagingRef: "foreign" };
      return portSuccess(receipt);
    });
    expect(await f.agent.assign(scope, mutable, f.control)).toEqual(
      portSuccess(delivery)
    );
    expect(f.stagingLocation.mock.calls[0]?.[0]).toBe(assignment.staging);
  });

  it("reserves assignments before awaiting host issuance", async () => {
    const f = fixture();
    const issued =
      deferred<ReturnType<typeof portSuccess<LifecycleAgentReceipt>>>();
    f.host.issueAssignment.mockReturnValue(issued.promise);
    const first = f.assign();
    expect(await f.assign()).toMatchObject({
      error: { code: "ACTION_NOT_OUTSTANDING" }
    });
    issued.resolve(portSuccess(receipt));
    expect(await first).toEqual(portSuccess(delivery));
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting outcomes that authenticate concurrently", async () => {
    const f = fixture();
    await f.assign();
    const verified = deferred<ReturnType<typeof portSuccess<void>>>();
    const entered = deferred<void>();
    f.host.verifyOutcome.mockImplementationOnce(async () => {
      entered.resolve();
      return verified.promise;
    });
    const first = f.authenticate();
    await entered.promise;
    const conflict: AgentOutcome = {
      kind: "agent.outcome",
      status: "failed",
      diagnostics: []
    };
    expect(
      await f.agent.authenticateOutcome(
        caller,
        assignment.action,
        conflict,
        f.control
      )
    ).toMatchObject({ status: "ok" });
    verified.resolve(portSuccess(undefined));
    expect(await first).toMatchObject({
      error: { code: "ACTION_RESPONSE_INVALID" }
    });
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
  });

  describe.each(["close", "request", "binding", "cancel"] as const)(
    "%s fencing",
    (fence) => {
      it.each([
        "issue",
        "verify",
        "skill",
        "location",
        "ready",
        "dispatch"
      ] as const)("rechecks fencing after assignment %s", async (stage) => {
        const f = fixture();
        const stop = async () => {
          if (fence === "close") f.agent.close();
          if (fence === "request") f.signal.aborted = true;
          if (fence === "binding")
            f.host.binding.mockReturnValue({
              ...caller,
              sessionRef: "foreign"
            });
          if (fence === "cancel") {
            // Receipt ownership is established only after issueAssignment returns.
            if (stage === "issue") f.signal.aborted = true;
            else expect(await f.cancel()).toMatchObject({ status: "ok" });
          }
        };
        if (stage === "issue")
          f.host.issueAssignment.mockImplementationOnce(async () => {
            await stop();
            return portSuccess(receipt);
          });
        if (stage === "verify" || stage === "ready") {
          if (stage === "ready")
            f.host.verifyAssignment.mockResolvedValueOnce(
              portSuccess(undefined)
            );
          f.host.verifyAssignment.mockImplementationOnce(async () => {
            await stop();
            return portSuccess(undefined);
          });
        }
        if (stage === "skill")
          f.discoverSkill.mockImplementationOnce(async () => {
            await stop();
            return portSuccess({ skillRef: "authoring-skill" });
          });
        if (stage === "location")
          f.stagingLocation.mockImplementationOnce(async () => {
            await stop();
            return portSuccess("owned-workspace\\staging");
          });
        if (stage === "dispatch")
          f.host.dispatch.mockImplementationOnce(async () => {
            await stop();
            return portSuccess(undefined);
          });
        const result = await f.assign();
        expect(result.status).toBe(
          (
            fence === "close" ||
              fence === "request" ||
              (fence === "cancel" && stage === "issue")
          ) ?
            "cancelled"
          : "forbidden"
        );
        expect(f.host.dispatch).toHaveBeenCalledTimes(
          stage === "dispatch" ? 1 : 0
        );
        expect((await f.authenticate()).status).not.toBe("ok");
      });

      it.each(["authority", "outcome"] as const)(
        "rechecks fencing after outcome %s",
        async (stage) => {
          const f = fixture();
          await f.assign();
          const stop = async () => {
            if (fence === "close") f.agent.close();
            if (fence === "request") f.signal.aborted = true;
            if (fence === "binding")
              f.host.binding.mockReturnValue({
                ...caller,
                sessionRef: "foreign"
              });
            if (fence === "cancel")
              expect(await f.cancel()).toMatchObject({ status: "ok" });
            return portSuccess(undefined);
          };
          if (stage === "authority")
            f.host.verifyAssignment.mockImplementationOnce(stop);
          else f.host.verifyOutcome.mockImplementationOnce(stop);
          expect((await f.authenticate()).status).toBe(
            fence === "close" || fence === "request" ? "cancelled" : "forbidden"
          );
          expect(f.host.verifyOutcome).toHaveBeenCalledTimes(
            stage === "outcome" ? 1 : 0
          );
        }
      );
    }
  );

  it.each([
    ["principal", { ...scope, principalRef: "foreign" }, delivery],
    ["authorization", { ...scope, authorizationRef: "" }, delivery],
    ["operation", { ...scope, operationId: "foreign" }, delivery],
    ["delivery operation", scope, { ...delivery, operationId: "foreign" }],
    ["delivery ref", scope, { ...delivery, deliveryRef: "foreign" }],
    ["delivery action", scope, { ...delivery, actionId: "foreign" }],
    [
      "target",
      { ...scope, target: { ...target, repo: "owner/foreign" } },
      delivery
    ],
    [
      "source",
      { ...scope, source: { ...snapshot.provenance, branch: "foreign" } },
      delivery
    ]
  ])(
    "refuses foreign cancellation %s without cancelling owned work",
    async (_label, inputScope, inputDelivery) => {
      const f = fixture();
      await f.assign();
      expect(
        await f.agent.cancel(
          { ...inputScope, operation: "operation.cancel" },
          inputDelivery,
          f.control
        )
      ).toEqual(portForbidden());
      expect(f.host.cancel).not.toHaveBeenCalled();
      expect(await f.authenticate()).toMatchObject({ status: "ok" });
    }
  );

  it("rechecks host binding after cancellation", async () => {
    const f = fixture();
    await f.assign();
    f.host.cancel.mockImplementationOnce(async () => {
      f.host.binding.mockReturnValue({ ...caller, agentBindingRef: "foreign" });
      return portSuccess(cancellation);
    });
    expect(await f.cancel()).toEqual(portForbidden());
  });

  it.each(["request", "close"] as const)(
    "rechecks %s cancellation after a failed host request",
    async (kind) => {
      const f = fixture();
      f.host.issueAssignment.mockImplementationOnce(async () => {
        if (kind === "request") f.signal.aborted = true;
        else f.agent.close();
        throw new Error("private exception");
      });
      expect(await f.assign()).toEqual(
        portCancelled(
          kind === "request" ? "request_cancelled" : "session_shutdown"
        )
      );
      expect(f.host.dispatch).not.toHaveBeenCalled();
    }
  );
});
