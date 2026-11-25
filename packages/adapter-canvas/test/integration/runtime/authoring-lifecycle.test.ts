import { resolve } from "node:path";
import { APP_ORIGIN_REPO_PATH, serializeAppOrigin } from "@radius-project/core";
import { describe, expect, it, vi } from "vitest";
import { hashAppBicep } from "../../../src/app-bicep-hash.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";

const REPO = "acme/widgets";
const PANEL = "model-panel";
const TARGET = `${REPO}::main`;
const MODEL = "resource app 'Radius.Core/applications@2025-08-01-preview' = {}";

async function setup(refresh: boolean) {
  let nodeAvailable = refresh;
  const cancelStage = vi.fn();
  const promote = vi.fn(async () => ({
    published: ["app.bicep"],
    gitError: ""
  }));
  const stage = resolve(".radius", ".staging-managed-fixture");
  const sdk = await createRuntimeSdkHarness(
    {
      workspaceTreeByRepoBranch: { [`${REPO}@main`]: ["Dockerfile"] },
      ...(refresh ?
        {
          bicepByRepoBranch: { [`workspace:${REPO}@main`]: MODEL },
          filesByRepoBranch: {
            [`workspace:${REPO}@main:${APP_ORIGIN_REPO_PATH}`]:
              serializeAppOrigin({
                generatedAt: "2026-08-11T05:32:32.000Z",
                sourceCommit: "a".repeat(40),
                skillVersion: "0.1.0-test",
                radiusVersion: "0.60",
                appBicepHash: hashAppBicep(MODEL)
              })
          },
          headCommits: { "workspace:/workspace": "b".repeat(40) },
          sourceChangedSince: true
        }
      : {})
    },
    (deps) => {
      deps.appModel.workspaceSourceRevision = async () => "workspace:saved";
      deps.radiusAppBicepSkill = () =>
        JSON.stringify({
          skill: "radius-app-bicep",
          skillBase: resolve("fixture-skill"),
          nodeCommand: nodeAvailable ? resolve("fixture-node") : null,
          instruction:
            nodeAvailable ? "Run the skill." : "Install Node.js first."
        });
      const begin = deps.beginManagedModel;
      deps.beginManagedModel = (worktree) => ({
        ...begin(worktree),
        stagingDir: stage,
        cancel: cancelStage,
        validate: (check) => check(resolve(stage, "app.bicep")),
        promote
      });
    }
  );
  const handoff = sdk.capturedHostCallbacks.appBicepHandoff;
  if (!handoff) throw new Error("Missing registered modeling handoff");
  const tool = (name: string) => {
    const registered = sdk.extension.tools.find(
      (candidate) => candidate.name === name
    );
    if (!registered) throw new Error(`Missing registered tool ${name}`);
    return registered.handler;
  };
  const open = async () => {
    await sdk.host.open(PANEL, { page: "graph" });
    const state = sdk.servers.get(PANEL)?.state;
    if (!state) throw new Error("Missing radius panel");
    return state;
  };
  return {
    sdk,
    cancelStage,
    promote,
    open,
    installNode: () => {
      nodeAvailable = true;
    },
    handoff: (state: Awaited<ReturnType<typeof open>>) =>
      handoff({ repo: REPO, branches: ["main"], page: "graph", state }),
    complete: tool("radius_complete_app_authoring"),
    report: tool("radius_report_modeling_failure")
  };
}

describe("registered Canvas authoring lifecycle", () => {
  it("retires a refresh on panel close so a reopened panel can refresh without an agent callback", async () => {
    const h = await setup(true);
    try {
      const original = await h.open();
      await h.handoff(original);
      const requestToken = original.appModelAttemptTokens?.[TARGET];
      expect(requestToken).toBeTruthy();

      await h.sdk.host.close(PANEL);
      expect(h.cancelStage).toHaveBeenCalledOnce();
      expect(original.appModelAttemptTokens).toEqual({});

      const reopened = await h.open();
      await h.handoff(reopened);
      const replacement = reopened.appModelAttemptTokens?.[TARGET];
      expect(replacement).toBeTruthy();
      expect(replacement).not.toBe(requestToken);
      await expect(
        h.complete({ requestToken, outcome: "complete" })
      ).resolves.toMatchObject({ kind: "refused" });
      expect(h.promote).not.toHaveBeenCalled();
      await expect(
        h.complete({ requestToken: replacement, outcome: "complete" })
      ).resolves.toMatchObject({ kind: "promoted" });
      expect(h.promote).toHaveBeenCalledOnce();
    } finally {
      await h.sdk.extension.shutdown("test");
    }
  });

  it("retries missing-model authoring after Node installation and refuses a late cancelled failure", async () => {
    const h = await setup(false);
    try {
      const state = await h.open();
      await h.handoff(state);
      expect(h.sdk.session.send).toHaveBeenLastCalledWith({
        prompt: expect.stringContaining("Install Node.js first."),
        displayPrompt: expect.any(String)
      });
      expect(state.appModelAttemptTokens).toEqual({});

      h.installNode();
      await h.handoff(state);
      const cancelled = state.appModelAttemptTokens?.[TARGET];
      expect(cancelled).toBeTruthy();
      await expect(
        h.complete({ requestToken: cancelled, outcome: "cancel" })
      ).resolves.toEqual({ kind: "cancelled" });
      await expect(
        h.report({
          repo: REPO,
          branch: "main",
          instanceId: PANEL,
          attemptToken: cancelled,
          error: "Late failure for a cancelled attempt."
        })
      ).resolves.toMatchObject({ recorded: false });

      await h.handoff(state);
      const replacement = state.appModelAttemptTokens?.[TARGET];
      expect(replacement).toBeTruthy();
      expect(replacement).not.toBe(cancelled);
      expect(h.sdk.session.send).toHaveBeenCalledTimes(3);
    } finally {
      await h.sdk.extension.shutdown("test");
    }
  });
});
