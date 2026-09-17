import { describe, expect, it, vi } from "vitest";
import {
  scriptGraphDiff,
  graphFailure
} from "../../test/support/canonical-graphs.js";
import {
  UNIDENTIFIED_APPLICATION_MESSAGE,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE
} from "@radius-project/core";
import { createRadiusTools } from "./create-radius-tools.js";
import {
  LIFECYCLE_API_VERSION,
  lifecycleError,
  type LifecycleResponseFor
} from "@radius-project/core/lifecycle";
import { createMissingModelHandoffClaims } from "./missing-model-handoff-claims.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../test/support/runtime/fakes.js";

function findTool(tools: ReturnType<typeof createRadiusTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

function setup(
  options?: Parameters<typeof createFakeDependencies>[0],
  writer: "legacy" | "lifecycle" = "lifecycle"
) {
  const fake = createFakeDependencies(options);
  fake.deps.lifecycle.routing.transition("definition", {
    writer,
    readers: ["legacy", "lifecycle"],
    controllers: ["legacy", "lifecycle"]
  });
  fake.sessionHolder.set(createFakeSession());
  const modelingActivity = {
    announce: vi.fn(),
    release: vi.fn(),
    inFlight: vi.fn(async () => false)
  };
  const missingModelHandoffs = createMissingModelHandoffClaims(() =>
    Date.now()
  );
  const tools = createRadiusTools(
    fake.deps,
    modelingActivity,
    missingModelHandoffs
  );
  return { ...fake, tools, modelingActivity, missingModelHandoffs };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function parseSkillHandoff(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new Error("Expected the skill handoff to be JSON text.");
  }
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected the skill handoff to be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

// RU-07: the selected writer owns each new authoring request.
describe("RU-07: radius_generate_app", () => {
  const intent = {
    operation: "definition.author",
    target: { repo: "acme/widgets", definition: ".radius/app.bicep" },
    input: {
      intent:
        "Generate a Radius application definition from the current workspace.",
      provider: "azure"
    }
  };
  function response(
    state:
      | "queued"
      | "running"
      | "action_required"
      | "succeeded"
      | "failed"
      | "cancelled"
  ): LifecycleResponseFor<"definition.author"> {
    const source = {
      kind: "workspace" as const,
      repo: "acme/widgets",
      workspaceRef: "workspace",
      branch: "main",
      fingerprint: `sha256:${"a".repeat(64)}`,
      resolvedAt: "2026-09-16T00:00:00Z"
    };
    const target = {
      ...intent.target,
      source: {
        kind: "workspace" as const,
        workspaceRef: "workspace",
        branch: "main",
        expectedFingerprint: source.fingerprint
      }
    };
    const common = {
      operationId: "authoring-operation",
      target,
      source,
      observation: {
        quality: "current" as const,
        completeness: "complete" as const,
        evidence: "session" as const
      }
    };
    return {
      apiVersion: LIFECYCLE_API_VERSION,
      requestId: "authoring-request",
      operation: "definition.author",
      result:
        state === "action_required" ?
          {
            ...common,
            state,
            requiredAction: {
              actionId: "authoring-action",
              operationId: common.operationId,
              target,
              source,
              status: "outstanding",
              kind: "agent.author_definition",
              responder: "agent",
              response: { kind: "agent.outcome" },
              message: "Author the guarded proposal."
            }
          }
        : state === "succeeded" ?
          {
            ...common,
            state,
            proposal: {
              operationId: common.operationId,
              actionId: "authoring-action",
              stagingRef: "guarded-staging",
              originalFingerprint: source.fingerprint,
              outputs: [
                {
                  path: ".radius/app.bicep",
                  kind: "definition",
                  existed: false,
                  contentHash: `sha256:${"b".repeat(64)}`
                }
              ],
              validation: {
                status: "passed",
                sourceFingerprint: source.fingerprint,
                proposalFingerprint: `sha256:${"b".repeat(64)}`,
                checks: [
                  {
                    checkId: "compiler",
                    classification: "required",
                    status: "passed",
                    reason: "Compiled the exact staged proposal."
                  }
                ],
                warnings: [],
                diagnostics: []
              },
              promotion: "promoted"
            }
          }
        : state === "failed" ?
          { ...common, state, error: lifecycleError("PRECONDITION_FAILED") }
        : { ...common, state }
    };
  }
  function supported(paths = ["Dockerfile"]) {
    return setup({
      workspaceTreeByRepoBranch: { "acme/widgets@main": paths }
    });
  }
  it("preserves legacy bootstrap when the current host cannot author through lifecycle", async () => {
    const { tools, deps, modelingActivity } = setup(
      { workspaceTreeByRepoBranch: { "acme/widgets@main": ["Dockerfile"] } },
      "legacy"
    );
    const execute = vi.spyOn(deps.lifecycle, "execute");
    const result = parseSkillHandoff(
      await findTool(tools, "radius_generate_app").handler({})
    );
    expect(result).toMatchObject({
      skill: "radius-app-bicep",
      repoPath: "."
    });
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledExactlyOnceWith(
      undefined,
      undefined
    );
    expect(execute).not.toHaveBeenCalled();
    expect(modelingActivity.announce).toHaveBeenCalledExactlyOnceWith({
      repo: "acme/widgets",
      branch: "main"
    });
  });
  it("routes new requests back to legacy after rollback while retaining lifecycle controls", async () => {
    const { tools, deps } = supported();
    deps.lifecycle.routing.claimDispatch("definition", "accepted-authoring");
    deps.lifecycle.routing.transition("definition", {
      writer: "legacy",
      readers: ["legacy", "lifecycle"],
      controllers: ["legacy", "lifecycle"]
    });
    const execute = vi.spyOn(deps.lifecycle, "execute");
    expect(
      parseSkillHandoff(
        await findTool(tools, "radius_generate_app").handler({})
      )
    ).toMatchObject({ skill: "radius-app-bicep" });
    expect(execute).not.toHaveBeenCalled();
    expect(deps.lifecycle.routing.address("accepted-authoring", true)).toBe(
      "lifecycle"
    );
  });
  it.each([
    { paths: ["Dockerfile"], repoPath: "/workspace", brief: false },
    {
      paths: ["services/api/Dockerfile", "services/web/Dockerfile"],
      repoPath: "/workspace",
      brief: true
    },
    {
      paths: ["services/api/Dockerfile", "services/web/Dockerfile"],
      repoPath: "/workspace/services/api",
      brief: false
    },
    { paths: null, repoPath: "/workspace", brief: true },
    { paths: ["package.json"], repoPath: "/other-repository", brief: false }
  ])(
    "retains legacy source scope and discovery information for $repoPath with $paths",
    async ({ paths, repoPath, brief }) => {
      const { tools, deps, modelingActivity } = setup(
        { workspaceTreeByRepoBranch: { "acme/widgets@main": paths } },
        "legacy"
      );
      const execute = vi.spyOn(deps.lifecycle, "execute");
      const result = parseSkillHandoff(
        await findTool(tools, "radius_generate_app").handler({ repoPath })
      );
      expect(result).toMatchObject({ skill: "radius-app-bicep", repoPath });
      expect(typeof result.brief === "string").toBe(brief);
      expect(execute).not.toHaveBeenCalled();
      expect(modelingActivity.announce).toHaveBeenCalledTimes(
        repoPath === "/other-repository" ? 0 : 1
      );
    }
  );
  it("withholds a legacy bootstrap on confirmed Dockerfile absence", async () => {
    const { tools, deps, modelingActivity } = setup(
      {
        workspaceTreeByRepoBranch: { "acme/widgets@main": ["package.json"] }
      },
      "legacy"
    );
    expect(await findTool(tools, "radius_generate_app").handler({})).toContain(
      UNSUPPORTED_NO_DOCKERFILE_MESSAGE
    );
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
    expect(modelingActivity.announce).not.toHaveBeenCalled();
  });
  it.each([
    { repo: "", branch: "main" },
    { repo: "acme/widgets", branch: "" }
  ])(
    "does not announce an unbound legacy target: $repo@$branch",
    async (context) => {
      const { tools, deps, modelingActivity } = setup(
        { workspaceContext: { workspacePath: "/workspace", ...context } },
        "legacy"
      );
      const execute = vi.spyOn(deps.lifecycle, "execute");
      expect(
        parseSkillHandoff(
          await findTool(tools, "radius_generate_app").handler({})
        )
      ).toMatchObject({ skill: "radius-app-bicep" });
      expect(modelingActivity.announce).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    }
  );
  it.each(["context", "listing", "selection"] as const)(
    "retains the legacy handoff with an explicit warning when %s lookup fails",
    async (boundary) => {
      const { tools, deps, modelingActivity } = setup(undefined, "legacy");
      if (boundary === "context")
        vi.mocked(deps.workspace.detectWorkspaceContext).mockRejectedValueOnce(
          new Error("private context details")
        );
      else if (boundary === "selection")
        vi.mocked(deps.workspace.isWorkspaceSelection).mockImplementationOnce(
          () => {
            throw new Error("private selection details");
          }
        );
      else
        vi.mocked(deps.workspace.fetchWorkspaceTree).mockRejectedValueOnce(
          new Error("private filesystem details")
        );
      const result = parseSkillHandoff(
        await findTool(tools, "radius_generate_app").handler({})
      );
      expect(result).toMatchObject({
        skill: "radius-app-bicep",
        brief: expect.stringContaining("discovery was unavailable")
      });
      expect(JSON.stringify(result)).not.toContain("private");
      expect(modelingActivity.announce).toHaveBeenCalledTimes(
        boundary === "context" ? 0 : 1
      );
    }
  );
  it("does not hand off or redispatch if the writer changes during legacy discovery", async () => {
    const { tools, deps, modelingActivity } = setup(undefined, "legacy");
    const execute = vi.spyOn(deps.lifecycle, "execute");
    vi.mocked(deps.workspace.fetchWorkspaceTree).mockImplementationOnce(
      async () => {
        deps.lifecycle.routing.transition("definition", {
          writer: "lifecycle",
          readers: ["legacy", "lifecycle"],
          controllers: ["legacy", "lifecycle"]
        });
        return ["Dockerfile"];
      }
    );
    expect(
      parseSkillHandoff(
        await findTool(tools, "radius_generate_app").handler({})
      )
    ).toMatchObject({ error: { code: "PRECONDITION_FAILED" } });
    expect(execute).not.toHaveBeenCalled();
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
    expect(modelingActivity.announce).not.toHaveBeenCalled();
  });
  it("reports legacy bootstrap failure without announcing a run or falling through", async () => {
    const { tools, deps, modelingActivity } = setup(
      { workspaceTreeByRepoBranch: { "acme/widgets@main": ["Dockerfile"] } },
      "legacy"
    );
    const execute = vi.spyOn(deps.lifecycle, "execute");
    vi.mocked(deps.radiusAppBicepSkill).mockImplementationOnce(() => {
      throw new Error("skill installation missing");
    });
    expect(
      parseSkillHandoff(
        await findTool(tools, "radius_generate_app").handler({})
      )
    ).toMatchObject({ error: { code: "RESULT_UNAVAILABLE" } });
    expect(execute).not.toHaveBeenCalled();
    expect(modelingActivity.announce).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    "",
    "/workspace",
    "/workspace/",
    "\\workspace",
    "/workspace/."
  ])(
    "maps workspace root %s to exactly one canonical request",
    async (repoPath) => {
      const { tools, deps, modelingActivity } = supported();
      const result = response("queued");
      const execute = vi
        .spyOn(deps.lifecycle, "execute")
        .mockImplementationOnce(async (input) => {
          expect(input).toEqual(intent);
          return result;
        });
      const send = vi.spyOn(deps.session.get(), "send");
      expect(
        parseSkillHandoff(
          await findTool(tools, "radius_generate_app").handler({ repoPath })
        )
      ).toEqual(result);
      expect(execute).toHaveBeenCalledExactlyOnceWith(intent);
      expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(modelingActivity.announce).toHaveBeenCalledExactlyOnceWith({
        repo: "acme/widgets",
        branch: "main"
      });
    }
  );
  it.each([
    "queued",
    "running",
    "action_required",
    "succeeded",
    "failed",
    "cancelled"
  ] as const)(
    "preserves canonical %s without inventing a handoff or completion",
    async (state) => {
      const { tools, deps, modelingActivity } = supported();
      const result = response(state);
      const execute = vi
        .spyOn(deps.lifecycle, "execute")
        .mockImplementationOnce(async (input) => {
          expect(input).toEqual(intent);
          return result;
        });
      expect(
        parseSkillHandoff(
          await findTool(tools, "radius_generate_app").handler({})
        )
      ).toEqual(result);
      expect(execute).toHaveBeenCalledOnce();
      expect(modelingActivity.announce).toHaveBeenCalledTimes(
        state === "succeeded" || state === "failed" || state === "cancelled" ?
          0
        : 1
      );
      expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
    }
  );
  it("does not bypass unavailable host authority through a skill or session message", async () => {
    const { tools, deps, modelingActivity } = supported();
    const result = graphFailure("CAPABILITY_UNAVAILABLE");
    const execute = vi
      .spyOn(deps.lifecycle, "execute")
      .mockImplementationOnce(async (input) => {
        expect(input).toEqual(intent);
        return result;
      });
    const send = vi.spyOn(deps.session.get(), "send");
    expect(
      parseSkillHandoff(
        await findTool(tools, "radius_generate_app").handler({})
      )
    ).toEqual(result);
    expect(execute).toHaveBeenCalledOnce();
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(modelingActivity.announce).not.toHaveBeenCalled();
  });
  it("fails explicitly without exposing external errors when canonical execution rejects", async () => {
    const { tools, deps, modelingActivity } = supported();
    vi.spyOn(deps.lifecycle, "execute").mockImplementationOnce(
      async (input) => {
        expect(input).toEqual(intent);
        throw new Error("private diagnostic");
      }
    );
    const result = await findTool(tools, "radius_generate_app").handler({});
    expect(parseSkillHandoff(result)).toMatchObject({
      error: { code: "RESULT_UNAVAILABLE" }
    });
    expect(result).not.toContain("private diagnostic");
    expect(modelingActivity.announce).not.toHaveBeenCalled();
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
  });
  it.each([
    "services/api",
    "/workspace/services/api",
    "/workspace/./services/api"
  ])(
    "refuses unsupported scoped source %s rather than modeling the whole repository",
    async (repoPath) => {
      const { tools, deps, modelingActivity } = supported();
      const execute = vi.spyOn(deps.lifecycle, "execute");
      expect(
        parseSkillHandoff(
          await findTool(tools, "radius_generate_app").handler({ repoPath })
        )
      ).toMatchObject({ error: { code: "CAPABILITY_UNAVAILABLE" } });
      expect(execute).not.toHaveBeenCalled();
      expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
      expect(modelingActivity.announce).not.toHaveBeenCalled();
    }
  );
  it.each([null, 42, {}, []])(
    "rejects malformed repoPath %j",
    async (repoPath) => {
      const { tools, deps } = supported();
      const execute = vi.spyOn(deps.lifecycle, "execute");
      expect(
        parseSkillHandoff(
          await findTool(tools, "radius_generate_app").handler({ repoPath })
        )
      ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      expect(execute).not.toHaveBeenCalled();
    }
  );
  it("passes multi-service evidence as intent, without a second listing or independent agent handoff", async () => {
    const { tools, deps } = supported([
      "services/api/Dockerfile",
      "services/web/Dockerfile",
      "pnpm-workspace.yaml",
      "node_modules/ignored/Dockerfile"
    ]);
    const execute = vi
      .spyOn(deps.lifecycle, "execute")
      .mockImplementationOnce(async (input) => {
        expect(input).toEqual({
          ...intent,
          input: {
            provider: "azure",
            intent: expect.stringContaining("ONE application")
          }
        });
        const text = JSON.stringify(input);
        expect(text).toContain("`services/api`");
        expect(text).toContain("`services/web`");
        expect(text).toContain("`pnpm-workspace.yaml`");
        expect(text).toContain(UNIDENTIFIED_APPLICATION_MESSAGE);
        expect(text).not.toContain("node_modules");
        return response("queued");
      });
    await findTool(tools, "radius_generate_app").handler({});
    expect(execute).toHaveBeenCalledOnce();
    expect(deps.workspace.fetchWorkspaceTree).toHaveBeenCalledOnce();
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
  });
  it("refuses a source not bound to the current worktree instead of reading a remote substitute", async () => {
    const { tools, deps } = supported();
    vi.mocked(deps.workspace.isWorkspaceSelection).mockReturnValue(false);
    const execute = vi.spyOn(deps.lifecycle, "execute");
    expect(
      parseSkillHandoff(
        await findTool(tools, "radius_generate_app").handler({})
      )
    ).toMatchObject({ error: { code: "RESULT_UNAVAILABLE" } });
    expect(deps.github.treePaths).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["missing", "throwing"] as const)(
    "publishes successfully when session logging is %s",
    async (logging) => {
      const { tools, deps, sessionHolder } = setup();
      const log = vi.fn(() => {
        throw new Error("Host logger disconnected");
      });
      sessionHolder.set(
        createFakeSession({ log: logging === "throwing" ? log : undefined })
      );
      vi.spyOn(deps.rad, "runRadBicepPublishExtension").mockImplementation(
        async (args) => {
          args.log?.("Publishing extension");
          return args.target;
        }
      );
      const result = await findTool(
        tools,
        "radius_publish_custom_type_extension"
      ).handler({});
      expect(result).toContain("Published custom-type extension");
      expect(deps.rad.runRadBicepPublishExtension).toHaveBeenCalledOnce();
      if (logging === "throwing")
        expect(log).toHaveBeenCalledWith("Publishing extension");
      await deps.lifecycle.close();
    }
  );
  it("withholds the skill and reports the unsupported repository when it has no Dockerfile", async () => {
    const { tools, deps } = setup({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json"]
      }
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(result).toContain(UNSUPPORTED_NO_DOCKERFILE_MESSAGE);
    expect(result).toContain("acme/widgets");
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
  });

  it("does not announce a repository-wide wildcard when the workspace branch is unresolved", async () => {
    const { tools, modelingActivity } = setup({
      workspaceContext: {
        workspacePath: "/workspace",
        repo: "acme/widgets",
        branch: ""
      }
    });

    await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(modelingActivity.announce).not.toHaveBeenCalled();
  });

  it("announces nothing for a repository it refuses to model", async () => {
    const { tools, modelingActivity } = setup({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json"]
      }
    });

    await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(modelingActivity.announce).not.toHaveBeenCalled();
  });

  it("announces nothing when the workspace context cannot be resolved", async () => {
    const { tools, deps, modelingActivity } = setup();
    (
      deps.workspace.detectWorkspaceContext as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("no session"));

    await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(modelingActivity.announce).not.toHaveBeenCalled();
  });

  it("fails explicitly when the repository cannot be listed", async () => {
    const { tools, deps } = setup();
    (
      deps.workspace.fetchWorkspaceTree as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("permission denied"));

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(parseSkillHandoff(result)).toMatchObject({
      error: { code: "RESULT_UNAVAILABLE" }
    });
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
  });
  it.each([null, []])(
    "fails closed for unknown source evidence %j",
    async (listing) => {
      const { tools, deps, modelingActivity } = setup({
        workspaceTreeByRepoBranch: { "acme/widgets@main": listing }
      });
      const execute = vi.spyOn(deps.lifecycle, "execute");
      expect(
        parseSkillHandoff(
          await findTool(tools, "radius_generate_app").handler({})
        )
      ).toMatchObject({
        error: { code: "RESULT_UNAVAILABLE" }
      });
      expect(execute).not.toHaveBeenCalled();
      expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
      expect(modelingActivity.announce).not.toHaveBeenCalled();
    }
  );

  it("fails explicitly when the workspace context cannot be resolved", async () => {
    const { tools, deps } = setup();
    (
      deps.workspace.detectWorkspaceContext as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("no session"));

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(parseSkillHandoff(result)).toMatchObject({
      error: { code: "RESULT_UNAVAILABLE" }
    });
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
  });

  it("fails explicitly when deciding which listing to use throws", async () => {
    const { tools, deps } = setup();
    (
      deps.workspace.isWorkspaceSelection as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(() => {
      throw new Error("selection unavailable");
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(parseSkillHandoff(result)).toMatchObject({
      error: { code: "RESULT_UNAVAILABLE" }
    });
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
  });

  it("fails without listing when the workspace has no repo context", async () => {
    const { tools, deps } = setup({
      workspaceContext: { workspacePath: "/workspace", repo: "", branch: "" }
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(parseSkillHandoff(result)).toMatchObject({
      error: { code: "RESULT_UNAVAILABLE" }
    });
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
    expect(deps.github.treePaths).not.toHaveBeenCalled();
    expect(deps.workspace.fetchWorkspaceTree).not.toHaveBeenCalled();
  });

  // A sibling whose name merely starts with the workspace root is not inside
  // it, and neither is a path that walks back out of it.
  it.each([
    ["a sibling with a shared prefix", "/workspace-other"],
    ["a path that escapes upward", "/workspace/../elsewhere"]
  ])("rejects %s without filesystem authority", async (_label, repoPath) => {
    const { tools, deps } = setup({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json"]
      }
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath
    });

    expect(parseSkillHandoff(result)).toMatchObject({
      error: { code: "CAPABILITY_UNAVAILABLE" }
    });
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
  });

  // The listing the check can obtain describes the workspace, so it is not
  // evidence about some other directory the caller named.
  it("does not refuse a target outside the workspace on the workspace's contents", async () => {
    const { tools, deps, modelingActivity } = setup({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json"]
      }
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/elsewhere/other-repo"
    });

    expect(parseSkillHandoff(result)).toMatchObject({
      error: { code: "CAPABILITY_UNAVAILABLE" }
    });
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
    expect(modelingActivity.announce).not.toHaveBeenCalled();
  });

  it.each([
    ["a trailing slash", "/workspace/"],
    ["Windows separators", "\\workspace"],
    ["a dot form", "/workspace/."],
    ["a subdirectory", "/workspace/services/api"],
    ["a nested dot form", "/workspace/services/../services/api"]
  ])("still gates the workspace named with %s", async (_label, repoPath) => {
    const { tools, deps } = setup({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json"]
      }
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath
    });

    expect(result).toContain(UNSUPPORTED_NO_DOCKERFILE_MESSAGE);
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
  });

  it("fails explicitly when the workspace path itself is unknown", async () => {
    const { tools, deps } = setup({
      workspaceContext: {
        workspacePath: "",
        repo: "acme/widgets",
        branch: "main"
      },
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json"]
      }
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(parseSkillHandoff(result)).toMatchObject({
      error: { code: "RESULT_UNAVAILABLE" }
    });
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
  });
});

// RU-08: PR diff mapping/fetch failure/markdown.
describe("TL-11: radius_report_modeling_failure", () => {
  async function currentAttempt(
    options?: Parameters<typeof createFakeDependencies>[0]
  ) {
    const harness = setup(options);
    const entry = await harness.deps.getOrCreateServer("radius-panel", "graph");
    Object.assign(entry.state, {
      contextRepo: "acme/widgets",
      contextBranch: "main",
      workspaceRepo: "acme/widgets",
      workspaceBranch: "main",
      workspacePath: "/workspace",
      appModelAttemptTokens: {
        "acme/widgets::main": "attempt-1"
      }
    });
    return { ...harness, entry };
  }

  const report = {
    instanceId: "radius-panel",
    repo: "acme/widgets",
    branch: "main",
    attemptToken: "attempt-1",
    error: "The configured Recipe rejects the required credential shape."
  };

  it("records a permanent failure for the current missing-model attempt", async () => {
    const { tools, entry, deps } = await currentAttempt();
    const execute = vi.spyOn(deps.lifecycle, "execute");

    const result = await findTool(
      tools,
      "radius_report_modeling_failure"
    ).handler(report);

    expect(result).toEqual({ recorded: true });
    expect(entry.state.appModelFailures?.["acme/widgets::main"]).toEqual({
      attemptToken: "attempt-1",
      error: report.error
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("releases the dead run's handoff claim so the promised retry can be sent", async () => {
    const { tools, missingModelHandoffs, modelingActivity } =
      await currentAttempt();
    const delivered = missingModelHandoffs.claim(
      "acme/widgets::main",
      "missing-model-key"
    );
    expect(delivered).not.toBeNull();
    missingModelHandoffs.markDelivered(delivered!);
    expect(missingModelHandoffs.current("acme/widgets::main")).toBe(delivered);

    await findTool(tools, "radius_report_modeling_failure").handler(report);

    expect(missingModelHandoffs.current("acme/widgets::main")).toBeNull();
    expect(
      missingModelHandoffs.claim("acme/widgets::main", "missing-model-key")
    ).not.toBeNull();
    expect(modelingActivity.release).toHaveBeenCalledWith({
      repo: "acme/widgets",
      branch: "main"
    });
  });

  it("leaves an unrelated target's claim alone when a failure is recorded", async () => {
    const { tools, missingModelHandoffs } = await currentAttempt();
    const other = missingModelHandoffs.claim(
      "acme/widgets::release",
      "missing-model-key"
    );

    await findTool(tools, "radius_report_modeling_failure").handler(report);

    expect(missingModelHandoffs.current("acme/widgets::release")).toBe(other);
  });

  it("rejects incomplete, oversized, and stale reports", async () => {
    const { tools, entry } = await currentAttempt();
    const tool = findTool(tools, "radius_report_modeling_failure");

    await expect(tool.handler({})).resolves.toMatchObject({ recorded: false });
    await expect(
      tool.handler({ ...report, error: "x".repeat(4001) })
    ).resolves.toMatchObject({ recorded: false });
    await expect(
      tool.handler({ ...report, attemptToken: "stale-attempt" })
    ).resolves.toMatchObject({ recorded: false });
    await expect(
      tool.handler({ ...report, instanceId: "closed-panel" })
    ).resolves.toMatchObject({ recorded: false });
    expect(entry.state.appModelFailures).toBeUndefined();
  });

  it("propagates a model read failure instead of recording an unverified failure", async () => {
    const { tools, deps, entry } = await currentAttempt();
    vi.mocked(deps.workspace.fetchWorkspaceBicep).mockRejectedValue(
      new Error("workspace unavailable")
    );

    await expect(
      findTool(tools, "radius_report_modeling_failure").handler(report)
    ).rejects.toThrow("workspace unavailable");
    expect(entry.state.appModelFailures).toBeUndefined();
  });

  it("rejects a report superseded while the model recheck is in flight", async () => {
    const { tools, deps, entry } = await currentAttempt();
    let finishRead!: (content: string | null) => void;
    vi.mocked(deps.workspace.fetchWorkspaceBicep).mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          finishRead = resolve;
        })
    );

    const pending = findTool(tools, "radius_report_modeling_failure").handler(
      report
    );
    await vi.waitFor(() =>
      expect(deps.workspace.fetchWorkspaceBicep).toHaveBeenCalledOnce()
    );
    const tokens = entry.state.appModelAttemptTokens;
    if (!tokens) throw new Error("expected current modeling attempt");
    tokens["acme/widgets::main"] = "attempt-2";
    finishRead(null);

    await expect(pending).resolves.toMatchObject({ recorded: false });
    expect(entry.state.appModelFailures).toBeUndefined();
  });

  it("rejects a stale failure when the application model now exists", async () => {
    const { tools, entry } = await currentAttempt({
      bicepByRepoBranch: {
        "workspace:acme/widgets@main": "extension radius"
      }
    });
    entry.state.appModelFailures = {
      "acme/widgets::main": {
        attemptToken: "attempt-1",
        error: "older failure"
      }
    };

    const result = await findTool(
      tools,
      "radius_report_modeling_failure"
    ).handler(report);

    expect(result).toMatchObject({ recorded: false });
    expect(entry.state.appModelFailures).toEqual({});
    expect(entry.state.appModelAttemptTokens).toEqual({});
  });
});

describe("RU-08: radius_generate_pr_diff_markdown", () => {
  it("reports missing app.bicep on both branches without calling rad", async () => {
    const { tools, deps } = setup();
    const scripted = scriptGraphDiff(deps.lifecycle);
    scripted.execute.mockResolvedValue(graphFailure("DEFINITION_NOT_FOUND"));
    const result = await findTool(
      tools,
      "radius_generate_pr_diff_markdown"
    ).handler({ repo: "acme/widgets", baseBranch: "main", headBranch: "feat" });
    expect(result).toMatchObject({
      resultType: "success",
      textResultForLlm: expect.stringContaining("DEFINITION_NOT_FOUND"),
      toolTelemetry: { radiusGraphDiff: { outcome: "unavailable" } }
    });
    expect(deps.rad.buildGraphViaRad).not.toHaveBeenCalled();
  });

  it("computes the diff and renders PR-embeddable markdown when bicep exists on both branches", async () => {
    const { tools, deps } = setup({
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource db {}",
        "remote:acme/widgets@feat": "resource db {}\nresource cache {}"
      }
    });
    (deps.rad.buildGraphViaRad as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: "db", name: "db", type: "x" }])
      .mockResolvedValueOnce([
        { id: "db", name: "db", type: "x" },
        { id: "cache", name: "cache", type: "x" }
      ]);
    scriptGraphDiff(deps.lifecycle, [
      { id: "db", name: "db", type: "x", diffStatus: "unchanged" },
      { id: "cache", name: "cache", type: "x", diffStatus: "added" }
    ]);
    const result = await findTool(
      tools,
      "radius_generate_pr_diff_markdown"
    ).handler({ repo: "acme/widgets", baseBranch: "main", headBranch: "feat" });
    expect(result).toMatchObject({
      resultType: "success",
      textResultForLlm: expect.stringContaining("Application Graph Diff"),
      toolTelemetry: { radiusGraphDiff: { outcome: "diff" } }
    });
    expect(result).toMatchObject({
      textResultForLlm: expect.stringContaining("main")
    });
    expect(result).toMatchObject({
      textResultForLlm: expect.stringContaining("feat")
    });
  });

  it("maps a fetch/build failure to a friendly warning instead of throwing", async () => {
    const { tools, deps } = setup({
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource db {}",
        "remote:acme/widgets@feat": "resource db {}"
      }
    });
    (deps.rad.buildGraphViaRad as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("rad exploded")
    );
    scriptGraphDiff(deps.lifecycle).execute.mockRejectedValue(
      new Error("rad exploded")
    );
    const result = await findTool(
      tools,
      "radius_generate_pr_diff_markdown"
    ).handler({ repo: "acme/widgets", baseBranch: "main", headBranch: "feat" });
    expect(result).toMatchObject({
      resultType: "failure",
      error:
        "Could not generate app graph diff: the selected graph evidence is unavailable.",
      textResultForLlm: expect.stringContaining(
        "Could not generate app graph diff"
      )
    });
    expect(JSON.stringify(result)).not.toContain("rad exploded");
  });

  it("uses canonical read results without calling legacy graph builders or logs", async () => {
    const { tools, deps } = setup({
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource db {}",
        "remote:acme/widgets@feat": "resource db {}"
      }
    });
    const session = deps.session.get();
    scriptGraphDiff(deps.lifecycle, [
      { id: "cache", name: "cache", type: "x", diffStatus: "added" }
    ]);
    session.log = vi.fn(() => {
      throw new Error("log unavailable");
    });
    (
      deps.rad.radArtifactsDirForSelection as ReturnType<typeof vi.fn>
    ).mockImplementation(async ({ log }) => {
      log("building graph");
      return { dir: "/workspace/.radius", remote: false };
    });

    const result = await findTool(
      tools,
      "radius_generate_pr_diff_markdown"
    ).handler({ repo: "acme/widgets", baseBranch: "main", headBranch: "feat" });

    expect(deps.rad.radArtifactsDirForSelection).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      textResultForLlm: expect.stringContaining("Application Graph Diff")
    });
  });
});

// RU-09: publish custom extension confinement/defaults/invoke/errors.
describe("RU-09: radius_publish_custom_type_extension", () => {
  it("reports a missing manifest without invoking rad", async () => {
    const { tools, deps } = setup();
    (deps.process.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(
      false
    );
    const result = await findTool(
      tools,
      "radius_publish_custom_type_extension"
    ).handler({});
    expect(result).toContain("Resource-type manifest not found at");
    expect(deps.rad.runRadBicepPublishExtension).not.toHaveBeenCalled();
  });

  it("defaults manifestPath/targetPath and publishes via the injected rad dependency", async () => {
    const { tools, deps } = setup();
    const result = await findTool(
      tools,
      "radius_publish_custom_type_extension"
    ).handler({});
    expect(
      deps.publishTargets.resolveExistingRadiusArtifact
    ).toHaveBeenCalledWith(
      "/workspace",
      undefined,
      ".radius/custom-types.yaml"
    );
    expect(
      deps.publishTargets.resolveRadiusArtifactTarget
    ).toHaveBeenCalledWith("/workspace", undefined, ".radius/custom-types.tgz");
    expect(deps.rad.runRadBicepPublishExtension).toHaveBeenCalledOnce();
    expect(result).toContain("Published custom-type extension to");
  });

  it("confines paths under the workspace .radius directory (propagates a confinement error)", async () => {
    const { tools, deps } = setup();
    (
      deps.publishTargets.resolveExistingRadiusArtifact as ReturnType<
        typeof vi.fn
      >
    ).mockImplementation(() => {
      throw new Error(
        "Path escapes the workspace .radius directory: ../../etc/passwd"
      );
    });
    const result = await findTool(
      tools,
      "radius_publish_custom_type_extension"
    ).handler({ manifestPath: "../../etc/passwd" });
    expect(result).toContain("Could not publish the custom-type extension");
    expect(result).toContain("escapes the workspace");
  });

  // A modeling run writes into `.radius/.staging-<runId>/` and publishes only
  // once it is complete, so the package this tool produces has to land in the
  // run's directory rather than where the product reads it.
  it("defaults into the run's staging directory when one is given", async () => {
    const { tools, deps } = setup();
    await findTool(tools, "radius_publish_custom_type_extension").handler({
      stagingDir: ".staging-run-42"
    });
    expect(
      deps.publishTargets.resolveExistingRadiusArtifact
    ).toHaveBeenCalledWith(
      "/workspace",
      undefined,
      ".radius/.staging-run-42/custom-types.yaml"
    );
    expect(
      deps.publishTargets.resolveRadiusArtifactTarget
    ).toHaveBeenCalledWith(
      "/workspace",
      undefined,
      ".radius/.staging-run-42/custom-types.tgz"
    );
  });

  it("rejects a staging directory that is not a staging directory", async () => {
    const { tools, deps } = setup();
    const result = await findTool(
      tools,
      "radius_publish_custom_type_extension"
    ).handler({ stagingDir: "../../etc" });
    expect(result).toContain("Could not publish the custom-type extension");
    expect(deps.rad.runRadBicepPublishExtension).not.toHaveBeenCalled();
  });

  it("surfaces a publish failure as a friendly warning", async () => {
    const { tools, deps } = setup();
    (
      deps.rad.runRadBicepPublishExtension as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("rad bicep publish-extension failed"));
    const result = await findTool(
      tools,
      "radius_publish_custom_type_extension"
    ).handler({});
    expect(result).toContain("Could not publish the custom-type extension");
    expect(result).toContain("rad bicep publish-extension failed");
  });
});

// RU-10: publish recipe confinement/GHCR/errors.
describe("RU-10: radius_publish_recipe", () => {
  it("rejects a target that does not publish under the workspace repo", async () => {
    const { tools, deps } = setup();
    (
      deps.publishTargets.validateGhcrTargetForRepo as ReturnType<typeof vi.fn>
    ).mockReturnValue(
      "The recipe target must publish under the repository being modeled."
    );
    const result = await findTool(tools, "radius_publish_recipe").handler({
      file: ".radius/recipe.bicep",
      target: "br:ghcr.io/other/repo/recipe:v1"
    });
    expect(result).toContain("must publish under the repository");
    expect(deps.withGhcrDockerConfig).not.toHaveBeenCalled();
  });

  it("reports a missing recipe file without invoking GHCR", async () => {
    const { tools, deps } = setup();
    (deps.process.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(
      false
    );
    const result = await findTool(tools, "radius_publish_recipe").handler({
      file: ".radius/recipe.bicep",
      target: "br:ghcr.io/acme/widgets/recipe:v1"
    });
    expect(result).toContain("Recipe file not found at");
    expect(deps.withGhcrDockerConfig).not.toHaveBeenCalled();
  });

  it("publishes through withGhcrDockerConfig and reports the published target", async () => {
    const { tools, deps } = setup();
    const result = await findTool(tools, "radius_publish_recipe").handler({
      file: ".radius/recipe.bicep",
      target: "br:ghcr.io/acme/widgets/recipe:v1"
    });
    expect(deps.withGhcrDockerConfig).toHaveBeenCalledOnce();
    expect(deps.rad.runRadBicepPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.any(String),
        target: "br:ghcr.io/acme/widgets/recipe:v1",
        env: { DOCKER_CONFIG: "/tmp/fake-docker-config" }
      })
    );
    expect(result).toContain("Published recipe to");
  });

  it("surfaces a publish failure as a friendly warning", async () => {
    const { tools, deps } = setup();
    (deps.rad.runRadBicepPublish as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("denied: permission_denied")
    );
    const result = await findTool(tools, "radius_publish_recipe").handler({
      file: ".radius/recipe.bicep",
      target: "br:ghcr.io/acme/widgets/recipe:v1"
    });
    expect(result).toContain("Could not publish the recipe");
    expect(result).toContain("permission_denied");
  });
});

// RU-11: deploy identity/mapping/dispatch/repeat/failure.
describe("RU-11: radius_deploy", () => {
  it("reports there is nothing to deploy when no canvas session is open", async () => {
    const { tools } = setup();
    const result = await findTool(tools, "radius_deploy").handler({});
    expect(result).toContain("No Radius canvas session is open");
  });

  it("reports an inactive attempt when attemptId does not match any open instance", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:0",
      url: "http://127.0.0.1:0/?page=deployed",
      page: "deployed",
      state: { deployAttempt: { id: "attempt-A", targetRepo: "acme/widgets" } }
    });
    const result = await findTool(tools, "radius_deploy").handler({
      attemptId: "attempt-B"
    });
    expect(result).toContain('"attempt-B"');
    expect(result).toContain("no longer active");
  });

  it("dispatches the deploy via fetch and reports the started message, identifying repo/branch/environment", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({})
    );
    const result = await findTool(tools, "radius_deploy").handler({
      repo: "acme/widgets",
      environment: "production",
      branch: "main",
      provider: "azure"
    });
    expect(deps.deploy.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/api/deploy",
      expect.objectContaining({ method: "POST" })
    );
    expect(result).toContain("acme/widgets");
    expect(result).toContain("production");
    expect(result).toContain("started");
  });

  it("passes the repair-loop position from the route through to the agent", async () => {
    // The budget is only useful if it reaches the agent on every redeploy, so
    // the tool has to surface what the route reports rather than drop it.
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {
        deployAttempt: {
          id: "attempt-A",
          targetRepo: "acme/widgets",
          environment: "production",
          branch: "main",
          provider: "azure",
          appFile: ".radius/app.bicep"
        }
      }
    });
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ ok: true, repairAttempt: 3, repairAttemptCap: 5 })
    );
    const result = await findTool(tools, "radius_deploy").handler({
      attemptId: "attempt-A"
    });
    expect(result).toContain("automatic repair attempt 3 of 5");
  });

  it("repeats the last deploy from this session when called with no arguments", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {
        deployParams: {
          targetRepo: "acme/widgets",
          environment: "production",
          branch: "main",
          provider: "azure",
          appFile: ".radius/app.bicep"
        },
        deployStartedAt: Date.now()
      }
    });
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({})
    );
    await findTool(tools, "radius_deploy").handler({});
    const body = JSON.parse(
      (deps.deploy.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
    );
    expect(body.targetRepo).toBe("acme/widgets");
    expect(body.environment).toBe("production");
  });

  it("surfaces a dispatch failure returned by the server as a friendly warning", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ error: "workflow dispatch failed" }, 500)
    );
    const result = await findTool(tools, "radius_deploy").handler({
      repo: "acme/widgets",
      environment: "production"
    });
    expect(result).toContain("Could not start the deploy");
    expect(result).toContain("workflow dispatch failed");
  });

  it("surfaces a deploy transport failure", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connection reset")
    );

    const result = await findTool(tools, "radius_deploy").handler({
      repo: "acme/widgets",
      environment: "production"
    });

    expect(result).toContain("Could not start the deploy");
    expect(result).toContain("connection reset");
  });

  it("treats an empty successful deploy response as a started deploy", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("not json", { status: 200 })
    );

    const result = await findTool(tools, "radius_deploy").handler({
      repo: "acme/widgets",
      environment: "production"
    });

    expect(result).toContain("started");
  });
});

