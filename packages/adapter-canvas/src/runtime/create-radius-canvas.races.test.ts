import { afterEach, describe, expect, it, vi } from "vitest";
import { portForbidden } from "@radius-project/core/lifecycle";
import { createRadiusCanvas } from "./create-radius-canvas.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../test/support/runtime/fakes.js";
import { scriptGraphDiff } from "../../test/support/canonical-graphs.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred promise not initialized");
  };
  let reject: (error: Error) => void = () => {
    throw new Error("Deferred promise not initialized");
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const context = {
  extensionId: "plugin:radius",
  canvasId: "radius",
  instanceId: "race-panel"
};
const diffInput = {
  page: "graph-diff",
  repo: "acme/widgets",
  baseBranch: "main",
  headBranch: "feat"
};
const cleanups: (() => Promise<void>)[] = [];
function setup() {
  const fake = createFakeDependencies();
  fake.sessionHolder.set(createFakeSession());
  const canvas = createRadiusCanvas(fake.deps);
  cleanups.push(async () => {
    await canvas.onClose(context);
    await fake.deps.lifecycle.close();
  });
  return { ...fake, canvas };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});
function action(canvas: ReturnType<typeof createRadiusCanvas>, name: string) {
  const found = canvas.actions.find((item) => item.name === name);
  if (!found) throw new Error(`Missing action ${name}`);
  return found;
}

describe("RU-05/RU-06 action lifetime fencing", () => {
  it.each(["get_graph_resources", "update_source_refs"])(
    "rejects %s when its server is closed during acquisition",
    async (name) => {
      const { canvas, deps } = setup();
      await canvas.open(context);
      const gate = deferred<void>();
      const entered = deferred<void>();
      const acquire = deps.getOrCreateServer;
      vi.spyOn(deps, "getOrCreateServer").mockImplementationOnce(
        async (...args) => {
          const entry = await acquire(...args);
          entered.resolve();
          await gate.promise;
          return entry;
        }
      );
      const pending = action(canvas, name).handler(context);
      await entered.promise;
      await canvas.onClose(context);
      gate.resolve();
      expect(await pending).toMatchObject(
        name === "get_graph_resources" ?
          { ready: false, resources: [], message: "The graph context changed." }
        : {
            error: "The graph context changed.",
            updated: 0,
            queued: 0,
            skipped: 0
          }
      );
      expect(deps.servers.size).toBe(0);
    }
  );
  it.each(["get_graph_resources", "update_source_refs"])(
    "rejects %s when acquisition returns a replaced server with the same generation",
    async (name) => {
      const { canvas, deps } = setup();
      const old = await deps.getOrCreateServer(context.instanceId);
      const gate = deferred<void>();
      vi.spyOn(deps, "getOrCreateServer").mockImplementationOnce(async () => {
        await gate.promise;
        return old;
      });
      const pending = action(canvas, name).handler(context);
      await canvas.onClose(context);
      const replacement = await deps.getOrCreateServer(context.instanceId);
      gate.resolve();
      expect(await pending).toMatchObject(
        name === "get_graph_resources" ?
          { ready: false, message: "The graph context changed." }
        : { error: "The graph context changed.", updated: 0 }
      );
      expect(deps.servers.get(context.instanceId)).toBe(replacement);
      expect(replacement.state.graphResources).toBeUndefined();
    }
  );
  it.each(["close", "replace", "new-context"] as const)(
    "does not report a successful reference update after %s during SDK reload",
    async (change) => {
      const { canvas, deps, sessionHolder } = setup();
      const entry = await deps.getOrCreateServer(context.instanceId);
      deps.sourceRefs.setSourceRefResources(entry, "graph", [{ id: "db" }], {
        repo: "acme/widgets",
        branch: "main"
      });
      const selection = deps.sourceRefs.getSourceRefResources(entry);
      if (!selection.context) throw new Error("Missing seeded context");
      const entered = deferred<void>();
      const gate = deferred<void>();
      sessionHolder.set(
        createFakeSession({
          rpc: {
            canvas: {
              open: async () => {
                entered.resolve();
                await gate.promise;
                return {};
              }
            }
          }
        })
      );
      const pending = action(canvas, "update_source_refs").handler({
        ...context,
        input: {
          contextToken: selection.context.token,
          refs: [null, { id: "invalid" }, { id: "db", codeReference: "db.ts" }]
        }
      });
      await entered.promise;
      if (change === "new-context") {
        deps.sourceRefs.prepareSourceRefResources(entry, "graph", {
          repo: "acme/widgets",
          branch: "feature"
        });
      } else {
        await canvas.onClose(context);
        if (change === "replace") await canvas.open(context);
      }
      gate.resolve();
      expect(await pending).toEqual({
        error: "The graph context changed.",
        updated: 0,
        queued: 0,
        skipped: 0
      });
      expect(
        deps.servers.get(context.instanceId)?.state.graphResources
      ).not.toEqual([{ id: "db", codeReference: "db.ts" }]);
    }
  );
});

