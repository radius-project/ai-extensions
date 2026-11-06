import { describe, expect, it } from "vitest";
import type { DeploymentState } from "@radius-project/core";
import { createTestDeploymentRuntime } from "../../../test/support/server/deployment-runtime.js";
import { createDeferred } from "../../../test/support/browser/fakes.js";
import type { CanvasState } from "../../shared.js";
import { createDeploymentViews } from "./deployment-views.js";

function harness() {
  const runtime = createTestDeploymentRuntime();
  const views = createDeploymentViews(runtime);
  const target = {
    repo: "acme/widgets",
    environment: "production",
    branch: "feature",
    provider: "azure",
    appFile: ".radius/app.bicep"
  };
  function begin(
    state: DeploymentState = {},
    repo = target.repo,
    attemptId?: string,
    environment = target.environment
  ) {
    const selected = { ...target, repo, environment };
    const reservation = runtime.owner.reserve(selected, "deploy");
    if (!reservation) throw new Error("Target reserved");
    const invocation = runtime.owner.begin(
      selected,
      state,
      reservation,
      attemptId
    );
    state.deployAttempt = {
      id: invocation.attemptId,
      targetRepo: repo,
      environment: selected.environment
    };
    state.deployGeneration = invocation.generation;
    runtime.owner.release(reservation);
    return invocation;
  }
  return { runtime, views, target, begin };
}

