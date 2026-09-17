import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  portSuccess,
  type EnvironmentAccessPort
} from "@radius-project/core/lifecycle";
import { createLifecycleValidators } from "@radius-project/adapter-shared";
import {
  createGraphBoundaryFixture,
  graphBase,
  graphBranch,
  graphDefinition,
  graphHead,
  graphInputs,
  startGraphRuntime
} from "../../support/lifecycle-graphs.js";

let validators: ReturnType<typeof createLifecycleValidators>;

beforeAll(() => {
  validators = createLifecycleValidators();
});

afterEach(() => vi.unstubAllEnvs());

it("registers authored graph reads in the actual runtime and recompiles changed worktree supporting and binary inputs without opening a panel", async () => {
  const fixture = await createGraphBoundaryFixture();
  const runtime = await startGraphRuntime(fixture);
  try {
    const capabilities = await runtime.execute({
      operation: "capabilities.get",
      target: { repo: "owner/repo" },
      input: {}
    });
    expect(capabilities).toMatchObject({
      result: {
        capabilities: expect.arrayContaining([
          expect.objectContaining({
            operation: "graph.get",
            requiresAgent: false
          }),
          expect.objectContaining({
            operation: "graph.diff",
            requiresAgent: false
          })
        ])
      }
    });
    const intent = {
      operation: "graph.get",
      target: { repo: "owner/repo", definition: graphDefinition },
      input: { kind: "authored" }
    };
    const first = validators.validateResponse(await runtime.execute(intent));
    if (
      !first.valid ||
      !("operation" in first.value) ||
      first.value.operation !== "graph.get" ||
      first.value.result.kind !== "authored"
    )
      throw new Error(
        "Expected validated authored graph from registered runtime"
      );
    const before = first.value.result;
    expect(before.provenance).toMatchObject({
      kind: "workspace",
      branch: graphBranch,
      baseCommit: "c".repeat(40)
    });
    expect(fixture.compiled[0]?.inputs).toEqual(graphInputs("uncommitted"));
    await fixture.expectUnchanged();
    await fixture.replaceWorkspaceInputs("changed-supporting-and-binary");
    const second = validators.validateResponse(await runtime.execute(intent));
    if (
      !second.valid ||
      !("operation" in second.value) ||
      second.value.operation !== "graph.get" ||
      second.value.result.kind !== "authored"
    )
      throw new Error("Expected a fresh validated authored graph");
    expect(second.value.result.provenance.fingerprint).not.toBe(
      before.provenance.fingerprint
    );
    expect(second.value.result.graph.resources[0]?.diffHash).not.toBe(
      before.graph.resources[0]?.diffHash
    );
    expect(fixture.compiled[1]?.inputs).toEqual(
      graphInputs("changed-supporting-and-binary")
    );
    expect(fixture.runGraph).toHaveBeenCalledTimes(2);
    expect(fixture.calls).toEqual([]);
    expect(runtime.open).not.toHaveBeenCalled();
    expect(runtime.send).not.toHaveBeenCalled();
    await fixture.expectUnchanged("changed-supporting-and-binary");
  } finally {
    await runtime.extension.shutdown("test");
    await fixture.close();
  }
});

it("independently authorizes a fork comparison and compiles committed base/head snapshots through the isolated shared compiler", async () => {
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "AZURE_CLIENT_SECRET",
    "AWS_ACCESS_KEY_ID",
    "DOCKER_CONFIG"
  ])
    vi.stubEnv(key, "fixture-only-graph");
  vi.stubEnv("GITHUB_ACTIONS", "true");
  const fixture = await createGraphBoundaryFixture();
  const runtime = await startGraphRuntime(fixture);
  try {
    const result = await runtime.execute({
      operation: "graph.diff",
      target: { repo: graphHead.repo },
      input: { kind: "authored", base: graphBase, head: graphHead }
    });
    expect(result).toMatchObject({
      operation: "graph.diff",
      result: {
        status: "available",
        baseTarget: graphBase,
        headTarget: graphHead,
        base: {
          kind: "git",
          repo: graphBase.repo,
          ref: "main",
          commit: "a".repeat(40)
        },
        head: {
          kind: "git",
          repo: graphHead.repo,
          ref: graphBranch,
          commit: "b".repeat(40)
        },
        graph: {
          resources: [
            expect.objectContaining({ id: "cache", diffStatus: "modified" })
          ]
        }
      }
    });
    for (const target of [graphBase, graphHead])
      expect(fixture.authorizations).toContainEqual(
        expect.objectContaining({
          operation: "graph.diff",
          target
        })
      );
    expect(fixture.compiled.map((entry) => entry.inputs)).toEqual(
      expect.arrayContaining([
        graphInputs("committed-base"),
        graphInputs("committed-head")
      ])
    );
    expect(fixture.runGraph).toHaveBeenCalledTimes(2);
    expect(fixture.git).not.toHaveBeenCalled();
    expect(
      fixture.calls.some((args) =>
        args.includes(
          `/repos/fork/repo/contents/${graphDefinition}?ref=${"b".repeat(40)}`
        )
      )
    ).toBe(true);
    expect(
      fixture.calls.every((args) => args[0] === "api" && args[4] === "GET")
    ).toBe(true);
    expect(runtime.open).not.toHaveBeenCalled();
    await fixture.expectUnchanged();
  } finally {
    await runtime.extension.shutdown("test");
    await fixture.close();
  }
});