// RU-12: deploy status/log bounds/URL/diagnostics.
describe("RU-12: radius_deploy_status", () => {
  it("reports no deploy status when no canvas session is open", async () => {
    const { tools } = setup();
    const result = await findTool(tools, "radius_deploy_status").handler({});
    expect(result).toContain("no deploy status to report");
  });

  it("reports the workflow run URL and a bounded log tail on failure", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    const logs = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({
        status: "failed",
        error: "deploy failed",
        deployRunUrl: "https://github.com/acme/widgets/actions/runs/1",
        logs
      })
    );
    const result = await findTool(tools, "radius_deploy_status").handler({});
    const parsed = parseSkillHandoff(result);
    expect(parsed.status).toBe("failed");
    expect(parsed.deployRunUrl).toBe(
      "https://github.com/acme/widgets/actions/runs/1"
    );
    expect(parsed.diagnostic).toContain("line 299");
    // Default tail cap is 40 lines — "line 259" is the 40th-from-end line.
    expect(parsed.diagnostic).toContain("line 260");
    expect(parsed.diagnostic).not.toContain("line 259\n");
  });

  it("honors a custom logLines count bounded to the max", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    const logs = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ status: "failed", error: "x", logs })
    );
    const result = await findTool(tools, "radius_deploy_status").handler({
      logLines: 999
    });
    const parsed = parseSkillHandoff(result);
    // capped at DEPLOY_LOG_TAIL_MAX (200)
    expect(parsed.diagnostic).toContain("line 100");
    expect(parsed.diagnostic).not.toContain("line 99\n");
  });

  it("reports a read failure as a friendly warning", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({}, 500)
    );
    const result = await findTool(tools, "radius_deploy_status").handler({});
    expect(result).toContain("Could not read the deploy status");
    expect(result).toContain("HTTP 500");
  });

  it("surfaces a deploy-status transport failure", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("status connection reset")
    );

    const result = await findTool(tools, "radius_deploy_status").handler({});

    expect(result).toContain("Could not read the deploy status");
    expect(result).toContain("status connection reset");
  });

  it("normalizes an empty successful status response", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("not json", { status: 200 })
    );

    const result = parseSkillHandoff(
      await findTool(tools, "radius_deploy_status").handler({})
    );

    expect(result.status).toBe("pending");
  });
});
