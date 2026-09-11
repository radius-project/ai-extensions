import { describe, expect, it } from "vitest";
import { browserEntryMarker, browserScript } from "../browser/scripts.js";
import { HOSTILE_STATE } from "../../test/support/pages/hostile-state.js";
import { readBrowserPageState } from "../../test/support/pages/browser-state.js";
import { unlabelledSelectIds } from "../../test/support/pages/labelled-controls.js";
import { plannedGraphPage } from "./planned-graph-page.js";

describe("plannedGraphPage", () => {
  it("gives every selector a programmatic name", () => {
    expect(
      unlabelledSelectIds(
        plannedGraphPage({
          plannedRepo: "octo/app",
          plannedBranch: "feature",
          plannedEnvironment: "dev",
          plannedProvider: "azure"
        })
      )
    ).toEqual([]);
    expect(
      unlabelledSelectIds(
        plannedGraphPage({
          plannedRepo: "octo/app",
          plannedBranch: "feature",
          plannedEnvironment: "dev",
          plannedProvider: "azure",
          branches: ["feature", "main"]
        })
      )
    ).toEqual([]);
  });

  it("renders selectors and exactly one generated page entry", () => {
    const html = plannedGraphPage({
      plannedRepo: "octo/app",
      plannedBranch: "feature",
      plannedEnvironment: "dev",
      plannedProvider: "azure"
    });
    expect(html).toContain('id="planned-app"');
    expect(html).toContain('id="planned-branch"');
    expect(html).toContain('id="planned-env"');
    expect(html).toContain(browserEntryMarker("planned-graph-page"));
    expect(html.split(browserScript("planned-graph-page"))).toHaveLength(2);
    expect(readBrowserPageState(html, "radius-planned-graph-state")).toEqual({
      repo: "octo/app",
      branch: "feature",
      environment: "dev",
      provider: "azure",
      resources: [],
      localSource: false,
      followWorkspaceBranch: false
    });
  });

  it("serializes resolved resources and workspace provenance", () => {
    const resources = [{ id: "app/web" }];
    const html = plannedGraphPage({
      plannedRepo: "octo/app",
      plannedBranch: "worktree",
      plannedEnvironment: "dev",
      plannedResources: resources,
      plannedFromWorkspace: true,
      contextRepo: "octo/app",
      contextBranch: "worktree",
      contextBranchSource: "workspace",
      workspaceRepo: "octo/app"
    });

    expect(readBrowserPageState(html, "radius-planned-graph-state")).toEqual({
      repo: "octo/app",
      branch: "worktree",
      environment: "dev",
      provider: "azure",
      resources,
      localSource: true,
      followWorkspaceBranch: true
    });
  });

  it("preserves an explicit selection even when its name matches the workspace branch", () => {
    const html = plannedGraphPage({
      plannedRepo: "octo/app",
      plannedBranch: "worktree",
      plannedFollowsWorkspaceBranch: false,
      contextBranch: "worktree",
      contextBranchSource: "workspace",
      workspaceRepo: "octo/app"
    });

    expect(
      readBrowserPageState(html, "radius-planned-graph-state")
    ).toMatchObject({
      branch: "worktree",
      followWorkspaceBranch: false
    });
  });

  it("keeps hostile state inert", () => {
    const html = plannedGraphPage({
      plannedRepo: HOSTILE_STATE,
      plannedBranch: HOSTILE_STATE,
      plannedEnvironment: HOSTILE_STATE
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(
      readBrowserPageState(html, "radius-planned-graph-state")
    ).toMatchObject({
      repo: HOSTILE_STATE,
      branch: HOSTILE_STATE,
      environment: HOSTILE_STATE
    });
  });
});