it("does not reuse the head repository authorization when the fork scope is forbidden", async () => {
  const fixture = await createGraphBoundaryFixture({ denyFork: true });
  const runtime = await startGraphRuntime(fixture);
  try {
    // The coarse repository scope succeeds; its complete source selection
    // requires independent authorization before any source retrieval.
    const result = await runtime.execute({
      operation: "graph.diff",
      target: { repo: graphHead.repo },
      input: { kind: "authored", base: graphBase, head: graphHead }
    });
    expect(result).toMatchObject({
      result: { status: "unavailable", source: "head", reason: "FORBIDDEN" }
    });
    expect(fixture.authorizations).toContainEqual(
      expect.objectContaining({
        operation: "graph.diff",
        target: graphHead
      })
    );
    expect(
      fixture.calls.some((args) =>
        args.some((arg) => arg.startsWith("/repos/fork/"))
      )
    ).toBe(false);
    expect(
      fixture.compiled.map((entry) =>
        entry.inputs.get(".radius/settings.json")?.toString()
      )
    ).not.toContain(JSON.stringify({ label: "committed-head" }));
    await fixture.expectUnchanged();
  } finally {
    await runtime.extension.shutdown("test");
    await fixture.close();
  }
});

it.each([
  ["missing", /DEFINITION_NOT_FOUND|does not exist|not found/i],
  ["forbidden", /FORBIDDEN|forbidden/i],
  ["network", /SOURCE_UNAVAILABLE|RESULT_UNAVAILABLE|connection|unavailable/i],
  ["malformed", /RESULT_UNAVAILABLE.*evidence/i]
] as const)(
  "retains the original PR description and opens no panel after actual %s source evidence",
  async (baseMode, reason) => {
    const fixture = await createGraphBoundaryFixture({ baseMode });
    const runtime = await startGraphRuntime(fixture);
    try {
      const args = {
        repo: "owner/repo",
        baseBranch: "main",
        headBranch: graphBranch
      };
      const tool = runtime.tool("radius_generate_pr_diff_markdown");
      const result = await tool.handler(args);
      expect(result).toMatchObject({
        resultType: "success",
        toolTelemetry: { radiusGraphDiff: { outcome: "unavailable" } }
      });
      expect(JSON.stringify(result)).toMatch(reason);
      expect(JSON.stringify(result)).not.toContain("```mermaid");
      expect(JSON.stringify(result)).not.toContain("## Application graph");
      expect(
        fixture.calls.some((call) =>
          call.includes("/repos/owner/repo/commits/main")
        )
      ).toBe(true);
      await runtime.extension.hooks.onPostToolUse({
        toolName: tool.name,
        toolArgs: args,
        toolResult: result,
        workingDirectory: fixture.workspace
      });
      const originalBody =
        "## Summary\n\nPreserve this reviewer-written description.\n";
      const request = {
        toolName: "create_pull_request",
        toolArgs: { title: "Change application", body: originalBody },
        workingDirectory: fixture.workspace
      };
      const hook = await runtime.extension.hooks.onPreToolUse(request);
      expect(hook).not.toHaveProperty("permissionDecision");
      expect(hook).not.toHaveProperty("updatedInput");
      expect(hook?.additionalContext).toContain("without a graph diff section");
      await runtime.extension.hooks.onPostToolUse(request);
      expect(request.toolArgs.body).toBe(originalBody);
      expect(runtime.open).not.toHaveBeenCalled();
      expect(runtime.send).not.toHaveBeenCalled();
      expect(
        fixture.compiled.map((entry) =>
          entry.inputs.get(".radius/settings.json")?.toString()
        )
      ).not.toContain(JSON.stringify({ label: "uncommitted" }));
      await fixture.expectUnchanged();
    } finally {
      await runtime.extension.shutdown("test");
      await fixture.close();
    }
  }
);

it("reports unavailable actual production recipe evidence without provider defaults or an evidence-producing workflow", async () => {
  const fixture = await createGraphBoundaryFixture();
  const runtime = await startGraphRuntime(fixture);
  try {
    const result = await runtime.execute({
      operation: "graph.get",
      target: {
        repo: "owner/repo",
        definition: graphDefinition,
        environment: "dev"
      },
      input: { kind: "planned" }
    });
    expect(result).toMatchObject({ error: { code: "RESULT_UNAVAILABLE" } });
    expect(result).not.toHaveProperty("result.graph");
    expect(
      fixture.calls.some(
        (args) => args.includes("POST") || args.includes("workflow")
      )
    ).toBe(false);
    await fixture.expectUnchanged();
  } finally {
    await runtime.extension.shutdown("test");
    await fixture.close();
  }
});

