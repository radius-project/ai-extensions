import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createCanvasDiscoveryContext } from "./create-discovery-context.js";
import { createLifecycleBinding } from "./create-lifecycle-binding.js";
import { createLifecycleFixture } from "../../test/support/lifecycle.js";

it.each(["complete", "incomplete"] as const)(
  "discovers both canonical definitions in order with %s first-source evidence and explicit inspection access",
  async (mode) => {
    const root = await mkdtemp(resolve(".test-discovery-canonical-"));
    const workspace = join(root, "worktree");
    await mkdir(join(workspace, ".radius"), { recursive: true });
    const app = (name: string) =>
      `resource app 'Radius.Core/applications@2025-08-01-preview' = { name: '${name}' }\n`;
    await writeFile(
      join(workspace, ".radius", "app.bicep"),
      app("primary") +
        (mode === "incomplete" ?
          "module remote 'br:ghcr.io/owner/module:v1' = {}\n"
        : "")
    );
    await writeFile(join(workspace, "app.bicep"), app("secondary"));
    await writeFile(join(workspace, "extra.bicep"), app("extra"));
    const fixture = createLifecycleFixture();
    const hostBinding = () => ({
      sessionRef: fixture.caller.sessionRef,
      bindingRef: "binding"
    });
    const context = createCanvasDiscoveryContext({
      authority: fixture.ports.identity,
      ids: fixture.ports.ids,
      clock: fixture.ports.clock,
      hostBinding,
      storageRoot: join(root, "snapshots"),
      workspace: async () => ({
        repo: "owner/repo",
        branch: "feature",
        workspacePath: workspace
      }),
      git: async (_root, args) =>
        args.includes("--abbrev-ref") ? "feature" : "a".repeat(40),
      executor: async () => {
        throw new Error("Worktree reads must not contact GitHub");
      }
    });
    const binding = createLifecycleBinding({
      ...context,
      authority: fixture.ports.identity,
      ids: fixture.ports.ids,
      clock: fixture.ports.clock,
      hostBinding,
      knownLegacyOperations: () => []
    });
    try {
      const listed = await binding.execute({
        operation: "application.list",
        target: { repo: "owner/repo" },
        input: {}
      });
      if (mode === "complete")
        expect(listed).toMatchObject({
          result: {
            items: [
              { target: { application: "primary" } },
              { target: { application: "secondary" } }
            ],
            observation: { completeness: "partial" }
          }
        });
      else
        expect(listed).toMatchObject({ error: { code: "SOURCE_UNAVAILABLE" } });
      expect(
        await binding.execute({
          operation: "application.inspect",
          target: {
            repo: "owner/repo",
            application: "extra",
            definition: "extra.bicep"
          },
          input: {}
        })
      ).toMatchObject({ result: { authored: { definition: "extra.bicep" } } });
    } finally {
      await binding.close();
      await fixture.binding.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
