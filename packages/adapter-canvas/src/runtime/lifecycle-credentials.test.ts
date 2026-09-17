import { expect, it, vi } from "vitest";
import { portForbidden, portSuccess } from "@radius-project/core/lifecycle";
import { createCanvasLifecycleCredentials } from "./lifecycle-credentials.js";
import { createLifecycleFixture } from "../../test/support/lifecycle.js";

async function fixture() {
  const foundation = createLifecycleFixture();
  const scope = {
    authorizationRef: "authority",
    principalRef: foundation.caller.principalRef,
    operation: "credentials.inspect" as const,
    target: { repo: "owner/repo" }
  };
  const control = {
    requestId: "request",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  const state = {
    azure: JSON.stringify({
      tenantId: "11111111-1111-1111-1111-111111111111",
      id: "33333333-3333-3333-3333-333333333333",
      user: { name: "fixture-user", type: "user" }
    }),
    aws: JSON.stringify({
      Account: "000011112222",
      Arn: "arn:aws:iam::000011112222:user/fixture-user"
    }),
    failure: undefined as Error | undefined
  };
  const runCommand = vi.fn(async (command: "az" | "aws", args: string[]) => {
    if (state.failure) throw state.failure;
    expect(args).toEqual(
      command === "az" ?
        ["account", "show", "-o", "json"]
      : ["sts", "get-caller-identity", "--output", "json"]
    );
    return state[command === "az" ? "azure" : "aws"];
  });
  const deps = {
    authority: foundation.ports.identity,
    hostBinding: () => ({
      bindingRef: "fixture-binding",
      sessionRef: foundation.caller.sessionRef
    }),
    clock: foundation.ports.clock,
    runCommand
  };
  return {
    foundation,
    scope,
    control,
    state,
    runCommand,
    deps,
    close: () => foundation.binding.close()
  };
}
it("verifies both actual cloud identities without exposing their raw provider payloads", async () => {
  const f = await fixture();
  try {
    const credentials = createCanvasLifecycleCredentials(f.deps);
    const result = await credentials.inspect(f.scope, {}, f.control);
    expect(result).toMatchObject({
      status: "ok",
      value: {
        prerequisites: [
          {
            provider: "azure",
            status: "satisfied",
            identityRef: expect.any(String)
          },
          {
            provider: "aws",
            status: "satisfied",
            identityRef: expect.any(String)
          }
        ]
      }
    });
    expect(JSON.stringify(result)).not.toContain("fixture-user");
    expect(JSON.stringify(result)).not.toContain("000011112222");
    expect(credentials.configure).toBeUndefined();
    expect(f.runCommand).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});
it.each(["azure", "aws"] as const)(
  "does not trust a saved completion or malformed %s identity",
  async (provider) => {
    const f = await fixture();
    try {
      f.state[provider] = JSON.stringify({
        status: "completed",
        identityRef: "claimed-profile"
      });
      const result = await createCanvasLifecycleCredentials(f.deps).inspect(
        f.scope,
        { provider },
        f.control
      );
      expect(result).toMatchObject({
        status: "ok",
        value: { prerequisites: [{ status: "unavailable" }] }
      });
    } finally {
      await f.close();
    }
  }
);
it.each([
  ["Please run az login", "missing"],
  ["spawn az ENOENT", "unavailable"],
  ["controlled provider diagnostic with private details", "unavailable"]
] as const)(
  "classifies provider failure without echoing %s",
  async (message, status) => {
    const f = await fixture();
    try {
      f.state.failure = new Error(message);
      const result = await createCanvasLifecycleCredentials(f.deps).inspect(
        f.scope,
        { provider: "azure" },
        f.control
      );
      expect(result).toMatchObject({
        status: "ok",
        value: { prerequisites: [{ status }] }
      });
      expect(JSON.stringify(result)).not.toContain(message);
    } finally {
      await f.close();
    }
  }
);
it("refuses a changed principal before cloud access", async () => {
  const f = await fixture();
  try {
    const credentials = createCanvasLifecycleCredentials({
      ...f.deps,
      authority: { ...f.deps.authority, authorize: async () => portForbidden() }
    });
    expect(await credentials.inspect(f.scope, {}, f.control)).toMatchObject({
      status: "forbidden"
    });
    expect(f.runCommand).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("uses an explicitly supplied authentication binding and independently reads the resulting identity", async () => {
  const f = await fixture();
  try {
    const configure = vi.fn(async () => portSuccess(undefined));
    const credentials = createCanvasLifecycleCredentials({
      ...f.deps,
      configure
    });
    if (!credentials.configure)
      throw new Error("Missing configured mutation binding");
    const result = await credentials.configure(
      { ...f.scope, operation: "credentials.configure" },
      { provider: "azure", intent: "authenticate" },
      f.control
    );
    expect(result).toMatchObject({
      status: "ok",
      value: { identityRef: expect.any(String) }
    });
    expect(configure).toHaveBeenCalledTimes(1);
    expect(f.runCommand).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});
it("rejects explicit selection when the configured identity does not match the requested reference", async () => {
  const f = await fixture();
  try {
    const credentials = createCanvasLifecycleCredentials({
      ...f.deps,
      configure: async () => portSuccess(undefined)
    });
    if (!credentials.configure)
      throw new Error("Missing configured mutation binding");
    expect(
      await credentials.configure(
        { ...f.scope, operation: "credentials.configure" },
        {
          provider: "azure",
          intent: "select_identity",
          identityRef: "different-profile"
        },
        f.control
      )
    ).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
  } finally {
    await f.close();
  }
});
it.each(["null", "[]", "{", '{"tenantId":"invalid"}'])(
  "reports unavailable evidence for malformed provider data %s",
  async (data) => {
    const f = await fixture();
    try {
      f.state.azure = data;
      expect(
        await createCanvasLifecycleCredentials(f.deps).inspect(
          f.scope,
          { provider: "azure" },
          f.control
        )
      ).toMatchObject({
        status: "ok",
        value: {
          prerequisites: [{ status: "unavailable" }],
          observation: { completeness: "unavailable" }
        }
      });
    } finally {
      await f.close();
    }
  }
);
it("preserves partial provider availability instead of advertising empty success", async () => {
  const f = await fixture();
  try {
    f.state.aws = "{}";
    expect(
      await createCanvasLifecycleCredentials(f.deps).inspect(
        f.scope,
        {},
        f.control
      )
    ).toMatchObject({
      status: "ok",
      value: { observation: { completeness: "partial", quality: "unknown" } }
    });
  } finally {
    await f.close();
  }
});
it.each(["before", "after-grant", "after-read"])(
  "rejects cancellation %s without accepting stale identity evidence",
  async (phase) => {
    const f = await fixture();
    try {
      if (phase === "before") f.control.cancellation.aborted = true;
      if (phase === "after-grant") {
        const authorize = f.deps.authority.authorize;
        f.deps.authority.authorize = async (request, control) => {
          f.control.cancellation.aborted = true;
          return authorize(request, control);
        };
      }
      if (phase === "after-read")
        f.runCommand.mockImplementation(async () => {
          f.control.cancellation.aborted = true;
          return f.state.azure;
        });
      expect(
        await createCanvasLifecycleCredentials(f.deps).inspect(
          f.scope,
          { provider: "azure" },
          f.control
        )
      ).toMatchObject({ status: "cancelled" });
    } finally {
      await f.close();
    }
  }
);
it.each(["unavailable", "other-principal", "changed-grant"])(
  "refuses %s host identity before cloud reads",
  async (phase) => {
    const f = await fixture();
    try {
      if (phase === "unavailable")
        f.deps.authority.resolveCaller = async () => portForbidden();
      if (phase === "other-principal") f.scope.principalRef = "other";
      if (phase === "changed-grant") {
        const authorize = f.deps.authority.authorize;
        f.deps.authority.authorize = async (request, control) => {
          const result = await authorize(request, control);
          return result.status === "ok" ?
              portSuccess({ ...result.value, authorizationRef: "" })
            : result;
        };
      }
      expect(
        await createCanvasLifecycleCredentials(f.deps).inspect(
          f.scope,
          {},
          f.control
        )
      ).toMatchObject({ status: "forbidden" });
      expect(f.runCommand).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  }
);
it.each(["authority", "configuration", "observation", "unverified"])(
  "propagates %s failure during explicit authentication",
  async (phase) => {
    const f = await fixture();
    try {
      if (phase === "authority")
        f.deps.authority.resolveCaller = async () => portForbidden();
      const credentials = createCanvasLifecycleCredentials({
        ...f.deps,
        configure: async () => {
          if (phase === "configuration") return portForbidden();
          if (phase === "observation") f.control.cancellation.aborted = true;
          if (phase === "unverified") f.state.azure = "{}";
          return portSuccess(undefined);
        }
      });
      if (!credentials.configure) throw new Error("Missing explicit binding");
      expect(
        await credentials.configure(
          { ...f.scope, operation: "credentials.configure" },
          { provider: "azure", intent: "authenticate" },
          f.control
        )
      ).not.toMatchObject({ status: "ok" });
    } finally {
      await f.close();
    }
  }
);
it("fails construction when the identity command seam is missing", async () => {
  const f = await fixture();
  try {
    Reflect.deleteProperty(f.deps, "runCommand");
    expect(() => createCanvasLifecycleCredentials(f.deps)).toThrow(
      "requires current identity"
    );
  } finally {
    await f.close();
  }
});
it.each(["operationId", "approvalRef", "configuration"])(
  "refuses a changed %s on the current trusted grant",
  async (field) => {
    const f = await fixture();
    try {
      const authorize = f.deps.authority.authorize;
      f.deps.authority.authorize = async (request, control) => {
        const result = await authorize(request, control);
        if (result.status !== "ok") return result;
        const value = { ...result.value };
        Reflect.set(value, field, field === "configuration" ? {} : "other");
        return portSuccess(value);
      };
      expect(
        await createCanvasLifecycleCredentials(f.deps).inspect(
          { ...f.scope, operationId: "operation", approvalRef: "approval" },
          {},
          f.control
        )
      ).toMatchObject({ status: "forbidden" });
      expect(f.runCommand).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  }
);
