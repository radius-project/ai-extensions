import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { nodeSourceFileSystem } from "@radius-project/adapter-shared";
import { createLifecycleFixture } from "../../test/support/lifecycle.js";
import { createCanvasDiscoveryContext } from "./create-discovery-context.js";
import { createLifecycleBinding } from "./create-lifecycle-binding.js";

it("fences concurrent shutdown and permits retrying local cleanup without reopening discovery", async () => {
  const root = await mkdtemp(resolve(".test-discovery-cleanup-"));
  const workspace = join(root, "worktree");
  await mkdir(workspace);
  const foundation = createLifecycleFixture();
  const hostBinding = () => ({
    sessionRef: foundation.caller.sessionRef,
    bindingRef: "binding"
  });
  let locked = false;
  const context = createCanvasDiscoveryContext({
    authority: foundation.ports.identity,
    clock: foundation.ports.clock,
    ids: foundation.ports.ids,
    hostBinding,
    storageRoot: join(root, "snapshots"),
    files: {
      ...nodeSourceFileSystem,
      remove: async (path) => {
        if (locked) throw new Error("Locked snapshot directory");
        return nodeSourceFileSystem.remove(path);
      }
    },
    workspace: async () => ({
      repo: "owner/repo",
      workspacePath: workspace,
      branch: "feature"
    }),
    git: async (_root, args) =>
      args.includes("--abbrev-ref") ? "feature" : "a".repeat(40),
    executor: async () => {
      throw new Error("No GitHub command expected");
    }
  });
  const binding = createLifecycleBinding({
    ...context,
    authority: foundation.ports.identity,
    clock: foundation.ports.clock,
    ids: foundation.ports.ids,
    hostBinding,
    knownLegacyOperations: () => []
  });
  try {
    expect(
      await binding.execute({
        operation: "application.inspect",
        target: {
          repo: "owner/repo",
          application: "app",
          definition: "app.bicep"
        },
        input: {}
      })
    ).toMatchObject({ error: { code: "DEFINITION_NOT_FOUND" } });
    await writeFile(
      join(workspace, "app.bicep"),
      "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n name: 'app'\n}\n"
    );
    expect(
      await binding.execute({
        operation: "application.list",
        target: { repo: "owner/repo" },
        input: {}
      })
    ).toMatchObject({ operation: "application.list" });
    locked = true;
    const results = await Promise.allSettled([
      binding.close(),
      binding.close()
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected"
    ]);
    expect(
      await binding.execute({
        operation: "capabilities.get",
        target: { repo: "owner/repo" },
        input: {}
      })
    ).toMatchObject({ error: { code: "PRECONDITION_FAILED" } });
    locked = false;
    await binding.close();
    await binding.close();
  } finally {
    locked = false;
    await binding.close();
    await foundation.binding.close();
    await rm(root, { recursive: true, force: true });
  }
});
