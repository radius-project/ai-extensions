import { describe, expect, it } from "vitest";
import type {
  GraphSourceBindings,
  GraphSourceRequest
} from "@radius-project/adapter-shared";
import type { GraphSourceRead } from "@radius-project/core";
import { createCanvasGraphSources } from "./graph-sources.js";
import { isWorkspaceSelection } from "../workspace.js";
import type { CanvasState } from "../shared.js";

const source = {
  kind: "workspace" as const,
  repo: "acme/app",
  ref: "topic",
  definitionPath: "app.bicep",
  workspacePath: "/workspace"
};
const state: CanvasState = {
  workspaceRepo: "acme/app",
  workspaceBranch: "topic",
  workspacePath: "/workspace"
};

function harness(selected: GraphSourceRead, branch = "topic") {
  const reads: GraphSourceRequest[] = [];
  const handle = {
    dir: "/staging",
    owned: true,
    fingerprint: "hash",
    dispose: async () => {}
  };
  const sources: GraphSourceBindings = {
    assertWorkspaceSource: async () => {},
    read: async (request) => {
      reads.push(request);
      return selected;
    },
    readFile: async () => {
      throw new Error("Unscripted exact read.");
    },
    stage: async (selection) => {
      expect(selection).toBe(selected);
      return handle;
    }
  };
  return {
    reads,
    handle,
    sources,
    bindings: createCanvasGraphSources(
      sources,
      isWorkspaceSelection,
      async () => branch
    )
  };
}