it("preserves selected-environment registration evidence and distinct expected outputs at the public tool boundary", async () => {
  const observed: string[] = [];
  const registrations: EnvironmentAccessPort["registrations"] = async (
    _scope,
    target
  ) => {
    observed.push(target.environment);
    if (
      target.repo !== "owner/repo" ||
      !["azure-test", "aws-test"].includes(target.environment)
    )
      throw new Error("Unmodeled environment registration read");
    return portSuccess({
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
        observedAt: "2026-09-15T22:00:00Z",
        limitation:
          "Expected recipe outputs, not an authoritative deployment plan."
      }
    });
  };
  const fixture = await createGraphBoundaryFixture({ registrations });
  const runtime = await startGraphRuntime(fixture);
  try {
    for (const [environment, type] of [
      ["azure-test", "Microsoft.Cache/redisEnterprise"],
      ["aws-test", "apps/Deployment"]
    ]) {
      const result = await runtime.execute({
        operation: "graph.get",
        target: {
          repo: "owner/repo",
          definition: graphDefinition,
          environment
        },
        input: { kind: "planned" }
      });
      expect(result).toMatchObject({
        operation: "graph.get",
        result: {
          kind: "planned",
          target: { environment },
          graph: {
            resources: [
              expect.objectContaining({
                outputResources: [expect.objectContaining({ type })]
              })
            ]
          },
          enrichment: {
            observation: {
              evidence: "radius",
              observedAt: "2026-09-15T22:00:00Z"
            }
          }
        }
      });
    }
    expect(observed).toEqual(["azure-test", "aws-test"]);
    expect(fixture.calls).toEqual([]);
    expect(runtime.open).not.toHaveBeenCalled();
    await fixture.expectUnchanged();
  } finally {
    await runtime.extension.shutdown("test");
    await fixture.close();
  }
});

it("cancels in-flight compilation on runtime shutdown, releases snapshots and rejects a late request without authoring", async () => {
  const fixture = await createGraphBoundaryFixture();
  const runtime = await startGraphRuntime(fixture);
  let entered: () => void = () => {
    throw new Error("Compiler entry signal not initialized");
  };
  const started = new Promise<void>((done) => {
    entered = done;
  });
  fixture.runGraph.mockImplementation(async (_file, options) => {
    entered();
    const signal = options?.signal;
    if (!signal) throw new Error("Missing compiler cancellation signal");
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new Error("Cancelled compilation"));
      else
        signal.addEventListener(
          "abort",
          () => reject(new Error("Cancelled compilation")),
          { once: true }
        );
    });
  });
  const intent = {
    operation: "graph.get",
    target: { repo: "owner/repo", definition: graphDefinition },
    input: { kind: "authored" }
  };
  const pending = runtime.execute(intent);
  try {
    // A response before compiler entry is an unexpected early failure, not a
    // reason to leave shutdown waiting on an entry signal that never arrives.
    await Promise.race([
      started,
      pending.then(() => {
        throw new Error("Graph request completed before compilation");
      })
    ]);
    await runtime.extension.shutdown("test");
    expect(await pending).toHaveProperty("error");
    expect(await runtime.execute(intent)).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
    await runtime.extension.shutdown("duplicate");
    expect(fixture.runGraph).toHaveBeenCalledTimes(1);
    expect(runtime.open).not.toHaveBeenCalled();
    await fixture.expectUnchanged();
  } finally {
    try {
      await runtime.extension.shutdown("test");
      await pending;
    } finally {
      await fixture.close();
    }
  }
});

it("makes the boundary fixture reject unknown GitHub reads, privileged workflow dispatch and Git pushes instead of a successful fallback", async () => {
  const fixture = await createGraphBoundaryFixture();
  try {
    const executor = await fixture.executor("fixture-reader");
    const prefix = ["api", "--hostname", "github.com", "--method"];
    expect(await executor.run([...prefix, "GET", "/repos/owner/repo"])).toEqual(
      {
        code: 0,
        stdout: '{"full_name":"owner/repo"}',
        stderr: ""
      }
    );
    for (const args of [
      [...prefix, "GET", "/repos/owner/repo/unmodeled"],
      [
        ...prefix,
        "POST",
        "/repos/owner/repo/actions/workflows/deploy.yml/dispatches"
      ],
      ["release", "upload", "graph", "app-graph.json"]
    ])
      await expect(executor.run(args)).rejects.toThrow(
        "Unmodeled graph boundary: gh:"
      );
    await expect(
      fixture.git(fixture.workspace, ["push", "origin", graphBranch])
    ).rejects.toThrow("Unmodeled graph boundary: git:");
    expect(fixture.forbidden).toHaveLength(4);
    expect(fixture.runGraph).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
  } finally {
    await fixture.close();
  }
});
