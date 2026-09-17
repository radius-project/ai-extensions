import { describe, expect, it, vi } from "vitest";
import {
  portSuccess,
  portFailure,
  portForbidden,
  portCancelled,
  createOperationRecord,
  type AuthorizationRequest,
  type AuthorizedScope,
  type CallerContext,
  type LifecycleOperation,
  repositorySchema,
  gitRefSchema,
  type Source
} from "@radius-project/core/lifecycle";
import {
  createLifecycleBinding,
  type LifecycleBindingDependencies
} from "./create-lifecycle-binding.js";
import { RADIUS_LIFECYCLE_TOOL_DECLARATION } from "./declarations.js";
import {
  createLifecycleFixture,
  createStrictLifecyclePorts
} from "../../test/support/lifecycle.js";

const caller: CallerContext = {
  principalRef: "principal",
  identityRef: "identity",
  sessionRef: "session",
  responder: "user"
};
const source: Source = {
  kind: "workspace",
  workspaceRef: "workspace",
  branch: "feature",
  expectedFingerprint: `sha256:${"a".repeat(64)}`
};
function grant<O extends LifecycleOperation>(
  input: AuthorizationRequest<O>
): AuthorizedScope<O> {
  const scope: AuthorizedScope = {
    ...input,
    authorizationRef: "auth",
    principalRef: caller.principalRef
  };
  return scope as AuthorizedScope<O>;
}
function fixture(overrides: Partial<LifecycleBindingDependencies> = {}) {
  let sequence = 0;
  let resolutions = 0;
  const binding = createLifecycleBinding({
    ids: { next: (kind) => `${kind}-${++sequence}` },
    clock: { now: () => "2026-09-15T00:00:00Z" },
    hostBinding: () => ({ bindingRef: "binding", sessionRef: "session" }),
    authority: {
      resolveCaller: async () => portSuccess(caller),
      authorize: async (input) => portSuccess(grant(input)),
      authorizeResponse: async () => {
        throw new Error("Unmodeled response authority");
      }
    },
    resolveWorkspaceSource: async () => {
      resolutions++;
      return portSuccess(source);
    },
    knownLegacyOperations: () => [],
    ...overrides
  });
  return { binding, resolutions: () => resolutions };
}
const respond = {
  operation: "operation.respond",
  target: { repo: "owner/repo" },
  input: {
    operationId: "missing",
    actionId: "action",
    response: { kind: "user.decision", choice: "approve" }
  }
};
const validate = {
  operation: "definition.validate",
  target: { repo: "owner/repo", definition: ".radius/app.bicep" },
  input: { policyVersion: "github-radius/validation/v1" }
};
describe("panel-free lifecycle binding", () => {
  it("closes the registry despite failed discovery cleanup and retries only the unfinished local owner", async () => {
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected discovery read");
    };
    const closeDiscovery = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error("Discovery close failed"));
    const f = fixture({
      discovery: {
        applications: { list: unexpected, inspect: unexpected },
        environments: { list: unexpected, inspect: unexpected },
        capabilities: [],
        close: closeDiscovery
      }
    });
    const closeRegistry = vi.spyOn(f.binding.registry, "close");
    const results = await Promise.allSettled([
      f.binding.close(),
      f.binding.close()
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected"
    ]);
    expect(closeDiscovery).toHaveBeenCalledOnce();
    expect(closeRegistry).toHaveBeenCalledOnce();
    await f.binding.close();
    await f.binding.close();
    expect(closeDiscovery).toHaveBeenCalledTimes(2);
    expect(closeRegistry).toHaveBeenCalledOnce();
    expect(await f.binding.execute(respond)).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
  });
  it.each([
    ["", "main"],
    ["not-a-repository", "main"],
    [`owner/${"r".repeat(repositorySchema.maxLength)}`, "main"],
    ["owner/repo", ""],
    ["owner/repo", "bad ref"],
    ["owner/repo", "r".repeat(gitRefSchema.maxLength + 1)],
    [null, "main"],
    ["owner/repo", 42]
  ])(
    "rejects invalid committed selection %j @ %j before identity or source I/O",
    async (repo, ref) => {
      const resolveGitSource = vi
        .fn<NonNullable<LifecycleBindingDependencies["resolveGitSource"]>>()
        .mockRejectedValue(new Error("Unexpected committed source read"));
      const f = fixture({ resolveGitSource });
      expect(
        await Reflect.apply(f.binding.resolveCommittedSource, f.binding, [
          repo,
          ref
        ])
      ).toEqual(portFailure("INVALID_REQUEST"));
      expect(resolveGitSource).not.toHaveBeenCalled();
      await f.binding.close();
    }
  );
  it("reports unavailable committed-source capability and fences reads after close", async () => {
    const f = fixture();
    expect(
      await f.binding.resolveCommittedSource("owner/repo", "main")
    ).toMatchObject({
      status: "unavailable",
      error: { code: "CAPABILITY_UNAVAILABLE" }
    });
    await f.binding.close();
    expect(
      await f.binding.resolveCommittedSource("owner/repo", "main")
    ).toEqual(portFailure("PRECONDITION_FAILED"));
  });
  it.each(["caller", "scope"] as const)(
    "propagates %s denial before reading committed content",
    async (denied) => {
      const resolveGitSource = vi
        .fn<NonNullable<LifecycleBindingDependencies["resolveGitSource"]>>()
        .mockRejectedValue(new Error("Unexpected committed source read"));
      const f = fixture({
        resolveGitSource,
        authority: createStrictLifecyclePorts({
          identity: {
            resolveCaller: async () =>
              denied === "caller" ? portForbidden() : portSuccess(caller),
            authorize: async () => portForbidden()
          }
        }).identity
      });
      expect(
        await f.binding.resolveCommittedSource("owner/repo", "main")
      ).toEqual(portForbidden());
      expect(resolveGitSource).not.toHaveBeenCalled();
      await f.binding.close();
    }
  );
  it.each(["principal", "repository"] as const)(
    "rejects a mismatched %s grant before reading committed content",
    async (mismatch) => {
      const resolveGitSource = vi
        .fn<NonNullable<LifecycleBindingDependencies["resolveGitSource"]>>()
        .mockRejectedValue(new Error("Unexpected committed source read"));
      const f = fixture({
        resolveGitSource,
        authority: createStrictLifecyclePorts({
          identity: {
            resolveCaller: async () => portSuccess(caller),
            authorize: async (input) =>
              portSuccess({
                ...grant(input),
                ...(mismatch === "principal" ?
                  { principalRef: "other-principal" }
                : { target: { ...input.target, repo: "other/repo" } })
              })
          }
        }).identity
      });
      expect(
        await f.binding.resolveCommittedSource("owner/repo", "main")
      ).toEqual(portFailure("PRECONDITION_FAILED"));
      expect(resolveGitSource).not.toHaveBeenCalled();
      await f.binding.close();
    }
  );
  it("returns a pinned commit only while its binding remains open", async () => {
    const committed: Source = {
      kind: "git",
      ref: "feature",
      expectedCommit: "b".repeat(40)
    };
    let release: () => void = () => {
      throw new Error("Resolution barrier not initialized");
    };
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolveGitSource = vi
      .fn<NonNullable<LifecycleBindingDependencies["resolveGitSource"]>>()
      .mockResolvedValueOnce(portSuccess(committed))
      .mockImplementationOnce(async (_scope, _ref, control) => {
        await pending;
        expect(control.cancellation.aborted).toBe(true);
        return portSuccess(committed);
      })
      .mockRejectedValueOnce(new Error("Source transport failed"));
    const f = fixture({ resolveGitSource });
    expect(
      await f.binding.resolveCommittedSource("owner/repo", "feature")
    ).toEqual(portSuccess(committed));
    const late = f.binding.resolveCommittedSource("owner/repo", "feature");
    await vi.waitFor(() => expect(resolveGitSource).toHaveBeenCalledTimes(2));
    await f.binding.close();
    release();
    expect(await late).toEqual(portFailure("PRECONDITION_FAILED"));
    const failed = fixture({ resolveGitSource });
    expect(
      await failed.binding.resolveCommittedSource("owner/repo", "feature")
    ).toMatchObject({
      status: "unavailable",
      error: { code: "SOURCE_UNAVAILABLE" }
    });
    await failed.binding.close();
  });
  it("reads workspace revision intent through the existing trusted resolver without dispatch", async () => {
    const f = fixture();
    expect(
      await f.binding.resolveWorkspaceSource({
        repo: "owner/repo",
        definition: ".radius/app.bicep"
      })
    ).toEqual(portSuccess(source));
    expect(f.resolutions()).toBe(1);
    expect(f.binding.hasActiveOperations()).toBe(false);
    await f.binding.close();
    expect(
      await f.binding.resolveWorkspaceSource({ repo: "owner/repo" })
    ).toEqual(portFailure("PRECONDITION_FAILED"));
    expect(f.resolutions()).toBe(1);
  });
  it("fences a revision result that finishes after shutdown", async () => {
    let complete: () => void = () => {
      throw new Error("Not started");
    };
    const f = fixture({
      resolveWorkspaceSource: () =>
        new Promise((resolve) => {
          complete = () => resolve(portSuccess(source));
        })
    });
    const pending = f.binding.resolveWorkspaceSource({ repo: "owner/repo" });
    expect(f.binding.hasActiveOperations()).toBe(true);
    await f.binding.close();
    complete();
    expect(await pending).toEqual(portFailure("PRECONDITION_FAILED"));
    expect(f.binding.hasActiveOperations()).toBe(false);
  });
  it("releases revision keepalive after resolver failure", async () => {
    const f = fixture({
      resolveWorkspaceSource: async () => {
        throw new Error("Source read failed");
      }
    });
    await expect(
      f.binding.resolveWorkspaceSource({ repo: "owner/repo" })
    ).rejects.toThrow("Source read failed");
    expect(f.binding.hasActiveOperations()).toBe(false);
    await f.binding.close();
  });
  it("propagates denied and cancelled caller resolution without dispatch", async () => {
    for (const result of [
      portForbidden(),
      portCancelled("request_cancelled")
    ]) {
      const f = fixture({
        authority: createStrictLifecyclePorts({
          identity: {
            resolveCaller: async () => result
          }
        }).identity
      });
      expect(await f.binding.execute(respond)).toMatchObject({
        error: {
          code:
            result.status === "forbidden" ? "FORBIDDEN" : "PRECONDITION_FAILED"
        }
      });
      await f.binding.close();
    }
  });
  it.each(["target", "base", "head"] as const)(
    "preserves explicit unavailable/cancelled source outcomes for %s",
    async (location) => {
      for (const result of [
        portFailure("SOURCE_CHANGED", {
          diagnostics: [
            { message: "The selected source changed.", truncated: false }
          ]
        }),
        portCancelled("request_cancelled")
      ]) {
        let resolutions = 0;
        const f = fixture({
          resolveWorkspaceSource: async () => {
            resolutions++;
            return location === "head" && resolutions === 1 ?
                portSuccess(source)
              : result;
          }
        });
        const intent =
          location === "target" ? validate : (
            {
              operation: "graph.diff",
              target: { repo: "owner/repo" },
              input: {
                kind: "authored",
                base: validate.target,
                head: validate.target
              }
            }
          );
        const response = await f.binding.execute(intent);
        expect(response).toMatchObject({
          error: {
            code:
              result.status === "failed" ?
                "SOURCE_CHANGED"
              : "PRECONDITION_FAILED"
          }
        });
        expect(
          "error" in response ? response.error.details : undefined
        ).toEqual("error" in result ? result.error.details : undefined);
        expect(resolutions).toBe(location === "head" ? 2 : 1);
        await f.binding.close();
      }
    }
  );
  it("owns pending request lifetime and idempotent cancellation listeners even without an operation", async () => {
    let cancelled = 0;
    let f: ReturnType<typeof fixture>;
    f = fixture({
      resolveWorkspaceSource: async (_target, control) => {
        expect(f.binding.hasActiveOperations()).toBe(true);
        const unsubscribe = control.cancellation.onAbort(() => {
          cancelled += 100;
        });
        unsubscribe();
        unsubscribe();
        control.cancellation.onAbort(() => {
          cancelled++;
        });
        control.cancellation.onAbort(() => {
          throw new Error("Observer failure");
        });
        await f.binding.close();
        control.cancellation.onAbort(() => {
          cancelled++;
        })();
        return portCancelled("session_shutdown");
      }
    });
    expect(await f.binding.execute(validate)).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(cancelled).toBe(2);
    expect(f.binding.hasActiveOperations()).toBe(false);
  });
  it("keeps definition, deployment and application identities independently addressable", async () => {
    const f = createLifecycleFixture();
    const selections = [
      {
        operation: "definition.author" as const,
        target: { repo: "owner/repo", definition: ".radius/app.bicep", source }
      },
      {
        operation: "application.delete" as const,
        target: { repo: "owner/repo", environment: "dev", application: "app" }
      },
      {
        operation: "deployment.start" as const,
        target: {
          repo: "owner/repo",
          environment: "dev",
          application: "app",
          definition: ".radius/app.bicep",
          source: {
            kind: "git" as const,
            ref: "feature",
            expectedCommit: "a".repeat(40)
          }
        }
      }
    ];
    for (const selection of selections) {
      const scope: AuthorizedScope = {
        ...selection,
        authorizationRef: "auth",
        principalRef: f.caller.principalRef
      };
      const operation = createOperationRecord(f.ports, selection);
      await f.binding.registry.create(scope, operation, {
        requestId: "request",
        cancellation: { aborted: false, onAbort: () => () => {} }
      });
      expect(f.binding.routing.address(operation.operationId)).toBe(
        "lifecycle"
      );
    }
    await f.binding.close();
  });
  it("reports cancellation from an accepted continuation without claiming parent success", async () => {
    const f = createLifecycleFixture();
    const pending = await f.pendingAction({
      revalidate: async () => portSuccess(undefined),
      continue: async () => portCancelled("request_cancelled")
    });
    expect(await f.binding.execute(pending.intent)).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
    await f.binding.close();
  });
  it("supplies version and request identity and registers only the implemented response handler", async () => {
    const { binding } = fixture();
    expect(await binding.execute(respond)).toMatchObject({
      apiVersion: "github-radius/v1",
      requestId: "request-1",
      error: { code: "OPERATION_UNAVAILABLE" }
    });
    expect(
      binding
        .capabilities()
        .filter((item) => item.available)
        .map((item) => item.operation)
    ).toEqual(["capabilities.get", "operation.respond"]);
    expect(
      await binding.execute({
        operation: "capabilities.get",
        target: { repo: "owner/repo" },
        input: {}
      })
    ).toMatchObject({
      operation: "capabilities.get",
      result: { target: { repo: "owner/repo" } }
    });
    await binding.close();
    await binding.close();
    expect(await binding.execute(respond)).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
  });
  it("resolves omitted source through trusted workspace context without overriding explicit expectations", async () => {
    const f = fixture();
    expect(await f.binding.execute(validate)).toMatchObject({
      error: { code: "CAPABILITY_UNAVAILABLE" }
    });
    expect(f.resolutions()).toBe(1);
    expect(
      await f.binding.execute({
        ...validate,
        target: { ...validate.target, source }
      })
    ).toMatchObject({ error: { code: "CAPABILITY_UNAVAILABLE" } });
    expect(
      await f.binding.execute({
        ...validate,
        target: {
          ...validate.target,
          source: { ...source, expectedFingerprint: "invalid" }
        }
      })
    ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(
      await f.binding.execute({
        ...validate,
        target: {
          ...validate.target,
          source: { kind: "git", ref: "feature", expectedCommit: "invalid" }
        }
      })
    ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(f.resolutions()).toBe(1);
    await f.binding.close();
  });
  it("resolves diff selections independently without opening any presentation surface", async () => {
    const f = fixture();
    expect(
      await f.binding.execute({
        operation: "graph.diff",
        target: { repo: "owner/repo" },
        input: {
          kind: "authored",
          base: validate.target,
          head: validate.target
        }
      })
    ).toMatchObject({ error: { code: "CAPABILITY_UNAVAILABLE" } });
    expect(f.resolutions()).toBe(2);
    await f.binding.close();
  });
  it("rejects untrusted identity, credential and approval claims rather than copying them into authority", async () => {
    const f = fixture();
    for (const key of [
      "caller",
      "principalRef",
      "approved",
      "credentials",
      "apiVersion",
      "requestId"
    ]) {
      expect(
        await f.binding.execute({ ...respond, [key]: "claim" })
      ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    }
    expect(
      await f.binding.execute({
        ...respond,
        input: { ...respond.input, approved: true }
      })
    ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(await f.binding.execute(null)).toMatchObject({
      error: { code: "INVALID_REQUEST" }
    });
    await f.binding.close();
  });
  it("fails closed on missing host context and unavailable source resolution", async () => {
    expect(() =>
      Reflect.apply(createLifecycleBinding, undefined, [{}])
    ).toThrow("trusted");
    const noHost = fixture({
      hostBinding: () => {
        throw new Error("not attached");
      }
    });
    expect(await noHost.binding.execute(respond)).toMatchObject({
      error: { code: "CAPABILITY_UNAVAILABLE" }
    });
    const noSource = fixture({
      resolveWorkspaceSource: async () => {
        throw new Error("not available");
      }
    });
    expect(await noSource.binding.execute(validate)).toMatchObject({
      error: { code: "CAPABILITY_UNAVAILABLE" }
    });
    await noHost.binding.close();
    await noSource.binding.close();
  });
  it("advertises exactly the shared operation names, with no arbitrary operation bag", () => {
    expect(RADIUS_LIFECYCLE_TOOL_DECLARATION.parameters).toMatchObject({
      type: "object",
      properties: {
        operation: {
          enum: expect.arrayContaining(["operation.respond", "graph.diff"])
        }
      }
    });
    const variants = RADIUS_LIFECYCLE_TOOL_DECLARATION.parameters.oneOf;
    expect(variants).toHaveLength(21);
  });
});