describe("Canvas graph source composition", () => {
  it("retains the selected identity and root path when projecting a workspace model", async () => {
    const selected: GraphSourceRead = {
      status: "present",
      source,
      content: "model"
    };
    const { bindings, reads } = harness(selected);
    const selection = await bindings.select({ state }, "acme/app", "topic");
    expect(selection).toEqual({
      content: "model",
      fromWorkspace: true,
      branch: "topic",
      bicepPath: "app.bicep",
      sourceRead: selected,
      verifyWorkspaceBranch: expect.any(Function)
    });
    await expect(selection.verifyWorkspaceBranch?.()).resolves.toBe(true);
    expect(reads[0]?.workspace).toEqual({
      repo: "acme/app",
      ref: "topic",
      path: "/workspace",
      authorized: true
    });
  });

  it("projects confirmed absence without replacing the selected source", async () => {
    const selected: GraphSourceRead = { status: "absent", source };
    const { bindings } = harness(selected);
    expect(await bindings.select({ state }, "acme/app", "topic")).toMatchObject(
      {
        content: null,
        fromWorkspace: true,
        sourceRead: selected
      }
    );
  });

  it("surfaces unreadable sources instead of returning absence", async () => {
    const { bindings } = harness({
      status: "unavailable",
      source,
      diagnostic: "permission denied"
    });
    const pending = bindings.select({ state: {} }, "acme/app", "topic");
    await expect(pending).rejects.toThrow(
      "acme/app@topic:app.bicep: permission denied"
    );
    await expect(pending).rejects.toMatchObject({
      code: "unavailable",
      source
    });
  });

  it("forwards the remote committed identity and refuses workspace authorization for another branch", async () => {
    const selected: GraphSourceRead = {
      status: "present",
      content: "committed",
      source: {
        ...source,
        kind: "github",
        ref: "base",
        revision: "a".repeat(40)
      }
    };
    const { bindings, reads } = harness(selected);
    expect(await bindings.select({ state }, "acme/app", "base")).toMatchObject({
      fromWorkspace: false,
      sourceRead: selected
    });
    expect(reads[0]?.workspace?.authorized).toBe(false);
  });

  it("uses the live checkout in both directions without rewriting cached branch state", async () => {
    const localSource = { ...source, ref: "new-topic" };
    const { sources, reads } = harness(
      { status: "present", source: localSource, content: "local" },
      "new-topic"
    );
    const read = sources.read;
    sources.read = async (request) => {
      if (request.workspace?.authorized) return read(request);
      return {
        status: "present",
        source: { ...source, kind: "github", revision: "a".repeat(40) },
        content: "older pushed model"
      };
    };
    const bindings = createCanvasGraphSources(
      sources,
      isWorkspaceSelection,
      async () => "new-topic"
    );
    expect(await bindings.select({ state }, "acme/app", "topic")).toMatchObject(
      {
        fromWorkspace: false,
        content: "older pushed model",
        sourceRead: { source: { revision: "a".repeat(40) } }
      }
    );
    expect(
      await bindings.select({ state }, "acme/app", "new-topic")
    ).toMatchObject({
      fromWorkspace: true,
      content: "local"
    });
    expect(reads[0]?.workspace).toMatchObject({
      ref: "new-topic",
      authorized: true
    });
    expect(state.workspaceBranch).toBe("topic");
  });

  it("does not fall back when a same-repo checkout probe is unavailable", async () => {
    const { bindings, reads } = harness({ status: "absent", source }, "");
    await expect(
      bindings.select({ state }, "acme/app", "topic")
    ).rejects.toMatchObject({
      constructor: expect.objectContaining({ name: "GraphRequestSuperseded" })
    });
    expect(reads).toEqual([]);
  });

  it("rejects a workspace model if the branch changes during the admitted read", async () => {
    const { sources } = harness({ status: "absent", source });
    let branch = "topic";
    sources.read = async () => {
      branch = "other";
      return { status: "absent", source };
    };
    const bindings = createCanvasGraphSources(
      sources,
      isWorkspaceSelection,
      async () => branch
    );
    await expect(
      bindings.select({ state }, "acme/app", "topic")
    ).rejects.toMatchObject({
      constructor: expect.objectContaining({ name: "GraphRequestSuperseded" })
    });
  });
  it("stages the exact captured source and retains its ownership handle", async () => {
    const selection: GraphSourceRead = {
      status: "present",
      source,
      content: "model"
    };
    const { bindings, handle } = harness(selection);
    expect(
      await bindings.stage({
        selection,
        repo: "acme/app",
        branch: "topic",
        bicepRepoPath: "app.bicep",
        isLocal: true
      })
    ).toEqual({ dir: handle.dir, remote: true, handle });
  });

  it("does not stage an absent model", async () => {
    const selection: GraphSourceRead = { status: "absent", source };
    const { bindings, sources } = harness(selection);
    sources.stage = async () => {
      throw new Error("Must not stage absence.");
    };
    expect(
      await bindings.stage({
        selection,
        repo: "acme/app",
        branch: "topic",
        bicepRepoPath: "app.bicep",
        isLocal: true
      })
    ).toEqual({ dir: "", remote: false });
  });

  it.each(["other", ""])(
    "refuses recovery on a changed or unavailable workspace branch (%s)",
    async (branch) => {
      const { bindings, reads } = harness(
        { status: "present", source, content: "model" },
        branch
      );
      await expect(
        bindings.readForRecovery({ state }, "acme/app", "topic", "app.bicep")
      ).rejects.toThrow("captured workspace branch changed");
      expect(reads).toEqual([]);
    }
  );

  it("refuses recovery if the workspace switches during the read", async () => {
    const { sources } = harness({
      status: "present",
      source,
      content: "model"
    });
    let branch = "topic";
    sources.read = async () => {
      branch = "other";
      return { status: "absent", source };
    };
    const bindings = createCanvasGraphSources(
      sources,
      isWorkspaceSelection,
      async () => branch
    );
    await expect(
      bindings.readForRecovery({ state }, "acme/app", "topic", "app.bicep")
    ).rejects.toThrow("captured workspace branch changed");
  });

  it("recovers an exact remote path without requiring a workspace branch", async () => {
    const selected: GraphSourceRead = {
      status: "absent",
      source: { ...source, kind: "github" }
    };
    const { sources, reads } = harness(selected);
    const bindings = createCanvasGraphSources(
      sources,
      isWorkspaceSelection,
      async () => {
        throw new Error("No workspace reads.");
      }
    );
    expect(
      await bindings.readForRecovery(
        { state: {} },
        "acme/app",
        "topic",
        "custom/app.bicep"
      )
    ).toBe(selected);
    expect(reads[0]).toMatchObject({
      definitionPath: "custom/app.bicep",
      workspace: { authorized: false }
    });
  });
});