describe("detachable deployment projections", () => {
  it("clones nested resources and logs, preserving unrelated panel state", () => {
    const h = harness();
    const invocation = h.begin({
      deployStatus: "in_progress",
      deployLogs: ["starting"],
      deployingResources: [{ name: "web", outputResources: [{ name: "pod" }] }]
    });
    const state: CanvasState = {
      contextRepo: "acme/widgets",
      deployError: "old"
    };
    h.views.attach("panel", state, invocation);
    expect(state.contextRepo).toBe("acme/widgets");
    expect(state.deployError).toBeUndefined();
    state.deployLogs?.push("view-only");
    if (state.deployingResources?.[0])
      state.deployingResources[0].name = "changed";
    expect(invocation.state.deployLogs).toEqual(["starting"]);
    expect(invocation.state.deployingResources?.[0].name).toBe("web");
    invocation.state.deployStatus = "success";
    h.runtime.owner.publish(invocation);
    expect(state.deployStatus).toBe("success");
    expect(state.deployLogs).toEqual(["starting"]);
    expect(state.deployAttempt?.id).toBe(invocation.attemptId);
  });

  it("detaches idempotently and reconnects a remembered live attempt", async () => {
    const h = harness();
    const invocation = h.begin({ deployStatus: "in_progress" });
    const state: CanvasState = {};
    const done = createDeferred<void>();
    const work = h.runtime.owner.run(invocation, () => done.promise);
    h.views.attach("panel", state, invocation);
    h.views.detach("panel");
    h.views.detach("panel");
    invocation.state.deployStatus = "success";
    h.runtime.owner.publish(invocation);
    expect(state.deployStatus).toBe("in_progress");
    expect(invocation.signal.aborted).toBe(false);
    expect(h.runtime.owner.hasActiveWork()).toBe(true);
    const reopened: CanvasState = {};
    h.views.refresh("panel", reopened);
    expect(reopened.deployStatus).toBe("success");
    done.resolve();
    await work;
  });

  it("refreshes a matching unambiguous record but not another repository", () => {
    const h = harness();
    h.begin({ deployStatus: "success" });
    const state: CanvasState = { workspaceRepo: "ACME/widgets" };
    h.views.refresh("new", state);
    expect(state.deployStatus).toBe("success");
    const unrelated: CanvasState = { plannedRepo: "other/repo" };
    h.views.refresh("other", unrelated);
    expect(unrelated.deployStatus).toBeUndefined();
    h.views.refresh("new", state);
    expect(state.deployStatus).toBe("success");
  });

  it("does not choose an arbitrary record from multiple targets", () => {
    const h = harness();
    h.begin({ deployStatus: "success" });
    h.begin({ deployStatus: "failed" }, "acme/other");
    const state: CanvasState = {};
    h.views.refresh("new", state);
    expect(state.deployStatus).toBeUndefined();
  });

  it("leaves an empty view empty when the runtime has no record", () => {
    const h = harness();
    const state: CanvasState = {};
    h.views.refresh("new", state);
    expect(state).toEqual({});
  });

  it("ignores missing and stale reset identity", () => {
    const h = harness();
    const invocation = h.begin({ deployStatus: "success" });
    const state: CanvasState = {};
    h.views.reset(state, invocation.attemptId);
    h.views.attach("panel", state, invocation);
    h.views.reset(state, "stale");
    expect(state.deployStatus).toBe("success");
    expect(h.runtime.owner.isCurrent(invocation)).toBe(true);
  });

  it("active reset removes only the view and cannot reattach it by polling", async () => {
    const h = harness();
    const invocation = h.begin({ deployStatus: "in_progress" });
    const done = createDeferred<void>();
    const work = h.runtime.owner.run(invocation, () => done.promise);
    const state: CanvasState = {};
    h.views.attach("panel", state, invocation);
    h.views.reset(state, invocation.attemptId);
    h.views.refresh("panel", state);
    expect(state.deployAttempt).toBeUndefined();
    expect(h.runtime.owner.isCurrent(invocation)).toBe(true);
    expect(invocation.signal.aborted).toBe(false);
    expect(h.views.retire(invocation)).toBe(false);
    done.resolve();
    await work;
  });

  it("terminal reset retires the exact record", () => {
    const h = harness();
    const invocation = h.begin({ deployStatus: "success" });
    const state: CanvasState = {};
    h.views.attach("panel", state, invocation);
    h.views.reset(state, invocation.attemptId);
    expect(h.runtime.owner.lookup()).toEqual({ kind: "missing" });
    expect(state.deployStatus).toBeUndefined();
  });

  it.each([
    { deployStatus: "failed", deployErrorKind: "run-unconfirmed" as const },
    { deployStatus: "in_progress" },
    {}
  ])(
    "preserves uncertain or nonterminal owner evidence on reset: %j",
    (snapshot) => {
      const h = harness();
      const invocation = h.begin(snapshot);
      const state: CanvasState = {};
      h.views.attach("panel", state, invocation);
      h.views.reset(state, invocation.attemptId);
      expect(state.deployAttempt).toBeUndefined();
      expect(h.runtime.owner.isCurrent(invocation)).toBe(true);
    }
  );

  it("retires all views of one terminal record but leaves another target alone", () => {
    const h = harness();
    const first = h.begin({ deployStatus: "failed" });
    const other = h.begin({ deployStatus: "success" }, "acme/other");
    const a: CanvasState = {},
      b: CanvasState = {},
      c: CanvasState = {};
    h.views.attach("a", a, first);
    h.views.attach("b", b, first);
    h.views.attach("c", c, other);
    expect(h.views.retire(first)).toBe(true);
    expect(h.views.retire(first)).toBe(false);
    expect(a.deployStatus).toBeUndefined();
    expect(b.deployStatus).toBeUndefined();
    expect(c.deployStatus).toBe("success");
    expect(h.runtime.owner.isCurrent(other)).toBe(true);
  });

  it("refreshes a newer generation and fences retirement of its predecessor", () => {
    const h = harness();
    const first = h.begin({ deployStatus: "failed" });
    const state: CanvasState = {};
    h.views.attach("panel", state, first);
    const next = h.begin(
      { deployStatus: "in_progress" },
      h.target.repo,
      first.attemptId
    );
    h.views.refresh("panel", state);
    expect(state.deployAttempt?.id).toBe(next.attemptId);
    expect(state.deployGeneration).toBe(2);
    expect(h.views.retire(first)).toBe(false);
    h.runtime.owner.publish(first);
    expect(state.deployStatus).toBe("in_progress");
  });

  it("selects the requested repository and exact environment among multiple records", () => {
    const h = harness();
    h.begin({ deployStatus: "success" });
    const selected = h.begin(
      { deployStatus: "failed" },
      h.target.repo,
      undefined,
      "staging"
    );
    h.begin({ deployStatus: "in_progress" }, "acme/other");
    const state: CanvasState = {
      contextRepo: "ACME/widgets",
      envName: "staging"
    };
    h.views.refresh("panel", state);
    expect(state.deployAttempt?.id).toBe(selected.attemptId);
    expect(state.deployStatus).toBe("failed");
    const wrongCase: CanvasState = {
      contextRepo: "acme/widgets",
      envName: "Staging"
    };
    h.views.refresh("wrong", wrongCase);
    expect(wrongCase.deployAttempt).toBeUndefined();
  });

  it("reconnects a replacement ordinary attempt without selecting an unrelated target", () => {
    const h = harness();
    const first = h.begin({ deployStatus: "success" });
    const state: CanvasState = {};
    h.views.attach("panel", state, first);
    h.views.detach("panel");
    h.begin({ deployStatus: "failed" }, "acme/other");
    const next = h.begin({ deployStatus: "in_progress" });
    const reopened: CanvasState = {};
    h.views.refresh("panel", reopened);
    expect(reopened.deployAttempt?.id).toBe(next.attemptId);
    expect(reopened.deployStatus).toBe("in_progress");
  });

  it("detaches a view when its repository context changes", () => {
    const h = harness();
    const invocation = h.begin({ deployStatus: "in_progress" });
    const state: CanvasState = { contextRepo: h.target.repo };
    h.views.attach("panel", state, invocation);
    state.contextRepo = "acme/other";
    h.views.refresh("panel", state);
    invocation.state.deployStatus = "success";
    h.runtime.owner.publish(invocation);
    expect(state.deployStatus).toBeUndefined();
    expect(h.runtime.owner.isCurrent(invocation)).toBe(true);
  });

  it("does not attach a different environment when only the environment is selected", () => {
    const h = harness();
    h.begin({ deployStatus: "success" });
    const state: CanvasState = { envName: "other" };
    h.views.refresh("panel", state);
    expect(state.deployStatus).toBeUndefined();
  });

  it("shares target reservations across panels and releases only exact handles", () => {
    const h = harness();
    const input = { ...h.target, kind: "delete" as const };
    const a = h.views.reserve({}, input);
    expect(a).not.toBeNull();
    expect(h.views.reserve({}, { ...input, kind: "abandon" })).toBeNull();
    if (!a) throw new Error("Missing reservation");
    h.views.release({}, { ...a });
    expect(h.views.reserve({}, input)).toBeNull();
    h.views.release({}, a);
    h.views.release({}, a);
    expect(h.views.reserve({}, input)).not.toBeNull();
  });
});
