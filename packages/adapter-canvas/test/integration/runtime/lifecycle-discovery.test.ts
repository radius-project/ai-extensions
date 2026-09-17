import { expect, it } from "vitest";
import { createLifecycleFixture } from "../../support/lifecycle.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createLifecycleValidators } from "@radius-project/adapter-shared";
import { createCanvasDiscoveryContext } from "../../../src/runtime/create-discovery-context.js";
import { createLifecycleBinding } from "../../../src/runtime/create-lifecycle-binding.js";

it("exposes truthful discovery capabilities through the panel-free public tool", async () => {
  const fixture = createLifecycleFixture();
  const harness = await createRuntimeSdkHarness({ lifecycle: fixture.binding });
  try {
    const tool = harness.extension.tools.find(
      (tool) => tool.name === "radius_lifecycle"
    );
    if (!tool) throw new Error("Missing lifecycle tool");
    const result: unknown = JSON.parse(
      String(
        await tool.handler({
          operation: "capabilities.get",
          target: { repo: "owner/repo" },
          input: {}
        })
      )
    );
    expect(result).toMatchObject({
      operation: "capabilities.get",
      result: {
        capabilities: expect.arrayContaining([
          {
            operation: "capabilities.get",
            apiVersion: "github-radius/v1",
            contexts: ["session"],
            providers: [],
            requiresAgent: false,
            limitations: []
          }
        ])
      }
    });

    expect(harness.getOrCreateServer).not.toHaveBeenCalled();
    expect(harness.session.rpc.canvas.open).not.toHaveBeenCalled();
  } finally {
    await harness.extension.shutdown("test");
  }
});

it("discovers and inspects real authored bytes with zero environments and fences supplied source expectations", async () => {
  const root = await mkdtemp(resolve(".test-discovery-runtime-"));
  const workspace = join(root, "worktree");
  await mkdir(workspace);
  const path = join(workspace, "app.bicep");
  const bytes =
    "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n  name: 'app'\n}\n";
  await writeFile(path, bytes);
  const fixture = createLifecycleFixture();
  const hostBinding = () => ({
    bindingRef: "fixture-binding",
    sessionRef: fixture.caller.sessionRef
  });
  const context = createCanvasDiscoveryContext({
    authority: fixture.ports.identity,
    hostBinding,
    clock: fixture.ports.clock,
    ids: fixture.ports.ids,
    storageRoot: join(root, "snapshots"),
    workspace: async () => ({
      repo: "owner/repo",
      workspacePath: workspace,
      branch: "feature"
    }),
    executor: async () => {
      throw new Error(
        "Authored discovery must not query environments, publish, log in or deploy"
      );
    },
    git: async (_root, args) => {
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return "feature";
      if (args.join(" ") === "rev-parse HEAD") return "a".repeat(40);
      throw new Error("Unmodeled Git command");
    }
  });
  const binding = createLifecycleBinding({
    ...context,
    authority: fixture.ports.identity,
    hostBinding,
    clock: fixture.ports.clock,
    ids: fixture.ports.ids,
    knownLegacyOperations: () => []
  });
  const harness = await createRuntimeSdkHarness({ lifecycle: binding });
  try {
    const tool = harness.extension.tools.find(
      (tool) => tool.name === "radius_lifecycle"
    );
    if (!tool) throw new Error("Missing lifecycle tool");
    const list: unknown = JSON.parse(
      String(
        await tool.handler({
          operation: "application.list",
          target: { repo: "owner/repo" },
          input: {}
        })
      )
    );
    const validated = createLifecycleValidators().validateResponse(list);
    if (
      !validated.valid ||
      !("operation" in validated.value) ||
      validated.value.operation !== "application.list"
    )
      throw new Error(`Invalid application listing: ${JSON.stringify(list)}`);
    const authored = validated.value.result.items[0]?.authored;
    if (!authored || authored.provenance.kind !== "workspace")
      throw new Error("Missing authored provenance");
    expect(validated.value.result.items[0]?.deployed).toBeUndefined();
    expect(authored.graph).toBeUndefined();
    const target = {
      repo: "owner/repo",
      application: "app",
      definition: "app.bicep"
    };
    expect(
      JSON.parse(
        String(
          await tool.handler({
            operation: "application.inspect",
            target,
            input: {}
          })
        )
      )
    ).toMatchObject({
      operation: "application.inspect",
      result: { authored: { definition: "app.bicep" } }
    });
    expect(await readFile(path, "utf8")).toBe(bytes);
    await writeFile(path, bytes.replace("'app'", "'changed'"));
    expect(
      JSON.parse(
        String(
          await tool.handler({
            operation: "application.inspect",
            target: {
              ...target,
              source: {
                kind: "workspace",
                workspaceRef: authored.provenance.workspaceRef,
                branch: authored.provenance.branch,
                expectedFingerprint: authored.provenance.fingerprint
              }
            },
            input: {}
          })
        )
      )
    ).toMatchObject({ error: { code: "SOURCE_CHANGED" } });
    expect(harness.getOrCreateServer).not.toHaveBeenCalled();
    expect(harness.session.rpc.canvas.open).not.toHaveBeenCalled();
  } finally {
    await harness.extension.shutdown("test");
    await fixture.binding.close();
    await rm(root, { recursive: true, force: true });
  }
});
