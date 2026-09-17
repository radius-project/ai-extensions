import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  portForbidden,
  portSuccess,
  type AuthorizedScope
} from "@radius-project/core/lifecycle";
import { createCanvasDiscoveryContext } from "./create-discovery-context.js";
import {
  authorizeFixture,
  createLifecycleFixture
} from "../../test/support/lifecycle.js";

const control = {
  requestId: "read",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
const scope: AuthorizedScope<"environment.inspect"> = {
  operation: "environment.inspect",
  principalRef: "github:reader",
  authorizationRef: "auth",
  target: { repo: "owner/repo", environment: "dev" }
};
it.each(["empty", "metadata", "malformed", "forbidden"] as const)(
  "never infers a deployed graph from %s GitHub deployment evidence",
  async (kind) => {
    const fixture = createLifecycleFixture({
      caller: {
        principalRef: scope.principalRef,
        identityRef: "identity",
        sessionRef: "session",
        responder: "user"
      }
    });
    const target = {
      repo: "owner/repo",
      environment: "dev",
      application: "app"
    };
    const graphScope: AuthorizedScope<"graph.get"> = {
      ...scope,
      operation: "graph.get",
      target
    };
    const calls: string[][] = [];
    const context = createCanvasDiscoveryContext({
      authority: fixture.ports.identity,
      clock: fixture.ports.clock,
      ids: fixture.ports.ids,
      hostBinding: () => ({ sessionRef: "session", bindingRef: "binding" }),
      storageRoot: resolve(".test-unused-source"),
      workspace: async () => {
        throw new Error("Deployed reads must not inspect source");
      },
      git: async () => {
        throw new Error("Deployed reads must not invoke Git");
      },
      executor: async (login) => ({
        login,
        run: async (args) => {
          calls.push(args);
          return {
            code: kind === "forbidden" ? 1 : 0,
            stderr: kind === "forbidden" ? "HTTP 403" : "",
            stdout: JSON.stringify(
              kind === "malformed" ? {}
              : kind === "empty" ? []
              : [{ id: 123, sha: "a".repeat(40), environment: "dev" }]
            )
          };
        }
      })
    });
    try {
      expect(
        await context.observeDeployed(graphScope, target, control)
      ).toMatchObject(
        kind === "forbidden" ? { status: "forbidden" }
        : kind === "malformed" ?
          { status: "failed", error: { code: "EVIDENCE_MISMATCH" } }
        : {
            status: "unavailable",
            error: { code: "RESULT_UNAVAILABLE" },
            observation: {
              limitation: expect.stringContaining(
                "Authored topology is not a deployed observation"
              )
            }
          }
      );
      expect(calls).toEqual([
        [
          "api",
          "--hostname",
          "github.com",
          "--method",
          "GET",
          "/repos/owner/repo/deployments?environment=dev&per_page=100"
        ]
      ]);
    } finally {
      await context.discovery.close();
      await fixture.binding.close();
    }
  }
);
it("uses the actual selected account read seam and publicly retains unavailable recipe observations", async () => {
  const fixture = createLifecycleFixture({
    caller: {
      principalRef: scope.principalRef,
      identityRef: "identity",
      sessionRef: "session",
      responder: "user"
    }
  });
  const calls: string[][] = [];
  const context = createCanvasDiscoveryContext({
    authority: fixture.ports.identity,
    clock: fixture.ports.clock,
    ids: fixture.ports.ids,
    hostBinding: () => ({ sessionRef: "session", bindingRef: "binding" }),
    storageRoot: resolve(".test-unused-source"),
    workspace: async () => {
      throw new Error("Environment inspection must not read source");
    },
    git: async () => {
      throw new Error("No Git command expected");
    },
    executor: async (login) => ({
      login,
      run: async (args) => {
        calls.push(args);
        return {
          code: 0,
          stdout: JSON.stringify(
            args.at(-1)?.includes("variables") ?
              { variables: [{ name: "AZURE_CLIENT_ID", value: "client" }] }
            : { name: "dev", protection_rules: [] }
          ),
          stderr: ""
        };
      }
    })
  });
  try {
    const result = await context.discovery.environments.inspect(scope, control);
    expect(result).toMatchObject({
      status: "ok",
      value: {
        configuration: { provider: "azure" },
        recipeObservation: { completeness: "unavailable" },
        limitations: [
          expect.stringContaining("existing read-only evidence channel")
        ]
      }
    });
    if (result.status !== "ok") throw new Error("Expected partial observation");
    expect(result.value.configuration?.recipes).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls.every((args) => args.includes("GET"))).toBe(true);
  } finally {
    await context.discovery.close();
    await fixture.binding.close();
  }
});
it.each(["caller", "principal", "authorization"] as const)(
  "fences %s failures before concrete reads",
  async (kind) => {
    const fixture = createLifecycleFixture({
      overrides: {
        identity: {
          ...(kind === "caller" ?
            { resolveCaller: async () => portForbidden() }
          : {}),
          ...(kind === "authorization" ?
            { authorize: async () => portForbidden() }
          : {})
        }
      },
      caller: {
        principalRef: kind === "principal" ? "other" : scope.principalRef,
        identityRef: "identity",
        sessionRef: "session",
        responder: "user"
      }
    });
    const context = createCanvasDiscoveryContext({
      authority: fixture.ports.identity,
      clock: fixture.ports.clock,
      ids: fixture.ports.ids,
      hostBinding: () => ({ sessionRef: "session", bindingRef: "binding" }),
      storageRoot: resolve(".test-unused-source"),
      workspace: async () => {
        throw new Error("No source IO expected");
      },
      git: async () => {
        throw new Error("No Git expected");
      },
      executor: async () => {
        throw new Error("No GitHub expected");
      }
    });
    try {
      expect(
        await context.discovery.environments.inspect(scope, control)
      ).toMatchObject({ status: "forbidden" });
      if (kind !== "principal")
        expect(
          await context.resolveWorkspaceSource(
            { repo: "owner/repo", definition: "app.bicep" },
            control
          )
        ).toMatchObject({ status: "forbidden" });
    } finally {
      await context.discovery.close();
      await fixture.binding.close();
    }
  }
);
it.each(["principal", "operation", "target"] as const)(
  "rejects returned %s authority mismatches",
  async (kind) => {
    const fixture = createLifecycleFixture({
      caller: {
        principalRef: scope.principalRef,
        identityRef: "identity",
        sessionRef: "session",
        responder: "user"
      },
      overrides: {
        identity: {
          authorize: async (request) => {
            const authorized = authorizeFixture(request);
            if (kind === "principal")
              return portSuccess({ ...authorized, principalRef: "other" });
            if (kind === "target")
              return portSuccess({
                ...authorized,
                target: { ...authorized.target, repo: "other/repo" }
              });
            return portSuccess({
              ...authorized,
              operation: "environment.list",
              target: { repo: "owner/repo" }
            });
          }
        }
      }
    });
    const context = createCanvasDiscoveryContext({
      authority: fixture.ports.identity,
      clock: fixture.ports.clock,
      ids: fixture.ports.ids,
      hostBinding: () => ({ sessionRef: "session", bindingRef: "binding" }),
      storageRoot: resolve(".test-unused-source"),
      workspace: async () => {
        throw new Error("No workspace read");
      },
      git: async () => {
        throw new Error("No Git");
      },
      executor: async () => {
        throw new Error("No GitHub");
      }
    });
    try {
      expect(
        await context.discovery.environments.inspect(scope, control)
      ).toMatchObject({ status: "forbidden" });
    } finally {
      await context.discovery.close();
      await fixture.binding.close();
    }
  }
);
it("preserves explicit source authority and unavailable workspace selection without external IO", async () => {
  const fixture = createLifecycleFixture();
  const context = createCanvasDiscoveryContext({
    authority: fixture.ports.identity,
    clock: fixture.ports.clock,
    ids: fixture.ports.ids,
    hostBinding: () => ({
      sessionRef: fixture.caller.sessionRef,
      bindingRef: "binding"
    }),
    storageRoot: resolve(".test-unused-source"),
    workspace: async () => ({
      repo: "other/repo",
      workspacePath: resolve("."),
      branch: "feature"
    }),
    git: async () => {
      throw new Error("No Git");
    },
    executor: async () => {
      throw new Error("No GitHub");
    }
  });
  try {
    expect(
      await context.resolveWorkspaceSource({ repo: "owner/repo" }, control)
    ).toMatchObject({ status: "forbidden" });
    expect(
      await context.discovery.applications.inspect(
        {
          operation: "application.inspect",
          target: {
            repo: "owner/repo",
            application: "app",
            definition: "app.bicep",
            source: fixture.source
          },
          source: {
            kind: "workspace",
            repo: "owner/repo",
            workspaceRef: fixture.source.workspaceRef,
            branch: fixture.source.branch,
            fingerprint: fixture.source.expectedFingerprint,
            resolvedAt: fixture.ports.clock.now()
          },
          principalRef: fixture.caller.principalRef,
          authorizationRef: "auth"
        },
        control
      )
    ).toMatchObject({ status: "forbidden" });
  } finally {
    await context.discovery.close();
    await fixture.binding.close();
  }
});
