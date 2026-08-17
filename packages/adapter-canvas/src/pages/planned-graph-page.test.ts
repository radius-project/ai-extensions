import { describe, expect, it } from "vitest";
import { browserEntryMarker, browserScript } from "../browser/scripts.js";
import { HOSTILE_STATE } from "../../test/support/pages/hostile-state.js";
import { readBrowserPageState } from "../../test/support/pages/browser-state.js";
import { plannedGraphPage } from "./planned-graph-page.js";

describe("plannedGraphPage", () => {
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
      localSource: false
    });
  });

  it("serializes resolved resources and workspace provenance", () => {
    const resources = [{ id: "app/web" }];
    const html = plannedGraphPage({
      plannedRepo: "octo/app",
      plannedBranch: "worktree",
      plannedEnvironment: "dev",
      plannedResources: resources,
      plannedFromWorkspace: true
    });
    expect(readBrowserPageState(html, "radius-planned-graph-state")).toEqual({
      repo: "octo/app",
      branch: "worktree",
      environment: "dev",
      provider: "azure",
      resources,
      localSource: true
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
