import { describe, expect, it, vi } from "vitest";
import {
  portForbidden,
  portSuccess,
  buildEffectiveInputManifest,
  type CallerContext,
  type LifecycleRequestFor,
  type RequestControl,
  type AuthorizationRequest,
  type AuthorizedScope,
  type LifecycleOperation
} from "@radius-project/core/lifecycle";
import {
  createLifecycleAuthorization,
  createCanvasLifecycleAuthority,
  unavailableCanvasLifecyclePrerequisite,
  type LifecycleAuthority
} from "./lifecycle-authorization.js";

const caller: CallerContext = {
  principalRef: "principal",
  sessionRef: "session",
  identityRef: "identity",
  responder: "agent",
  agentBindingRef: "binding"
};

it("publishes the static missing-prerequisite explanation as bounded diagnostics", () => {
  const result = unavailableCanvasLifecyclePrerequisite();
  const limitation =
    "The host does not provide verified user approval or external agent assignment authority.";
  expect(result).toMatchObject({
    status: "unavailable",
    observation: { limitation },
    error: {
      code: "CAPABILITY_UNAVAILABLE",
      retryable: false,
      details: [{ message: limitation, truncated: false }]
    }
  });
});
const control: RequestControl = {
  requestId: "request",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
const request: LifecycleRequestFor<"operation.respond"> = {
  apiVersion: "github-radius/v1",
  requestId: "request",
  operation: "operation.respond",
  target: { repo: "owner/repo" },
  input: {
    operationId: "operation",
    actionId: "action",
    response: { kind: "user.decision", choice: "approve" }
  }
};
function grant<O extends LifecycleOperation>(
  input: AuthorizationRequest<O>
): AuthorizedScope<O> {
  const scope: AuthorizedScope = {
    ...input,
    authorizationRef: "authorization",
    principalRef: input.caller.principalRef
  };
  return scope as AuthorizedScope<O>;
}
const diffSource = {
  definition: ".radius/app.bicep",
  source: {
    kind: "git" as const,
    ref: "feature",
    expectedCommit: "a".repeat(40)
  }
};
function authority(
  overrides: Partial<LifecycleAuthority> = {}
): LifecycleAuthority {
  return {
    resolveCaller: async () => portSuccess(caller),
    authorize: async (input) => portSuccess(grant(input)),
    authorizeResponse: async () => {
      throw new Error("Unmodeled response authorization");
    },
    ...overrides
  };
}

describe("trusted lifecycle authorization", () => {
  describe.each(["graph.diff", "definition.validate"] as const)(
    "independent %s repository access",
    (operation) => {
      function graphAuthority() {
        const binding = { bindingRef: "binding", sessionRef: "session" };
        const identity = vi.fn(async () => ({ actingLogin: "account" }));
        const run = vi.fn<
          (
            args: string[]
          ) => Promise<{ code: number; stdout: string; stderr: string }>
        >(async () => {
          throw new Error("Unmodeled authenticated repository read");
        });
        const executor = vi.fn(async (login: string) => ({ login, run }));
        const value = createCanvasLifecycleAuthority({
          binding: () => binding,
          identity,
          workspace: async () => ({ repo: "owner/repo" }),
          executor,
          responseAuthority: async () => portForbidden()
        });
        const trusted: CallerContext = {
          principalRef: "github:account",
          identityRef: "github:account",
          sessionRef: "session",
          responder: "agent",
          agentBindingRef: "binding"
        };
        return {
          value,
          run,
          identity,
          executor,
          request: {
            caller: trusted,
            operation,
            target: { repo: "fork/repo", ...diffSource }
          }
        };
      }
      it("authorizes the full fork selection only after actual selected-account repository access", async () => {
        const fixture = graphAuthority();
        fixture.run.mockResolvedValue({
          code: 0,
          stdout: '{"full_name":"fork/repo"}',
          stderr: ""
        });
        const result = await fixture.value.authorize(fixture.request, control);
        expect(result).toMatchObject({
          status: "ok",
          value: { operation, target: fixture.request.target }
        });
        expect(fixture.executor).toHaveBeenCalledWith("account");
        expect(fixture.run.mock.calls[0][0]).toEqual([
          "api",
          "--hostname",
          "github.com",
          "--method",
          "GET",
          "/repos/fork/repo"
        ]);
        expect(fixture.identity).toHaveBeenCalledTimes(2);
      });
      it.each([
        { code: 1, stdout: "", stderr: "HTTP 403" },
        { code: 0, stdout: '{"full_name":"wrong/repo"}', stderr: "" },
        { code: 0, stdout: "{}", stderr: "" }
      ])(
        "refuses inaccessible or mismatched repository evidence",
        async (response) => {
          const fixture = graphAuthority();
          fixture.run.mockResolvedValue(response);
          expect(
            await fixture.value.authorize(fixture.request, control)
          ).toMatchObject({ status: "forbidden" });
        }
      );
      it("rechecks identity immediately before the authenticated fork read", async () => {
        const fixture = graphAuthority();
        fixture.identity
          .mockResolvedValueOnce({ actingLogin: "account" })
          .mockResolvedValueOnce({ actingLogin: "switched" });
        expect(
          await fixture.value.authorize(fixture.request, control)
        ).toMatchObject({ status: "forbidden" });
        expect(fixture.run).not.toHaveBeenCalled();
      });
      it("fails closed when the selected-account executor is unavailable", async () => {
        const fixture = graphAuthority();
        fixture.executor.mockRejectedValue(
          new Error("private credential details")
        );
        const result = await fixture.value.authorize(fixture.request, control);
        expect(result).toMatchObject({ status: "unavailable" });
        expect(JSON.stringify(result)).not.toContain("private credential");
      });
    }
  );
  it("rejects missing authority at construction", () => {
    for (const value of [
      undefined,
      {},
      { resolveCaller() {} },
      { resolveCaller() {}, authorize() {} }
    ]) {
      expect(() =>
        Reflect.apply(createLifecycleAuthorization, undefined, [value])
      ).toThrow("trusted");
    }
  });

  describe("Canvas identity helper binding", () => {
    it("resolves the acting GitHub identity only for the attached session and current workspace", async () => {
      const binding = { bindingRef: "binding", sessionRef: "session" };
      const authority = createCanvasLifecycleAuthority({
        binding: () => binding,
        identity: async () => ({ actingLogin: "account" }),
        workspace: async () => ({ repo: "owner/repo" }),
        responseAuthority: async () => portForbidden()
      });
      const resolved = await authority.resolveCaller(binding, control);
      expect(resolved).toMatchObject({
        status: "ok",
        value: { principalRef: "github:account", responder: "agent" }
      });
      if (resolved.status !== "ok") throw new Error("Resolution failed");
      expect(
        await authority.authorize(
          {
            caller: resolved.value,
            operation: request.operation,
            target: request.target
          },
          control
        )
      ).toMatchObject({ status: "ok" });
      expect(
        await authority.authorize(
          {
            caller: { ...resolved.value, principalRef: "other" },
            operation: request.operation,
            target: request.target
          },
          control
        )
      ).toMatchObject({ status: "forbidden" });
      expect(
        await authority.authorize(
          {
            caller: resolved.value,
            operation: "operation.get",
            target: request.target
          },
          control
        )
      ).toMatchObject({ status: "unavailable" });
      expect(
        await authority.resolveCaller(binding, {
          ...control,
          cancellation: { ...control.cancellation, aborted: true }
        })
      ).toMatchObject({ status: "cancelled" });
      expect(
        await authority.authorize(
          {
            caller: resolved.value,
            operation: request.operation,
            target: { repo: "other/repo" }
          },
          control
        )
      ).toMatchObject({ status: "forbidden" });
      expect(
        await authority.resolveCaller(
          { ...binding, sessionRef: "other" },
          control
        )
      ).toMatchObject({ status: "forbidden" });
    });
    it("requires actual identity and host approval adapters rather than credential claims", async () => {
      expect(() =>
        Reflect.apply(createCanvasLifecycleAuthority, undefined, [{}])
      ).toThrow("identity");
      const binding = { bindingRef: "binding", sessionRef: "session" };
      const authority = createCanvasLifecycleAuthority({
        binding: () => binding,
        identity: async () => ({ actingLogin: "" }),
        workspace: async () => ({ repo: "owner/repo" }),
        responseAuthority: async () => portForbidden()
      });
      expect(await authority.resolveCaller(binding, control)).toMatchObject({
        status: "unavailable"
      });
      expect(
        await authority.authorize(
          {
            caller,
            operation: request.operation,
            target: request.target
          },
          control
        )
      ).toMatchObject({ status: "unavailable" });
    });
  });
  it("binds callers to the host session and preserves typed operation scope", async () => {
    const auth = createLifecycleAuthorization(authority());
    expect(
      await auth.resolveCaller(
        { bindingRef: "binding", sessionRef: "session" },
        control
      )
    ).toEqual(portSuccess(caller));
    expect(
      await auth.resolveCaller(
        { bindingRef: "binding", sessionRef: "other" },
        control
      )
    ).toMatchObject({ status: "forbidden" });
    expect(await auth.authorize(caller, request, control)).toMatchObject({
      status: "ok",
      value: { operationId: "operation", target: request.target }
    });
  });
  it("fails closed when identity resolution or authorization is unavailable", async () => {
    const auth = createLifecycleAuthorization(
      authority({
        resolveCaller: async () => {
          throw new Error("offline");
        },
        authorize: async () => {
          throw new Error("offline");
        }
      })
    );
    expect(
      await auth.resolveCaller(
        { bindingRef: "binding", sessionRef: "session" },
        control
      )
    ).toMatchObject({ status: "unavailable" });
    expect(await auth.authorize(caller, request, control)).toMatchObject({
      status: "unavailable"
    });
  });
  it("rejects authority returned for another principal and propagates denial", async () => {
    const denied = createLifecycleAuthorization(
      authority({ authorize: async () => portForbidden() })
    );
    expect(await denied.authorize(caller, request, control)).toMatchObject({
      status: "forbidden"
    });
    const wrong = createLifecycleAuthorization(
      authority({
        authorize: async (input) => {
          const scope = grant(input);
          return portSuccess(Object.assign(scope, { principalRef: "other" }));
        }
      })
    );
    expect(await wrong.authorize(caller, request, control)).toMatchObject({
      status: "forbidden"
    });
  });
  it("independently authorizes both diff scopes", async () => {
    const targets: string[] = [];
    const auth = createLifecycleAuthorization(
      authority({
        authorize: async (input) => {
          targets.push(
            "environment" in input.target ?
              (input.target.environment ?? "")
            : ""
          );
          return targets.length === 2 ?
              portForbidden()
            : portSuccess(grant(input));
        }
      })
    );
    expect(
      await auth.authorizeDiff(
        caller,
        {
          ...request,
          operation: "graph.diff",
          input: {
            kind: "deployed",
            base: {
              ...diffSource,
              repo: "owner/repo",
              environment: "base",
              application: "app"
            },
            head: {
              ...diffSource,
              repo: "owner/repo",
              environment: "head",
              application: "app"
            }
          }
        },
        control
      )
    ).toMatchObject({ status: "forbidden" });
    expect(targets).toEqual(["base", "head"]);
  });
  it("returns both authorized diff scopes on success", async () => {
    const auth = createLifecycleAuthorization(authority());
    expect(
      await auth.authorizeDiff(
        caller,
        {
          ...request,
          operation: "graph.diff",
          input: {
            kind: "deployed",
            base: {
              ...diffSource,
              repo: "owner/repo",
              environment: "base",
              application: "app"
            },
            head: {
              ...diffSource,
              repo: "owner/repo",
              environment: "head",
              application: "app"
            }
          }
        },
        control
      )
    ).toMatchObject({
      status: "ok",
      value: [
        { target: { environment: "base" } },
        { target: { environment: "head" } }
      ]
    });
  });
  it.each(["principalRef", "identityRef"] as const)(
    "rejects missing %s and preserves resolver refusal",
    async (key) => {
      const auth = createLifecycleAuthorization(
        authority({
          resolveCaller: async () => portSuccess({ ...caller, [key]: "" })
        })
      );
      expect(
        await auth.resolveCaller(
          { bindingRef: "binding", sessionRef: "session" },
          control
        )
      ).toMatchObject({ status: "forbidden" });
      const denied = createLifecycleAuthorization(
        authority({ resolveCaller: async () => portForbidden() })
      );
      expect(
        await denied.resolveCaller(
          { bindingRef: "binding", sessionRef: "session" },
          control
        )
      ).toMatchObject({ status: "forbidden" });
    }
  );
  it("fences cancelled calls before and after authority I/O", async () => {
    const signal = { aborted: true, onAbort: () => () => {} };
    const cancelledControl = { ...control, cancellation: signal };
    const auth = createLifecycleAuthorization(
      authority({
        resolveCaller: async () => {
          signal.aborted = true;
          return portSuccess(caller);
        },
        authorize: async (input) => {
          signal.aborted = true;
          return portSuccess(grant(input));
        }
      })
    );
    expect(
      await auth.resolveCaller(
        { bindingRef: "binding", sessionRef: "session" },
        cancelledControl
      )
    ).toMatchObject({ status: "cancelled" });
    expect(
      await auth.authorize(caller, request, cancelledControl)
    ).toMatchObject({ status: "cancelled" });
    signal.aborted = false;
    expect(
      await auth.resolveCaller(
        { bindingRef: "binding", sessionRef: "session" },
        cancelledControl
      )
    ).toMatchObject({ status: "cancelled" });
    signal.aborted = false;
    expect(
      await auth.authorize(caller, request, cancelledControl)
    ).toMatchObject({ status: "cancelled" });
  });
  it("checks the original source expectation before trusting resolved source authority", async () => {
    const selection: LifecycleRequestFor<"definition.validate"> = {
      ...request,
      operation: "definition.validate",
      target: {
        repo: "owner/repo",
        definition: ".radius/app.bicep",
        source: { kind: "git", ref: "feature", expectedCommit: "a".repeat(40) }
      },
      input: { policyVersion: "github-radius/validation/v1" }
    };
    const source = {
      kind: "git" as const,
      repo: "owner/repo",
      ref: "feature",
      commit: "a".repeat(40),
      fingerprint: `sha256:${"b".repeat(64)}`,
      resolvedAt: "2026-09-15T00:00:00Z"
    };
    const manifest = buildEffectiveInputManifest(
      {
        definition: selection.target.definition,
        closure: "complete",
        inputs: [
          {
            path: selection.target.definition,
            kind: "definition",
            contentHash: source.fingerprint,
            existed: true
          }
        ]
      },
      () => source.fingerprint
    );
    if (manifest.status !== "ok" || manifest.value.completeness !== "complete")
      throw new Error("Invalid manifest fixture");
    const snapshot = {
      snapshotRef: "snapshot",
      selection: selection.target,
      provenance: source,
      manifest: manifest.value
    };
    const auth = createLifecycleAuthorization(authority());
    expect(
      await auth.authorize(caller, selection, control, snapshot)
    ).toMatchObject({ status: "ok" });
    expect(
      await auth.authorize(caller, selection, control, {
        ...snapshot,
        provenance: { ...source, commit: "c".repeat(40) }
      })
    ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
  });
  it.each([
    { authorizationRef: "" },
    { operation: "operation.get" as const },
    { operationId: "other" },
    { target: { repo: "other/repo" } },
    { target: { repo: "owner/repo", environment: "other" } },
    { target: { repo: "owner/repo", application: "other" } },
    { target: { repo: "owner/repo", definition: "other.bicep" } }
  ])("rejects mismatched authority %j", async (override) => {
    const auth = createLifecycleAuthorization(
      authority({
        authorize: async (input) => {
          const valid = grant(input);
          Object.assign(valid, override);
          return portSuccess(valid);
        }
      })
    );
    expect(await auth.authorize(caller, request, control)).toMatchObject({
      status: "forbidden"
    });
  });
});