describe("RU-13/RU-15 open lifetime and diff failures", () => {
  it("prepares an unselected graph without inventing a repository or branch", async () => {
    const { canvas, deps, sessionHolder } = setup();
    sessionHolder.set(createFakeSession({ workspacePath: undefined }));
    vi.spyOn(deps.workspace, "detectWorkspaceContext").mockResolvedValue({
      workspacePath: "",
      repo: "",
      branch: ""
    });
    await canvas.open(context);
    const entry = deps.servers.get(context.instanceId);
    expect(entry?.state.sourceRefContexts?.graph).toMatchObject({
      repo: "",
      branch: "",
      view: "graph"
    });
    expect(deps.process.execFile).not.toHaveBeenCalled();
    expect(
      await action(canvas, "get_graph_resources").handler(context)
    ).toMatchObject({ ready: false, resources: [] });
  });
  it.each(["close", "reopen", "replace"] as const)(
    "rejects an opening server superseded by %s",
    async (change) => {
      const { canvas, deps } = setup();
      const entered = deferred<void>();
      const gate = deferred<void>();
      const acquire = deps.getOrCreateServer;
      vi.spyOn(deps, "getOrCreateServer").mockImplementationOnce(
        async (...args) => {
          const entry = await acquire(...args);
          entered.resolve();
          await gate.promise;
          return entry;
        }
      );
      const pending = canvas.open(context);
      const rejected = expect(pending).rejects.toThrow(
        "context changed while opening"
      );
      await entered.promise;
      if (change !== "reopen") await canvas.onClose(context);
      if (change !== "close") await canvas.open(context);
      gate.resolve();
      await rejected;
      if (change === "close") {
        await expect(
          canvas.open({ ...context, instanceId: "next-panel" })
        ).resolves.toMatchObject({ title: "Radius" });
        await canvas.onClose({ ...context, instanceId: "next-panel" });
      } else {
        expect(deps.servers.get(context.instanceId)?.state.contextRepo).toBe(
          "acme/widgets"
        );
      }
    }
  );
  it.each(["close", "reopen", "replace"] as const)(
    "rejects stale workspace detection after %s",
    async (change) => {
      const { canvas, deps } = setup();
      const gate =
        deferred<
          Awaited<ReturnType<typeof deps.workspace.detectWorkspaceContext>>
        >();
      const entered = deferred<void>();
      vi.spyOn(deps.workspace, "detectWorkspaceContext").mockImplementationOnce(
        () => {
          entered.resolve();
          return gate.promise;
        }
      );
      const pending = canvas.open(context);
      const rejected = expect(pending).rejects.toThrow(
        "context changed while opening"
      );
      await entered.promise;
      if (change !== "reopen") await canvas.onClose(context);
      if (change !== "close") await canvas.open(context);
      gate.resolve({
        repo: "stale/repo",
        branch: "old",
        workspacePath: "owned-workspace"
      });
      await rejected;
      expect(deps.servers.get(context.instanceId)?.state.contextRepo).not.toBe(
        "stale/repo"
      );
    }
  );
  it("retains a denied diff source as unavailable evidence and removes obsolete successful diff state", async () => {
    const { canvas, deps } = setup();
    const entry = await deps.getOrCreateServer(context.instanceId);
    entry.state.diffNoChanges = true;
    entry.state.diffResources = [{ id: "obsolete" }];
    const resolve = vi
      .spyOn(deps.lifecycle, "resolveCommittedSource")
      .mockResolvedValue(portForbidden());
    await canvas.open({ ...context, input: diffInput });
    expect(entry.state.graphReadEvidence?.diff).toMatchObject({
      unavailable: true,
      reason: "FORBIDDEN",
      source: "base"
    });
    expect(entry.state.diffError).toContain("FORBIDDEN");
    expect(entry.state.diffNoChanges).toBeUndefined();
    expect(entry.state.diffResources).toBeUndefined();
    expect(resolve).toHaveBeenCalledOnce();
  });
  it.each(["current", "replaced", "superseded", "closed"] as const)(
    "handles an unexpected diff rejection for a %s selection",
    async (change) => {
      const { canvas, deps } = setup();
      const scripted = scriptGraphDiff(deps.lifecycle);
      const gate =
        deferred<Awaited<ReturnType<typeof deps.lifecycle.execute>>>();
      const entered = deferred<void>();
      scripted.execute.mockImplementationOnce(() => {
        entered.resolve();
        return gate.promise;
      });
      const pending = canvas.open({ ...context, input: diffInput });
      await entered.promise;
      const entry = deps.servers.get(context.instanceId);
      if (!entry) throw new Error("Missing pending server");
      if (change === "replaced" || change === "closed")
        await canvas.onClose(context);
      if (change === "replaced" || change === "superseded") {
        await canvas.open({ ...context, input: diffInput });
      }
      gate.reject(new Error("Compiler transport disconnected"));
      await expect(pending).resolves.toMatchObject({ title: "Radius" });
      if (change === "current") {
        expect(entry.state.diffError).toBe(
          "The selected graph comparison is unavailable."
        );
        expect(entry.state.graphReadEvidence?.diff).toMatchObject({
          unavailable: true,
          reason: "RESULT_UNAVAILABLE"
        });
        expect(entry.state.diffResources).toBeUndefined();
        expect(entry.state.diffNoChanges).toBeUndefined();
      } else {
        expect(entry.state.diffError).toBeUndefined();
        if (change !== "closed")
          expect(
            deps.servers.get(context.instanceId)?.state.graphReadEvidence?.diff
          ).toMatchObject({ unavailable: false });
      }
    }
  );
});
