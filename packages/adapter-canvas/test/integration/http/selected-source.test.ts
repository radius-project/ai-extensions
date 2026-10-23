import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { graphDefinitionHash } from "../../../src/server.js";
import { radArtifactsFingerprint } from "../../../src/remote-rad-artifacts.js";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { configureOperationStore } from "../../../src/operations.js";
import { disabledOperationStore } from "../../../src/operation-store.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";

it("retains matching-worktree Bicep selection through the production HTTP composition", async () => {
  await configureOperationStore(disabledOperationStore());
  const workspacePath = mkdtempSync(join(tmpdir(), "radius-selected-source-"));
  const artifacts = join(workspacePath, ".radius");
  mkdirSync(artifacts);
  const content = "param location string = 'westus'\n";
  writeFileSync(join(artifacts, "app.bicep"), content);
  const owner = createEnvironmentExecutionOwner();
  const runtime = createTestCanvasServerRuntime({ executionOwner: owner });
  try {
    const entry = await runtime.getOrCreateServer("selected-source", "graph");
    Object.assign(entry.state, {
      workspacePath,
      workspaceRepo: "fixture/app",
      workspaceBranch: "feature/model",
      graphTargetRepo: "fixture/app",
      graphBranch: "feature/model",
      graphLoaded: true,
      graphResources: [],
      graphDefinitionHash: graphDefinitionHash(
        content,
        radArtifactsFingerprint(artifacts)
      )
    });
    const response = await fetch(entry.baseUrl + "/api/load-graph", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: entry.baseUrl,
        "Sec-Fetch-Site": "same-origin",
        "X-Radius-Mutation-Nonce": String(entry.state.browserMutationNonce)
      },
      body: JSON.stringify({
        repo: "fixture/app",
        branch: "feature/model",
        followWorkspaceBranch: false,
        refresh: true
      })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      reload: false,
      resources: [],
      fromWorkspace: true,
      cached: true
    });
    expect(entry.state.graphFromWorkspace).toBe(true);
    expect(entry.state.graphModelRevision).toBe(graphDefinitionHash(content));
  } finally {
    await runtime.stopServer("selected-source", true);
    owner.shutdown();
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
