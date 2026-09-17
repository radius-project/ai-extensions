import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { portSuccess } from "@radius-project/core/lifecycle";
import { createWorkspaceSourceHost } from "./workspace-source.js";
import { createWorkspaceGitPort } from "./workspace-source.js";
import { nodeSourceFileSystem } from "./source-access-files.js";

it("captures real uncommitted bytes with computed expectations and no source publication", async () => {
  const root = await mkdtemp(resolve(".test-discovery-source-"));
  const workspace = join(root, "worktree");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "app.bicep"),
    "param application string = 'app'\n"
  );
  let sequence = 0;
  const host = createWorkspaceSourceHost({
    storageRoot: join(root, "snapshots"),
    workspace: async () => ({
      repo: "owner/repo",
      workspacePath: workspace,
      branch: "feature"
    }),
    authorize: async () => portSuccess(undefined),
    git: async (_root, args) => {
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return "feature";
      if (args.join(" ") === "rev-parse HEAD") return "a".repeat(40);
      throw new Error("Unexpected Git command");
    },
    clock: { now: () => "2026-09-15T00:00:00Z" },
    ids: { next: () => `id-${++sequence}` }
  });
  const scope = {
    operation: "application.list" as const,
    target: { repo: "owner/repo" },
    authorizationRef: "auth",
    principalRef: "reader"
  };
  const control = {
    requestId: "read",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  try {
    const selection = await host.resolveSelection(scope, undefined, control);
    if (selection.status !== "ok") throw new Error("Expected source selection");
    expect(selection.value.definition).toBe("app.bicep");
    const capture = await host.source.capture(scope, selection.value, control);
    expect(capture).toMatchObject({
      status: "ok",
      value: { status: "captured" }
    });
    await writeFile(
      join(workspace, "app.bicep"),
      "param application string = 'changed'\n"
    );
    expect(
      await host.source.capture(scope, selection.value, control)
    ).toMatchObject({
      status: "failed",
      error: { code: "SOURCE_CHANGED" }
    });
    expect(await readFile(join(workspace, "app.bicep"), "utf8")).toContain(
      "changed"
    );
    expect(
      await host.source.capture(
        scope,
        {
          ...selection.value,
          source: {
            kind: "git",
            ref: "feature",
            expectedCommit: "a".repeat(40)
          }
        },
        control
      )
    ).toMatchObject({ status: "unavailable" });
    expect(
      await host.source.capture(
        scope,
        {
          ...selection.value,
          source: {
            kind: "workspace",
            workspaceRef: "another-workspace",
            branch: "feature",
            expectedFingerprint: `sha256:${"a".repeat(64)}`
          }
        },
        control
      )
    ).toMatchObject({ status: "forbidden" });
    await host.close();
    expect(
      await host.source.capture(scope, selection.value, control)
    ).toMatchObject({ status: "cancelled" });
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  "absent",
  "incomplete",
  "forbidden",
  "wrong-repo",
  "invalid-path",
  "workspace-error",
  "storage-error"
] as const)(
  "reports %s source prerequisites without weakening capture",
  async (kind) => {
    const { portForbidden } = await import("@radius-project/core/lifecycle");
    const root = await mkdtemp(resolve(".test-discovery-source-"));
    const path = join(root, "app.bicep");
    if (kind !== "absent")
      await writeFile(
        path,
        kind === "incomplete" ?
          "module remote 'br:ghcr.io/owner/module:v1' = {}\n"
        : "param value string\n"
      );
    let sequence = 0;
    const host = createWorkspaceSourceHost({
      storageRoot: kind === "storage-error" ? path : join(root, "snapshots"),
      workspace: async () => {
        if (kind === "workspace-error") throw new Error("Context unavailable");
        return {
          repo: kind === "wrong-repo" ? "other/repo" : "owner/repo",
          workspacePath: root,
          branch: "feature"
        };
      },
      authorize: async () =>
        kind === "forbidden" ? portForbidden() : portSuccess(undefined),
      git: async (_root, args) =>
        args.includes("--abbrev-ref") ? "feature" : "a".repeat(40),
      clock: { now: () => "2026-09-15T00:00:00Z" },
      ids: { next: () => `id-${++sequence}` }
    });
    const scope = {
      operation: "application.list" as const,
      target: { repo: "owner/repo" },
      principalRef: "reader",
      authorizationRef: "auth"
    };
    const control = {
      requestId: "read",
      cancellation: { aborted: false, onAbort: () => () => {} }
    };
    try {
      const result = await host.resolveSelection(
        scope,
        kind === "invalid-path" ? "../escape.bicep" : "app.bicep",
        control
      );
      if (kind === "storage-error") {
        if (result.status !== "ok") throw new Error("Expected selection");
        expect(
          await host.source.capture(scope, result.value, control)
        ).toMatchObject({ status: "failed" });
      } else
        expect(result.status).toBe(
          kind === "absent" ? "absent"
          : kind === "forbidden" || kind === "wrong-repo" ? "forbidden"
          : kind === "invalid-path" ? "failed"
          : "unavailable"
        );
      await host.close();
      expect(
        await host.resolveSelection(scope, undefined, control)
      ).toMatchObject({ status: "cancelled" });
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
it("exposes only read-only Git state and explicitly refuses remote materialization", async () => {
  const git = createWorkspaceGitPort(async (_root, args) =>
    args.includes("--abbrev-ref") ? "feature" : "a".repeat(40)
  );
  const control = {
    requestId: "read",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  const remote = {
    kind: "git" as const,
    repo: "owner/repo",
    accessRef: "access"
  };
  expect(await git.readCommit("workspace", control)).toEqual(
    portSuccess("a".repeat(40))
  );
  expect(await git.resolveCommit(remote, "feature", control)).toMatchObject({
    status: "unavailable"
  });
  expect(
    await git.materializeCommit(remote, "a".repeat(40), "destination", control)
  ).toMatchObject({ status: "unavailable" });
  expect(() =>
    Reflect.apply(createWorkspaceSourceHost, undefined, [{}])
  ).toThrow("require");
});
it("rechecks authorization at capture and fences cancellation during missing-file observation", async () => {
  const { portForbidden } = await import("@radius-project/core/lifecycle");
  const root = await mkdtemp(resolve(".test-discovery-source-"));
  let denied = false;
  let aborted = false;
  let sequence = 0;
  const host = createWorkspaceSourceHost({
    storageRoot: join(root, "snapshots"),
    workspace: async () => ({
      repo: "owner/repo",
      workspacePath: root,
      branch: "feature"
    }),
    authorize: async () => (denied ? portForbidden() : portSuccess(undefined)),
    git: async () => {
      throw new Error("No Git for rejected reads");
    },
    clock: { now: () => "2026-09-15T00:00:00Z" },
    ids: { next: () => `id-${++sequence}` },
    files: {
      ...nodeSourceFileSystem,
      lstat: async (path) => {
        try {
          return await nodeSourceFileSystem.lstat(path);
        } catch (error) {
          aborted = true;
          throw error;
        }
      }
    }
  });
  const scope = {
    operation: "application.list" as const,
    target: { repo: "owner/repo" },
    principalRef: "reader",
    authorizationRef: "auth"
  };
  const control = {
    requestId: "read",
    cancellation: {
      get aborted() {
        return aborted;
      },
      onAbort: () => () => {}
    }
  };
  try {
    denied = true;
    expect(
      await host.source.capture(
        scope,
        {
          repo: "owner/repo",
          definition: "app.bicep",
          source: {
            kind: "workspace",
            workspaceRef: "id-1",
            branch: "feature",
            expectedFingerprint: `sha256:${"a".repeat(64)}`
          }
        },
        control
      )
    ).toMatchObject({ status: "forbidden" });
    denied = false;
    expect(
      await host.resolveSelection(scope, "app.bicep", control)
    ).toMatchObject({ status: "cancelled" });
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
